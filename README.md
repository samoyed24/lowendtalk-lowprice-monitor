# LowEndTalk 低价 VPS 监控

每 4 小时抓取 [LowEndTalk](https://lowendtalk.com) 的 Offers 板块，用 AI 判定类型并生成中文摘要，
按价格规则筛选后，把**新增**条目邮件推送。

## 筛选规则

| 类型 | 规则 |
|---|---|
| VPS | 折合年费 ≤ $15 |
| 独立服务器 | 折合月费 ≤ $50 |
| 其他（虚拟主机 / 代理IP / 许可证 / 机柜托管等） | 排除 |

月付、季付会折算到比较基准后再比。AI 读不出价格的条目会保留，并在邮件里标「价格待确认」。

## 工作方式

```
cron (每 4 小时)
  └─ Resolve Model      从 /v1/models 动态解析模型 id
     └─ Fetch Feed      feed2json.org 转换 LET RSS（直连被 Cloudflare 403）
        └─ Parse        7 天窗口 / HTML 实体解码 / 剥离重复标题
           └─ Classify  AI 判定 kind + 最低价档 + 中文摘要
              └─ Rules  折算后比对阈值
                 └─ Dedupe  与 .cache/sent.json 比对，取新增
                    └─ Mail  有新增才发信
                       └─ Save State  投递成功后才记录
```

三个刻意的设计选择，都是踩过坑换来的：

- **模型名动态解析** —— 网关 10 天内把同一个模型改了 3 次名
  （`deepseek/deepseek-v4.1-flash` → `deepseek-v4.1-flash` → `cc/deepseek-v4.1-flash`），
  硬编码必然失效。
- **去重放在投递之后** —— 之前 n8n 版本把去重放在 AI 调用之前，
  结果 AI 认证失效的 6 次运行把 14 条帖子标记成「已发送」却从未投递，永久丢失。
- **失败要吵** —— 任何异常都非零退出 + 发一封 `🚨` 告警邮件。
  之前的版本静默失败了 8 天才被发现。

## 配置

需要在仓库里设置这些 secrets（Settings → Secrets and variables → Actions）：

| Secret | 说明 |
|---|---|
| `LITELLM_TOKEN` | LiteLLM 网关的 API key |
| `SMTP_USER` | 发信邮箱，如 `you@qq.com` |
| `SMTP_PASS` | SMTP 授权码（**不是**登录密码） |
| `MAIL_TO` | 收件地址 |

可选的 variables（同名会覆盖默认值）：

| Variable | 默认值 |
|---|---|
| `LITELLM_BASE_URL` | `https://litellm.portcloud.online` |
| `SMTP_HOST` | `smtp.qq.com` |
| `SMTP_PORT` | `465` |

## 手动运行

Actions → LET Low-Price Monitor → Run workflow，勾选 `dry_run` 可以只预览不发信
（结果作为 artifact 上传）。

本地跑：

```bash
pip install -r requirements.txt
export LITELLM_TOKEN=... SMTP_USER=... SMTP_PASS=... MAIL_TO=...
python src/monitor.py --dry-run     # 预览写到 .cache/preview.html
python src/monitor.py               # 真发
```

## 已知限制

- **抓取依赖 `feed2json.org`** —— LET 前面有 Cloudflare，直连 403。
  这个第三方服务挂了就抓不到（会发告警邮件，不会静默）。
- **状态存在 Actions cache 里** —— cache 超过 7 天未访问会被清理。
  因为每 4 小时跑一次，正常不会触发；但如果仓库长期停用后再启用，
  可能会把窗口内的帖子重发一遍。
- **AI 判定是启发式的** —— 分类和价格提取都可能出错，尤其是价格写在图片里
  或只写「联系报价」的帖子。
