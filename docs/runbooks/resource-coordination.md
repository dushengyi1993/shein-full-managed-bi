# 全托共享服务器资源协调

## 目标与边界

全托与半托共用 2 核 8GiB 云服务器。本规则只约束 `/opt/shein-fm` 和
`shein-fm-*` 批任务，不修改、停止或降权任何半托目录、进程、unit 或 timer。

2026-08-04 20:10 重启后的实机证据显示：全托首页实时、销量同步和 Dashboard
物化在开机数分钟内重叠，且同一时段半托启动预热、库存 OpenAPI 与浏览器任务也在
运行。重启前云监控达到 CPU 88.6%、内存 98.3%、磁盘繁忙 97%，SSH 与 HTTPS
同时超时。因此调度必须在进程创建前让路，而不能只依赖任务内部互斥。

## 三层门禁

### 1. 不追补、错峰

- `shein-fm-sales-sync.timer`：每小时 `:05`，避开半托库存 `:25/:55`。
- `shein-fm-home-realtime.timer`：每小时 `:32`。
- `shein-fm-dashboard-materialize.timer`：固定偶数小时`:55`兜底；没有
  `OnBootSec`，不会随上次结束时间漂移。
- `shein-fm-dashboard-materialize-retry.timer`：在每小时`:00–:24`与
  `:47–:59`每3分钟只检查一次
  `.materialize-pending`。没有待物化标记时不拿锁、不查库；上次因锁或资源压力返回
  `75` 时才在近端重试。
- 所有定时全托批任务使用 `Persistent=false`，重启不形成补跑风暴。
- 成功的数据任务仍以 `OnSuccess` 触发一次物化；共享锁确保它不会和下一项重叠。
- `/run/shein-fm-webapi`、`/run/shein-fm-sales` 与
  `/run/shein-fm-supply` 由 tmpfiles 按最小权限在开机时创建；复用这些目录的
  oneshot 必须设置 `RuntimeDirectoryPreserve=yes`，避免前一任务收口后让下一任务
  在 namespace 阶段以 `226` 失败。

### 2. 启动前系统压力门禁

`scripts/check_full_managed_resource_pressure.mjs` 只读 Linux `/proc`，在 Node、
Chrome 和数据扫描启动前执行。重任务先获得中立主机锁和全托内部锁，再由
`scripts/run_full_managed_resource_guarded.sh` 检查压力；不满足门槛返回 `75`，
但不会进入真正的 `ExecStart` 业务命令。轻量 sales 使用 systemd
`ExecCondition` 模式并返回 `1` 受控跳过，不进入主机重任务队列。

| 类型 | 开机稳定 | MemAvailable | 每核 load1 | memory full PSI avg10 | io full PSI avg10 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 浏览器 | 15 分钟 | 2560 MiB | `<= 0.75` | `<= 1` | `<= 5` |
| OpenAPI | 15 分钟 | 2048 MiB | `<= 0.85` | `<= 2` | `<= 8` |
| 物化 | 20 分钟 | 2048 MiB | `<= 0.75` | `<= 1` | `<= 5` |

跳过的小时数据由后续小时的覆盖窗口吸收；历史日结由后续批次和 11:50 缺失重试
吸收。禁止在开机后人工同时补跑多个跳过任务。

### 3. 主机共享锁和资源包络

- `/run/lock/shein-host-heavy.lock` 是半托、全托 Chrome、大查询、物化和大批量
  OpenAPI 的中立外层锁；双方自己的领域锁继续作为内层锁。
- `shein-host-heavy.slice` 对全机重任务合计设置 `CPUQuota=90%`、
  `MemoryHigh=3G`、`MemoryMax=4G`、`MemorySwapMax=256M`。
- `shein-host-heavy-fm.slice` 是全托子 slice，继续限制全托合计
  `CPUQuota=90%`、
  `MemoryHigh=2G`、`MemoryMax=3G`、`MemorySwapMax=256M`、`TasksMax=256`。
