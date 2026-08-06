# 全托共享服务器资源协调

## 固定原则

半托与全托共用 2 核 8 GiB 主机，排班按一台主机设计，不再靠两个项目逐分钟临时
协商。业务优先级固定为：实时销售与 Webhook > 上班前日更 > 常规库存/物化 > 营销与
维护。所有 timer 均为 `Persistent=false`，重启后不形成补跑风暴。

能用 OpenAPI 的任务进入轻量 API 车道；只有尚未开放的经营分析字段才使用 WebAPI。
浏览器任务必须逐店关闭 Chrome，并保留 Profile 登录态。普通营销写任务不占云端固定
时段，云端资源不满足或预计超过 10 分钟时转本地执行。

## 主机资源车道

统一入口为 `scripts/run_shein_host_lane.sh`：

| 车道 | 并发 | 用途 | 压力门禁 |
| --- | ---: | --- | --- |
| `api-light` | 2 | OpenAPI 销售、财务、供应链短阶段 | 开机 3 分钟；2 GiB 可用内存、每核 load1 `<=0.85` |
| `browser-read` | 最多 2 | 只读 WebAPI、会话续期 | 开机 10 分钟；首个 2.5 GiB；第二个 4 GiB、每核 load1 `<=0.65` |
| `browser-write` | 1 且全机独占 | 有外部副作用的浏览器写入 | 重任务门禁；营销优先转本地 |
| `db-heavy` | 1 且全机独占 | Dashboard 大物化、数据库维护 | 3 GiB 可用内存、每核 load1 `<=0.75` |
| `io-heavy` | 1 且全机独占 | 数据库备份与恢复演练 | 3 GiB 可用内存、每核 load1 `<=0.65` |

`browser-read` 对 `/run/lock/shein-host-heavy.lock` 取共享锁，并占用
`shein-browser-read-0/1.lock` 之一；写浏览器、数据库和 IO 重任务取排他锁。因此全机
最多两个只读 Chrome，绝不会出现第三个，也不会与写任务并行。全托自己的
`home-history.lock` 仍限制全托同时只运行一个浏览器；第二个槽位主要用于半托与全托各
一个。半托未切到共享读锁前仍使用旧排他锁，行为只会更保守，不会突破上限。

资源包络继续由 `shein-host-heavy.slice` 和 `shein-host-heavy-fm.slice` 控制；Portal、
Webhook 接收及单订单入仓不进入重车道。锁顺序固定为“主机车道 -> 项目锁 -> 领域或
Profile 锁 -> 压力检查 -> 业务命令”，不得反向拿锁。

## 全托固定排班

业务时区为 `Asia/Shanghai`。

| 时间 | 任务 | 资源/边界 |
| --- | --- | --- |
| 每小时 `:02/:32` | 首页当天经营事实 | `browser-read`；25 店拆为 12+13 |
| 每小时 `:05` | OpenAPI 销售 | `api-light`；与 WebAPI 独立落库、独立终态 |
| `00:15` | PostgreSQL 日备份 | `io-heavy`；同一上海自然日最多一份 |
| `00:30` | 25 店会话续期 | `browser-read`；10 分钟硬上限，部分店失败不拖死整批 |
| `02:20` | OpenAPI 供应链日更 | `api-light`；部分店失败记录 PARTIAL |
| `03:15` | 财务滚动核对 | `api-light`；重读 D-8 至 D-2 |
| `03:45/04:15/04:45/05:15/05:45` | 首页历史日更 | 每批 5 店，12 分钟硬上限 |
| `06:15` | 历史缺口重试 | 只补缺店/缺日，12 分钟硬上限 |
| `12:20` 周日 | Profile 可再生缓存清理 | 有租约或 Chrome 时直接跳过 |
| 每月首个周日 `11:15` | 备份恢复演练 | 临时库完整恢复并核对关键表后删除临时库 |

每个批次写原子 done marker，状态分为 `SUCCEEDED/PARTIAL/FAILED`。平台业务码导致的
单店缺失记为 `PARTIAL`，已成功事实照常落库和排队物化；真正进程或契约失败才是
`FAILED`。OpenAPI 销售成功不依赖 WebAPI 经营指标成功。

## Dashboard 物化

数据任务成功或部分成功后只调用 enqueue 服务写一个待处理标记，不在数据 unit 的
`OnSuccess` 中直接启动大查询。两分钟 pending timer 会合并这段时间内的多个变化，
获取 `db-heavy` 车道后只物化一次；失败或资源不足时保留标记和旧 Dashboard 原子文件。
`00/06/12/18:55` 的 timer 仅作低频兜底，不设开机触发。

## 备份边界

日常代码和前端发布不再创建数据库备份。只有三类备份：每日 `00:15`、数据库迁移/高
风险数据变更前、人工明确要求。默认本地保留集合为并集：最近 2 份日备份、最近 4 个
上海 ISO 周每周最新一份、最近 1 份部署/迁移备份。未知文件永不删除。

日常不再自动上传 COS；所有 dump 已落在挂载云硬盘 `/srv/shein-fm/backups/db`。每月
执行一次真实恢复演练，证明“有文件”确实等于“可恢复”。

## 部署与验收

```bash
install -o root -g root -m 0644 infra/systemd/shein-host-heavy.slice \
  infra/systemd/shein-host-heavy-fm.slice infra/systemd/shein-fm-heavy.slice \
  /etc/systemd/system/
install -o root -g root -m 0644 infra/tmpfiles.d/shein-fm-scheduler.conf \
  /etc/tmpfiles.d/shein-fm-scheduler.conf
systemd-tmpfiles --create /etc/tmpfiles.d/shein-fm-scheduler.conf
systemd-analyze verify /etc/systemd/system/shein-fm-*.service \
  /etc/systemd/system/shein-fm-*.timer
systemctl daemon-reload
```

验收必须同时满足：

1. 所有高频 timer 均 `Persistent=false`，没有 boot catch-up。
2. 两个浏览器槽存在；第二个槽只有在严格压力门禁通过时可用。
3. `browser-write/db-heavy/io-heavy` 能排他阻止所有只读浏览器。
4. 定时批次结束后对应 Chrome、CDP 监听和 Profile 租约均为零。
5. `PARTIAL` marker 可定位缺店，成功事实仍能触发一次合并物化。
6. 物化失败时旧 Dashboard 可读，pending 标记保留并由下一轮重试。
7. Portal、Webhook、PostgreSQL、公网健康正常，半托 timer 不被本仓库覆盖。

## 回滚

先停用本次涉及的全托 timer，等待正在执行的任务自然收口，再把 `current` 切回
`previous` 并恢复上一版 unit。不得杀死正在提交外部写事务的浏览器；不得用
`Persistent` 或并发手工补跑弥补错过窗口。
