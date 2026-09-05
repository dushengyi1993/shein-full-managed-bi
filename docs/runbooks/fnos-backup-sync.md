# 飞牛独立盘备份同步

## 完成边界

本链路只同步已经生成的 PostgreSQL 自定义格式 dump，不复制运行中的数据库目录或 VM 镜像。
发送端先固定源文件句柄、inode、大小、mtime/ctime，算哈希并通过 `pg_restore --list`，再传输；接收端 fsync、重算大小/哈希后无覆盖发布；发送端核验回执并再次核对源哈希。
归档清单校验不等于恢复演练。整库恢复仍由既有恢复验证任务负责。

2026-09-05 20:43（北京时间）：专用受限身份、双方脚本与同步服务已安装。真实约1.28GB归档传输终结成功，独立NAS读回大小、0600与SHA-256一致；返回 `already_present`，没有覆盖既有文件。此测试源为9月2日快照，不是当日新备份。

发送端已修复归档清单提前EOF销毁固定文件句柄的问题，本地7项测试通过，VM真实 `pg_restore --list` 后同一fd再次完整哈希通过。新脚本SHA-256为 `b99ad964cf74c7630dee14ec17cc5a8bbf4842a32793b9c22e27fa654f780586`；旧脚本保留于同目录 `.pre-fd-fix`。

既有备份服务的 `60-nas-sync.conf` 已安装（仓库模板 `infra/systemd/shein-fm-db-backup-nas-sync.conf`），`OnSuccess`属性已读回。备份定时器仍未启用；接线不等于新备份生成到同步的完整链路已验收。

## 固定边界

- VM 源：`/srv/shein-fm/backups/db/shein-fm-weekly-YYYYMMDDTHHMMSSZ.dump` 及高风险迁移/发布前的 `/srv/shein-fm/backups/db/shein-fm-deploy-YYYYMMDDTHHMMSSZ.dump`。最新完成备份（`--latest-completed`）按文件名内嵌入的 UTC 时间戳统一排序选取，不按前缀字母排序，防止 `deploy` 模式备份被 `OnSuccess` 漏同步。非规范命名、目录、`.partial` 临时文件及 `daily` 备份严格拒绝同步。
- NAS 目标：`/vol3/shein-fm-backups`，必须现场核对仍属于独立备份盘，不能仅凭路径名字判断。
- NAS 接收器：`/home/dushengyi/.local/libexec/shein-fm-backup-receiver.py`，Python 标准库，无第三方依赖。
- VM 专用身份：`/srv/shein-fm/secrets/backup-nas-sync/id_ed25519`，root:root 0600；known_hosts 同目录，必须使用独立已核验的 NAS host key，不自动接受新 key。
- 私钥在 VM 内新建并仅留在 VM；不能复制操作者的 Windows 私钥。
- NAS authorized_keys 的该专用公钥行必须限制来源 `192.168.1.79`、使用 `restrict`、固定 forced-command 为上述 Python 接收器。不得用不受限的交互 SSH key 代替。
- 接收器命令没有目标目录参数，协议头仅接受版本、规范文件名、大小和 SHA-256。授权行及脚本安装前须备份旧配置，保持其他 authorized_keys 行不变。

## 安装与接线顺序

1. 主代理核对目标盘挂载、可用空间、接收目录与脚本路径权限；部署双方脚本并读回 SHA-256。接收器不提升权限。
2. 建立上述受限专用身份和固定 host key，先做非敏感合成数据协议测试及错误路径检查，不能发送生产凭据到输出。
3. 发送端默认 dry-run；它不连接 NAS，也不证明归档已通过清单校验：

   `node scripts/sync_full_managed_backup_nas.mjs --latest-completed`

4. 用准确固定的正式 dump 路径执行一次 `--source=<完整路径> --execute`；独立读回 NAS 正式文件大小、哈希、0600，以及 VM `runtime/backup-nas-sync/latest.json`。重复同一备份应返回 `already_present`，冲突不能覆盖。
5. 安装 `shein-fm-backup-sync-nas.service`。在既有 `shein-fm-db-backup.service` 的专用 drop-in 添加 `[Unit] OnSuccess=shein-fm-backup-sync-nas.service`；先用本机 systemd 版本验证该指令支持情况。不新增 timer，不改现有备份时间。
6. 同步 service 本身再经过 io-heavy 资源检查。退出75代表暂缓，不是副本更新完成。既有备份单元将75视为成功，因此 OnSuccess 可能触发对旧完成文件的幂等核验；不能据此称有新备份。
7. 只有真实一次备份完成到同步回执、独立盘文件的完整链路核验后，才能称自动同步已通过。启用既有备份 timer 属于整体切流时的调度所有权步骤，不能同时新建另一个排班。

## 故障及回滚

- 不删除源归档；目标同名异哈希拒绝覆盖；接收器只清理自己本次创建的临时文件。
- 进程被强制杀死或机器掉电可能留下 `.partial` 或 VM `sync.lock`。不要自动按年龄删除。先确认没有 sender/receiver 活进程及锁持有者，再由操作者按精确路径处理，不能扫目录清理。
- SSH/归档工具 stderr 不进入用户回执；对外只有固定错误码。清单内容也不写入回执。
- 回滚只移除本次 OnSuccess drop-in、停用同步 service，并撤回本次专用公钥行。保留源和独立盘备份、既有其他授权以及既有备份调度。
- 当前方案是“每份完成备份自动复制”，不是实时数据库容灾或任意时间点恢复。断电时仍受最近完成备份时间限制。

## 测试

- `node --test tests/maintenance/backup-nas-sync.test.mjs`
- Linux：`python3 tests/maintenance/backup-nas-receiver-test.py`（独占临时目录，合成内容，不用正式备份）。
- 发送端测试不能替代真实 SSH forced-command 验证；接收器测试不能证明实际目标盘挂载正确。