- sales OpenAPI 是今日核心轻量车道：保留独立 API 锁、CPU/内存上限和压力门禁，
  但不被 30–80 分钟的 Chrome 日更任务无条件饿死。
- 每个 service 另设 CPUQuota、CPUWeight、IOWeight、Nice、MemoryMax、
  OOMScoreAdjust 和超时；即使任务异常也不能吃满共享主机。
- Dashboard 当前135MB级JSON的实机物化峰值约717MB；其单元使用
  `MemoryHigh=1G`、`MemoryMax=1.5G`，避免在640MB阈值上被内核持续回收，同时仍
  受全托3G和主机重任务4G双层上限约束。
- Chrome 任务使用 `KillMode=control-group`。正常流程逐店关闭浏览器；停止超时后
  systemd 会清理该 unit cgroup 内的全部 Chrome 子进程。

主机锁只协调重任务，不读取两个项目的业务数据。半托消费同一中立锁时仍保留自己的
Profile/任务锁；营销 Chrome 抢不到锁时转本地执行。

### 跨项目消费合同

- 全托仓库维护 `/run/lock/shein-host-heavy.lock` 和
  `shein-host-heavy.slice` 的主机级定义；半托只增加
  `shein-host-heavy-bi.slice` 子 slice，不覆盖主机定义。
- 固定锁顺序为“主机锁 → 项目锁 → Profile/领域锁 → 压力检查 → 业务命令”；
  任一项目不得反向拿锁。
- 今日销售 Webhook、单订单 upsert、页面实时销售缓存以及轻量 sales 对账不进入
  长重锁；它们使用独立小锁和资源熔断。
- Chrome、ET、全库/大 section、备份、批量物化进入主机重锁。长链路必须拆成
  可续跑 chunk，并在每小时 `:27` 前释放，给全托 `:32` 首页核心数据预留窗口。
- 全托五店日结在 `05/06/07/09/10:45` 启动，显式映射 batch `0..4`；
  08点不排全托批次。实时首页精确在`:32`触发并硬超时11分钟，日结批次35分钟，物化5分钟，
  确保异常任务不会跨越下一核心窗口。
- 夜间同样执行该合同：续期02:10启动、02:20硬停止；供应链03:45启动并在
  04:21前收口；财务04:45启动并在05:00前收口。备份01:55只写dump，
  COS归档改在12:45独立执行。
- 营销 repair 抢不到主机锁或预计 Chrome 超过 10 分钟时标记
  `deferred_to_local`，由本地 Profile 执行，云端只接收结果与审计。

### 联合夜间基线

下表是双方共同消费主机锁的时间合同；半托 unit 仍由半托仓库维护，本仓库不安装或
覆盖它们。

| 时间 | 项目 | 任务/依赖 |
| --- | --- | --- |
| `00:45` | 半托 | session manager；最晚01:10停止并写done marker |
| `01:12` | 半托 | ET重任务；最晚01:27释放。同分钟stock为轻量API车道 |
| `01:45` | 半托 | DB backup；只在session marker完成后运行 |
| `01:55` | 全托 | DB backup；只生成已校验dump |
| `02:10` | 全托 | Profile续期；10分钟硬超时 |
| `02:45` | 半托 | yesterday final；依赖session、backup和平台ready证据 |
| `03:45` | 全托 | supply；按实测约21–24分钟，04:21前硬收口 |
| `04:12` | 半托 | ET重任务；锁忙则跳过，不挤04:32核心车道 |
| `04:45` | 全托 | finance；平台/凭据ready后运行 |
| `12:45` | 全托 | COS归档；非业务数据，不占上班前关键链路 |
| `13:45–14:17` | 半托 | 库存守卫；依赖 morning-links-ready 与13:12库存 marker |
| `14:20` | 半托 | ET仓储费；库存守卫必须先释放共享锁 |

