# 飞牛正式切流现场记录（2026-09-06，Asia/Shanghai）

## 当前结论

Portal/Webhook 公网 upstream 已切到飞牛，云端回滚保留；迁移总目标尚未终验完成。尚待真实回调端到端验收、切流后定时任务终态、稳定观察及克制的 GitHub 版本管理。不得据本文删除云端。

## 已验证的补数与回滚基线

- 本次 freezeFingerprint：`dac87518a9e3702ed4552f7e24b4417cb7815de69a7ce0a58edba92601952bd7`。
- dry-run 184633ms，精确计划 `3c5053f0103781bf053c610da3e0e9d2975f3a250bf6cdadb3f2303938e963c8`；42912 inserts / 0 updates。receipt/job/event 各6790，heartbeat19035，directive3507。
- `@900` 换防至 `@1260` 八阶段通过。执行入口显式预算1200000ms：execute840000、fresh dry120000、forward120000、cutover60000、recovery60000。守卫额外余量26362ms，引用额外余量549759ms；门禁通过才调用execute。
- execute终态 `applied / committed / readyForForwardBaseline=true`，569286ms。阶段：presnapshot78044、plan92905、validatehash91688、apply130997、finalvalidation77461、commit28、freshreadback86971（ms）。未删减任何哈希/回读步骤。
- 独立 fresh dry 92362ms，`already_applied`、全部新增/更新为0、ready=true。
- forward在 `2026-09-05T19:02:48.379Z` 生成基线；主代理再比对其七表、六序列、readiness、triggers与fresh dry两端一致。
- baselineFingerprint：`1bfe469a503fe2c7844659eacd45bb4090455b9bc4a93b5f01c9178ce1c2f44d`。
- 基线文件SHA256：`f95313ad08bb5b4415b25e48289cc9f9bb64ab94ada20f5994150e832bb2f2fc`。
- 本地：`tmp/fnos-candidate-ccad2a7-20260906T0206/forward-baseline-20260906T030248.json`（忽略目录，连同dry/execute/fresh证据保留）。
- 云端：`/var/backups/shein-fm/migration/forward-baseline-20260906T030248.json`，0600。
- 飞牛VM：`/srv/shein-fm/runtime/migration-evidence/fnos-20260906/forward-baseline.json`，0600。三处文件SHA一致。

## 单边运行与公网切换

- 云端receiver/worker/hydration.timer/hydration.path均已读回inactive+disabled；两个恢复guard读回inactive/PID0。
- VM原先因两个ConditionPathExists门禁不存在而跳过启动，未把enable命令成功误报为运行成功。基线通过后创建 `webhook-ingress.enabled` 与 `webhook-worker.enabled`，内容绑定本次baselineFingerprint。
- VM receiver：active/enabled，PID172753，InvocationID `5b4d8b470d7b4e7b8249f2f0957d817e`。
- VM worker：active/enabled，PID172754，InvocationID `c7c127a4ead2404e804533fc812bfd0f`。两者后续读回NRestarts=0。
- VM hydration未开启；其他数据质量门禁没有伪造或绕过。
- 云端Nginx配置 `/etc/nginx/shein-fm-upstreams.conf`：Portal18788、Webhook18793、StoreLogin18794，三个reverse监听均只绑定127.0.0.1。
- 配置SHA：`9897c97615f08e835cd1c6c2c615039c63d529a368ae77586a28108f7bbebbbc`。
- 旧混合upstream备份：`/var/backups/shein-fm/nginx/shein-fm-upstreams.conf.pre-fnos-20260906T0305`，旧SHA `dd8866987206f97e46231dafb1ea4bfdd9f5ea31484a2f4b9931d1768934503e`。
- 实际nginx -t通过后仅reload，master PID仍1188。云端域名TLS/Host健康检查及办公室外部HTTPS `/health` 均返回status=ok。
- 云端转发18793 `/healthz`返回ok=true。真实回调尚未新到达，不能以健康检查替代签名/落库/处理全链验收。
- D-Bus引用进程3363736在核对start ticks278837714后终止，独立确认/proc不存在；未留自动恢复进程。

