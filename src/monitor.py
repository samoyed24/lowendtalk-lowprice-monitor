#!/usr/bin/env python3
"""LowEndTalk 低价 VPS 监控。

抓取 LET 的 Offers 板块 → AI 分类与中文摘要 → 按价格规则筛选 →
去重后把新增条目邮件推送。

设计上刻意规避了之前 n8n 版本踩过的坑：
  * 模型名从 /v1/models 动态解析（网关 10 天内改过 3 次名）
  * 去重放在投递成功之后（失败不会把帖子误标为已发送）
  * 任何异常都非零退出并发告警邮件（不再静默失败）
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

FEED_URL = "https://lowendtalk.com/categories/offers/feed.rss"
# LET 前面挡着 Cloudflare，直连会被 403，走这个转换服务拿 JSON Feed
FEED_PROXY = "https://feed2json.org/convert?url={url}"

MODEL_WANT = "deepseek-v4.1-flash"
# 网关会同时挂出 cc/ wb/ ve/ 等多个同名模型，优先用 cc/ 通道
MODEL_PREFERRED_PREFIX = "cc/"

# 价格规则：VPS 折合年费 ≤ $15，独立服务器折合月费 ≤ $50
RULES = {
    "vps": {"basis": "year", "limit": 15},
    "dedi": {"basis": "month", "limit": 50},
}
# 各计费周期折算到比较基准的系数
TO_BASIS = {
    "year": {"month": 12, "quarter": 4, "year": 1},
    "month": {"month": 1, "quarter": 1 / 3, "year": 1 / 12},
}

LOOKBACK_DAYS = 7
MAX_POSTS = 60          # 单次送进 AI 的条数上限，约束首次运行的规模
# 状态单独放一个目录，和预览文件分开 —— 预览不该进状态缓存，
# 否则 dry-run 会覆盖掉真实状态，导致下次把窗口内帖子全部重发。
STATE_PATH = Path(".state/sent.json")
PREVIEW_PATH = Path("preview.html")
STATE_MAX = 5000        # 状态文件里保留的 URL 上限
UA = "lowendtalk-lowprice-monitor/1.0 (+https://github.com/samoyed24)"

TZ = "Asia/Shanghai"

LITELLM_BASE_URL = os.environ.get("LITELLM_BASE_URL", "https://litellm.portcloud.online")
LITELLM_TOKEN = os.environ.get("LITELLM_TOKEN", "")
SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.qq.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "465"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "")
MAIL_TO = os.environ.get("MAIL_TO", "")

DRY_RUN = "--dry-run" in sys.argv


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
    price_re = re.compile(
        r"(?:US)?\$\s?\d+(?:[.,]\d+)?(?:\s?/\s?(?:mo|month|yr|year|quarter|qtr))?", re.I
    )
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
            "prices": " / ".join(dict.fromkeys(price_re.findall(body)))[:120],
        })

    posts.sort(key=lambda p: p["date"], reverse=True)
    return posts[:MAX_POSTS]


# ---------------------------------------------------------------- AI

def litellm_headers() -> dict:
    return {
        "x-api-key": LITELLM_TOKEN,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "User-Agent": UA,
    }


def resolve_model() -> str:
    """从 /v1/models 解析出当前可用的模型 id。

    网关改过三次命名（deepseek/deepseek-v4.1-flash → deepseek-v4.1-flash
    → cc/deepseek-v4.1-flash），硬编码必然失效，所以每次运行都问一次。
    """
    r = requests.get(f"{LITELLM_BASE_URL}/v1/models", headers=litellm_headers(), timeout=60)
    r.raise_for_status()
    ids = [m.get("id", "") for m in r.json().get("data", []) if m.get("id")]

    for cand in (
        MODEL_PREFERRED_PREFIX + MODEL_WANT,
        MODEL_WANT,
    ):
        if cand in ids:
            log(f"模型: {cand}")
            return cand
    suffix = [i for i in ids if i.endswith("/" + MODEL_WANT)]
    if suffix:
        log(f"模型: {suffix[0]}（后缀匹配）")
        return suffix[0]
    raise RuntimeError(f"网关没有 {MODEL_WANT}；可用: {', '.join(sorted(ids))[:400]}")


SYSTEM_PROMPT = "\n".join([
    "你是 VPS / 独立服务器优惠分析师。用户只关心超低价机器。",
    "判定规则（严格执行）：",
    "1. kind：vps = VPS/虚拟服务器/KVM/OpenVZ/LXC/云主机；"
    "dedi = 独立服务器/裸金属/整机租用；"
    "other = 其他（虚拟主机、代理IP、软件许可证、机柜托管、域名/SSL、CDN、游戏服、邮箱托管等）。",
    "2. price / period：提取该帖子促销的【最低价档】。"
    "period 只能是 month | year | quarter | one-time | unknown。price 只填数字，无法确定填 null。",
    "3. zh：中文摘要，40 字以内，说清「什么机器 + 什么配置 + 什么价位」。",
    "4. 只输出 JSON 数组，不要解释文字，不要 markdown 代码块。",
    '格式：[{"i":序号,"kind":"vps|dedi|other","price":数字或null,"period":"...","zh":"..."}]',
])


def classify(posts: list[dict], model: str) -> list[dict]:
    payload = [
        {"i": i, "title": p["title"][:200], "body": p["body"][:700]}
        for i, p in enumerate(posts)
    ]
    body = {
        "model": model,
        "max_tokens": 8000,
        "temperature": 0,
        "system": SYSTEM_PROMPT,
        "messages": [{
            "role": "user",
            "content": "分析以下 LowEndTalk Offers 帖子：\n" + json.dumps(payload, ensure_ascii=False),
        }],
    }

    last = None
    for attempt in range(1, 4):
        try:
            r = requests.post(
                f"{LITELLM_BASE_URL}/v1/messages",
                headers=litellm_headers(),
                json=body,
                timeout=300,
            )
            if r.status_code >= 400:
                raise RuntimeError(f"HTTP {r.status_code}: {r.text[:300]}")
            data = r.json()
            text = "".join(c.get("text", "") for c in data.get("content", []))
            m = re.search(r"\[[\s\S]*\]", text)
            if not m:
                raise RuntimeError(f"响应里没有 JSON 数组: {text[:200]}")
            verdicts = json.loads(m.group(0))
            log(f"AI 判定 {len(verdicts)} 条（{data.get('usage', {})}）")
            return verdicts
        except Exception as exc:  # noqa: BLE001
            last = exc
            log(f"  AI 调用失败 ({attempt}/3): {type(exc).__name__}: {str(exc)[:200]}")
            if attempt < 3:
                time.sleep(5 * attempt)

    raise RuntimeError(f"AI 分类失败: {last}")


# ---------------------------------------------------------------- 规则

def apply_rules(verdicts: list[dict], posts: list[dict]) -> list[dict]:
    kept = []
    for v in verdicts:
        idx = v.get("i")
        if not isinstance(idx, int) or not (0 <= idx < len(posts)):
            continue
        post = posts[idx]
        kind = str(v.get("kind") or "other").lower()
        period = str(v.get("period") or "unknown").lower()
        price = v.get("price")
        try:
            price = float(price) if price is not None else None
        except (TypeError, ValueError):
            price = None

        rule = RULES.get(kind)
        basis_val = None
        unknown = False
        period_unknown = False
        cmp_text = ""

        if kind == "other" or not rule:
            continue
        conv = TO_BASIS[rule["basis"]].get(period)
        if price is None:
            unknown = True          # 完全读不出价格 —— 保留但标注
            cmp_text = "价格待确认"
        elif conv is None:
            # 价格读到了但周期读不出，无法折算，同样保留待人工确认
            period_unknown = True
            cmp_text = f"${price:g}（周期未知）"
        else:
            basis_val = price * conv
            unit = "年" if rule["basis"] == "year" else "月"
            cmp_text = f"${basis_val:g}/{unit}"
            if basis_val > rule["limit"]:
                continue

        kept.append({
            **post,
            "kind": kind,
            "price": price,
            "period": period,
            "basisVal": basis_val,
            "unknown": unknown or period_unknown,
            "cmpText": cmp_text,
            "priceText": "" if price is None else f"${price:g}" + {
                "month": "/月", "year": "/年", "quarter": "/季", "one-time": " 一次性",
            }.get(period, ""),
            "zh": str(v.get("zh") or ""),
        })

    # 有价的按价格升序，价格待确认的排后面按时间倒序
    kept.sort(key=lambda x: (x["unknown"], x["basisVal"] if x["basisVal"] is not None else 0))
    log(f"规则筛选后保留 {len(kept)} 条")
    return kept


# ---------------------------------------------------------------- 输出

LABEL = {"vps": "VPS", "dedi": "独服", "other": "其他"}
COLOR = {"vps": "#1a56db", "dedi": "#9a3412", "other": "#6b7280"}


def fmt_date(raw: str) -> str:
    if not raw:
        return ""
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return dt.astimezone(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return raw[:16]


def build_digest(items: list[dict]) -> tuple[str, str]:
    def esc(s):
        return html.escape(str(s or ""), quote=True)

    rows = []
    for x in items:
        if x["unknown"]:
            price_html = '<span style="color:#b45309;font-weight:700">价格待确认</span>'
        else:
            price_html = f'<span style="color:#0a7d32;font-weight:700">{esc(x["cmpText"])}</span>'
            if x["priceText"] and x["priceText"] != x["cmpText"]:
                price_html += f' <span style="color:#9ca3af">（原报价 {esc(x["priceText"])}）</span>'
        rows.append(f"""
  <div style="padding:13px 0;border-bottom:1px solid #ececec">
    <div style="margin-bottom:5px">
      <span style="display:inline-block;font-size:11px;font-weight:700;color:#fff;
                   background:{COLOR.get(x['kind'], '#666')};border-radius:3px;
                   padding:1px 6px;margin-right:7px;vertical-align:1px">{LABEL.get(x['kind'], x['kind'])}</span>
      <a href="{esc(x['postUrl'])}" style="font-size:15px;font-weight:600;color:#1a56db;
         text-decoration:none">{esc(x['title'])}</a>
    </div>
    <div style="font-size:12px;color:#8a8a8a;margin-bottom:6px">
      {esc(x['author'])}{' · ' if x['author'] else ''}{esc(fmt_date(x['date']))} · {price_html}
    </div>
    <div style="font-size:13px;color:#333;line-height:1.55">{esc(x['zh'])}</div>
  </div>""")

    n_vps = sum(1 for x in items if x["kind"] == "vps")
    n_dedi = sum(1 for x in items if x["kind"] == "dedi")
    now = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")

    doc = f"""<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;max-width:700px">
  <h2 style="margin:0 0 5px;font-size:19px">LowEndTalk 低价 VPS 汇总</h2>
  <div style="color:#8a8a8a;font-size:12px;margin-bottom:4px">
    新增 <b>{len(items)}</b> 条（VPS {n_vps} · 独服 {n_dedi}） · 抓取时间 {now}
  </div>
  <div style="color:#b0b0b0;font-size:11px;margin-bottom:16px">
    筛选规则：VPS 折合年费 ≤ $15 ／ 独立服务器折合月费 ≤ $50 · AI 判定分类与中文摘要
  </div>
  {''.join(rows)}
  <div style="margin-top:18px;font-size:11px;color:#b0b0b0">
    来源 LowEndTalk › Offers 板块 · 每 4 小时自动抓取去重
  </div>
