# 全托数据刷新排班

业务时区固定为 `Asia/Shanghai`。当前日核心数据和 D-1 日更分开：实时销售、Webhook
和 OpenAPI 快车道不等待浏览器；日更尽量在 07:00 上班前闭环。

## 固定时间表

| 时间 | 任务 | 数据边界 |
| --- | --- | --- |
| 每小时 `:02/:32` | `shein-fm-home-realtime` | 当天经营分析 WebAPI，25 店拆为 12+13 |
| 每小时 `:05` | `shein-fm-sales-sync` | OpenAPI 销售快照，独立落库 |
| `00:15` | `shein-fm-db-backup` | 每个上海自然日最多一份可恢复 dump |
| `00:30` | `shein-fm-session-renewal` | 25 店登录态检查/续期，只处理异常店 |
| `02:20` | `shein-fm-supply-sync` | OpenAPI 商品、采购和交付日更 |
| `03:15` | `shein-fm-home-finance-daily` | D-8 至 D-2 财务滚动重读 |
| `03:45/04:15/04:45/05:15/05:45` | `shein-fm-home-daily` | 5 个固定五店批次，重读 D-2/D-1 |
| `06:15` | `shein-fm-home-daily-retry` | 按 marker 只补缺店、缺日、缺数据域 |
| `00/06/12/18:55` | Dashboard 兜底 | 正常由事实变更 enqueue；这里只防漏唤醒 |

高频任务全部 `Persistent=false`。每个历史批次 12 分钟硬上限，确保在下一次`:02`或
`:32`当前日刷新前自然释放。供应链、财务与销售使用 OpenAPI 轻车道，允许在资源健康
时与一个只读浏览器并行；数据库大物化、备份及外部写浏览器仍全机排他。

## 数据完整性

- 首页历史任务在写 D-1 前读取平台更新时间；平台尚未出数时记 `WAITING/PARTIAL`，
  不把未知补成零。
- 财务通常比经营日报晚，固定重读 D-8 至 D-2，吸收迟到结算、补款和扣款。
- OpenAPI 销售与 WebAPI 经营指标是两个事实域：任一域成功先落库，不能互相覆盖，
  也不能因另一域失败而回滚。
- 每批写 `SUCCEEDED/PARTIAL/FAILED` marker。06:15 只读取 marker 定向补漏，不重跑
  已闭环店铺。
- Dashboard 只发布校验通过的新版本；失败继续使用旧缓存。

## Webhook

Webhook 入口只验签落库，异步 Worker 按业务键回查并幂等更新。订单、采购、发货、
缺货、授权和商品状态等重要事件可定向刷新；它不等待任何日更或 Dashboard 大物化。
飞书提醒暂不启用。

资源阈值、双浏览器规则、备份和回滚见
[资源协调运行手册](resource-coordination.md)。
