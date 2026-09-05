# 飞牛正式切流现场记录（2026-09-06，Asia/Shanghai）

## 当前结论

截至04:26，Portal/Webhook公网upstream已切到飞牛，云端回滚保留。真实回调接收处理、财务与小时任务自动运行、补采首次自动运行、真实事件触发页面物化均已有下文终态证据。迁移总目标仍未完成：05:45日更、MZ定向纠偏授权与供应门禁、局部业务数据覆盖缺口及稳定观察仍待处理；GitHub推送/发版暂缓。不得据本文删除云端。

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

### 03:49后现场更新：单行差异字段已定位

- 本节更新前文时点状态，不将历史待验事项冒充当前结论。真实回调、财务自动调度已按上文完成；realtime受控运行已发布且保留partial质量提示，04:02自动触发和05:45日更尚待实际终态。supply与hydration尚未放行，迁移总目标仍未完成。
- 03:49现场VM receiver仍为PID172753、InvocationID `5b4d8b470d7b4e7b8249f2f0957d817e`、NRestarts0，worker active；数据盘37G已用、158G可用。首次探测误用了不存在的 `shein-fm-webhook.service`，已通过unit清单纠正为 `shein-fm-webhook-receiver.service`，未误判为接收故障或执行重启。
- 云端receiver/worker、realtime/daily timer均再次读回inactive/disabled；公网upstream SHA仍为 `9897c97615f08e835cd1c6c2c615039c63d529a368ae77586a28108f7bbebbbc`，域名TLS健康请求status=ok。
- 诊断补丁CLI残留异常信息回显经主代理复核发现、退回修复，11项测试独立重跑通过。新诊断脚本SHA `12305ce65906229be31320daa2308403c182c4d759aa5475eb4b7e4f1567715f`，部署至独立维护目录 `/opt/shein-fm/maintenance/mz-diagnostic-12305ce65906`，未修改正式release。
- 单次unit `shein-fm-mz-readonly-diagnostic-12305ce65906`，InvocationID `62e14898c0314619a1eb4cae8eb44914`，初始PID184162；PG默认只读、host lane与supply锁、仅OpenAPI代理保持不变。journal完整报告ok=true，按InvocationID取systemd管理器终态为Deactivated successfully；没有根据回收后的空InvocationID判断成功。
- MZ2406、2026-08-19仍返回16单，15单指纹一致，1单同时间戳冲突，数据库无缺单。冲突单为1/1明细，唯一不同的身份字段名为 `supplierSku`，`skuCode`、`skc`、`supplierCode`一致，主表可比字段与JIT关系未见差异；未对身份不匹配行证明所有非身份数量字段一致。
- 两次观察的新旧订单指纹均相同，证据保存 `tmp/fnos-mz-diagnostic-20260906/live-sanitized-report-v2.json`。这不证明平台变化或旧映射是唯一原因；未输出具体SKU值、未覆盖业务记录、未更新checkpoint或供应门禁。下一步核对既有映射与历史来源，不盲目重复调用API。

### 03:53–03:59 两端源记录与完整指纹重构

- 独立在云端与VM执行READ ONLY，按MZ2406和旧订单指纹精确定位：各1单1行、sourceTime均2026-08-19T03:00:32Z、supplierSkuNullCount均1，身份字段/明细指纹/sourceTime排序聚合md5均 `f95e31bf9644e5757d10908ec09fdbaa`。这支持该历史字段没有在搬库时被改写，不证明上游变化的具体时间或责任来源。
- 本地真实指纹重构测试12/12通过，新维护脚本SHA `2b2f78cded827a29b0002452fd5d187d6ace9319f9a8de8543f92384298ebd83`；单次只读unit `shein-fm-mz-readonly-diagnostic-2b2f78cded82`，InvocationID `3c0e789984ec4bd881fa587c0833463d`、初始PID185953，完整报告ok=true且管理器终态Deactivated successfully。
- 同一16单仍15同/1差，旧新指纹保持一致。将当前规范订单内唯一行的supplierSku在内存中换回历史NULL，完整订单指纹精确等于历史指纹；currentSupplierSkuPresent=true/historySupplierSkuPresent=false。该结果支持在现有订单指纹覆盖范围内仅supplierSku不同，不是对原始HTTP未入模字段的证明。
- 脱敏证据 `tmp/fnos-mz-diagnostic-20260906/live-sanitized-report-v3.json`。未修正数据库、未放宽同时间戳守卫、未执行供应补数；任何单单纠偏仍须当前计划和授权，保留旧版本与审计，不能直接改指纹冒充加载成功。

