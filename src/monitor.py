#!/usr/bin/env python3
"""LowEndTalk 低价 VPS 监控。

抓取 LET 的 Offers 板块 → AI 打标签并生成中文摘要 → 去重后邮件推送新增条目。

后端通过环境变量配置，任何兼容 OpenAI /v1/chat/completions 的服务都可以用。
"""

from __future__ import annotations

import html
import json
import os
import re
import smtplib
import ssl
import sys
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path

import requests

# ---------------------------------------------------------------- 配置

FEED_URL = os.environ.get(
    "FEED_URL", "https://lowendtalk.com/categories/offers/feed.rss"
)
# LET 前面挡着 Cloudflare，直连会 403，走这个转换服务拿 JSON Feed。
# 换用其他站点时，若源站可直接访问，把 FEED_PROXY 设为 "{url}" 即可。
FEED_PROXY = os.environ.get("FEED_PROXY", "https://feed2json.org/convert?url={url}")

# 兼容的三种接口格式：
#   chat_completions  OpenAI /v1/chat/completions（默认）
#   responses         OpenAI /v1/responses
#   anthropic         Anthropic /v1/messages
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "https://api.openai.com/v1")
LLM_API_KEY = os.environ.get("LLM_API_KEY", "")
LLM_MODEL = os.environ.get("LLM_MODEL", "gpt-4o-mini")
LLM_API_FORMAT = os.environ.get("LLM_API_FORMAT", "chat_completions").strip().lower()
LLM_TIMEOUT = int(os.environ.get("LLM_TIMEOUT", "300"))

LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "7"))
MAX_POSTS = int(os.environ.get("MAX_POSTS", "60"))

# 实际推送间隔（分钟）。工作流被唤醒得比这更频繁时，脚本会跳过，
# 避免重复抓取与浪费调用。手动触发（--force）不受此限制。
INTERVAL_MINUTES = int(os.environ.get("INTERVAL_MINUTES", "30"))

# 只推送带服务器类型标签的条目。Offers 板块里混着 SSL 证书、
# 控制面板、IP 租赁等非服务器内容，置为 false 可一并推送。
REQUIRE_SERVER_TAG = os.environ.get("REQUIRE_SERVER_TAG", "true").lower() not in (
    "0", "false", "no",
)

# 状态与预览分开存放：状态进 Actions cache，预览只作为 artifact 上传。
STATE_PATH = Path(os.environ.get("STATE_PATH", ".state/sent.json"))
PREVIEW_PATH = Path(os.environ.get("PREVIEW_PATH", "preview.html"))
STATE_MAX = 5000

UA = "lowendtalk-lowprice-monitor/1.0 (+https://github.com/samoyed24)"
TZ_OFFSET = timezone(timedelta(hours=8))

SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.qq.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "465"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "")
MAIL_TO = os.environ.get("MAIL_TO", "")

DRY_RUN = "--dry-run" in sys.argv
FORCE = "--force" in sys.argv


def log(msg: str) -> None:
    print(f"[{datetime.now(timezone.utc):%H:%M:%S}] {msg}", flush=True)


# ---------------------------------------------------------------- 抓取与解析

def http_get_json(url: str, *, timeout: int = 60, tries: int = 3):
    """GET 一个 JSON 接口，带退避重试。"""
    last = None
    for attempt in range(1, tries + 1):
        try:
            r = requests.get(url, headers={"User-Agent": UA}, timeout=timeout)
            r.raise_for_status()
            return r.json()
        except Exception as exc:  # noqa: BLE001 - 重试后再抛出
            last = exc
            log(f"  请求失败 ({attempt}/{tries}): {type(exc).__name__}: {str(exc)[:120]}")
            if attempt < tries:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"GET {url} 重试 {tries} 次仍失败: {last}")


