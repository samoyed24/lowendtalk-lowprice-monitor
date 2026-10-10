# lowendtalk-lowprice-monitor

定时抓取 [LowEndTalk](https://lowendtalk.com) 的 Offers 板块，用 Workers AI 打标签并生成中文摘要，去重后把新增条目邮件推送。

跑在 **Cloudflare Worker Cron** 上：定时唤醒 → 抓取 → AI 打标 → 去重 → 发信。状态存在 KV，AI 走 Workers AI 绑定，发信走 AgentNotify（推荐）或自定义 SMTP。

---

## 目录

- [一、快速开始](#一快速开始)
- [二、配置项](#二配置项)
- [三、推送间隔](#三推送间隔)
- [四、工作方式](#四工作方式)
- [五、本地开发](#五本地开发)
- [六、常见问题](#六常见问题)
- [七、已知限制](#七已知限制)

---

## 一、快速开始

前置：Cloudflare 账号、`node >= 18`、已登录的 wrangler（`npx wrangler login`）。

```bash
git clone https://github.com/samoyed24/lowendtalk-lowprice-monitor.git
cd lowendtalk-lowprice-monitor
npm install
```

### 1. 建自己的 KV（存状态用）

```bash
npx wrangler kv namespace create LET_STATE
```

把输出的 `id` 填进 `wrangler.jsonc` 的 `kv_namespaces[0].id`。

### 2. 设 secrets（不进版本库）

推送通道至少配一个，都配则同时发送：

**通道 1 —— AgentNotify（推荐）**

```bash
npx wrangler secret put NOTIFY_KEY   # AgentNotify 控制台创建的 API Key（pck_xxx）
npx wrangler secret put NOTIFY_TO    # 收件邮箱（须与控制台验证过的地址一致）
```

> 使用前需先给该服务的 GitHub 仓库点一个 Star，否则调用返回 `403 STAR_REQUIRED`。在 [notify.portcloud.online](https://notify.portcloud.online) 用 GitHub 登录控制台，在**接收邮箱**里添加并验证地址，再在 **API Key** 里创建 Key（明文只展示一次）。
> 旧的 `PC_KEY` / `PC_TO` 仍兼容（作为 fallback 读取），新部署建议用 `NOTIFY_*`。

**通道 2 —— 自定义 SMTP**

```bash
npx wrangler secret put SMTP_USER   # 发件邮箱，如 you@qq.com
npx wrangler secret put SMTP_PASS   # 邮箱授权码（不是登录密码）
npx wrangler secret put MAIL_TO     # 收件邮箱
```

端口用 465（隐式 TLS，默认）或 587（STARTTLS）；25 被 Cloudflare 禁止出站。`SMTP_HOST` / `SMTP_PORT` 在 vars 里改，默认 `smtp.qq.com:465`。

### 3. 部署

```bash
npm run deploy
```

部署后 Cron 自动生效（默认每 30 分钟唤醒，UTC），无需在 dashboard 手动添加。首次创建或修改触发器[最多需要 15 分钟传播](https://developers.cloudflare.com/workers/configuration/cron-triggers/)，部署不会立即运行：需要等传播完成后的下一个整点或半点。在 dashboard 的 Workers → Settings → Trigger Events → View events 查看记录；新 Worker 的历史事件展示还可能延迟最多 30 分钟。`npx wrangler tail` 只看连接后的实时日志，不会补放历史调用。

## 二、配置项

### Secrets（`wrangler secret put`）

| Secret | 必填 | 说明 |
|---|---|---|
| `NOTIFY_KEY` | 通道 1 | AgentNotify API Key，形如 `pck_xxx`（兼容旧 `PC_KEY`） |
| `NOTIFY_TO` | 通道 1 | 收件邮箱（与控制台验证过的地址一致；兼容旧 `PC_TO`） |
| `SMTP_USER` | 通道 2 | 发件邮箱，如 `you@qq.com` |
| `SMTP_PASS` | 通道 2 | 邮箱授权码（不是登录密码） |
| `MAIL_TO` | 通道 2 | 收件邮箱 |

两个通道至少配一个，都配则同时发送。

### Vars（`wrangler.jsonc`，可选，都有默认值）

| Variable | 默认值 | 说明 |
|---|---|---|
| `AI_MODEL` | `@cf/qwen/qwen3-30b-a3b-fp8` | Workers AI 模型；默认 Qwen3 30B A3B，调用时追加 `/no_think`，并用 JSON Schema 约束分类输出结构 |
| `FEED_URL` | LET Offers 板块 RSS | 抓取源 |
| `FEED_PROXY` | `https://feed2json.org/convert?url={url}` | RSS 转 JSON 服务 |
| `LOOKBACK_DAYS` | `7` | 只处理最近 N 天的帖子 |
| `MAX_POSTS` | `60` | 单次送进 AI 的条数上限 |
| `CLASSIFY_BATCH_SIZE` | `1` | 单次 AI 分类的条数；完整正文默认每次 1 帖，避免多篇长文挤占上下文。调大会减少调用次数，但更容易超出模型限制 |
| `REQUIRE_SERVER_TAG` | `true` | 只推送带服务器类型标签的条目 |
| `INTERVAL_MINUTES` | `30` | 推送间隔（分钟），与 cron 保持一致 |
| `NOTIFY_URL` | `https://notify.portcloud.online` | AgentNotify API 地址（兼容旧 `PC_URL`） |
| `NOTIFY_TIMEOUT` | `60` | AgentNotify 轮询投递结果的总预算（秒），须为正整数（兼容旧 `PC_TIMEOUT`） |
| `SMTP_HOST` | `smtp.qq.com` | 自定义 SMTP 服务器 |
| `SMTP_PORT` | `465` | 465（隐式 TLS）或 587（STARTTLS）；25 被 Cloudflare 禁止 |

> **异步两段式投递**（AgentNotify）：`POST /api/v1/send` 只受理（返回 `201` + `log_id`），程序在受理后等待 1 秒，再用 `GET /api/v1/send/{log_id}` 每隔 1 秒轮询，直到 `success` / `failed` / `rejected`。受理只请求一次、**不重试发送**（重试可能重复投递）；受理后的轮询预算由 `NOTIFY_TIMEOUT`（默认 60 秒）控制。短暂查询网络错误、HTTP 429 / 5xx 会在预算内继续查询。超时或无法确认状态时，报「投递结果未知」并且不保存状态，不代表邮件一定未送达；后续运行可能再次发送未记入状态的内容，产生重复邮件，可根据报错中的 `log_id` 在控制台核对。

---

## 三、推送间隔

间隔由两处共同决定，改动时**同步改两处**：

1. `wrangler.jsonc` 的 `triggers.crons`（唤醒频率，UTC）
2. `wrangler.jsonc` 的 `INTERVAL_MINUTES`（分钟）

| 推送间隔 | `INTERVAL_MINUTES` | cron（UTC） |
|---|---|---|
| 30 分钟（默认） | `30` | `*/30 * * * *` |
| 1 小时 | `60` | `17 * * * *` |
| 4 小时 | `240` | `17 */4 * * *` |

> `INTERVAL_MINUTES` 应当 ≥ cron 的唤醒周期。

---

## 四、工作方式

```
唤醒（Worker Cron，默认 */30 * * * * UTC）
  └─ 间隔检查    距上次运行不足 INTERVAL_MINUTES（默认 30）则跳过
     └─ 抓取     FEED_PROXY 转换 RSS
        └─ 解析  时间窗口 / HTML 实体解码 / 剥离重复标题
           └─ 打标 Workers AI（env.AI）输出 tags + prices + 中文摘要
              └─ 整理 按最低月均价排序
                 └─ 去重 与 KV 状态比对，取新增
                    └─ 发信 有新增才发送（AgentNotify / 自定义 SMTP，配了几个发几个）
                       └─ 存状态（KV）
```

状态（已推送 URL + 上次运行时间）存在 `STATE` KV 里。**投递成功后**才写状态；运行失败时状态不变，这批帖子下次重新处理。任何异常都会抛给 Cron（在 Cron Events 里记为失败），并发送一封 `🚨` 开头的告警邮件。

标签体系：每条帖子会被打上一组标签，并在邮件里以徽章展示。

| 类别 | 取值 |
|---|---|
| 类型（最多一个） | `vps`、`vds`、`独服`、`存储服` |
| 网络（可多选） | `ipv4`、`ipv6`、`家宽`、`回国优化`、`CN2`、`GIA`、`BGP`、`Anycast`、`大带宽`、`不限流量` |
| 其他（可多选） | `高防`、`KVM`、`OpenVZ`、`LXC`、`Windows`、`GPU`、`独立IP`、`免费试用`、`抽奖` |

价格提取帖子里出现的所有档位（最多 5 条），按金额从低到高排列，保留原币种与计费周期。

正文读取 Feed 的 `content_text`，没有时从 `content_html` 去掉 HTML 标签；清理后的正文完整送入 AI，不再按字符数截断。它不会另外打开原帖页面：Feed 本身没提供的内容和图片里的文字仍无法据此总结。

默认每次分析 1 帖，避免多篇完整正文挤占上下文；调用次数和总耗时会比批量处理更多。默认模型的[上下文上限为 32,768 tokens](https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/)，还需为提示词和输出预留空间，因此单篇异常长文仍可能超限。本项目不自动分段；若 AI 接口报错，则按运行失败处理，而不是主动截断正文。

中文摘要要求正文信息充足时写 150–300 字，覆盖商家与机房、主要套餐的配置及对应价格、网络与 IP、优惠码、首期/续费条件及限制。信息不足时允许更短，不补猜缺失参数；实际字数和准确性仍取决于模型输出。HTML 与纯文本邮件均保留完整摘要。已推送的帖子仍按原状态去重，不会因为修改摘要而重新发送。

---

## 五、本地开发

```bash
npm test        # 单测（vitest）
npm run typecheck  # tsc --noEmit
npm run types   # 改完 wrangler.jsonc 后重新生成 Env 类型
npm run dev     # 本地启动（Workers AI 绑定走远端，会产生用量计费）
npx wrangler tail  # 看线上日志
```

> Workers AI 在本地开发时也是远端调用，会产生用量费用。

---

## 六、常见问题

**Q：跑完了但没收到邮件？**

有新增才会发信。若本次没有新帖，会静默退出（日志里是「0 条是新增」）。先看 `wrangler tail` 或 dashboard 日志确认。

**Q：想临时停掉？**

dashboard → Workers → 你的 Worker → Settings → Triggers，把 Cron Trigger 暂停即可；或直接 `npx wrangler deploy` 一个去掉 `triggers.crons` 的配置。

**Q：邮件里出现了 SSL 证书、控制面板这类内容？**

这些是 Offers 板块里混着的非服务器帖子。默认已过滤（`REQUIRE_SERVER_TAG=true`），置为 `false` 可一并推送。

**Q：从旧的 GitHub Actions 版迁移过来，状态怎么办？**

状态存的地方变了（Actions cache → KV），旧状态带不过来。首次运行会把窗口内（默认 7 天）的帖子全当新增推一次，之后恢复正常。觉得太多可以先把 `LOOKBACK_DAYS` 调小跑一次，再调回来。

**Q：AI 模型想换一个？**

改 `AI_MODEL` 为 Workers AI 目录里的文本生成模型即可。部分模型需要 Workers Paid 计划或 AI Gateway 额度。

默认 Qwen3 30B A3B 的单位 token 消耗比原来的 Llama 3.3 70B 更低，并使用 Qwen 的 [`/no_think` 软开关](https://qwenlm.github.io/blog/qwen3/) 请求非思考模式。更换模型不会重置免费额度：[每天 10,000 Neurons，UTC 零点重置](https://developers.cloudflare.com/workers-ai/platform/pricing/)。本地测试也会消耗远端额度；仅新增帖子进入 AI，但清空状态或发信失败后重跑可能重复分析。

默认 Qwen 调用使用 JSON Schema 请求完整的 `i/tags/prices/zh` 数组，并兼容接口返回的文本或已解析数组。格式约束不保证价格、配置等事实正确；若返回仍不完整或无法解析，运行会失败且不保存状态，不会截掉错误条目后记为已推送。

---

## 七、已知限制

- **抓取依赖 `feed2json.org`**：LET 前面有 Cloudflare，直连返回 403，只能经该第三方服务转换 RSS。服务不可用时抓取失败，会发告警邮件。换用可直接访问的源站时，把 `FEED_PROXY` 设为 `{url}` 即可绕过。
- **标签与价格由 AI 判定**：均可能出错，尤其是价格仅出现在图片中、或只写「联系报价」的帖子。
- **Cron 不保证精确准时**：高峰期可能延迟数分钟。
- **自定义 SMTP 走 TCP sockets**：25 端口被 Cloudflare 禁止出站，只能用 465（隐式 TLS）或 587（STARTTLS）；协议是手写的 `EHLO → AUTH LOGIN → DATA`，QQ 邮箱请用授权码。