### 入口HTTP异常观察（截至03:59）

- 读取实际站点配置确认独立日志路径后检查：portal访问日志全文件中切流后3次请求均200；Webhook访问日志全文件中切流后48次请求，42次200、6次503。不能宣称切流后零错误。
- 六次503均在03:10:04，POST、耗时0–1毫秒。receiver同一Invocation未重启，健康ok=true，accepted42/duplicates18/appScopedOnly23/quarantined0/rejected0；03:09–03:12该Invocation无应用拒绝日志。后续03:13、03:30、03:32、03:33、03:38记录均为200。
- 现场Nginx的请求速率限制返回429，连接数限制为20；上述证据倾向连接数限制产生503，但无upstream_status/limit_conn_status且Webhook error_log为crit，不能最终定因或逐条证明6个失败请求后来全部重投成功。未擅自放宽限制或重放平台事件。
- 03:59:39的realtime timer仍active，NextElapse04:02，LastTrigger为空；尚未自动触发，不算自动调度终验通过。

### 04:02–04:05 小时任务首次自动运行终验

- timer现场LastTrigger明确为04:02:00；service自动启动PID186771、InvocationID `6b45974f83ba47c1a31ec18436ed6a99`，协调器startedAt `2026-09-05T20:02:00.737Z`。没有手动重复启动。
- 04:02:30首页阶段COMPLETE/attempts1/exit0；销量随后COMPLETE/attempts1/exit2，保留TERMINAL_DATA_QUALITY_GAP和25条终态明细。按该startedAt读DB：25店25条均SUCCEEDED/PARTIAL，quarantined_sku_count合计3。
- `fm-realtime-cockpit-2026-09-06T04.json` 最终PUBLISHED，publishedAt `2026-09-05T20:05:18.606Z`。按上述Invocation过滤systemd管理器日志确认Deactivated successfully、Triggering OnSuccess；物化服务随后inactive/PID0，Invocation `3ff28ce395c842a7809dd6e15751cea3`。
- timer下一次为05:02:00，原小时规则不变。自动执行/协调发布链路通过；PARTIAL数据覆盖仍不是完整业务总量，不能合并为全部数据门禁通过。
- 同期两端只读回调增量核对：VM新增receipt/job/event各24，24个job均SUCCEEDED；云端新增均0。Hydration存量VM为PENDING67353/RETRY1/FAILED161/SUCCEEDED7735，云端PENDING67341、其余三类相同，没有RUNNING项。
- Hydration runner/repository/infra七测试独立通过。实读docs/cloud-deployment.md的Webhook步骤及systemd单元，hydration为独立点查链，不以supply-backfill.verified为启动条件。应使用当前真实的store-scoped `full-managed-catalog:${storeId}`事务锁（supply-repository.mjs），不是分析代理误援引的sales loader锁；同一组三条内若同店一起失败会影响该组，不声称绝对单单隔离。
- 云端hydration service inactive/PID0、timer/path inactive/disabled，VM相同；尚未启动或新建门禁。04:05之后资源检查READY（load1=0.15、availableMemory约11097MiB、memoryFull0、ioFull4.42），仅作为当次预检查，不复用于未来生产启动。
- MZ定向纠偏授权尚待用户实际答复；自动goal继续不作为该纠偏授权。05:45日更、hydration受控启动与后续稳定观察仍未完成。

### 04:08后 Hydration受控验证与原调度移交