def decode_entities(s: str) -> str:
    """feed2json 返回的 content_text 里 HTML 实体仍未解码。

    必须先解码，否则我们重新转义时 ``&`` 会变成 ``&amp;amp;``。
    """
    s = str(s or "")
    s = re.sub(r"&#x([0-9a-f]+);", lambda m: chr(int(m.group(1), 16)), s, flags=re.I)
    s = re.sub(r"&#(\d+);", lambda m: chr(int(m.group(1))), s)
    for ent, ch in (
        ("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'),
        ("&apos;", "'"), ("&hellip;", "…"), ("&mdash;", "—"), ("&ndash;", "–"),
        ("&rsquo;", "’"), ("&lsquo;", "‘"), ("&ldquo;", "“"),
        ("&rdquo;", "”"),
    ):
        s = s.replace(ent, ch)
    return s.replace("&amp;", "&")   # 最后解码 &，避免二次解码


def strip_title_lead(title: str, text: str) -> str:
    """正文开头重复了标题（标点可能不同，如 "[Foo] Bar" vs "Foo - Bar"）。

    只比较字母数字，再按字符位置切开原文。
    """
    nt = re.sub(r"[^a-z0-9]+", "", str(title).lower())
    tt = re.sub(r"[^a-z0-9]+", "", str(text).lower())
    if len(nt) < 15 or len(tt) < len(nt):
        return text
    if not tt.startswith(nt):
        probe = nt[: max(15, int(len(nt) * 0.7))]
        if not tt.startswith(probe):
            return text
    count = i = 0
    while i < len(text) and count < len(nt):
        if re.match(r"[a-z0-9]", text[i].lower()):
            count += 1
        i += 1
    rest = re.sub(r"^[\s\-–—|:·•,.]+", "", text[i:]).strip()
    return rest if len(rest) > 40 else text


def fetch_feed() -> dict:
    url = FEED_PROXY.format(url=urllib.parse.quote(FEED_URL, safe=""))
    data = http_get_json(url, timeout=90)
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise RuntimeError("feed 返回结构异常，拿不到 items")
    log(f"抓到 {len(data['items'])} 条（feed: {data.get('title')}）")
    return data


def parse_posts(feed: dict) -> list[dict]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)
    posts = []
    for item in feed["items"]:
        url = item.get("url") or item.get("external_url") or item.get("id") or ""
        if not url:
            continue
        raw_date = item.get("date_published") or item.get("date_modified") or ""
        ts = None
        if raw_date:
            try:
                ts = datetime.fromisoformat(raw_date.replace("Z", "+00:00"))
            except ValueError:
                ts = None
        if ts and ts < cutoff:
            continue

        title = decode_entities(str(item.get("title", "")).strip())
        body = decode_entities(
            item.get("content_text") or re.sub(r"<[^>]+>", " ", item.get("content_html") or "")
        )
        body = re.sub(r"\s+", " ", body).strip()
        body = strip_title_lead(title, body)

        posts.append({
            "title": title,
            "postUrl": url,
            "author": (item.get("author") or {}).get("name", ""),
            "date": raw_date,
            "body": body,
        })

    posts.sort(key=lambda p: p["date"], reverse=True)
    return posts[:MAX_POSTS]


# ---------------------------------------------------------------- AI

SYSTEM_PROMPT = "\n".join([
    "你是 VPS / 服务器优惠分析师。对每一条帖子打标签并写中文摘要。",
    "",
    "tags：从下列取值中选出所有适用的，可以多选，也可以为空数组。",
    "  类型（最多选一个）：vps、vds、独服、存储服",
    "  网络（可多选）：ipv4、ipv6、家宽、回国优化、CN2、GIA、BGP、Anycast、大带宽、不限流量",
    "  其他（可多选）：高防、KVM、OpenVZ、LXC、Windows、GPU、独立IP、免费试用、抽奖",
    "",
    "  · vps = 虚拟服务器；vds = 独享资源的虚拟服务器",
    "  · 独服 = 独立服务器 / 裸金属 / 整机租用",
    "  · 存储服 = 主打大容量存储的机型",
    "  · 家宽 = 住宅宽带 IP；回国优化 = 面向中国大陆优化的线路",
    "  · 注意 \"1 Dedicated IPv4\"、\"dedicated port\"、\"dedicated resources\" 说的是 VPS 的配置，",
    "    不是独立服务器。只有整机租用才算「独服」。",
    "",
    "prices：列出帖子里出现的所有价格档，按从低到高排序，最多 5 条。",
    "  · amount 只填数字；currency 填 USD / EUR / CNY 等，不确定填 null",
    "  · period 只能是 month | year | quarter | half-year | one-time | unknown",
    "",
    "zh：中文摘要，40 字以内，说清「什么机器 + 什么配置 + 什么价位」。",
    "",
    "只输出 JSON 数组，不要解释文字，不要 markdown 代码块。",
    '格式：[{"i":序号,"tags":["..."],"prices":[{"amount":数字,"currency":"USD","period":"month"}],"zh":"..."}]',
])


