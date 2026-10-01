# LowEndTalk 低价 VPS 监控

定时抓取 [LowEndTalk](https://lowendtalk.com) 的 Offers 板块，用 AI 打标签并生成中文摘要，
去重后把新增条目邮件推送。

后端不限厂商 —— 任何兼容 OpenAI `/v1/chat/completions` 的服务都可以接。

## 标签

每条帖子会被打上一组标签，并在邮件里以徽章展示。

| 类别 | 取值 |
|---|---|
| 类型（最多一个） | `vps`、`vds`、`独服`、`存储服` |
| 网络（可多选） | `ipv4`、`ipv6`、`家宽`、`回国优化`、`CN2`、`GIA`、`BGP`、`Anycast`、`大带宽`、`不限流量` |
| 其他（可多选） | `高防`、`KVM`、`OpenVZ`、`LXC`、`Windows`、`GPU`、`独立IP`、`免费试用`、`抽奖` |

帖子若同时涉及多种机型（如既卖 VPS 又卖独服），会同时打上多个类型标签。

价格会提取帖子里出现的**所有档位**（最多 5 条），按金额从低到高排列，保留原币种与计费周期。

## 工作方式

```
唤醒（cron）
  └─ 间隔检查    距上次运行不足 INTERVAL_MINUTES 则跳过
     └─ 抓取     feed2json.org 转换 RSS
        └─ 解析  时间窗口 / HTML 实体解码 / 剥离重复标题
           └─ 打标 AI 输出 tags + prices + 中文摘要
              └─ 整理 按最低月均价排序
                 └─ 去重 与 .state/sent.json 比对，取新增
                    └─ 发信 有新增才发送
                       └─ 存状态
```

状态在**投递成功后**才写入。运行失败时状态不变，这批帖子会在下次运行重新处理。
任何异常都会以非零码退出，并发送一封 `🚨` 开头的告警邮件。

## 配置

### Secrets

在仓库 Settings → Secrets and variables → Actions → Secrets 中设置：

| Secret | 说明 |
|---|---|
| `LLM_API_KEY` | 模型服务的 API key |
| `SMTP_USER` | 发信邮箱，如 `you@qq.com` |
| `SMTP_PASS` | SMTP 授权码（**不是**登录密码） |
| `MAIL_TO` | 收件地址 |

### Variables

在同一个页面的 Variables 标签页设置，全部可选：

| Variable | 默认值 | 说明 |
|---|---|---|
| `LLM_BASE_URL` | `https://litellm.portcloud.online/v1` | 兼容 OpenAI 格式的接口地址 |
| `LLM_MODEL` | `cc/deepseek-v4.1-flash` | 模型名 |
| `INTERVAL_MINUTES` | `30` | 推送间隔（分钟） |
| `SMTP_HOST` | `smtp.qq.com` | |
| `SMTP_PORT` | `465` | |
| `FEED_URL` | LET Offers 板块 RSS | 抓取源 |
| `LOOKBACK_DAYS` | `7` | 只处理最近 N 天的帖子 |
| `MAX_POSTS` | `60` | 单次送进 AI 的条数上限 |
| `REQUIRE_SERVER_TAG` | `true` | 只推送带服务器类型标签的条目；置 `false` 则 SSL 证书、控制面板等也推送 |

### 切换模型服务

把 `LLM_BASE_URL` 和 `LLM_MODEL` 换成目标服务的值即可，例如：

```
LLM_BASE_URL = https://api.openai.com/v1
LLM_MODEL    = gpt-4o-mini
```

或自建服务：

```
LLM_BASE_URL = http://localhost:11434/v1
LLM_MODEL    = qwen2.5:14b
```

### 调整推送间隔

**GitHub Actions 的 cron 不支持变量**，所以要改两处：

1. `.github/workflows/monitor.yml` 里的 `cron` —— 决定唤醒频率
2. `INTERVAL_MINUTES` —— 决定实际推送间隔

`INTERVAL_MINUTES` 应当 ≥ cron 的唤醒周期，否则会有部分唤醒被浪费。常见组合：

| 推送间隔 | cron |
|---|---|
| 30 分钟 | `*/30 * * * *` |
| 1 小时 | `0 * * * *` |
| 4 小时 | `0 0,4,8,12,16,20 * * *` |

## 运行

**定时**：由 cron 唤醒，实际是否执行取决于 `INTERVAL_MINUTES`。

**手动**：Actions → LET Low-Price Monitor → Run workflow。

- 勾选 `dry_run` —— 只抓取预览，不发信也不改状态，结果作为 artifact 上传
- 勾选 `force`（默认勾选）—— 忽略时间间隔立即执行

**本地**：

```bash
pip install -r requirements.txt
export LLM_API_KEY=... LLM_BASE_URL=... LLM_MODEL=...
export SMTP_USER=... SMTP_PASS=... MAIL_TO=...

python src/monitor.py --dry-run   # 预览写入 preview.html
python src/monitor.py --force     # 忽略间隔，立即执行
python src/monitor.py             # 正常执行
```

## 已知限制

- **抓取依赖 `feed2json.org`**：LET 前面有 Cloudflare，直连返回 403，
  只能经该第三方服务转换 RSS。服务不可用时抓取失败，会发告警邮件。
  换用可直接访问的源站时，把 `FEED_PROXY` 设为 `{url}` 即可绕过。
- **状态存在 Actions cache 中**：cache 超过 7 天未被访问会被清理。
  正常运行不会触发；若仓库长期停用后重新启用，窗口内的帖子可能被重复推送一次。
- **标签与价格由 AI 判定**：均可能出错，尤其是价格仅出现在图片中、
  或只写「联系报价」的帖子。