- fresh preflight：25店配置无阻断，VM/cloud hydration service/timer/path均inactive，VM无其他小时采集/物化运行，资源READY；无RUNNING租约，支持的可认领指令11239条，排序前30条ID摘要 `495e23e9c1f244277401dc62026b7734`。配置未输出凭据。
- 以单次试运行专属门禁启动原service，createdAt `2026-09-05T20:08:24.484Z`，InvocationID `268e61622c004b3a83c7c07b1a0de702`，PID188849，ConditionResult=yes。保持原资源通道、代理、权限、最多10批×3条规则，未开启timer/path。
- 终态summary：claimed30/succeeded29/retrying1/groups27。不能将summary.retrying1直接描述为数据库仍RETRY：独立READ ONLY实际为29条SUCCEEDED/attempt1，1条FAILED/attempt8/WEBHOOK_READBACK_NOT_READY；它是之前已有的第7次RETRY交付指令，第8次后按既有规则终结。
- manager按上述Invocation读回Deactivated successfully；service inactive/PID0后核对试运行门禁createdAt和mode再删除，未删除他人门禁。失败项类型DELIVERY_READBACK、不匹配MZ冲突订单；未重放或纠偏。
- 对本次29条SUCCEEDED展开businessKey/businessKeys并按store+type+key联查事实表：29条directive、29个键、missingFacts0。该证据支持对应事实存在及原runner点查终态，不虚称29条全部是新插入或Dashboard已被本次补采刷新。
- 单项旧失败隔离保留，不阻塞独立成功指令。再次核对云端全部inactive/disabled、VM资源READY后，将门禁改为绑定上述试运行和回滚基线的既有调度移交记录；仅启用原 `shein-fm-webhook-hydration.timer` 与 `.path`。读回两者active/enabled，service inactive，NextElapse04:17:00；未新增timer、heartbeat或改动原每小时07/17/27/37/47/57规则。
- 尚待原调度实际自动运行与长期积压处理观察；本次不宣称全部pending指令完成，不开启supply-backfill门禁。FAILED旧交付项、MZ授权、05:45日更和稳定观察继续保留为未完成项。

### 04:13–04:15 事件页面更新链路补齐

- 现场发现VM `shein-fm-webhook-dashboard-enqueue.path` 和 `shein-fm-dashboard-materialize-retry.path` 均inactive/disabled；云端两者inactive但仍enabled。仅有worker写dashboard.request不代表页面监听已迁移。
- 实读原enqueue脚本：300秒合并等待后，仅当真实request marker比dashboard.home.json更新才touch pending/kick；retry.path监听kick运行原only-pending物化器。没有创建新轮询或修改这套规则。
- materializer.enabled与request目录现场存在，资源READY，相关物化service均inactive。先将云端两个path disable --now并读回inactive/disabled，再在VM enable --now，逐个读回active/enabled/ConditionResult=yes。云端历史failed enqueue服务未重置或重启。
- 因最近request为19:38:40Z、home文件mtime20:05:04Z，启用PathModified不会重放该旧事件。为读回刚完成补采后的页面生成，单次启动原materializer，InvocationID `bafefc3d5b0d4bc8b0fdc224e899a8d9`、PID190763，随后以管理器Invocation日志确认Deactivated successfully，service inactive/PID0。
- dashboard.home.json mtime20:15:16.706Z但内容updatedAt仍19:17:37.698Z；dashboard.json mtime20:15:17.130Z、内容updatedAt20:04:40.801Z、quality partial。不得凭文件mtime把所有业务数据说成20:15最新。
- order-management.next.json mtime20:15:29.214Z、内容updatedAt20:15:22.615Z，coverage PARTIAL/promotable=false，未晋升候选。
- 这证明监听所有权移交与一次真实物化完成，不替代下一条真实事件触发两级监听的端到端证据。此时hydration timer下一次仍04:17、尚无LastTrigger，自动运行仍待终态。

### 04:17首次自动补采与安全可观测性

- hydration timer实际LastTrigger为04:17:06，service PID191292、InvocationID `c76f478166814006a0b9e567d9223af7`；原任务自行触发，未手动补跑。
- 完整summary claimed30/succeeded30/retrying0/groups28；独立DB读取该次completedAt范围：30条SUCCEEDED，展开业务键联查事实表为30条directive/30个键/missingFacts0；管理器Invocation日志确认Deactivated successfully。未把service默认success替代实际终态。
- 为今后区分入口与后端503，worker仅更改现有shein_fm_webhook_safe日志格式，末尾追加upstream_status/limit_conn_status/limit_req_status三个判别字段；新增2项安全/不改路由阈值测试独立通过。未加入签名、请求体、查询参数或任意认证请求头。
- 云端Nginx现场1.24.0。部署前将候选除日志格式外的全部文本与现场精确比对；备份 `/var/backups/shein-fm/nginx/shein-fm.pre-observability-20260906T0420`，旧SHA `1a2094950b1b0874542904d803799ac283219be42c3b475b6950376da221e1c0`，新SHA `a04e0f0fd3534f8ee2016bd8b5ddca77a9eebe97f959a3615ac84caa15cd5bfb`。
- 实际nginx -t通过后仅reload，主进程仍1188/active；公网Portal健康status=ok，upstreams SHA仍 `9897c97615f08e835cd1c6c2c615039c63d529a368ae77586a28108f7bbebbbc`。没有放宽限流或改变后端归属。
- 新字段只能验证后续请求，不能倒推证明03:10旧503的来源。GET回调健康端点不是签名业务事件，不记作新增业务验收样本。
- 04:21:39的GET健康探测返回200，安全日志实际读回upstream=200/limit_conn=PASSED/limit_req=PASSED，三个新字段已真实生效。