def _post(path: str, payload: dict, headers: dict) -> dict:
    url = f"{LLM_BASE_URL.rstrip('/')}/{path.lstrip('/')}"
    last = None
    for attempt in range(1, 4):
        try:
            r = requests.post(url, headers=headers, json=payload, timeout=LLM_TIMEOUT)
            if r.status_code >= 400:
                raise RuntimeError(f"HTTP {r.status_code}: {r.text[:300]}")
            return r.json()
        except Exception as exc:  # noqa: BLE001
            last = exc
            log(f"  LLM 调用失败 ({attempt}/3): {type(exc).__name__}: {str(exc)[:200]}")
            if attempt < 3:
                time.sleep(5 * attempt)
    raise RuntimeError(f"LLM 调用失败: {last}")


def _extract_chat_completions(data: dict) -> str:
    return data["choices"][0]["message"]["content"] or ""


def _extract_responses(data: dict) -> str:
    """Responses API 的 output 里混着 reasoning 与 message，只取 message 的文本。"""
    if data.get("error"):
        raise RuntimeError(f"响应报错: {json.dumps(data['error'], ensure_ascii=False)[:300]}")
    parts = []
    for item in data.get("output") or []:
        if item.get("type") != "message":
            continue
        for c in item.get("content") or []:
            if c.get("type") in ("output_text", "text") and c.get("text"):
                parts.append(c["text"])
    text = "".join(parts)
    if not text:
        raise RuntimeError(f"响应里没有文本: {json.dumps(data, ensure_ascii=False)[:300]}")
    return text


def _extract_anthropic(data: dict) -> str:
    return "".join(c.get("text", "") for c in data.get("content", []))


def llm_chat(system: str, user: str, *, max_tokens: int = 8000) -> str:
    """按 LLM_API_FORMAT 指定的格式调用后端。"""
    if LLM_API_FORMAT == "responses":
        data = _post("responses", {
            "model": LLM_MODEL,
            "instructions": system,
            "input": user,
            "max_output_tokens": max_tokens,
        }, {
            "Authorization": f"Bearer {LLM_API_KEY}",
            "Content-Type": "application/json",
            "User-Agent": UA,
        })
        return _extract_responses(data)

    if LLM_API_FORMAT == "anthropic":
        data = _post("messages", {
            "model": LLM_MODEL,
            "max_tokens": max_tokens,
            "temperature": 0,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        }, {
            "x-api-key": LLM_API_KEY,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
            "User-Agent": UA,
        })
        return _extract_anthropic(data)

    # 默认：OpenAI chat completions
    data = _post("chat/completions", {
        "model": LLM_MODEL,
        "max_tokens": max_tokens,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }, {
        "Authorization": f"Bearer {LLM_API_KEY}",
        "Content-Type": "application/json",
        "User-Agent": UA,
    })
    return _extract_chat_completions(data)


def classify(posts: list[dict]) -> list[dict]:
    payload = [
        {"i": i, "title": p["title"][:200], "body": p["body"][:700]}
        for i, p in enumerate(posts)
    ]
    text = llm_chat(
        SYSTEM_PROMPT,
        "分析以下帖子：\n" + json.dumps(payload, ensure_ascii=False),
    )
    m = re.search(r"\[[\s\S]*\]", text)
    if not m:
        raise RuntimeError(f"响应里没有 JSON 数组: {text[:300]}")
    verdicts = json.loads(m.group(0))
    log(f"AI 打了 {len(verdicts)} 条的标签")
    return verdicts


# ---------------------------------------------------------------- 整理

TYPE_TAGS = ("vps", "vds", "独服", "存储服")
TYPE_COLOR = {"vps": "#1a56db", "vds": "#7c3aed", "独服": "#9a3412", "存储服": "#0f766e"}
TAG_COLOR = "#6b7280"

PERIOD_ZH = {
    "month": "/月", "year": "/年", "quarter": "/季",
    "half-year": "/半年", "one-time": " 一次性", "unknown": "",
}
# 折算到月，用于排序；周期未知的不参与排序
TO_MONTH = {"month": 1, "quarter": 1 / 3, "half-year": 1 / 6, "year": 1 / 12}


def normalize_prices(raw) -> list[dict]:
    """规整 AI 返回的价格档，丢弃读不出金额的。"""
    out = []
    if not isinstance(raw, list):
        return out
    for p in raw:
        if not isinstance(p, dict):
            continue
        try:
            amount = float(p.get("amount"))
        except (TypeError, ValueError):
            continue
        if amount <= 0:
            continue
        period = str(p.get("period") or "unknown").lower()
        currency = p.get("currency")
        out.append({
            "amount": amount,
            "currency": (str(currency).upper() if currency else ""),
            "period": period,
        })
    out.sort(key=lambda x: x["amount"])
    return out[:5]


