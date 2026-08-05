# 全托磁盘与历史治理运维手册

本手册只覆盖全托（full-managed）资产。所有工具都硬编码全托固定路径，
`/opt/shein-bi`、`/srv/shein-bi`、`/lhcos-data/shein-bi-archive` 等半托路径会被
`FORBIDDEN_PREFIXES` 直接拒绝，不存在“传参切到半托”的可能。

所有破坏性工具都是**默认只计划（plan）**，必须显式加 `--apply`（历史维护还需
`--execute` 加计划哈希）才会动数据。任何校验失败都是 fail closed：源文件保留、
命令非零退出。

## 1. 数据库备份模式与保留策略

数据库已约 5.8 GiB，单份压缩 dump 约 0.7–0.8 GiB，因此保留备份但不允许每次发布
都生成一份。`scripts/backup_full_managed_db.sh` 只用于：

| 模式 | 触发方式 | 频率约束 |
| --- | --- | --- |
| `--mode daily` | `shein-fm-db-backup.timer`（每日 00:15） | 每个上海自然日最多一份 |
| `--mode deploy` | 数据库迁移、高风险数据变更或人工明确要求 | 本地最多保留最新一份 |

普通代码、前端和 systemd 发布不创建 deploy dump。所有备份落在已挂载云硬盘
`/srv/shein-fm/backups/db`，不占根盘。两种模式共用数据库备份锁；生成后先做
`pg_restore --list` 格式校验，再按 SHA-256 去重。

本地保留集合是以下三项的**并集**：

- 最近 2 份 daily/scheduled dump；
- 最近 4 个上海 ISO 周中，每周最新一份 daily/scheduled dump；
- 最近 1 份 deploy/pre-deploy dump。

`scripts/prune_full_managed_backups.mjs` 默认只输出计划；`--apply` 才删除二次核对过
大小、mtime 和路径的精确候选。未知文件、配置备份、edge 备份和软链永不删除，且
永远至少保留一份可用数据库 dump。

```bash
npm run maintenance:prune-backups
npm run maintenance:prune-backups -- --apply
```

日常不再自动归档 COS。代码版本由 GitHub 管理，数据库恢复能力由本地有界备份和真实
恢复演练保证；历史 COS 工具保留为人工应急工具，但没有 systemd timer，也不在日常
备份链路中。

## 2. 恢复演练

`shein-fm-db-restore-test.timer` 在每月第一个周日 11:15 运行：选取最新 daily/deploy
dump，先验证自定义归档清单，再恢复到严格命名的临时数据库，核对关键 schema、表和
行数，最后无论成功失败都删除临时库。恢复演练进入 `io-heavy` 排他车道，Portal 和
Webhook 保持在线，OpenAPI 销售快车道不受影响。

手工验证：

```bash
systemctl start shein-fm-db-restore-test.service
journalctl -u shein-fm-db-restore-test.service -n 100 --no-pager
```

## 3. 发布目录清理（部署成功后）

本仓库没有单体部署脚本，因此**不做自动清理**。部署健康检查与回读通过后，显式执行：

```bash
scripts/post_deploy_prune_releases.sh            # 只计划
scripts/post_deploy_prune_releases.sh --apply    # 确认后执行
```

该脚本只做一件事——清理空闲发布目录；不部署、不重启、不迁移、不碰数据库。两道前置门禁：

1. `/health` 必须返回 `"status":"ok"`；
2. `/opt/shein-fm/current` 必须是软链且解析到 `/opt/shein-fm/releases/` 之内。

保护集合是以下四者的**并集**：

- `current` 解析到的发布；
- `previous` 解析到的发布；
- 按名称（时间戳有序）最新 5 个发布；
- **任何被存活进程 `/proc/<pid>/cwd` 引用的发布**。

第四条是强制的，不是建议：Webhook receiver/worker 会长期运行在启动时那个较旧的
发布上。只按“最新 5 个”清理会把正在运行的代码目录删掉。`/proc` 不可读时工具以
`PROC_UNAVAILABLE` 拒绝执行——无法证明空闲就不删。

软链子项、目录外路径、异常名称一律拒绝；删除前二次 `lstat` 复核，防止列表之后被
换成软链。

## 4. WebAPI Profile 缓存清理

规范 Profile 按当前 25 家店铺白名单维护；工具只会处理配置中明确登记的 Profile，
不会扫描或猜测未知目录。

```bash
npm run maintenance:prune-profile-caches              # 只计划
npm run maintenance:prune-profile-caches -- --apply   # 空闲时执行
```

定时器 `shein-fm-profile-cache-prune.timer` 每周日 12:20 执行，避开上班前日更。

