# 全托共享服务器资源协调

## 原则

半托与全托共用 2 核 8 GiB 主机，排班按一台主机设计。优先级固定为：实时销售与
Webhook > 上班前日更 > 常规库存/物化 > 营销与维护。所有 timer 均为
`Persistent=false`，重启后不形成补跑风暴。

能用 OpenAPI 就不用 WebAPI；能用 Cookie 会话 HTTP 就不启动 Chrome。Profile 只用于
首次会话导出和单店失效恢复。普通每周营销浏览器重活优先在本地 headless 执行，云端
只保留明确授权任务的受控保底。

## 资源车道

统一入口为 `scripts/run_shein_host_lane.sh`：

| 车道 | 并发 | 用途 | 准入边界 |
| --- | ---: | --- | --- |
| `api-light` + `api-critical` | 2 | OpenAPI 核心销售、每小时首页 Session HTTP | 只在可用内存低于 1 GiB、严重 PSI 或每核 load1 > 2.5 时延期 |
| `api-light` + `openapi` | 2 | 财务、供应链、日更 Session HTTP | 1.5 GiB 可用内存、每核 load1 <= 1.5 |
| `browser-read` | 最多 2 | 单店登录恢复、仍未迁移成功的只读页面 | 首个沿用常规浏览器门禁；第二个要求至少 3 GiB 可用内存、每核 load1 <= 1.25 |
| `db-read` | 1 | Dashboard 只读物化 | 可与 API/只读浏览器并行；自身 cgroup 限制 CPU、内存和 IO |
| `browser-write` | 1 且全机独占 | 有外部副作用的浏览器写入 | 必须有业务授权、预演和回读 |
| `db-heavy` | 1 且全机独占 | 破坏性迁移/重建 | 普通物化不得进入 |
| `io-heavy` | 1 且全机独占 | 每周备份和月度恢复演练 | 低优先级 IO |

两个 `browser-read` 槽是上限，不是要求。全托正常高频链路切换后 Chrome 数应为零；只有
恢复队列非空时才占用一个槽。第二个槽允许半托和全托各有一个只读浏览器，不允许第三个。

核心 API 不再因普通 load1 抖动漏跑。cgroup、可用内存、memory/io PSI 仍构成硬熔断，
因此不是无条件并发。Portal、Webhook 接收及按单入仓不进入重车道。

## 全托排班

| 时间 | 任务 | 资源/边界 |
| --- | --- | --- |
| 每小时 `:02` | `FM_REALTIME_COCKPIT` | 一个 run 并行 OpenAPI 销售与 25 店 Session HTTP；同主体串行、全局并发 2；无 Chrome；完整后一次发布 |
| `00:30` | `FM_SESSION_MAINTENANCE` | 一个 run 先 HTTP 验证，仅失效店进入 `browser-read` 恢复，再回到同一 manifest |
| `02:20` | `FM_SUPPLY_DAILY` | `api-light`；同主体串行、全局并发 2；只重试失败店 |
| `03:15` | `FM_FINANCE_DAILY` | `api-light`，D-8 至 D-2；只重试失败店/窗口 |
| `05:45` | `FM_DAILY_OPERATIONS_CLOSE` | 一个 run 完成 readiness、25 店历史/台账、定向重试和一次发布 |
| 周日 `00:15` | PostgreSQL 周备份 | `io-heavy`，保留最近 2 周 |
| 月首周日 `01:15` | 恢复演练 | `io-heavy` |

## Dashboard 物化

coordinator 的必需阶段全部完成后，才由 `OnSuccess` 直接执行一次 `db-read` 物化；原子
替换成功后同一 run 从 `READY_TO_PUBLISH` 改为 `PUBLISHED` 并记录 manifest。`PARTIAL`、
`WAITING` 和资源延期 `75` 都不能触发发布。Webhook 的业务键定向回读仍立即执行；首页
全量物化由 path 延迟 5 分钟合并，并在启动前确认请求 marker 确实比已发布 Dashboard 新。
若期间已有 coordinator 发布了更新快照则直接跳过。固定 retry timer 保持停用，只有
pending/kick 事件 path 负责资源延期后的重试；资源忙时旧 Dashboard 原子文件继续服务。

## 备份

取消每日完整 dump。普通代码、前端和 systemd 发布不备份数据库；每周日 00:15 生成
一份 full dump，保留最近 2 周。只有破坏性 schema/数据迁移或用户明确要求才创建最新
1 份 deploy dump。历史 daily dump 仍可被恢复工具识别，并随两周保留策略自然收敛。

## 部署与验收

```bash
install -o root -g root -m 0644 infra/systemd/shein-host-heavy.slice \
  infra/systemd/shein-host-heavy-fm.slice infra/systemd/shein-fm-heavy.slice \
  /etc/systemd/system/
install -o root -g root -m 0644 infra/tmpfiles.d/shein-fm-scheduler.conf \
  /etc/tmpfiles.d/shein-fm-scheduler.conf
systemd-tmpfiles --create /etc/tmpfiles.d/shein-fm-scheduler.conf
systemd-analyze verify /etc/systemd/system/shein-fm-*.service \
  /etc/systemd/system/shein-fm-*.timer \
  /etc/systemd/system/shein-fm-*.path
systemctl daemon-reload
```

验收必须同时满足：

1. 高频 timer 均 `Persistent=false`。
2. DL/MZ 浏览器内 fetch 与 Session HTTP 响应哈希一致后，才批量导出 25 店。
3. 正常 `home-realtime` 运行时 Chrome、CDP、Profile 租约均为零。
4. 401/403 只创建对应店恢复队列；恢复后双读一致、Chrome 清零。
5. `FM_REALTIME_COCKPIT` 只有一个 run；OpenAPI 销售和 Session HTTP 可并行，但只发布一次。
6. Dashboard path 能在 5 分钟窗口合并唤醒并跳过已覆盖请求；失败时旧缓存仍可读，固定
   retry timer 保持停用。
7. Portal、Webhook、PostgreSQL、公网健康正常，半托 unit 和仓库未被覆盖。

## 回滚

先停本次涉及的全托 timer，等待正在执行的任务自然收口，再把 `current` 切回
`previous` 并恢复上一版 unit。加密会话文件可保留，旧版本不会读取；不得删除原
Profile、密码库或登录态。
