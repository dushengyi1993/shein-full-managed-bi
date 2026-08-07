# 全托数据刷新排班

业务时区固定为 `Asia/Shanghai`。一个逻辑任务只有一个 coordinator、一个 `run_id` 和一个
timer。店铺分组、数据域、资源等待和定向重试都是同一次运行的内部 checkpoint，不再由
多个 timer 拼成用户可见结果。

## 固定时间表

| 时间 | 业务任务 | 数据边界 |
| --- | --- | --- |
| 每小时 `:02` | `FM_REALTIME_COCKPIT` | 同一 run 并行刷新 25 店 Session HTTP 经营事实与 OpenAPI 销售事实；同主体串行、全局并发 2；两域均完成后只物化一次 |
| `00:30` | `FM_SESSION_MAINTENANCE` | 同一 run 先做 25 店 HTTP 验证和 Cookie 轮换，只对失效店启动 Profile 恢复，再复核会话 |
| `02:20` | `FM_SUPPLY_DAILY` | OpenAPI 商品、采购和交付；同主体串行、全局并发 2，只重试失败店 |
| `03:15` | `FM_FINANCE_DAILY` | D-8 至 D-2 财务滚动重读；按失败店/失败窗口定向重试 |
| `05:45` | `FM_DAILY_OPERATIONS_CLOSE` | 一个 run 完成平台 readiness、25 店 D-2/D-1 经营历史与台账、缺店定向重试和一次原子发布 |
| 每周日 `00:15` | `shein-fm-db-backup` | 每周一份完整 dump，保留最近两周 |
| 每月首个周日 `01:15` | `shein-fm-db-restore-test` | 用最新 weekly/deploy dump 做真实临时库恢复 |
| 事实变化时 | Dashboard 发布阶段 | coordinator 的全部必需阶段 READY 后直接物化；Webhook 只合并唤醒；十分钟 timer 仅补资源延期 |

所有 timer 均为 `Persistent=false`。OpenAPI 和 Session HTTP 按阶段领取 API 令牌，事实写入
完成即释放；Dashboard 物化再领取独立 `db-read` 令牌。coordinator 不从开头到结尾持有
浏览器或数据库重锁。

## 运行与发布合同

- 每个 run 在 `/srv/shein-fm/runtime/coordinator/<task>/` 保存唯一状态文件，记录阶段、尝试、
  待重试店铺和业务日期。重启或资源延期后继续同一个 run，而不是新建补跑任务。
- 只有全部必需阶段为 `COMPLETE` 才进入 `READY_TO_PUBLISH`；物化原子替换成功后状态改为
  `PUBLISHED`，并记录 Dashboard 文件大小、时间和 SHA-256。
- `PARTIAL`、平台未 ready、资源延期退出码 `75` 都不等于成功，不触发 `OnSuccess`，也不
  覆盖上一份完整 Dashboard。
- 销售与经营指标是独立事实域，可以分别先落库；但同一小时的驾驶舱快照只在两域均达到
  本 run 的终态后发布一次。终端能力缺口会明确写 warning，不被未知值补零。
- Dashboard materializer 是 coordinator 的末端发布阶段，不再拥有固定高频业务 timer。
  `.path` 与十分钟 retry 只负责 Webhook 合并唤醒或资源延期后的技术兜底。

## 数据完整性

- D-1 日结先检查平台更新时间；未出数时保持同一 run 为 `WAITING_PLATFORM` 并定向重试，
  不把未知补成零。
- 财务固定重读 D-8 至 D-2，以吸收迟到结算、补款和扣款。
- 货号销量来自经营分析商品诊断；货号报账销售款与明细件数来自财务明细，两种件数独立
  保存和展示，禁止互相冒充或覆盖。
- 25 店完整性与关键域校验通过后才发布；失败继续使用上一份原子 Dashboard。

## Cookie 会话

Profile 只负责首次登录、身份验真和失效恢复。固定 SHEIN 来源的 Cookie 和 User-Agent
以 AES-256-GCM、店铺编码 AAD 加密保存；密钥由 systemd credential 注入。每次 HTTP
响应的 `Set-Cookie` 原子写回。每日 00:30 同一 run 内先验证全部会话，再只恢复受影响店；
恢复结束即关闭 Chrome，不再设独立的每小时恢复业务 timer。

## Webhook

Webhook 是独立持续流，不属于日结分片。入口只验签落库，异步 Worker 标准化并按业务键
精确回查；采购单和交付单只有在 OpenAPI 返回对应行且仓库写入成功后才完成。标准化事件
合并唤醒 Dashboard，不逐事件做全量物化；兜底回查也不等待日更任务。

资源阈值、浏览器并发、备份和回滚见
[资源协调运行手册](resource-coordination.md)。