### 04:20–04:26 真实事件驱动页面更新终验

- DB只读确认20:20:21.069454Z至20:20:21.382813Z收到4条真实receipt，关联4个job均SUCCEEDED；request marker随后更新至20:20:51.472Z。没有人为写marker或注入签名业务事件。
- 原enqueue服务自动启动于04:20:21，InvocationID `8a5b4143675d4f50bc35ac73dc7db4d9`、PID192056；原300秒合并等待后，retry.path自动启动only-pending物化器于04:25:21，InvocationID `d1cabac91ea845f2bbc4ba3a182a1dd1`、PID193130。
- 两个服务分别按Invocation读管理器日志均Deactivated successfully；pending marker最终不存在。dashboard.home.json mtime20:25:39.544Z、dashboard.json mtime20:25:40.252Z，证明本次生成完成，不证明业务源时间推进：两者内容updatedAt仍19:17:37.698Z/20:04:40.801Z，销量quality仍partial。
- order-management.next.json updatedAt20:25:45.826Z、coverage PARTIAL/promotable=false，继续禁止晋升。事件监听→合并等待→物化路径通过，局部数据覆盖门禁没有放宽。
- 本地Webhook全套228测试：226通过、0失败、2项真实数据库测试跳过；新增安全日志2测试通过，staged diff检查通过。代码/文档仅准备本地版本记录，不推送、发tag或触发CI。

### 04:30后订单Session快照缺失定位（只读）

- canonical `/srv/shein-fm/runtime/dashboard/order-management.sessions.json` 现场不存在；当前物化候选六个SESSION_HTTP页均为SESSION_SNAPSHOT_ABSENT。0行表示未取得快照，不代表这些域无业务记录。
- 旧候选 `/run/shein-fm-webapi/order-management-candidate-20260905.json` 仍存在，12096553字节、mtime2026-09-05T14:21:19.390Z，内容updatedAt14:19:42.127Z、roster25。未替换正式快照、未重新采集。
- 旧候选四页AVAILABLE且25店四项校验全通过：waybills3378、return-applications472、return-orders696、value-added-services382行。stock-records PARTIAL/storeCount3、exceptions PARTIAL/storeCount16、quality-reports UNAVAILABLE/storeCount0。
- 独立汇总perStore证据：stock22店totalVerified/contentVerified为false，但25店paging/dedupe均true；exceptions9店total/paging/content为false；quality25店total/paging/content为false，三页dedupe均true。exceptions/quality存在字符串形式fetch failures，尚未解析具体原因；不能从这些门禁单独断言认证过期或真实缺单数。
- 后续静态生成/推广链路核对已交给GLM5.3Flash；已按用户要求关闭此前Gemini子代理。此时05:45日更timer仍active且未触发，不能保证它将自动补齐全部候选。

### 新日志已区分入口503（04:29样本）

- 新格式实际32条POST：26条200/upstream200/limit_connPASSED/limit_reqPASSED，6条503/upstream-/limit_connREJECTED/limit_reqPASSED。这六条可明确归因为Nginx并发连接限制，而非应用拒绝；不得将此证据倒推至03:10旧格式样本。
- 聚合来源只有一个IP（未输出IP值）；成功耗时min0.551s/median0.618s/p950.802s/max0.803s。04:29:24–25突发20成功、6拒绝，04:30:38–04:31:03另有6成功；后者数量相同不证明与先前拒绝请求逐条对应。
- 保持现有限制不变，GLM只读审查当前并发、超时与PG池约束后再决定是否需要变更；未用HTTP状态码改名冒充解决投递可靠性。
- 首个bai GLM快照explorer明确以通道401鉴权错误终结，已关闭；这不是SHEIN认证过期。按用户先前指定的codexapis渠道重新分配同一GLM5.3Flash只读任务；派发已接受，但尚未取得终态交付。未回退Gemini、未修改全局配置。
- 随后codexapis任务通知为429重试耗尽，未形成交付。另需保留状态差异：首个bai任务关闭调用返回previous_status=running，与先前errored通知不一致；已显式关闭并取消其旧只读范围，不将其描述为始终停止。通道错误不计为业务故障或迁移验收通过。