## 切流后第一次只读数据库核对

- 基线receipt144069、heartbeat235912、job144069、event144069、directive75238、subscription0、gate0。
- 云端receipt144069/heartbeat235912/job144069保持基线。
- VM receipt144069/heartbeat235928/job144069，只有VM产生16条运行心跳。此证据支持单边运行，不证明真实平台回调已到达。

## 尚未完成的边界

### 03:10–03:13 真实回调终验更新

- VM receiver现场计数accepted22/duplicates18/appScopedOnly13/quarantined0/rejected0。随后以本次基线最大主键为边界，READ ONLY事务查到VM新增receipt/job/event各6条，6个job均SUCCEEDED；同期云端三项新增均0。
- 再按receipt_id逐条LEFT JOIN job与event，6条记录missing_job=0、missing_event=0、succeeded=6、retry_or_failed=0，重复投递计数合计18。真实签名回调已经经过接收、去重、持久化与worker处理；没有人为注入合成业务事件。
- 最初事件计数SQL误用event_id，查询失败；根据实际schema修正为operational_event_id后才获得上述结果，失败查询没有计入成功证据。
- receiver/worker依旧为PID172753/172754、原InvocationID、NRestarts0。OpenAPI tunnel active，18080/8788/8793均只监听127.0.0.1。
- 03:15财务timer现场active，NextElapse明确为当日03:15，service尚未触发；不把未运行的ExecMainStatus0作为成功。

### 03:15–03:18 财务自动调度与发布终验更新

- timer实际LastTrigger为03:15:46；finance service InvocationID `e664165135e34f3a93ddfebce22aa240`，初始PID175088，后读回inactive/PID0/Resultsuccess/ExecMainStatus0。
- 同次 `observed_at >= 2026-09-05T19:15:46.142Z` 的窗口表：25店、25窗口全部SUCCEEDED，日期2026-08-29至2026-09-04。协调器finance阶段attempts1、pendingStores空、lastExitCode0。
- OnSuccess自动触发既有dashboard-materialize服务，InvocationID `753414bc709e4ec08814a5d180257687`，03:17:44开始，后读回inactive/PID0/Resultsuccess/ExecMainStatus0。没有手动重复运行或新增调度。
- `fm-finance-daily-2026-09-06.json` 最终PUBLISHED，readyAt `2026-09-05T19:17:44.749Z`，publishedAt `2026-09-05T19:18:19.547Z`。
- dashboard.home.json mtime `2026-09-05T19:18:04.325Z`，内容updatedAt `2026-09-05T19:17:37.698Z`。dashboard.json虽刷新文件，内容updatedAt仍14:37:58.021Z，不据mtime宣称所有域最新。
- order-management.next.json仍coverage.status=PARTIAL/promotable=false，保持不发布。该局部质量边界没有因财务发布而被覆盖。

### 03:25–03:32 实时任务试运行及小时调度移交