</div>"""

    subject = (f"[LET] 低价VPS {len(items)} 条 · VPS {n_vps} / 独服 {n_dedi} · "
               f"{datetime.now(timezone(timedelta(hours=8))):%Y-%m-%d}")
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
    """失败时告警。刻意用不同主题，方便邮箱里一眼区分。"""
    try:
        send_mail(
            "🚨 LET 监控运行失败",
            f"""<div style="font-family:monospace;font-size:13px">
  <p><b>LowEndTalk 监控本次运行失败</b></p>
  <p style="color:#b91c1c;white-space:pre-wrap">{html.escape(error[:2000])}</p>
  <p style="color:#6b7280">时间：{datetime.now(timezone(timedelta(hours=8))):%Y-%m-%d %H:%M} (CST)</p>
</div>""",
        )
    except Exception as exc:  # noqa: BLE001 - 告警本身失败不应掩盖原始错误
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
        "updated": datetime.now(timezone.utc).isoformat(),
    }, ensure_ascii=False))
    log(f"状态已保存（累计 {len(sent)} 条已推送）")


# ---------------------------------------------------------------- 主流程

def run() -> int:
    if not LITELLM_TOKEN:
        raise RuntimeError("缺少 LITELLM_TOKEN")

    state = load_state()
    seen = set(state["sent"])

    posts = parse_posts(fetch_feed())
    new = [p for p in posts if p["postUrl"] not in seen]
    log(f"{len(posts)} 条在窗口内，其中 {len(new)} 条是新增")
    if not new:
        return 0

    model = resolve_model()
    verdicts = classify(new, model)
    if not verdicts:
        raise RuntimeError(f"有 {len(new)} 条待分类但 AI 没给出任何判定")
    kept = apply_rules(verdicts, new)

    if DRY_RUN:
        subject, doc = build_digest(kept) if kept else ("(无匹配)", "<p>无匹配条目</p>")
        PREVIEW_PATH.write_text(doc)
        log(f"[dry-run] 主题: {subject}；预览写入 {PREVIEW_PATH}；不改状态、不发信")
        return 0

    if kept:
        subject, doc = build_digest(kept)
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