每个小时的`:32–:43`均优先保留给全托首页当前日核心事实；任何尚未完成的可延期
重任务不得跨入该窗口。

## 安装

部署 release 后，先安装资源包络和临时文件规则，再覆盖相关 service/timer：

```bash
install -o root -g root -m 0644 \
  infra/systemd/shein-host-heavy.slice \
  infra/systemd/shein-host-heavy-fm.slice \
  infra/systemd/shein-fm-heavy.slice \
  /etc/systemd/system/
install -o root -g root -m 0644 \
  infra/tmpfiles.d/shein-fm-scheduler.conf \
  /etc/tmpfiles.d/shein-fm-scheduler.conf
systemd-tmpfiles --create /etc/tmpfiles.d/shein-fm-scheduler.conf

systemd-analyze verify \
  /etc/systemd/system/shein-host-heavy.slice \
  /etc/systemd/system/shein-host-heavy-fm.slice \
  /etc/systemd/system/shein-fm-heavy.slice \
  /etc/systemd/system/shein-fm-home-realtime.service \
  /etc/systemd/system/shein-fm-home-realtime.timer \
  /etc/systemd/system/shein-fm-sales-sync.service \
  /etc/systemd/system/shein-fm-sales-sync.timer \
  /etc/systemd/system/shein-fm-dashboard-materialize.service \
  /etc/systemd/system/shein-fm-dashboard-materialize.timer \
  /etc/systemd/system/shein-fm-dashboard-materialize-retry.service \
  /etc/systemd/system/shein-fm-dashboard-materialize-retry.timer
systemctl daemon-reload
```

部署期间先停止 full-managed timers，不杀正在运行的半托或全托任务。安装成功后只
启动 timer；不要手工补跑错过窗口。

## 验收

```bash
systemctl show shein-host-heavy.slice shein-host-heavy-fm.slice \
  -p CPUQuotaPerSecUSec -p CPUWeight -p IOWeight \
  -p MemoryHigh -p MemoryMax -p MemorySwapMax -p TasksMax
systemctl list-timers 'shein-fm-*'
node /opt/shein-fm/current/scripts/check_full_managed_resource_pressure.mjs \
  --class=browser
```

必须逐项回读：

1. `:05`、`:32`、物化2小时兜底和3分钟待处理检查均为
   `Persistent=false`，物化无开机触发。
2. 压力不足时 service 为条件跳过，journal 包含结构化 `DEFERRED` 原因，且没有新
   Chrome、Node 数据任务或物化进程。
3. 空闲时同一时刻最多一个半托或全托重任务持有主机锁；轻量实时车道不受长锁饿死。
4. 批次结束后 `/srv/shein-fm/webapi/profiles` 对应 Chrome 进程、临时调试端口及
   store-login 活动租约均为零。
5. Portal、数据库、Webhook 健康，公网 HTTPS 和 SSH 保持响应。
6. 半托 unit 文件、timer 状态和仓库工作区没有被修改。
7. 物化因锁或压力返回 `75` 时保留 `.materialize-pending`；下一个3分钟检查成功
   后必须删除标记并原子更新正式 Dashboard 文件。
8. 三个 `/run/shein-fm-*` 业务运行目录始终存在、所有者分别与 WebAPI、销量和
   供应链服务身份一致；任一 oneshot 结束后再次回读仍不能消失。

## 回滚

1. 停止本手册涉及的全托 timer，不停止半托服务。
2. 从部署前备份恢复精确的 `shein-fm-*` unit；删除新增 slice/tmpfiles 规则前先确认
   没有 full-managed batch 在运行。
3. `systemctl daemon-reload`，验证旧 unit，再按旧状态启用 timer。
4. 代码 release 原子切回 `previous`；保留 journal 和压力门禁 JSON 作为事故证据。

回滚也禁止启动 `Persistent` 补跑或一次性并发补数据；需要补数据时另开受控维护窗。
