# 全托数据刷新排班

业务时区固定为 `Asia/Shanghai`。排班将当前日快速事实、已结算日事实和慢变供应链
拆开，避免浏览器 Profile、OpenAPI 应用额度和 Dashboard 物化相互争抢。

## 排班

| 时间 | 任务 | 数据边界 |
| --- | --- | --- |
| 每小时 `:05` | `shein-fm-sales-sync` | OpenAPI SKU 今日/昨日/7日/30日快照 |
| 每小时 `:32` | `shein-fm-home-realtime` | 仅当天 WebAPI 小时曲线；不抓商品历史 |
| `02:20` | `shein-fm-db-backup` | PostgreSQL 自定义格式压缩备份 |
| `03:20` | `shein-fm-session-renewal` | 25店 Profile 每日登录态续期 |
| `03:40` | `shein-fm-supply-sync` | 商品、PI/JI、缺货、采购、交付日更 |
| `04:20` | `shein-fm-home-finance-daily` | D-4 至 D-2 财务窗口滚动重读 |
| `05:20` 至 `09:20` | `shein-fm-home-daily` | 每小时5店，重读 D-2/D-1 |
| `10:20` | `shein-fm-home-daily-retry` | 只补前述分批留下的缺失范围 |

Dashboard 由成功的数据任务通过 `OnSuccess` 立即触发。独立物化 timer 只保留
2小时兜底，不设开机触发，不再每30分钟无条件重建。

## 平台结算门禁

每日首页任务在写入任何 D-1 事实前逐店调用官方 `get_update_time`。只有
`dataAnchorDate >= D-1` 才继续；否则记录 `HOME_SETTLEMENT_NOT_READY`，不把尚未
更新的空值或旧值冒充昨日最终数据。10:20 的重试仍执行同一门禁。

财务报表当前生产证据显示通常晚于经营日报，因此按 D-2 结算，并每日重读 D-4 至
D-2 以吸收迟到明细和补扣款。

## 互斥与性能

- 高频 timer 均为 `Persistent=false`，服务器重启后不追补错过的整点任务。
- 所有全托批任务共用 `/run/lock/shein-fm-heavy.lock`，销量、首页、物化和日任务
  串行执行；组件自己的锁仍作为第二层领域互斥。
- 所有批任务进入 `shein-fm-heavy.slice`；全托批任务合计最多使用一个 CPU 的
  `90%`、3GiB 内存和 256MiB Swap，并使用低 CPU/IO 权重与较高 Nice 值。
- 启动前按任务类型检查开机稳定时间、可用内存、每核负载和 memory/io PSI。
  不满足门槛时以受控跳过码 `75` 退出，不启动 Node、Chrome 或数据库扫描。
- 所有 WebAPI 首页任务共用 `home-history.lock`，同一时刻只允许一个 Chrome。
- 每个 Profile 继续使用自己的租约；店铺完成后立即关闭浏览器。
- 销量、供应链和财务任务共用 PostgreSQL advisory lock `8842137002`，不会并发
  消耗同一批 OpenAPI 应用额度。
- 日收口拆为5个固定五店批次；错过的批次由10:20统一补漏。
- 历史回填和人工修复不得绕过上述两类锁，也不得与整点任务并发。
- 锁被占用时任务以受控跳过码 `75` 结束，不计为故障；后续整点或10:20补漏接管。
- 缺数保持 `NULL`；失败只重试店铺、日期和数据域的交集。

当前共享服务器只有2核。第一版保持单浏览器；以连续24小时实测为准，只有整点
链路无法在15分钟内完成且 CPU、内存、Swap 均有余量时，才评审两浏览器并发。

资源门禁阈值、systemd 安装顺序、实机验收与回滚见
[资源协调运行手册](resource-coordination.md)。

## Webhook

Webhook 用于采购单、发货、缺货、授权、商品审核/额度/合规、采购退货和建议零售
价等对象的定向刷新。它不替代当前日销售轮询。入口只验签落库；异步 Worker 按
业务键回查并幂等更新。Portal 的“紧急事项”默认只显示 P0、P1 或处理失败事件，
普通业务动态和技术验证记录通过筛选或证据区查看。

飞书提醒暂不启用。