def merge(verdicts: list[dict], posts: list[dict]) -> list[dict]:
    items = []
    for v in verdicts:
        idx = v.get("i")
        if not isinstance(idx, int) or not (0 <= idx < len(posts)):
            continue
        tags = [str(t).strip() for t in (v.get("tags") or []) if str(t).strip()]
        if REQUIRE_SERVER_TAG and not any(t in TYPE_TAGS for t in tags):
            continue
        items.append({
            **posts[idx],
            "tags": tags,
            "prices": normalize_prices(v.get("prices")),
            "zh": str(v.get("zh") or ""),
        })

    # 按最低月均价排序，价格未知的排后面
    def sort_key(x):
        monthly = [
            p["amount"] * TO_MONTH[p["period"]]
            for p in x["prices"] if p["period"] in TO_MONTH
        ]
        return (0, min(monthly)) if monthly else (1, 0)

    items.sort(key=sort_key)
    log(f"整理出 {len(items)} 条")
    return items


# ---------------------------------------------------------------- 输出



def fmt_date(raw: str) -> str:
    if not raw:
        return ""
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return dt.astimezone(TZ_OFFSET).strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return raw[:16]


def price_text(p: dict) -> str:
    cur = {"USD": "$", "EUR": "€", "CNY": "¥"}.get(p["currency"], p["currency"] + " " if p["currency"] else "$")
    return f"{cur}{p['amount']:g}{PERIOD_ZH.get(p['period'], '')}"


def build_digest(items: list[dict]) -> tuple[str, str]:
    def esc(s):
        return html.escape(str(s or ""), quote=True)

    rows = []
    for x in items:
        type_tag = next((t for t in x["tags"] if t in TYPE_TAGS), None)
        others = [t for t in x["tags"] if t not in TYPE_TAGS]

        badges = []
        if type_tag:
            badges.append(
                f'<span style="display:inline-block;font-size:11px;font-weight:700;color:#fff;'
                f'background:{TYPE_COLOR[type_tag]};border-radius:3px;padding:1px 6px;'
                f'margin-right:6px;vertical-align:1px">{esc(type_tag)}</span>'
            )
        badges.extend(
            f'<span style="display:inline-block;font-size:11px;color:{TAG_COLOR};'
            f'border:1px solid #d1d5db;border-radius:3px;padding:0 5px;'
            f'margin-right:4px;vertical-align:1px">{esc(t)}</span>'
            for t in others
        )

        price_html = (
            '<span style="color:#0a7d32;font-weight:700">'
            + esc(" / ".join(price_text(p) for p in x["prices"]))
            + "</span>"
        ) if x["prices"] else '<span style="color:#9ca3af">未列价格</span>'

        rows.append(f"""
  <div style="padding:13px 0;border-bottom:1px solid #ececec">
    <div style="margin-bottom:5px">{''.join(badges)}
      <a href="{esc(x['postUrl'])}" style="font-size:15px;font-weight:600;color:#1a56db;
         text-decoration:none">{esc(x['title'])}</a>
    </div>
    <div style="font-size:12px;color:#8a8a8a;margin-bottom:6px">
      {esc(x['author'])}{' · ' if x['author'] else ''}{esc(fmt_date(x['date']))} · {price_html}
    </div>
    <div style="font-size:13px;color:#333;line-height:1.55">{esc(x['zh'])}</div>
  </div>""")

    counts: dict[str, int] = {}
    for x in items:
        for t in x["tags"]:
            if t in TYPE_TAGS:
                counts[t] = counts.get(t, 0) + 1
    summary = " · ".join(f"{k} {v}" for k, v in counts.items())
    now = datetime.now(TZ_OFFSET).strftime("%Y-%m-%d %H:%M")

    doc = f"""<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;max-width:720px">
  <h2 style="margin:0 0 5px;font-size:19px">LowEndTalk 低价 VPS 汇总</h2>
  <div style="color:#8a8a8a;font-size:12px;margin-bottom:16px">
    新增 <b>{len(items)}</b> 条{f'（{summary}）' if summary else ''} · 抓取时间 {now}
  </div>
  {''.join(rows)}
  <div style="margin-top:18px;font-size:11px;color:#b0b0b0">
    来源 LowEndTalk › Offers 板块
  </div>
</div>"""

    subject = f"[LET] 低价VPS {len(items)} 条 · {now[:10]}"
    return subject, doc