- 决策纠正：coordinator的terminalPartial会保留告警并标记阶段COMPLETE，全部阶段完成后可READY_TO_PUBLISH。不能声称任何PARTIAL都必然WAITING_PLATFORM/exit2且阻止OnSuccess。发布门禁应以实际物化数据质量语义验收。
- 主代理实读物化器与线上dashboard.json：quality.status=partial，明确说明缺日期非零SKU已隔离、销售卡片/趋势/排行榜只汇总有日期SKU、当前数值不是完整总量。保持原规则，没有放宽日期门禁。
- 云端timer disabled/inactive、service历史failed/PID0；VM相关任务均停止、两项既有会话门禁存在后，单次启动home-realtime，InvocationID `5f62c54690504528908281221d746723`，PID177864，03:25:49.926开始。
- 本次首页阶段COMPLETE/attempts1/exit0；销量阶段25店记录均SUCCEEDED+PARTIAL，attempts1/exit2，协调器保留TERMINAL_DATA_QUALITY_GAP及25条终态明细，没有为质量缺口反复请求。
- 以该InvocationID过滤systemd管理器日志，确认Deactivated successfully及Triggering OnSuccess。首次宽日志读取触发ENOBUFS，随后改为源端限定_PID=1、UNIT及InvocationID获取终态，未据读取错误重启任务。
- 自动物化后该小时协调器PUBLISHED，publishedAt `2026-09-05T19:29:13.860Z`；dashboard.json updatedAt `2026-09-05T19:28:33.829Z`，质量提示明确本轮3个SKU被隔离，仍为partial。
- 原有 `shein-fm-home-realtime.timer` 已启用，读回loaded/active/enabled，NextElapse为2026-09-06 04:02:00 CST。未修改每小时:02规则、未增加timer或heartbeat；云端同类timer保持disabled/inactive。
- MZ诊断工具尚未生产准入：发现写死资源指标、上海时区结束日计算错误、范围/代理/锁约束不足等问题，已退回原作者；禁止执行未验收版本。

### MZ采购历史单窗口只读诊断更新

- 修订诊断脚本本地8测试通过，维护目录独立部署，指向已验收ccad2a7源模块；未修改正式release。脚本SHA `60cf55bb616a173cc7fda0dfcc712a73eb0dab777b6dcd51dcbe61db75d3bfc0`。
- 由sheinfm-supply用户运行，沿用api-light/fm/openapi资源通道和 `/run/shein-fm-supply/sync.lock`，proxy严格127.0.0.1:18080。PG连接default_transaction_read_only=on、statement_timeout15s、lock_timeout3s；不调用loader或checkpoint写入。
- 首次unit `shein-fm-mz-readonly-diagnostic-20260906T0335` 被客户端构造阶段的REAL_OPENAPI_CLOUD_ATTESTATION_REQUIRED拦截，没有HTTP调用。补齐与正式服务一致的SHEIN_FM_CLOUD_EXECUTION=1后，单次unit `shein-fm-mz-readonly-diagnostic-20260906T0340`、InvocationID `deb8589fa66c4c8a8688cee2ce1968b3` 完成诊断。
- 精确MZ2406、2026-08-19窗口返回16单；15单指纹一致，1单同source timestamp下指纹不同，数据库无缺单。该单可比主表字段无差异，JIT关联均0，明细均1行但身份键不匹配。尚不能排他认定上游静默修改或历史映射差异，也尚未定位到具体哪一个身份字段。
- 脱敏报告：`tmp/fnos-mz-diagnostic-20260906/live-sanitized-report.json`。旧指纹 `860ef36199cd88afd2e1d85b63663f96c030e8384a04dd8b4156ec2cc15c5589`，新指纹 `fe06a1476128472c22c346a3a185c9e237c8fcdf29010ced69e802ade6b6995f`。这些指纹只是诊断证据，不是覆盖授权或可复用执行计划。
- journal JSON的长MESSAGE字段可能为字节数组，首次读取漏掉报告；随后使用--all/字节解码取回完整报告，未因观察缺失重启成功诊断。采购业务数据保持未覆盖。

- 03:15 VM财务定时任务已按上述更新完成终验；05:45日更及后续稳定观察仍待验证。云端财务/日更/续期/home-realtime定时器已读回disabled/inactive。
- MZ2406 2026-08-19采购仍为 `PURCHASE_ORDER_SAME_TIME_PAYLOAD_DRIFT`。进一步诊断代理上游错误终结，尚无新的根因证据；未重试API或覆盖旧数据。
- realtime与订单候选的PARTIAL状态不计通过；尚未开启相关生产门禁。
- 未push、tag、创建GitHub Release或删除云端；稳定观察尚未完成。
- 回滚必须先冻结VM，遵循 `fnos-cutover.md` 的reverse dry/精确hash execute/权威回读流程。VM已开始写入运行心跳，不得直接启动云端旧writer或只还原Nginx。