**允许删除的目录（精确白名单，不是模式匹配）**：`cache`、`component_crx_cache`、
`Profile 1/Cache`、`Profile 1/Code Cache`、`Profile 1/GPUCache`、
`Profile 1/Service Worker/CacheStorage`。未知目录一律不动，新版 Chrome 新增的状态
目录不会被误删。

**永不删除并在执行前后做指纹比对**：`Cookies`、`Cookies-journal`、`Login Data`
及其变体、`Web Data` 及其变体、`Local Storage`、`IndexedDB`、`Sessions`。
指纹前后不一致时以 `LOGIN_STATE_CHANGED` 失败。

fail-closed 条件（任一命中即拒绝，且**从不杀进程**）：

- `/srv/shein-fm/runtime/webapi-locks` 下存在任何租约文件（`LEASE_ACTIVE`）；
- 该目录存在无法解析或无法识别的锁工件（`LEASE_UNPARSEABLE`）；
- 任何进程命令行含指向全托 Profile 根的 `--user-data-dir`（`PROFILE_IN_USE`）；
- `/proc` 不可读（`PROC_UNAVAILABLE`）；
- 白名单路径本身是软链（`CACHE_SYMLINK`）。

> systemd 单元**故意不写** `Conflicts=`：WebAPI 实验是人工命令而非 unit，而 systemd
> 会静默忽略指向不存在 unit 的 `Conflicts=`，那样只会制造“看起来有防护”的假象。
> 真正的防护是上面这些运行时检查。

## 5. 根分区磁盘守护

`shein-fm-disk-guard.timer` 每 15 分钟检查 `/`：

- `>= 75%` 告警（warning），journal 可见，退出码 0；
- `>= 85%` critical，**退出非零**，unit 显示为 failed，便于 ops 发现。

使用率由 `used/total` 自行推导，不解析 `df` 的本地化 `Use%` 列。状态文件原子写入
`/srv/shein-fm/runtime/disk-guard.json`（先写 `.tmp` 再 rename），并发读取不会看到
半个文件。

冷却：同一严重级别默认 60 分钟只播报一次；**严重级别变化立即播报**，不受冷却抑制；
`reportedAt` 落盘，重启后冷却仍然有效。

该工具**只观测**：不扫描、不删除、不清理，也不发明任何外部通知凭据。

## 6. 有界历史维护

```bash
npm run maintenance:history                                  # 只计划，输出 planHash
npm run maintenance:history -- --execute --plan-hash=<sha256> # 按已审阅计划执行
```

前置：`SHEIN_FM_MAINTENANCE_DATABASE_URL` 指向 owner 连接。

执行顺序（FK 安全）：

1. **拒绝在供应链同步进行中运行**。`ops.supply_sync_attempt` 是 append-only 事件表：
   存在 `STARTED` 但没有对应 `SUCCEEDED/PARTIAL/FAILED` 即视为进行中，
   以 `SUPPLY_SYNC_ACTIVE` 拒绝。
2. 获取专用 advisory 锁 `8842137001`（`pg_try_advisory_lock`，不阻塞）。
3. `ops.ensure_reconciliation_partitions(120, 14)` 预建未来分区并覆盖完整保留窗口
   （写入前必须存在）。
4. 对仍有明细的每一天刷新长期日汇总与异常表。
5. **DROP** 超过 14 天的对账明细分区（`DROP` 立即归还磁盘，`DELETE` 不会）。
6. 删除超过 14 天、且**不属于任何最新已接受投影批次**的
   `inventory_snapshot` / `warehouse_inventory_snapshot` / `stock_advice_snapshot` 行。
7. 清理超过 14 天的 `supply_projection_member` / `supply_projection_batch`，
   但**永久保留每个 (store, domain, subtype) 的最新批次**，无论其年龄。

### 6.1 最新批次保护口径（与读路径完全一致）

BI 读路径按 `(store_id, domain_code, subtype_code)` 取
`source_fetched_at DESC, supply_projection_batch_id DESC` 的第一条批次，再用
**精确的 `source_fetch_batch_id`** 关联快照。维护工具复用同一个 `latest_batch`
CTE，因此“受保护”严格等于“仪表盘仍可读到”。

- 库存快照按 **subtype** 区分：`latest_batch.subtype_code = target.inventory_type_code`，
  PI 批次不会保护 JI 行；
- 仓库快照跟随其**父库存快照**（`fk_fact_warehouse_inventory_store_snapshot`），
  父行受保护则子行受保护；
- 备货建议快照按 `domain_code = 'STOCK_ADVICE'` 的批次，无 subtype 维度。

> 不再使用时间戳比较。两个批次共享同一时刻时，时间戳猜测会删掉仪表盘仍在读的行，
> 同时留下已被取代的行。

