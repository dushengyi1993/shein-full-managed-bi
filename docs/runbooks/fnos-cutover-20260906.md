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
