# 全托数据刷新排班

业务时区固定为 `Asia/Shanghai`。实时销售、Webhook、首页经营 WebAPI 与 D-1 日更按
事实域独立终态：任何一个来源失败都不能回滚另一个来源已经验证并落库的数据。

## 固定时间表

| 时间 | 任务 | 数据边界 |
| --- | --- | --- |
| 每小时 `:02` | `shein-fm-home-realtime` | 加密 Cookie 会话 HTTP，一次刷新 25 店当天店铺经营与货号销量；不启动 Chrome |
| 每小时 `:05` | `shein-fm-sales-sync` | OpenAPI 销售快照；核心 API 车道，不等待浏览器或物化 |
| `00:30` | `shein-fm-session-renewal` | 25 店 HTTP 健康/续期；只把失效店写入恢复队列 |
| 每小时 `:18` | `shein-fm-session-recovery` | 仅队列非空时逐店打开 Profile，利用已保存密码恢复并重新导出加密会话 |
| `02:20` | `shein-fm-supply-sync` | OpenAPI 商品、采购和交付日更 |
| `03:15` | `shein-fm-home-finance-daily` | D-8 至 D-2 财务滚动重读 |
| `03:45/04:15/04:45/05:15/05:45` | `shein-fm-home-daily` | Session HTTP 五个固定五店批次，重读 D-2/D-1 |
| `06:15` | `shein-fm-home-daily-retry` | 按 marker 只补缺店、缺日、缺数据域 |
| 每周日 `00:15` | `shein-fm-db-backup` | 每周一份完整 dump，保留最近两周 |
| 每月首个周日 `01:15` | `shein-fm-db-restore-test` | 用最新 weekly/deploy dump 做真实临时库恢复 |
| 事实变化时 | Dashboard 物化 | `.path` 立即唤醒；每 10 分钟只作压力延期后的兜底 |

高频任务全部 `Persistent=false`。首页经营数据和 OpenAPI 销售各有一个 API 令牌，可在
资源健康时并行；它们不再拿浏览器锁。只有首次会话导出或某一家登录失效时才启动该店
Profile，恢复成功后立即关闭 Chrome。

## 数据完整性

- 首页历史任务在写 D-1 前读取平台更新时间；平台尚未出数时记 `WAITING/PARTIAL`，
  不把未知补成零。
- 财务通常比经营日报晚，固定重读 D-8 至 D-2，吸收迟到结算、补款和扣款。
- OpenAPI 销售与 WebAPI 经营指标是两个事实域：任一域成功先落库，不能互相覆盖。
- 货号销量来自经营分析商品诊断；货号报账销售款与明细件数来自财务明细。两种件数独立展示，禁止互相冒充或覆盖。
- 每批写 `SUCCEEDED/PARTIAL/FAILED` marker。06:15 只读取 marker 定向补漏。
- Dashboard 只发布校验通过的新版本；失败继续使用旧缓存。

## Cookie 会话

Profile 只负责首次登录、身份验真和失效恢复。身份验证通过后，固定 SHEIN 来源的 Cookie
和 User-Agent 以 AES-256-GCM、店铺编码 AAD 加密保存；密钥由 systemd credential 注入，
仓库、日志和命令行都不出现 Cookie。每次 HTTP 响应的 `Set-Cookie` 会原子写回加密会话，
每日健康请求维持活跃；401/403、登录跳转或业务登录失效只排队恢复受影响店。

## Webhook

Webhook 入口只验签落库，异步 Worker 按业务键回查并幂等更新。订单、采购、发货、
缺货、授权和商品状态等重要事件可定向刷新；它不等待任何日更或 Dashboard 大物化。

资源阈值、双浏览器例外、备份和回滚见
[资源协调运行手册](resource-coordination.md)。