### 6.2 append-only 旁路（仅 owner，事务内）

`fact.supply_projection_member` / `fact.supply_projection_batch` 上有两个
append-only 触发器，运行时角色**永远**不能删除投影行：

- `trg_fact_supply_projection_member_append_only`
- `trg_fact_supply_projection_batch_append_only`

维护工具在**同一个事务内**先证明 `current_user` 是这两张表的 owner 且触发器确实存在
（否则以 `PROJECTION_NOT_OWNED` / `PROJECTION_TRIGGER_MISSING` fail closed），
再 `DISABLE TRIGGER`，删除，然后 `ENABLE TRIGGER`。PostgreSQL 的 DDL 是事务性的，
因此**回滚会自动恢复触发器**，不存在运行时角色可以写入的窗口。删除顺序为
member → batch（member 引用 batch）。

### 6.3 事务边界

第 3–7 步的全部破坏性操作（分区 DROP、快照删除、投影删除、触发器开关）都在
**一个事务**内，要么全部提交要么全部回滚。`VACUUM FULL` 不能在事务内运行，因此只在
提交之后、且只在显式 `--reclaim` 下执行。

### 6.4 真实维护窗口门禁

`--execute` 在开启事务前还要证明供应链同步**无法启动**：

- `systemctl is-active shein-fm-supply-sync.service` 必须是 inactive/failed；
- `systemctl is-enabled shein-fm-supply-sync.timer` 不能是 enabled
  （否则定时器可能在事务中途触发）；
- `pg_stat_activity` 中不能有其他会话正在触碰供应链表。

仅 `--plan`（只读）不需要维护窗口。

`--plan-hash` 覆盖保留天数、cutoff、待删分区、目标表、候选行数、候选业务键指纹以及
是否 reclaim。计划生成后只要候选集合发生变化，哈希就会失效，必须重新出计划并审阅，
避免执行阶段删除与审阅时不同的一批数据。

永不清理：采购单、交付单、商品身份、销量 mart、WebAPI 登录态（见 `NEVER_PRUNE`）。

## 7. 迁移维护窗口：停机 → 备份 → 迁移 → 验证 → 恢复

`ops.reconciliation_result` 曾为 3,007,452 行 / ~1.78GB，而真实当前粒度只有 93,702 个。
根因是 `reconciliation_key` 里含 `sourceFetchedAt`，导致每批次都新建行、upsert 退化为 append。

迁移 0013 采用**重建并交换**（而非 2.9M 行 DELETE），因此需要一个受控窗口：

```bash
# 1. 停止会写入的定时器与服务
systemctl stop shein-fm-supply-sync.timer shein-fm-supply-sync.service
systemctl stop shein-fm-dashboard-materialize.timer
systemctl status shein-fm-supply-sync.service   # 确认 inactive

# 2. 迁移前全量备份（这是唯一的回滚证据）
bash scripts/backup_full_managed_db.sh --mode deploy
# 记录输出中的 backup 路径与 sha256

# 3. 迁移（runner 会重放全部 migration 与 verify）
bash scripts/migrate_full_managed_db.sh

# 4. 验证：0013 与 9999 必须都通过
#    verify 0013 会检查：无重复当前粒度、FK/identity/trigger/index 完好、
#    >=90 个分区、无伪造异常、无遗留 compact 影子表

# 5. 恢复服务
systemctl start shein-fm-supply-sync.timer
systemctl start shein-fm-dashboard-materialize.timer

# 6. 观察一次真实同步后再次确认当前表行数接近粒度数
```

### 可选：显式空间回收

`VACUUM FULL` 取排他锁，**绝不由任何定时器调度**，只能人工在窗口内执行：

```bash
# 仅在确认相关服务 inactive 后
npm run maintenance:history -- --execute --plan-hash=<sha256> --reclaim
```

`--reclaim` 必须与 `--execute` 同时给出，且仍要先通过同步空闲检查与 advisory 锁。
迁移 0013 已通过 drop 旧表归还了对账表的主要空间，因此多数情况下不需要 reclaim。

## 8. 恢复与回滚

- **迁移回滚**：从第 2 步的迁移前 dump 恢复；刻意不保留第二份在线影子表。
- **备份恢复**：从 `/srv/shein-fm/backups/db` 取 dump，先通过归档清单校验，再
  `pg_restore` 到临时库验证。
- **发布回滚**：`previous` 始终受保护，未被清理。
- **Profile 恢复**：登录态从未被删除；只有可再生缓存被清掉，Chrome 会自行重建。

## 9. 边界声明

以上全部工具、单元与迁移只作用于全托资产。它们不读写半托路径，不发起 SHEIN 写请求，
不触碰凭据，也不做任何外部通知。