### 04:40前后日更接线独立核对

- 失败explorer范围由主代理明确接回只读检查。主代理实读源码，并在VM导入当前release的buildCoordinatorPlan('daily-operations')独立输出阶段：只有home-history与home-ledger。05:45日更不会生成order-management.sessions.json；不能以等待此日更替代修复订单快照缺口。
- sync_full_managed_order_management_sessions.mjs会将构造出的快照写到明确output，包含PARTIAL页也会写候选；CLI要求完整25店范围。没有证据可将canonical不存在单独归因于它的全量写出门禁，也不能为单店诊断直接放宽该CLI范围要求。
- 按源码safeFetchFailure格式对白名单错误码脱敏分类旧候选：quality-reports 25店ORDER_MANAGEMENT_AUTH_EXPIRED/PLATFORM_100004及PAGING_INCOMPLETE；exceptions9店ORDER_MANAGEMENT_BUSINESS_STATUS_FAILED及PAGING_INCOMPLETE。stock-records没有fetch failure、但22店内容/总数校验失败。均为14:19Z旧样本，不证明当前已恢复会话仍失败。
- 限流advisor亦由运行时明确返回通道400错误，未交付建议。没有把其超时观察当失败，也没有在错误后切回Gemini或更换其他模型；现有限流参数未动。

### 04:49–04:51 当前会话最小端点对照

- 本轮重新读取两项GLM句柄：Banach明确errored/400，Kuhn明确errored/429 retry limit；没有有效交付，主代理继续已披露的只读检查，不启用Gemini或改全局配置。
- VM现场04:49:12 receiver、worker、hydration timer均active，release仍ccad2a7；hydration LastTrigger04:47:11，realtime下一次05:02、daily下一次05:45。这些运行状态不替代任务终态或完整迁移验收。
- 使用当前release现有单店HTTP适配器及createEphemeralWebApiSessionStore，将DL5477加密会话读取到内存；仅白名单只读端点、每端点第一页、30天窗口2026-08-08至2026-09-06。未改全25店采集CLI守卫，未打开浏览器，未持久化会话或业务数据。
- 首个transient诊断因ProtectSystem=strict未给两个既有api-light锁文件可写权限而在网络请求前退出。输出的API_LIGHT_SLOTS_BUSY属于该包装器的误导性分类，本次实际原因是Read-only file system，不能称服务压力繁忙。随后只补两个锁文件的ReadWritePaths，其余文件系统继续只读；资源门禁READY。
- 20:50:17.398Z质检单页返回ORDER_MANAGEMENT_AUTH_EXPIRED/platformCode100004，未取得记录；20:50:46.092Z同店同来源会话运单单页HTTP200、total164、firstPageRows50。没有全量翻页，164是接口报告总数，不是本次已采集164行。
- 对照证明当前DL会话可以读取运单，而质检仍失败；不能解释为全店登录态失效，也不能将DL结果推广为25店现况。质检独立认证/权限/请求上下文原因尚未确定；没有要求同事盲目重新登录、放宽门禁或推广旧PARTIAL候选。

### 04:52–04:54 质检认证响应与Cookie范围核对

- 源码profile-session-exporter.mjs的Network.getCookies仅传HOME_ENDPOINTS对应URL，理论上可能遗漏订单独立path的Cookie。已向codexapis GLM5.3Flash派发隔离tmp范围的无网络复现实验（Kierkegaard，01a07357-f8b5-7cc0-a072-6b7c9b449476）；运行时返回429 retry limit，无实验交付。未把理论缺陷当现场根因、未改导出代码或切换模型。
- 20:53:07Z只读取DL加密bundle的元数据计数：15个Cookie、/gmpj路径0个。起初查Default目录无数据库，随后从现场发现实际Profile 1/Cookies，与两处Chrome启动代码的--profile-directory=Profile 1一致；未据错误目录判断Profile丢失。
- 20:53:48.462Z使用SQLite mode=ro查询实际Profile 1数据库，仅统计geiwohuo.com域Cookie元数据，不取值：持久化9个、/gmpj路径0个、非根路径0个。因此没有现场证据支持“浏览器已有质检专用path Cookie但导出遗漏”；持久化库不代表浏览器全部内存会话，9/15数量差不作为丢失证明。
- 为补齐旧诊断未记录HTTP状态的证据，使用同一白名单单页读取，fetch包装器只记录HTTP状态及Location存在性、不修改请求、不跟随跳转。20:54:07.573Z实际HTTP302、Location不存在、platformCode100004；适配器据HTTP状态分类AUTH_EXPIRED，并非本地文本正则误报。仍不能确定为独立认证、权限或请求上下文问题。
- 上述临时诊断全部只在内存更新会话，未写登录文件/业务数据库，未打开本机或VM浏览器；未推广订单候选。下一步若需要浏览器对照，应按原VM Profile独占锁和身份验证流程进入真实质检页面，不能凭本次响应伪造页面URL或清空登录态。

