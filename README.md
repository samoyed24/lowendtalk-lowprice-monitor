# LowEndTalk 低价 VPS 监控

每 4 小时抓取 [LowEndTalk](https://lowendtalk.com) 的 Offers 板块，用 AI 判定类型并生成中文摘要，
按价格规则筛选后，把**新增**条目邮件推送。

## 筛选规则

| 类型 | 规则 |
|---|---|
| VPS | 折合年费 ≤ $15 |
| 独立服务器 | 折合月费 ≤ $50 |
| 其他（虚拟主机 / 代理 IP / 许可证 / 机柜托管等） | 排除 |

月付、季付会先折算到比较基准再比对。价格或计费周期无法识别的条目予以保留，并在邮件中标注。

## 工作方式

```
cron (每 4 小时)
  └─ 解析模型      GET /v1/models，取当前可用的模型 id
     └─ 抓取       feed2json.org 转换 LET 的 RSS
        └─ 解析    7 天窗口 / HTML 实体解码 / 剥离重复标题
           └─ 分类 AI 判定类型、最低价档、生成中文摘要
              └─ 筛选  折算后比对阈值
                 └─ 去重  与 .state/sent.json 比对，取新增
                    └─ 发信  有新增才发送
                       └─ 存状态
```

状态在**投递成功后**才写入。运行失败时状态不变，这批帖子会在下次运行重新处理。
任何异常都会以非零码退出，并发送一封 `🚨` 开头的告警邮件。

## 配置

在仓库 Settings → Secrets and variables → Actions 中设置：

| Secret | 说明 |
|---|---|
| `LITELLM_TOKEN` | LiteLLM 网关的 API key |
| `SMTP_USER` | 发信邮箱，如 `you@qq.com` |
| `SMTP_PASS` | SMTP 授权码（**不是**登录密码） |
| `MAIL_TO` | 收件地址 |

可选 variables，不设则用默认值：

| Variable | 默认值 |
|---|---|
| `LITELLM_BASE_URL` | `https://litellm.portcloud.online` |
| `SMTP_HOST` | `smtp.qq.com` |
| `SMTP_PORT` | `465` |

## 运行

**定时**：每 4 小时自动执行（UTC 00/04/08/12/16/20，即北京时间 08/12/16/20/00/04）。

**手动**：Actions → LET Low-Price Monitor → Run workflow。
勾选 `dry_run` 则只抓取预览，不发信也不改状态，结果作为 artifact 上传。

**本地**：

```bash
pip install -r requirements.txt
export LITELLM_TOKEN=... SMTP_USER=... SMTP_PASS=... MAIL_TO=...
python src/monitor.py --dry-run     # 预览写入 preview.html
python src/monitor.py               # 实际发送
```

## 已知限制

- **抓取依赖 `feed2json.org`**：LET 前面有 Cloudflare，直连返回 403，
  只能经该第三方服务转换 RSS。服务不可用时抓取失败，会发告警邮件。
- **状态存在 Actions cache 中**：cache 超过 7 天未被访问会被清理。
  每 4 小时运行一次的情况下不会触发；若仓库长期停用后重新启用，
  窗口内的帖子可能被重复推送一次。
- **AI 判定是启发式的**：类型分类与价格提取均可能出错，
  尤其是价格仅出现在图片中、或只写「联系报价」的帖子。