def send_mail(subject: str, html_body: str) -> None:
    if not (SMTP_USER and SMTP_PASS and MAIL_TO):
        raise RuntimeError("缺少 SMTP_USER / SMTP_PASS / MAIL_TO")
    msg = EmailMessage()
    msg["From"] = SMTP_USER
    msg["To"] = MAIL_TO
    msg["Subject"] = subject
    msg.set_content("此邮件为 HTML 格式，请用支持 HTML 的客户端查看。")
    msg.add_alternative(html_body, subtype="html")

    ctx = ssl.create_default_context()
    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=60, context=ctx) as s:
        s.login(SMTP_USER, SMTP_PASS)
        s.send_message(msg)
    log(f"邮件已发送 → {MAIL_TO}")


def send_alert(error: str) -> None:
    """失败时告警。主题刻意区分，方便在邮箱里一眼认出。"""
    try:
        send_mail(
            "🚨 LET 监控运行失败",
            f"""<div style="font-family:monospace;font-size:13px">
  <p><b>LowEndTalk 监控本次运行失败</b></p>
  <p style="color:#b91c1c;white-space:pre-wrap">{html.escape(error[:2000])}</p>
  <p style="color:#6b7280">时间：{datetime.now(TZ_OFFSET):%Y-%m-%d %H:%M} (CST)</p>
</div>""",
        )
    except Exception as exc:  # noqa: BLE001 - 告警失败不应掩盖原始错误
        log(f"告警邮件也发不出去: {exc}")


# ---------------------------------------------------------------- 状态

def load_state() -> dict:
    # 刻意不建目录：dry-run 应当完全没有副作用，
    # 目录只在真正要写状态时才创建（见 save_state）。
    if STATE_PATH.exists():
        try:
            data = json.loads(STATE_PATH.read_text())
            if isinstance(data.get("sent"), list):
                return data
        except (json.JSONDecodeError, OSError):
            log("状态文件损坏，按空状态处理")
    return {"sent": []}


def save_state(state: dict) -> None:
    sent = state["sent"][-STATE_MAX:]
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps({
        "sent": sent,
        "lastRun": datetime.now(timezone.utc).isoformat(),
        "updated": datetime.now(timezone.utc).isoformat(),
    }, ensure_ascii=False))
    log(f"状态已保存（累计 {len(sent)} 条已推送）")


def due_since_last_run(state: dict) -> bool:
    """距离上次运行是否已达到 INTERVAL_MINUTES。"""
    if FORCE or DRY_RUN or INTERVAL_MINUTES <= 0:
        return True
    last = state.get("lastRun")
    if not last:
        return True
    try:
        prev = datetime.fromisoformat(last)
    except ValueError:
        return True
    elapsed = (datetime.now(timezone.utc) - prev).total_seconds() / 60
    if elapsed < INTERVAL_MINUTES:
        log(f"距上次运行仅 {elapsed:.0f} 分钟，未达 {INTERVAL_MINUTES} 分钟间隔，跳过")
        return False
    return True


# ---------------------------------------------------------------- 主流程

def run() -> int:
    if not LLM_API_KEY:
        raise RuntimeError("缺少 LLM_API_KEY")

    state = load_state()
    if not due_since_last_run(state):
        return 0
    seen = set(state["sent"])

    posts = parse_posts(fetch_feed())
    new = [p for p in posts if p["postUrl"] not in seen]
    log(f"{len(posts)} 条在窗口内，其中 {len(new)} 条是新增")
    if not new:
        return 0

    items = merge(classify(new), new)

    if DRY_RUN:
        subject, doc = build_digest(items) if items else ("(无内容)", "<p>无内容</p>")
        PREVIEW_PATH.write_text(doc)
        log(f"[dry-run] 主题: {subject}；预览写入 {PREVIEW_PATH}；不改状态、不发信")
        return 0

    if items:
        subject, doc = build_digest(items)
        send_mail(subject, doc)

    # 投递成功后才记状态 —— 失败时这些帖子下次还会被处理，不会丢
    state["sent"].extend(p["postUrl"] for p in new)
    save_state(state)
    return 0


def main() -> int:
    try:
        return run()
    except Exception as exc:  # noqa: BLE001 - 顶层兜底，必须可见地失败
        log(f"运行失败: {type(exc).__name__}: {exc}")
        if not DRY_RUN:
            send_alert(f"{type(exc).__name__}: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