### 04:56 VM真实浏览器会话对照

- fresh preflight：人工登录state.active=false、DL62041端口未监听、webapi-history门禁存在；browser资源READY。虚拟机agent-browser未安装，使用现有createLinuxExperimentRuntime及openSession，在原renewal.lock、browser-read资源通道、DL Profile锁下启动；未打开本机浏览器、未安装新工具。
- 单次transient unit shein-fm-quality-browser-readonly-20260906T0457（名称时分是标识，不代替实际时间），report.checkedAt为20:56:18.901Z。DL browser identityProven=true后，仅对既有白名单QUALITY_REPORTS_PAGE发同样30天窗口第一页只读查询；实际HTTP302/platformCode100004、total与rows均null。ok=true仅代表诊断执行结束，不是质检业务读取成功。
- 同源浏览器上下文也失败，对照此前HTTP会话结果，不能把故障仅归因于HTTP适配器或导出Cookie遗漏。未证明平台权限/独立子系统认证的具体根因，未放宽认证守卫或标记质检页面可用。
- 对a/button/menuitem的限定质检入口查找为空；这不证明页面没有质检入口，可能使用其他DOM结构或菜单层级。未伪造路由跳转。
- finally关闭所拥有的浏览器/显示进程及runtime；随后service inactive/MainPID0。未持久化新HTTP会话或写业务数据库，浏览器正常运行可能更新自己Profile。仍保留云端回滚、订单候选不推广、MZ纠偏未授权和供应门禁关闭。
- 管理器日志独立终验InvocationID da10536cd5d04d5097b01b76cda638d5为Deactivated successfully，DL62041端口不再监听；并非仅依据已被GC的空Invocation字段判定清理完成。

### 04:58–04:59 回调入口承载边界复核

- VM接收进程仍PID172753，从进程环境仅投影FULL_BI_WEBHOOK_DB_POOL_MAX得到实际池上限4；healthz HTTP200/ok=true，accepted84/duplicates40/appScopedOnly44/quarantined0/rejected0。这些计数是本次进程生命周期，不等于新日志时段计数。
- 云端新格式日志截至20:58:23.125Z共44条POST，其中38为200/upstream200/limit_connPASSED/limit_reqPASSED，6为503/upstream-/limit_connREJECTED/limit_reqPASSED。与上次新格式统计相比新增12条成功、没有新增该类拒绝；仍无逐条关联证明此前6条已经重投。
- 初次pg_stat_activity按默认application_name=shein_fm_webhook查为0，不能解释为接收器无数据库连接。实读原service覆盖为shein_fm_webhook_receiver，按该精确名称重查为connections1/active0/lockWait0。空闲时点无锁等待不能推导突发吞吐或未来容量。
- 接收器现有总预算1200ms、单SQL超时最高800ms、池连接等待2000ms；Nginx速率20/s、突发80 nodelay、连接上限20。若提高入口上限，必须验证有效签名、实际事务与连接排队在预算内；健康GET或无签名POST压测不覆盖该路径。当前未修改任何阈值、池大小、超时、路由或签名门禁，也未对生产发送模拟业务回调。

### 05:00后切流后备份补齐启动

