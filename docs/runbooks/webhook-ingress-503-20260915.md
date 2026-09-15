# Webhook 入口 503 与 SHEIN 关停告警处置（2026-09-15）

## 结论

SHEIN 对店铺 DL5477 的 app 发出「推送成功率低于 70%，否则关停」告警。原因是 receiver 在入库阶段返回 503（`WEBHOOK_INGRESS_DEADLINE` / `WEBHOOK_STORAGE_UNAVAILABLE`），**不是 webhook 配置错误**。已把入库时间预算从 800ms/1200ms 提升到 4000ms/8000ms 并部署，生产已确认生效。

## 证据

- 近 3 天 305 次 503：280 次 `WEBHOOK_INGRESS_DEADLINE`、25 次 `WEBHOOK_STORAGE_UNAVAILABLE`；**没有一次 401 或 400**，说明签名与身份校验正常。
- 按天：09-09 6、09-10 16、09-11 1、09-13 18、09-14 83、09-15 204。09-15 高峰在 19–21 时，且**成簇**：19:40 有 20 次、19:48 有 25 次、20:04 有 24 次、20:42 有 15 次、21:37 有 32 次、21:42 有 28 次。
- Postgres 被取消的语句（24 小时）：28 条 `INSERT INTO raw.webhook_receipt`、22 条 `SELECT ... FOR UPDATE`；CONTEXT 多为 `while inserting index tuple (...) in relation "webhook_receipt"`，少数为 `while locking tuple`。
- 配置健康：25 店全部 `enabled=true`、`applicationStatus=approved`、`authorizationStatus=authorized`；DL5477 同样健康，24 小时 39 条入库、平均载荷 148 字节，属低流量店。
- 失败是系统级、25 店共享同一条入库链路；成功率是比值，分母小的 app 先触线，所以告警落在低流量的 DL5477。

## 根因

入库事务由三条语句组成：`SELECT store_id FROM dim.store` + `INSERT INTO raw.webhook_receipt ... ON CONFLICT (idempotency_key) DO NOTHING` + `INSERT INTO ops.webhook_job`。SHEIN 会对同一事件并发重投，重复投递的 `INSERT` 必须等待第一次投递的事务提交才能判定冲突，随后的 `SELECT ... FOR UPDATE` 也要等同一行的锁。这个等待在共享机械盘的写延迟尖峰下会超过原来的 800ms 语句超时，于是 Postgres 取消语句、receiver fail-closed 返回 503，SHEIN 记为该次推送失败。

原来的两个预算是**硬编码且有硬上限**：`boundedInteger(..., 800, 50, 800)` 与 `boundedInteger(..., 1200, 250, 1200)`，没有任何配置入口，所以调配置无效。

## 修改

- `src/webhook/receiver.mjs`：`WEBHOOK_DB_STATEMENT_TIMEOUT_MS` 800 → 4000，`WEBHOOK_INGRESS_BUDGET_MS` 1200 → 8000，并同步抬高 `boundedInteger` 上限；把生效值加到返回对象与启动日志，便于现场核验。
- `src/warehouse/webhook-repository.mjs`：`statementTimeoutMs` 默认值与上限 800 → 4000（该函数超范围会抛错，必须同步改，否则 receiver 传入 4000 会被拒）。
- 没有放宽签名、身份或幂等性校验；只增加「慢但正确」的容忍度，慢写不再被当成失败。
- 新增/更新测试：`tests/webhook/receiver.test.mjs` 锁定新预算并断言语句超时小于请求预算。

## 部署与验证

- 提交 `3736da2`，tag `2026.09.15.2`，release 目录 `/opt/shein-fm/releases/3736da291b1755f068b03a17e5b2348a993128b9`。
- 按共享服务器资源协调手册的切换流程：停全托 timer → 原子替换 `current` → `daemon-reload` → 重启 `shein-fm-webhook-receiver.service` → 启动 timer。receiver 是常驻进程，必须重启才加载新常量。
- 启动日志实测：`{"ok":true,"service":"shein-fm-webhook-receiver",...,"ingressBudgetMs":8000,"statementTimeoutMs":4000,...}`。
- 重启后 `/healthz` 返回 `ok:true`、计数归零；9 个 timer active；公网 `/health` 200；重启后 5 分钟内无新 503。
- 同日另一次部署的协调器具名错误码也在生产得到验证：`sales-realtime` 阶段对 25 店报 `SALES_DATE_ANCHOR_PARTIAL`。

## 残留边界

- 本次只提高容忍度，不消除延迟本身。残留风险是入库等待超过 4 秒仍会返回 503。
- 延迟来源主要是共享机械盘（同机还承载半托）；容器 `shared_buffers` 仅 128MB，checkpoint 有过 `write=16.858s` 的记录。是否调整数据库参数需要在有窗口时单独评估，本次未动，因为重启数据库会短暂中断入口。
- `webhook-hydration` 观察到高频运行（近段约每 30 秒一次，每次 claimed=0），频率高于其 10 分钟排程，原因未定位，建议单独排查。
- 未创建数据库 deploy 备份：本次只有代码变更，无数据库迁移。

## 观察到的无关现象（记录，不属本次故障）

- `shein-fm-home-realtime.service` 在 00:11 与 23:11 以 `WAITING_PLATFORM` 退出并被标记为 failed，同日凌晨另有一次相同。这是等待平台日结锚点的既有夜间形态，不是 25 店登录失效（会话续期报告 25/25 ACTIVE）。该 unit 的 failed 状态是 exit code 2 的结果，会在下一次成功运行后清除，未做 reset-failed 掩盖。

