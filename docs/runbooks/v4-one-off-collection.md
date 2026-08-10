# V4 一次性全量采集运行手册

本手册只适用于人工授权的一次性全托采集。它不创建、修改、启停或绑定任何
`timer`、`path`、cron 或排班；固定 retry 保持 `disabled`，事件 path 保持现状。

## 1. 冻结合同

- 店铺：`FULL_MANAGED_STORE_CODES` 的固定 25 店，顺序也属于合同。
- 计划格式：`full-managed-v4-collection-plan.v2`；v2 把实际请求合同清单纳入授权 hash。
- 业务页面：备货记录、运单、退货申请、退货单、异常、增值服务、质检报告。
- 控制请求：`WAYBILLS_STATISTICS_1..6`。
- 单窗口闭合：`25 × (7 + 6) = 325` 个 attempt。
- 时间窗：以上海日历昨天为终点的连续 30 个完整自然日；异常和增值服务按正式
  once-only 合同完整分页。
- 并发：店铺串行，`storeConcurrency=1`。
- 重试：`NONE`；一次 execute 只调用一次正式同步器。
- 输出：同步器先写同目录私有 staging；只有数据库写入、逐页精确回读、325 attempt
  终结和 coverage 全部完成后才原子发布到显式 candidate。runner 拒绝 basename 为
  `order-management.json` 的路径；异常退出不得留下可被物化器误认的正式 candidate。

`VALUE_ADDED_SERVICES_PAGE` 进入第七张类型化事实表，但因响应合同没有币种，
`actualTotalAmount` 与 `estimateIncrementAmount` 不进入 candidate、索引、数据库或
汇总。运单统计只保存状态、覆盖收据及请求/响应/schema hash，不把 `info` 业务值写入
candidate，也不物化成经营指标。

## 2. 执行前门禁

1. 目标提交已合并到远端 `main`，release/tag/部署目录都是同一 SHA。
2. 同版本 PostgreSQL 临时库已完整执行所有 migration、verify、二次幂等回放和角色
   正/负权限探针。
3. 生产 deploy 备份已完成并校验；`current`、`previous`、systemd/timer/path 哈希已记录。
4. 会话续期报告必须是 25/25 ACTIVE，恢复队列为空。
5. 无同项目可变 writer、共享锁或未结束的采集任务。
6. 只使用 `/srv/shein-fm/secrets/webapi-experiment/database.env` 与 systemd credential
   提供运行身份；不得在命令、日志、plan 或报告中打印凭据。

任何一项不满足都停止，不把缺失店或失败页补成零。

## 3. Dry-run 与 hash 锁定

Dry-run 不连接数据库、不读取会话、不发网络请求、不写 candidate：

```bash
npm run webapi:v4-collection
```

将输出中的 `plan` 对象原样保存为 root-private plan 文件，并记录 `planHash`。计划必须
包含按 13 个 work item 排序的请求合同清单；每项固定 method/path/body template、窗口、
分页字段、schema hash 与本窗口的 request fingerprint。上述任一项变化都必须改变
`planHash`。执行前必须用 `--plan-file` 回读同一个对象；不得在 execute 时重新计算一个
跨日计划来代替已批准计划。

## 4. 串行 execute

在受 systemd 约束的 `sheinfm` 一次性进程中执行：

```text
node scripts/run_full_managed_v4_collection.mjs
  --execute
  --plan-file=<root-private-plan.json>
  --approved-plan-hash=<exact-64-hex>
  --output=<candidate-session-snapshot.json>
```

实际命令必须保持单行参数；上面的换行只为说明。进程必须继承 WebAPI loader 数据库
环境、session-key systemd credential、资源 lane 和独占锁。不要安装同名 timer，也不
要把本命令加入现有 coordinator。

## 5. 终态回读

必须从 PostgreSQL 与 candidate 同时证明：

- run 的 `plan_hash`、`run_key`、`retry_policy=NONE` 与批准计划完全一致；
- 25 店、13 work item、325 attempt 全部存在，且没有第二 attempt；
- 每个真实分页都有 request/schema/source-payload hash、HTTP 状态、行数和拒绝数；
- 每个事实页写入后，行数与 payload hash 精确回读一致；仅“无拒绝行”不足以成功；
- 七张事实表的行均引用同 attempt 的 page evidence，且数据库强制事实店铺和 endpoint
  与 attempt 一致；原始业务号只出现为 hash；
- 六类运单统计每店各有独立 page/control 收据；
- coverage 的 complete/partial/unknown 与 attempt 逐项重算一致；
- candidate JSON 通过契约、PII、分页、去重和覆盖检查。

任何持久化异常都必须先把仍为 `PLANNED/RUNNING` 的 attempt 终结为明确失败，再以
失败 coverage 闭合 run；不能用一个 `FAILED` run 掩盖 325 项中的开放 attempt。状态
时间使用数据库时钟，不能复用创建 run 之前捕获的客户端时间。

只有 run 为 `SUCCEEDED` 且 candidate 经过现有订单物化器后得到
`coverage.status=COMPLETE`、`promotable=true`，才可原子提升 active
`order-management.json` 或活动输入 `order-management.sessions.json`。只有
`SUCCEEDED` 才生成最终 candidate；`PARTIAL`、`FAILED`、`UNKNOWN` 或不可提升的 candidate
只保留审计，不覆盖 active。

## 6. 回滚

- 代码：`current` 原子切回 `previous`，重启受影响服务并回读。
- 数据：迁移与事实均为 additive/append-only，不删表、不清事实、不伪造反向迁移。
- 页面数据：active 订单文件保持或切回上一份已验证文件；失败 candidate 保留审计。
- 调度：本流程从未创建或修改调度，因此回滚也不得新建、重绑或补跑 timer/path。