- VM现场最新归档仍为deploy-20260905T163150Z（1286486067字节），latest restore报告仍精确绑定该切流前归档：16:53:12Z/ok=true、storeCount43/salesRows4880004/webhookReceipts137279。不能把该报告称为03:05切流后增量已备份。
- NAS /vol3当前ZFS ONLINE、READ/WRITE/CKSUM均0、无已知数据错误，317G可用，旧deploy归档大小一致。普通PATH未找到zpool后用/usr/sbin/zpool成功读取；SMART读取/dev/sda被权限拒绝、sudo -n也要求密码。ZFS在线不替代SMART健康验收，仍不宣称500GB硬盘健康已验证。
- fresh preflight：VM备份/恢复/同步/realtime/hydration服务均inactive/MainPID0，158G可用，单次目标unit不存在；backup脚本SHA2c641655a585ae082420b93112d739e43d047052c6ba34f59680328db4161877与资源lane脚本SHA893d82da6dffe4d77b72fd9238cefbf606696dec15fc019d1b6574f07d3645f6均与本地实读一致。
- 启动单次shein-fm-postcutover-backup-20260906T0501.service，MainPID201860、InvocationID8c54e210148045fea23f1f811189b5bc；原脚本--mode deploy、FULL_BI_SKIP_BACKUP_RETENTION=1，保留旧归档。沿用io-heavy资源门禁、heavy锁、原db-backup互斥；OnSuccess指向现有NAS同步服务，不新增timer、不中止现有业务调度。
- 当前仅证明启动，尚需同Invocation终态、新归档精确哈希、NAS最新回执和目标副本独立读回；不能用旧latest回执替代本次完成证据。新归档恢复演练亦尚未完成。

### 05:03 切流后新归档完成，自动同步暂缓

- 原备份Invocation8c54e210148045fea23f1f811189b5bc完整报告ok=true且管理器Deactivated successfully；新归档shein-fm-deploy-20260905T210131Z.dump，1291926858字节，SHA256=feb3cfb6eeaf7d39358a45116485305927f0c48edea4a329f1ec48fa6377cbba，retention=skipped。没有重复启动备份。
- OnSuccess实际触发原NAS同步，首次Invocation db244cf7a15849cb9ff0e7d4d665906b资源门禁DEFERRED/MEMORY_STALL_PRESSURE+IO_STALL_PRESSURE（memoryFull2.37/ioFull33.68），service处于自动重试等待。旧latest回执仍绑定163150Z归档，不能作为本次同步成功证据。保留原仅exit75有界重试，不绕过资源门禁。
- 05:02原realtime timer实际自动启动，Invocation5d5fc71f281e497c960a8c10da97568c/PID202007；协调器startedAt21:02:00.729Z，home阶段21:02:46.787Z COMPLETE/attempt1/exit0，sales仍RUNNING。此次小时链路尚未终验，不根据pending0认定完成。

### 05:05–05:07 新归档独立副本完成与小时发布暂缓

- NAS同步由既有自动重试进入Invocation5e31d24f073940759c5439af14329007/PID203083，latest回执21:05:13.072Z copied/archiveVerified=true，精确绑定新210131Z归档、1291926858字节、feb3cfb6eeaf7d39358a45116485305927f0c48edea4a329f1ec48fa6377cbba；管理器同Invocation为Deactivated successfully。
- 主代理独立SSH到NAS正式目标重新sha256sum与stat：同一SHA、1291926858字节、0600。新独立盘副本完成；旧恢复报告不代表新归档已经恢复成功。
- 小时协调器21:05:49.770Z为READY_TO_PUBLISH：home COMPLETE/attempt1/exit0，sales COMPLETE/attempt2/exit2，TERMINAL_DATA_QUALITY_GAP、terminalDetails2。05:05首次物化实际因IO_STALL_PRESSURE暂缓（ioFull12.83），未发布；不得将小时采集结束说成页面已经刷新。
- 恢复演练脚本现场SHA173217f102f8b6f86fd44a1fe1698dfd58eac5430bf0403cfcd26267e9436420与本地一致，但暂未启动，先完成当前页面更新。fresh物化门禁随后READY/ioFull5.38，相关materialize/retry/enqueue服务均inactive；单次启动原shein-fm-dashboard-materialize.service，不重跑采集、不新增排班。
- 物化Invocation05fcda7f24f9451ebc88e1c640d094ff（初始PID204493）管理器Deactivated successfully、MainPID0；05时协调器21:08:19.399Z为PUBLISHED，仍明确保留销售数据质量告警。其后恢复演练预检io-heavy DEFERRED/IO_STALL_PRESSURE（ioFull3.28），未启动恢复；不能用物化门禁READY替代阈值更严格的io-heavy门禁。

### 05:09 新归档恢复演练已启动

