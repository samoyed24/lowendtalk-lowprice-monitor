# lowendtalk-lowprice-monitor

定时抓取 [LowEndTalk](https://lowendtalk.com) 的 Offers 板块，用 AI 打标签并生成中文摘要，
去重后把新增条目邮件推送。

后端不限厂商 —— 兼容 OpenAI Chat Completions、OpenAI Responses、
Anthropic Messages 三种接口格式的服务都可以接。

---

## 目录

- [一、快速开始](#一快速开始)
  - [1. Fork 本仓库](#1-fork-本仓库)
  - [2. 启用 Actions（关键，容易漏）](#2-启用-actions关键容易漏)
  - [3. 配置 Secrets](#3-配置-secrets)
  - [4. 手动触发一次](#4-手动触发一次)
  - [5. 调整推送间隔](#5-调整推送间隔)
- [二、本地运行](#二本地运行)
- [三、配置项](#三配置项)
- [四、标签](#四标签)
- [五、工作方式](#五工作方式)
- [六、常见问题](#六常见问题)
- [七、已知限制](#七已知限制)

---

## 一、快速开始

### 1. Fork 本仓库

点本仓库右上角的 **Fork**，把它复制到你自己的账号下。

> **为什么必须 Fork？**
> 定时任务需要读取 secrets，而 secrets 只能配置在**你自己拥有写权限的仓库**里。

### 2. 启用 Actions（关键，容易漏）

Fork 之后，GitHub **默认不运行 fork 仓库里的 workflow**，定时任务不会执行。

进入你 fork 出来的仓库，点 **Actions** 标签页，点击
**I understand my workflows, go ahead and enable them**。

若顶部出现黄色横幅，点右侧 **Enable workflow**。

> 这是 GitHub 的官方行为：*"Workflows don't run in forked repositories by default."*
> 参考 [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)。

### 3. 配置 Secrets

进入**你 fork 的仓库**，点 **Settings → Secrets and variables → Actions**。

#### 模型服务（必填）

| Secret | 说明 |
|---|---|
| `LLM_API_KEY` | 模型服务的 API key |

模型地址与名称在 Variables 标签页配置，见[三、配置项](#三配置项)。

#### 推送通道（至少配一个）

**通道 1 —— Portcloud Notify（推荐）**

自己配 SMTP 比较麻烦（要开服务、申请授权码、处理各服务商的限制），
建议直接用这个现成的托管服务。免费，几步就能用起来。

> **使用前需要先给该服务的 GitHub 仓库点一个 Star** ——
> 服务端会校验你的 GitHub 账号是否已 Star，否则调用返回 `403 STAR_REQUIRED`。
> 登录控制台后页面会提示并给出仓库链接。

**1.** 用 GitHub 登录 [notify.portcloud.online](https://notify.portcloud.online) 控制台

**2.** 在 **接收邮箱** 中添加收件邮箱并完成验证（只有验证过的地址才能收信）

**3.** 在 **API Key** 中创建 Key —— 明文**只展示一次**，请立即复制保存

**4.** 填入以下 secrets：

| Secret | 说明 |
|---|---|
| `PC_KEY` | API Key，形如 `pck_xxx` |
| `PC_TO` | 收件邮箱（须与上一步验证过的地址一致） |

邮件以 `multipart/alternative` 发送（同时带 HTML 与纯文本正文），
由客户端选择展示版本。

**通道 2 —— SMTP 邮件**

适合已有邮箱、且不想依赖第三方服务的场景。需**同时配置**下面三项：

| Secret | 说明 |
|---|---|
| `SMTP_USER` | 发件邮箱，如 `you@qq.com` |
| `SMTP_PASS` | 邮箱**授权码**（不是登录密码） |
| `MAIL_TO` | 收件邮箱 |

> 两个通道都配置时会**同时发送**。只配一个也可以。

### 4. 手动触发一次

Actions → LET Low-Price Monitor → **Run workflow**。

- **`dry_run`** —— 只抓取预览，不发信也不改状态，结果作为 artifact 上传。
  建议先跑这个确认配置无误。
- **`force`**（默认勾选）—— 忽略时间间隔立即执行。

### 5. 调整推送间隔

间隔**写死在代码里**，不通过 Variables 配置。默认每小时一次，要改需同步两处：

1. `src/monitor.py` 的 `INTERVAL_MINUTES`（分钟）
2. `.github/workflows/monitor.yml` 的 `cron`（唤醒频率）

| 推送间隔 | `INTERVAL_MINUTES` | cron |
|---|---|---|
| 30 分钟 | `30` | `*/30 * * * *` |
| 1 小时（默认） | `60` | `0 * * * *` |
| 4 小时 | `240` | `0 0,4,8,12,16,20 * * *` |

> `INTERVAL_MINUTES` 应当 ≥ cron 的唤醒周期，否则会有部分唤醒被浪费。

---

## 二、本地运行

```bash
pip install -r requirements.txt

export LLM_API_KEY=... LLM_BASE_URL=... LLM_MODEL=...
export PC_KEY=... PC_TO=...          # 或 SMTP_USER / SMTP_PASS / MAIL_TO

python src/monitor.py --dry-run      # 预览写入 preview.html，不发信、不改状态
python src/monitor.py --force        # 忽略间隔，立即执行
python src/monitor.py                # 正常执行（受间隔约束，默认 60 分钟）
```

> **验证配置时请一律用 `--dry-run`。** 真实运行会写状态文件，
> 而删掉状态文件会让窗口内的帖子重新变成「新增」，导致重复发信。

---

## 三、配置项

### Secrets

见[配置 Secrets](#3-配置-secrets)。此外：

| Secret | 默认 | 说明 |
|---|---|---|
| `SMTP_HOST` | `smtp.qq.com` | 也可配在 Variables |

### Variables

在 **Settings → Secrets and variables → Actions → Variables** 设置，全部可选：

| Variable | 默认值 | 说明 |
|---|---|---|
| `LLM_BASE_URL` | `https://litellm.portcloud.online/v1` | 接口地址 |
| `LLM_MODEL` | `cc/deepseek-v4.1-flash` | 模型名 |
| `LLM_API_FORMAT` | `chat_completions` | 接口格式，见下 |
| `PC_URL` | `https://notify.portcloud.online` | Portcloud API 地址 |
| `SMTP_HOST` | `smtp.qq.com` | |
| `SMTP_PORT` | `465` | |
| `FEED_URL` | LET Offers 板块 RSS | 抓取源 |
| `FEED_PROXY` | `https://feed2json.org/convert?url={url}` | RSS 转 JSON 服务 |
| `LOOKBACK_DAYS` | `7` | 只处理最近 N 天的帖子 |
| `MAX_POSTS` | `60` | 单次送进 AI 的条数上限 |
| `REQUIRE_SERVER_TAG` | `true` | 只推送带服务器类型标签的条目 |

### 切换模型服务

`LLM_API_FORMAT` 支持三种接口格式：

| 取值 | 请求路径 | 认证头 |
|---|---|---|
| `chat_completions` | `/chat/completions` | `Authorization: Bearer` |
| `responses` | `/responses` | `Authorization: Bearer` |
| `anthropic` | `/messages` | `x-api-key` + `anthropic-version` |

常见组合：

| 服务 | `LLM_BASE_URL` | `LLM_MODEL` | `LLM_API_FORMAT` |
|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | `chat_completions` |
| OpenAI（新接口） | `https://api.openai.com/v1` | `gpt-4o-mini` | `responses` |
| Anthropic | `https://api.anthropic.com/v1` | `claude-sonnet-5` | `anthropic` |
| Ollama | `http://localhost:11434/v1` | `qwen2.5:14b` | `chat_completions` |
| LiteLLM 等网关 | 网关地址 | 网关侧模型名 | 按网关支持的格式 |

---

## 四、标签

每条帖子会被打上一组标签，并在邮件里以徽章展示。

| 类别 | 取值 |
|---|---|
| 类型（最多一个） | `vps`、`vds`、`独服`、`存储服` |
| 网络（可多选） | `ipv4`、`ipv6`、`家宽`、`回国优化`、`CN2`、`GIA`、`BGP`、`Anycast`、`大带宽`、`不限流量` |
| 其他（可多选） | `高防`、`KVM`、`OpenVZ`、`LXC`、`Windows`、`GPU`、`独立IP`、`免费试用`、`抽奖` |

帖子若同时涉及多种机型（如既卖 VPS 又卖独服），会同时打上多个类型标签。

价格会提取帖子里出现的**所有档位**（最多 5 条），按金额从低到高排列，保留原币种与计费周期。

---

## 五、工作方式

```
唤醒（cron）
  └─ 间隔检查    距上次运行不足 INTERVAL_MINUTES（默认 60）则跳过
     └─ 抓取     FEED_PROXY 转换 RSS
        └─ 解析  时间窗口 / HTML 实体解码 / 剥离重复标题
           └─ 打标 AI 输出 tags + prices + 中文摘要
              └─ 整理 按最低月均价排序
                 └─ 去重 与状态文件比对，取新增
                    └─ 发信 有新增才发送
                       └─ 存状态
```

状态在**投递成功后**才写入。运行失败时状态不变，这批帖子会在下次运行重新处理。
任何异常都会以非零码退出，并发送一封 `🚨` 开头的告警邮件。

---

## 六、常见问题

**Q：跑完了但没收到邮件？**

有新增才会发信。若本次没有新帖，会静默退出（日志里是「0 条是新增」）。
先看 Actions 的运行日志确认。

**Q：想临时停掉，但不想删 secrets？**

Actions → 选中 workflow → 右上角 **⋯ → Disable workflow**。

**Q：邮件里出现了 SSL 证书、控制面板这类内容？**

这些是 Offers 板块里混着的非服务器帖子。默认已过滤
（`REQUIRE_SERVER_TAG=true`），置为 `false` 可一并推送。

**Q：上游有更新，怎么同步到我的 fork？**

在 fork 的仓库页面点 **Sync fork → Update branch**。

---

## 七、已知限制

- **抓取依赖 `feed2json.org`**：LET 前面有 Cloudflare，直连返回 403，
  只能经该第三方服务转换 RSS。服务不可用时抓取失败，会发告警邮件。
  换用可直接访问的源站时，把 `FEED_PROXY` 设为 `{url}` 即可绕过。
- **状态存在 Actions cache 中**：cache 超过 7 天未被访问会被清理。
  正常运行不会触发；若仓库长期停用后重新启用，窗口内的帖子可能被重复推送一次。
- **标签与价格由 AI 判定**：均可能出错，尤其是价格仅出现在图片中、
  或只写「联系报价」的帖子。
- **GitHub Actions 的定时任务不保证准时**：高峰期可能延迟数分钟到数十分钟。
