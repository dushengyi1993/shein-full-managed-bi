# 全托生产 release 部署与开机时钟偏斜（2026-09-15）

## 范围与结论

用户授权把 `2026.09.15.1` 部署到飞牛 VM，目标提交 `ec0fb56c587b487445c9e2fce89da934676f688a`。部署完成并通过验证。过程中发现并处置了一个既有故障：VM 每次开机后，基于 `OnCalendar` 的亚日级 timer 其 next_elapse 会被算到错误时间点，导致漏跑；本次 `home-realtime` 因此漏了 13:02–17:02 共 5 轮。

## 部署事实

- 线上原 release 目录 `/opt/shein-fm/releases/9ba4a533c08e4a96689af1ae1b759c73d32532fc`，`current` 指向它。
- 新 release 目录 `/opt/shein-fm/releases/ec0fb56c587b487445c9e2fce89da934676f688a`。
- 传输：本地 `git archive` 生成 tar.gz，两端 SHA256 一致 `a4e1e09c7455472662e2f98ff8b24fd69a10c9669d7a8943f42b4e60714a9643`；scp 后解包。
- 依赖：`npm ci --omit=dev --ignore-scripts`，新增 15 个包，0 漏洞。
- 静态校验：`node scripts/check_syntax.mjs`，356 个源码与测试文件通过。
- 发布血缘门禁：`check:version-lineage -- --release-ref=HEAD --main-ref=origin/main` 返回 `ok:true`。
- 切换顺序：停 9 个全托 timer → 原子替换 `current`（`ln -s` 后 `mv -T`）→ `systemd-analyze verify` → `daemon-reload` → 启动 9 个 timer。旧 release 目录保留，未清理。
- 未重启任何守护服务，沿用该系统既有做法：安装 release 不额外重启生产，oneshot 在下次调度自然加载新代码。

## 部署范围与兼容性

本次 `9ba4a53 → ec0fb56` 除本 Release 的 6 个提交外，还包含 9-8 的 5 个提交（LAN HTTP 门户与授权迁移接线）。其中 `src/server/auth.mjs`、`src/server/index.mjs` 的改动是严格 opt-in：只有 `FULL_BI_ALLOW_LAN_HTTP=true` 时才进入 LAN 分支，默认路径下生产校验规则（安全 Cookie、HTTPS Origin、默认 Cookie 名）保持不变。因此对公网 Portal 行为等价。

## 修复生效证据

手动执行 `shein-fm-system-health.service`（Result=success、ExecMainStatus=0）后：

- 健康快照 `generatedAt=2026-09-15T09:29:01Z`，服务日志 `unitCount=14, attentionUnitCount=1`。
- 非 healthy 单元只剩 `supplySync`；`dashboardMaterialize` 不再计入，事件驱动修复在生产达到预期效果。
- 9 个守护服务 active；公网 `/health`、`/store-login` 均 200；`systemctl --failed` 为 0。

## 开机时钟偏斜导致亚日级 timer 漏跑

现象：`shein-fm-home-realtime.timer` 在 12:05 那次重启后一次未触发（13:02–17:02 全缺），而它的 `OnCalendar=*-*-* *:02:00 Asia/Shanghai` 本身正确。

证据：

- `systemd-analyze calendar "*-*-* *:02:00 Asia/Shanghai"` 给出 Next elapse `18:02`，即正确值。
- 运行中的 timer `TimersCalendar` 显示 `next_elapse=Tue 2026-09-15 21:02:00 CST`，为错误值。
- 显式 `stop` + `start` 后 `next_elapse` 变为 `18:02`，与解析结果一致。

根因：开机时 guest 时钟偏 +8 小时（宿主把 RTC 按本地时间呈现，guest 按 UTC 解读），systemd 在错误时钟下把该小时级 timer 的下次触发算成 21:02；12:07:10 NTP 把时钟纠正回来后，已武装的 elapse 没有重算，于是空等到 21:02。

影响面：只影响基于 `OnCalendar` 的亚日级（小时、分钟）timer。使用单调时钟的 `system-health`、`disk-guard` 不受影响；每日、每周 timer 的目标是绝对墙钟时间，也不受影响。每次 VM 重启都会复现，代价是漏跑到那个错误时间点为止。

处置：显式重新武装受影响的 timer。本次重新武装了 `home-realtime`（21:02→18:02）与 `webhook-hydration`。

## 边界与未做项

- 根治需在宿主侧把 VM 的 RTC 改为 UTC，guest 内无法彻底修复。根治前，每次 VM 重启后应检查 `OnCalendar` 亚日级 timer 的 next_elapse。
- 协调器具名错误码 `SALES_DATE_ANCHOR_PARTIAL` 需等下一次自然调度运行才能在生产观察到；本记录未主动触发业务采集。
- 边缘机的 relay 改动未部署：默认允许列表未变、无功能收益，且属生产出口，本次未改动。
- `webhook-hydration` 观察到自 12:06 起运行 193 次（近段约每 30 秒一次），每次 claimed=0；频率高于其 10 分钟排程，原因未定位，留存观察。
- 未创建数据库 deploy 备份：本次无数据库迁移或数据变更，按部署手册普通代码发布不创建备份。

## 回滚

把 `current` 指回 `/opt/shein-fm/releases/9ba4a533c08e4a96689af1ae1b759c73d32532fc`，执行 `systemctl daemon-reload`，只重启受影响的守护服务。旧目录仍在，无需重新安装。

