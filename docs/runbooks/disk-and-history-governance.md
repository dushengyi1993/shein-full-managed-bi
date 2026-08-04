# 全托磁盘与历史治理运维手册

本手册只覆盖全托（full-managed）资产。所有工具都硬编码全托固定路径，
`/opt/shein-bi`、`/srv/shein-bi`、`/lhcos-data/shein-bi-archive` 等半托路径会被
`FORBIDDEN_PREFIXES` 直接拒绝，不存在“传参切到半托”的可能。

所有破坏性工具都是**默认只计划（plan）**，必须显式加 `--apply`（历史维护还需
`--execute` 加计划哈希）才会动数据。任何校验失败都是 fail closed：源文件保留、
命令非零退出。

## 1. 数据库备份模式与保留策略

`scripts/backup_full_managed_db.sh` 必须带 `--mode`：

| 模式 | 触发方式 | 频率约束 |
| --- | --- | --- |
| `--mode daily` | `shein-fm-db-backup.timer`（每日 01:55 Asia/Shanghai） | 每个 **UTC 自然日**最多一次成功备份，重复触发直接跳过 |
| `--mode deploy` | 部署时人工调用 | 2 小时冷却窗口；超过本地上限只告警，实际回收交给归档工具 |

两种模式共用主机锁 `/srv/shein-fm/runtime/db-backup.lock`，部署备份不会和定时器
互相打断。落盘后按 SHA-256 去重：内容完全相同的 dump 会被丢弃而不是存两份。
定时 daily 单元只生成和校验 dump；12:45 的独立归档单元负责 COS 复制与保留治理，
避免大文件复制占住 02:20 半托会话窗口。

**保留规则**（`selectBackupsForArchive`）：

- 生产默认在数据盘保留最近 **7 个 UTC 自然日**每天最新一份 dump；
- 再额外保留 **3 份最新**的其他 dump（应对同日部署和迁移的短尾）；
- 过期本地 dump 只有在 COS 副本完成大小与 SHA-256 校验后才删除，因此
  GitHub 版本历史不能、也不会被当作数据库备份的替代品；
- 其余数据库 dump 成为归档候选；
- `edge-*`、`*.tar.gz`、配置类备份等**非数据库备份永不参与清理**。

> 注意：窗口是**自然日**而不是“有备份的那 7 天”。否则备份稀疏时，一份 19 天前的
> dump 会长期占住“最近一天”的名额、永不过期。

## 2. COS 归档与两阶段校验

归档命名空间固定为 `/lhcos-data/shein-fm-archive`。

```bash
npm run maintenance:backup-archive              # 只计划
npm run maintenance:backup-archive -- --apply   # 归档并删除本地过期 dump
```

`--apply` 严格按顺序执行，任一步失败即中止且**不删除本地源文件**：

1. 复制到 `<name>.partial`，再原子改名为目标名（不留半个对象）；
2. 独立 `stat` 校验目标字节数与源一致；
3. 独立重算目标 SHA-256 并与源比对；
4. 写 `<name>.manifest.json` 清单；
5. 才删除精确的本地源文件。

清单格式：

```json
{
  "schemaVersion": 1,
  "sourceName": "shein-fm-daily-20260705T021500Z.dump",
  "bytes": 5510234112,
  "sha256": "<64 hex>",
  "archiveTarget": "/lhcos-data/shein-fm-archive/shein-fm-daily-20260705T021500Z.dump",
  "archivedAt": "2026-07-29T03:10:00.000Z",
  "replayed": false
}
```

幂等重放：目标已存在且字节数与哈希都一致时视为已归档（`replayed: true`）并继续
删源；**同名但内容不同**会以 `ARCHIVE_CONFLICT` 失败，绝不覆盖。

COS 未挂载时归档命令非零退出，本地 dump 全部保留——磁盘紧张优于数据丢失。

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

规范 Profile 只有两个：`persistent-dl5477-profile`、`persistent-mz2406-profile`。

```bash
npm run maintenance:prune-profile-caches              # 只计划
npm run maintenance:prune-profile-caches -- --apply   # 空闲时执行
```

定时器 `shein-fm-profile-cache-prune.timer` 每周日 04:40 执行，避开夜间同步与备份。

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

- **迁移回滚**：从第 2 步的迁移前 dump 恢复。旧的 3M 行只存在于该 dump 与其 COS
  归档副本中——刻意不保留第二份 1.7GB 影子表。
- **备份恢复**：从 `/srv/shein-fm/backups/db` 或 COS 归档取 dump，先按清单核对
  字节数与 SHA-256，再 `pg_restore`。
- **发布回滚**：`previous` 始终受保护，未被清理。
- **Profile 恢复**：登录态从未被删除；只有可再生缓存被清掉，Chrome 会自行重建。

## 9. 边界声明

以上全部工具、单元与迁移只作用于全托资产。它们不读写半托路径，不发起 SHEIN 写请求，
不触碰凭据，也不做任何外部通知。