- 05:09:06 fresh io-heavy门禁READY（availableMemory11075MiB/ioFull0.83），restore/materialize/sync均inactive/MainPID0。仅启动原shein-fm-db-restore-test.service，不创建新排班或修改服务定义。
- 运行实例Invocatione55a805a65b04bd4ae9410a52aa6925e，初始MainPID205082、activating。原脚本选择最新已完成归档，预期绑定210131Z新归档；最终必须以报告精确SHA与新归档一致、临时库清理、同Invocation管理器终态证明，不将预期选择当已恢复成功。
- 后续READ ONLY确认本次临时库shein_fm_restore_check_20260905_205096存在且有实际活动恢复连接；05:11:35采样COPY当前操作bytesProcessed136252244/tuplesProcessed555033，不作为整库进度百分比。同刻receiver health HTTP200/ok=true/rejected0，PID172753/NRestarts0。

### 恢复期间本地代理隔离回归

- 独立重跑tests/openapi/proxy-transport.test.mjs、tests/infra/openapi-proxy-runtime-wiring.test.mjs、tests/infra/fnos-edge-tunnel.test.mjs，23/23通过、无跳过。覆盖官方域名精确匹配、代理缺失fail-closed、普通global fetch不受OpenAPI dispatcher影响、七个既有业务单元接线和三条反向入口模板。测试中的本机CONNECT探针不作为真实云端出口IP或SHEIN业务读取证据。
- 本轮未对VM增加重磁盘任务，恢复仍由原Invocation/PID205082持有；未push、tag或触发GitHub CI。

### 05:29 切流后新备份恢复终验通过

- 原restore Invocatione55a805a65b04bd4ae9410a52aa6925e于报告completedAt2026-09-05T21:29:12Z完成，管理器同Invocation明确Deactivated successfully，service inactive/MainPID0。持续跟踪原任务，没有因等待或COPY/索引阶段切换而重启或重复恢复。
- 最新报告ok=true，精确绑定shein-fm-deploy-20260905T210131Z.dump、1291926858字节、SHA256 feb3cfb6eeaf7d39358a45116485305927f0c48edea4a329f1ec48fa6377cbba，与VM归档及已独立核验的NAS副本一致。
- 实际恢复校验storeCount43（dim.store全表，不是本次25店会话数量）、salesRows4908420、webhookReceipts144113、criticalRelationsReady=true；脚本已执行pg_restore --exit-on-error。此为可恢复归档与关键结构/计数验证，不宣称所有业务域数据完整无异常。
- 独立READ ONLY确认临时恢复库列表为空、restoreConnections0/activeRestoreConnections0，本次shein_fm_restore_check_20260905_205096已清理。回调healthz ok=true/rejected0。业务库未覆盖，旧备份保留。
- 本次新归档生成→原OnSuccess同步→NAS独立哈希→临时整库恢复→关键验证→清理链路完成。迁移总目标仍未完成：05:45日更自动终验、平台/数据遗留异常及相关门禁、入口限流风险、500GB盘SMART健康和稳定观察/后续版本管理仍须分别处理。

### 05:32 安全日志后端耗时补齐

- GLM通道持续明确失败且未交付，主代理事先向用户披露接手这处小范围诊断实现；只修改infra/nginx/shein-fm.conf和对应nginx-observability测试。新增upstream_connect_time/header_time/response_time三个内建耗时变量，闭合变量白名单，不记录query/body/认证头。无其他agent持有该写范围。
- 日志与反向入口8项测试通过，复核修正变量匹配为含数字的完整变量名（time_iso8601），日志2测试再次通过。未修改速率、连接上限、任何超时、签名校验或代理路由。
- 云端fresh旧配置SHAa04e0f0fd3534f8ee2016bd8b5ddca77a9eebe97f959a3615ac84caa15cd5bfb，候选去除唯一日志格式块后与线上逐字相等；排他保留/var/backups/shein-fm/nginx/shein-fm.pre-timing-20260906T0532并原子替换，nginx -t和reload通过。新SHA72b43a2b5974a8eecc32ca1d16fee6e672507124d0dbcbac45868b3e89572c47；master仍1188/active。
- 独立公网已支持的callback健康GET返回200；21:33:15Z新格式回读upstream200、两个limit均PASSED，connectTime0.001/headerTime0.536/responseTime0.536秒。此GET不访问业务入库路径，不能拿来证明有效签名POST承载能力或此前6条已重投；后续真实POST可用新字段定位耗时。upstream文件SHA仍9897c97615f08e835cd1c6c2c615039c63d529a368ae77586a28108f7bbebbbc。
