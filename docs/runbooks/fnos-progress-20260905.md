# fnOS 迁移与混合验证进度记录（2026-09-05）

## 9月6日批量插入真实SSH集成启动

- 主代理终态独立读回两端pg_database：本次唯一source/target测试库fnos_cutover_test_*_50632_7f7cb23db5bb49f0均已不存在（两端count0，cloude5f840/VMdd2728）。
- 已按明确边界建立本地提交：a7d70c6（Webhook受控迁移/计时/保护与测试）、8e7b83d（独立盘备份与有界延后重试）。无推送/标签/Release；不是生产部署。
- 业务补丁本地提交0cc9c30：保留PARTIAL质量状态并给采购守卫固定安全错误码；未部署、未重试MZ窗口。
- 提交前diff-check发现三个测试文件空白问题，仅移除行尾空白/多余EOF空行；迁移core与SSH实现哈希未变。Python Git提示未来检出换行转换，后续部署归档必须按实际包内字节校验，不能把Windows工作副本SHA直接当作归档文件SHA。
- 最终session34109 exit0，真实SSH用例521239.7093ms通过，套件17项/16通过/1直接连接模式跳过。已完成forward baseline、fnOS后续delta、reverse dry/execute与post_reverse_assertions，非只完成prepare。
- session34109阶段证据：dry50679ms；execute presnapshot17325/plan22894/validatehash22311/apply23761/finalvalidation16144/commit89/freshreadback28105/finish142302ms。真实计数insertBatches25/insertedRows5000/singleInserts0/singleUpdates4，证明批量路径使用；尚待reverse及清理终态。
- 与先前同规模execute139369ms比较，本次总时长未缩短（142302ms），apply仅由26130ms降为23761ms。不能宣称整体性能问题已解决，生产规模效果仍须实际阶段证据。
- 完整本地npm test已独立执行：1518项、1507通过、11跳过、0失败（chunkdee4cf），不是所有平台/数据库路径全验证。
- Planck修订进程报告stream disconnected/upstream重试后空响应终态错误，主代理明确接手tests/webhook/fnos-cutover.pg.test.mjs。未因超时接管；此前持续等待期间保持其独占域。
- 主代理修正：instrument必须调用真实super.applyInsertBatch，成功后才计数；无batch方法直接抛错，不允许单行fallback伪装；update测试调用真实方法并检查SQL；增量受全表批次前缀对齐，每表50+250+250+250+200，共25批5000行及4单行update。新增缺方法/批次失败不计成功与批次算术反例。
- 离线该文件17项：15通过、2真实数据库模式跳过；不是实机验收。
- 两端新鲜db-heavy均exit0/READY（VM3960b5/cloudd20a4a），然后启动真实SSH测试session34109，存储句柄fmBatchIntegrationSession。只创建/删除唯一隔离测试库，不冻结生产；core仍699dbfdafa53d4802d2c43404217d1695d9ff948b03c56903b808380681e5ef6。待终态及清理读回后才能宣布该项通过。

## 9月6日批量迁移补丁独立复审

- MZ2406/8月19日缺口新鲜只读确认：backfill两次FAILED/ADAPTER_ERROR/PURCHASE_DOMAIN_NOT_LOADED；底层attempt域实际为PURCHASE_ORDERS（非建议查询中的purchaseOrders），对应UTC窗口8月18日16:00至19日16:00，两次FAILED/WAREHOUSE_LOAD_ERROR，时间9月5日09:34:33.940和09:48:04.777 UTC。原错误域查询返回0不代表记录缺失。
- attempt的source_fetch_batch_id为空，但邻近成功窗口同样为空，不能单凭此判断原始证据不存在。已驳回以事实表重复行计数证明同时间戳payload漂移及用抓取执行日期代替业务窗口的诊断SQL；未补采/改库，具体根因仍未证明。
- 01:39后独立云端读回：receiver/worker仍active，PID3260020/3260021；healthz ok=true，恢复以来accepted31、duplicates2、appScopedOnly15、quarantined0、rejected0。证明恢复后确有新回调接收，不只是进程或空健康页存活；未改变公网路由。
- Euclid初稿存在可覆盖参数上限未校验问题，主审交回修正。修正版core SHA256=699dbfdafa53d4802d2c43404217d1695d9ff948b03c56903b808380681e5ef6，batch-insert测试SHA256=a6f655d7636066950ad3bb120480ed93c023666af8a22c446432e92b9187565c；硬上限60000、每批不超既有batchSize，失败不重试，连续insert保序聚合，update保持单行。
- 主代理Webhook非PG测试200/200通过（chunkaf9853），语法检查352文件通过（session95307最终exit0）。尚未用此版本完成真实PG集成，不能据此宣称生产超时已解决。
- PGfixture新增路径计数初稿因fallback可伪装批量成功、批次数误算20、测试替换待测update方法而被交回；Planck继续独占该测试文件修正，目标以真实super方法证明5000insert分批及4update。
- 两端db-heavy检查exit0/READY（VM chunkbb40ac，cloud chunkd53e49），但实际启动实测前仍需重新检查。没有冻结生产。
- Faraday文档进程终态upstream空响应错误；主代理已接手并修正候选清单，撤销不完整部署命令与过时状态；不影响Euclid/Planck其他独占域。

## 9月6日01:17备份定时基线补齐与候选复验

- 当前实施所有权：Euclid（01a07294-8317-7ff3-bbf4-f10f6bc03945）独占cutover核心及新batch-insert测试，完成后主代理独立源码复审、离线回归、隔离数据库实测；Faraday（01a07203-c109-76a3-880f-d8985102bae7）仅修正候选清单的不准确现状与部署步骤。01:23前后wait仍running/无终态不是失败，不接管重叠文件。
- 后续主代理维护域独立测试120/120通过；备份同步/重试独立测试11/11通过，0跳过。两项业务补丁SHA与候选清单匹配，但尚未发布。
- VM直接查询pg_trigger：七表非internal触发器恰8个，全部row_level=true、tgoldtable/tgnewtable为空。此证明未见statement/transition-table依赖，不替代批量INSERT代码及整事务回滚集成测试。
- 01:20后重新读取续期报告仍generatedAt=2026-09-05T16:30:22.810Z、completedProfileCount25/activeCount25/recoveryQueuedCount0；这是00:30定时运行产物读回，不冒认为新启动一次25店实时认证。
- 云端既有restore timer实际在01:16:01触发，但service ExecMainStatus=75（SuccessExitStatus列入75故Result显示success），不是恢复成功；下一次已变为10月4日01:16:14。此云端演练属于延后未完成，飞牛本月独立恢复通过的证据不受影响，也不能替云端冒认成功。
- 前轮分类为progress：完成新生产dry-run并恢复云端；未execute、未切流。
- VM数据盘独立findmnt确认/srv/shein-fm=/dev/sdb1 ext4，196G总容量、37G已用、157G可用；/srv本身属于根卷，不能把根卷df当作业务数据盘。
- 本月完整恢复演练已独立通过，确认restore.service inactive/PID0之后启用既有db-restore-test.timer（未新增排程）：enabled/active，下一次2026-10-04 01:17:22 CST，无立即执行。weekly backup已启用，形成飞牛备份与恢复定时基线；云端仍保留回滚主机维护。
- 主代理重新运行coordinator与supply repository定向测试，38/38通过、0跳过。补丁仍只在本地，尚未部署，不把错误码增强称为供应链数据已补齐。
- 只读分析报告把42311增量当成表总数、把VM查询套云端RTT，已驳回并要求修正；不能据此声称超时根因已查明。主代理源码确认prepare实际逐行INSERT，独立委派受控批量插入实现与测试，保持全部迁移一致性门禁。

## 9月6日01:14预演收尾，云端恢复

- 用户明确登录操作只使用虚拟机，不启动本机浏览器。
- 本轮仅prepare-forward dry-run：session93260退出0，planned，42311条插入、0更新；presnapshot98193ms、plan129595ms、总239856ms。commitOutcome=not_attempted，readyForForwardBaseline=false，未执行迁移或切流。
- 本轮planHash=4e4a100170181136e9e58b65f62a06212ef650b75cf22df2f6d6c84df00feece；恢复云端后已失效，不得复用。终态输出被截断，不作为完整快照归档。
- 01:14重新启动云端receiver/worker，PID3260020/3260021，均active/running；首次即刻健康检查连接未就绪，随后重读healthz返回ok=true。
- 两个恢复保护service（900/1260）均已停止，inactive/PID0；随后结束本轮D-Bus引用持有进程3251069。VM Webhook未启动，公网路由未修改。
- 临时停止的云端db-restore-test.timer已恢复active，下一次2026-09-06 01:15:51 CST，未错过本月维护窗口。迁移目标仍未完成。

本文档记录 2026-09-05 经主代理独立核验的技术事实与中间状态，供后续各链路承接与审计查验。不包含敏感载荷、凭据或密钥。

## 完整记录只读测量与既有每周备份准入（9月6日01:00后）

- 新鲜读回backup/restore/sync服务均inactive/PID0，VM既有weekly timer disabled，定义仍Sun00:15/Persistentfalse。enable --now后读回enabled/active，下一次2026-09-13 00:15 CST，没有立即额外备份。云端仍承接公网，保留其独立主机备份用于回滚，不属于双端业务队列执行。
- full-row采样扩展独立测试10/10通过；有效db-heavy预检exit0/READY后才启动session57651，终态exit0/sample-complete，两端受限只读、每表最多30000摘要、尾部完整receipt各1000条。
- cloud完整1000条utf8JsonBytes971559、duration1239ms；VM976276、101ms。该次摘要cloud receipt6729ms/heartbeat4141ms，VM1584ms/286ms。样本不证明全部历史或全量迁移耗时，但不支持简单归因于尾部记录庞大或单次传输慢。
- 未冻结生产、未改变Webhook/Portal路由，仍需实际迁移阶段证据与最终调度/版本验收。

## 实际大表摘要只读采样完成（9月6日）

- session47430 exit0/sample-complete；两端身份指纹通过，只读事务固定10000行/页，每表3页共30000行。cloud receipt4578ms、heartbeat1703ms；VM receipt1668ms、heartbeat322ms。各页最大2179ms，无生产冻结或写入，无迁移ready结论。
- 初始资源检查错误使用不支持的class=db-read，返回RESOURCE_PRESSURE_ARGUMENT_INVALID，不能记为预检READY；采样仍已完成，随后以支持的db-heavy重新检查。后续必须按有效class的退出状态串行准入，不用复合命令末尾exit0遮盖检查失败。
- 此为摘要读取采样，不是完整表或完整记录传输；尚不能解释960秒超时。继续受限只读尾部1000条完整receipt的体积/传输耗时测量工具实现，不输出任何记录内容，不放松切流门禁。

## 最新备份恢复终验通过与同步有界重试落地（9月6日00:53）

- 既有restore服务00:53:14 Deactivated successfully；报告completedAt=2026-09-05T16:53:12Z/ok=true，精确绑定deploy-20260905T163150Z归档、1286486067字节和068628fedd064cd4e11eac99d54e7c2243918c20752f1cdc8a333ce888ea7793。实际恢复verification：storeCount43（dim全表，非25会话数量）、salesRows4880004、webhookReceipts137279、criticalRelationsReady=true。主代理独立查询本次临时库shein_fm_restore_check_20260905_141114剩余0。
- 两个无业务重试探针现场验证：exit1只运行一次且NRestarts0；exit75于00:49:45/00:50:45/00:51:45实际运行三次，00:52:45第四次启动请求被StartLimit拦截，最终failed/PID0。NRestarts3包括被阻止的调度请求，不误称执行四次。探针不接触备份或业务数据，结束后仅对这两个自建probe stop/reset-failed清理。
- 原同步服务inactive/PID0时，先排他保留原文件.pre-retry-20260906，校验旧/新哈希后原子替换与fsync，再daemon-reload，不启动正式同步。正式配置读回Typeexec/Restartno/Force75/Restart1min/RuntimeMax25min/20min内StartLimitBurst3、inactive/PID0；SHA256=91152c8fc53cccce1c8b2ab57ebd815367458910d37d405a0b7e8022f856b2ac。恢复服务定义未修改。
- 最新备份生成、独立盘副本精确哈希、临时整库恢复及清理均已验证；既有backup/restore timer转移与生产Webhook性能/切流门禁仍未完成。

## 只读采样器修正版离线验收（9月6日）

- 主代理独立执行fnos-read-cost.test.mjs 9/9通过，并实际运行默认CLI得到plan-only/executeReadOnly=false固定配置，未连接数据库。复读main已无条件将两端digestBatchSize固定10000，环境覆盖不能改变生产采样页大小。
- 范围为receipt/heartbeat各最多30000行，显式REPEATABLE READ READ ONLY，无显式冻结/排他业务锁，身份审批指纹先验，单语句30s/全程180s。该工具不产生迁移planHash或ready门禁。
- 恢复服务仍activating，暂不执行现场采样避免磁盘负载干扰；工具就绪不代表大表读取耗时已测或迁移已验收。

## 恢复运行进度与仅75重试语义实机验证（9月6日）

- 原restore PID141100/InvocationID34069f84afbe4f24b981641690ff80cf仍activating。临时库shein_fm_restore_check_20260905_141114处于active COPY，后续pg_stat_progress_copy当前操作bytesProcessed429098436/tuplesProcessed2714389；非整库完成比例，尚无终态。
- 主代理在VM临时目录生成两个无业务测试unit，仅systemd-analyze verify、不启动：Type=oneshot+RestartForceExitStatus75被拒绝；Type=exec同组合exit0通过。已选择exec/Restart=no/Force75/60s/20min内3次启动有界方案，并要求RuntimeMaxSec25min保留完整运行期限；不能把exec的TimeoutStartSec当运行时限。worker继续原配置+测试独占域，尚未部署。
- 只读采样器初稿复读发现环境digestBatchSize可覆盖固定10000，导致实际页数与固定统计不一致；交回修正为不可覆盖，未运行现场采样。普通只读SELECT仍持有AccessShareLock，不称绝对无锁，仅禁止显式冻结或排他业务锁。

## 新deploy独立盘副本完成并启动恢复演练（9月6日）

- 资源重新READY后只重试NAS同步，InvocationID64171be7a7554559acda1743c8941a36终态inactive/PID0/success/exit0。latest回执state=copied、archiveVerified=true、completedAt=2026-09-05T16:35:51.309Z，精确绑定shein-fm-deploy-20260905T163150Z.dump。
- 主代理独立在NAS读取正式文件：1286486067字节、0600，SHA256=068628fedd064cd4e11eac99d54e7c2243918c20752f1cdc8a333ce888ea7793，与VM备份和传输回执一致。此次新数据副本完成，不沿用旧weekly回执。
- 再次io-heavy READY后启动既有shein-fm-db-restore-test.service，PID141100/InvocationID34069f84afbe4f24b981641690ff80cf，activating；它只恢复到独立临时DB，业务库不覆盖。当前尚未有恢复终验，必须后续绑定同一归档SHA与清理读回。
- 已交worker为既有sync service补充仅75临时退出的有界重试；不新增timer、不重试永久错误，当前尚未部署该配置。

## 新deploy备份完成、同步压力暂缓与自动续期验收（9月6日）

- migration-backup服务00:33:44终态success/PID0，实际归档shein-fm-deploy-20260905T163150Z.dump，1286486067字节，SHA256=068628fedd064cd4e11eac99d54e7c2243918c20752f1cdc8a333ce888ea7793，retention skipped；旧备份未删除。
- OnSuccess真实触发NAS同步，但资源门禁返回75/DEFERRED/IO_STALL_PRESSURE，ioFullAvg10=31.71，服务failed，尚未传输。不能把触发当副本完成；待新鲜资源门禁通过后只重试同步，不重新生成备份。
- 飞牛既有session-renewal.timer 00:30:05自动触发，服务终态inactive/PID0/success，InvocationID02f1de05c3134acbade3cef15ddfd198。主代理读renewal-report generatedAt=2026-09-05T16:30:22.810Z，completedProfileCount25/activeCount25/recoveryQueuedCount0，结果25个唯一店码逐一匹配部署canonical名单且全部ACTIVE/renewed=true。证明此次自动运行有效，下一次为9月7日00:30。

## 带阶段计时真实集成通过并进入新备份（9月6日00:31）

- session16999终态exit0，真实SSH正反向524445.86ms；12项中11通过、1互斥直连PG跳过、0失败。主代理随后分别查询两端，本次source/target_43992_32c247910e894908临时数据库均0残留。
- 新备份前VM backup/sync均inactive/PID0，目标一次性unit不存在、标准备份目录无deploy归档。准备调用现有backup脚本--mode deploy，保留旧归档（SKIP_BACKUP_RETENTION=1），既有资源lane与heavy锁不绕过；不新建timer，不修改周/月排班。
- 已启动一次性shein-fm-migration-backup-20260906.service，PID139220/InvocationID19d31ac34c5349a19529c2357994ae9c，activating，OnSuccess指向既有NAS同步服务。只允许成功后新归档/回执/独立盘哈希读回证明完成；当前仍运行中，不称备份或同步已完成。

## deploy备份同步兼容部署与新阶段测量（9月6日）

- 主代理独立执行sender Node 9/9、receiver WSL Python 9/9。支持weekly/deploy严格文件名，按名称UTC时间戳选最新，保持固定根、拒绝覆盖、受限SSH、句柄与哈希校验；不增加daily或修改生成/保留策略。
- 先新鲜读回VM backup/sync inactive/PID0和旧脚本哈希，NAS /vol3仍独立ZFS挂载且318G可用。逐端核验旧/新精确哈希，排他创建旧文件备份，再原子替换与目录fsync。两端返回updated=true/backupPreserved=true。
- 新receiver SHA256=2236d96909812acb5a146eabb290e89d62688eba8995904a72622e0b63b566c1；sender=f9a3f87cc3822c9ed5f84a287ea8e253396a3abde08e9e566fa946e1528a7d7d。旧文件保留为原路径.pre-deploy-support-20260906。此为部署验证，不是新deploy归档已生成/同步/恢复。
- 真实SSH完整fixture再次启动session16999，仅加FNOS_WEBHOOK_PG_TEST_TIMING=1，保留250批量/全流程/清理断言。已获得即时dry presnapshot17174ms；尚无终态，未冻结生产。等待测量结束后再生成大备份避免IO干扰。
- 该次已读到prepare execute finish=139369ms：presnapshot16129、plan21399、validatehash21272、apply26130、finalvalidation15469、commit22、freshreadback27729；计划5000 inserts/4 updates。dry总51608ms。说明在此合成规模下不是apply单段主导，不能依据云端RTT误套到VM目标单行写入；仍须等完整reverse和清理终态。

## 同一SSH连接只读往返测量与并行修复（9月6日）

- 主代理使用同一SshTransportRegistry/buildPgPoolOptions，显式pool.connect持有client，暖身后30次参数SELECT逐项结果核对。session20987 exit0：cloud median357.1946ms/p95360.2704ms；fnos median0.7725ms/p951.2585ms。无表锁、无业务写入。
- 先前session83570采用pool.query，与maxUses=1组合导致每次重建SSH连接；结果cloud median4068.7111ms/fnos252.8253ms只能代表含建连耗时，不能作持续连接RTT。该次已exit0，没有残留测量；已纠正设计后才采用上述同client数据。
- 高云端RTT是实测事实，不足以单独确认生产960秒超时根因；保持原安全重扫/哈希门禁，已将真实隔离测试显式opt-in接入阶段输出交原代理，禁止缩减reverse覆盖或改变fixture规模。
- 另由Faraday独占修复NAS同步只接受weekly、不接受既有生成脚本deploy格式的遗漏，范围限sender/receiver/对应测试/备份runbook。尚未部署，不改排班或备份保留策略。

## 真实SSH隔离集成终态通过（9月6日）

- session88308终结exit0；真实SSH正反向测试耗时525840ms，测试文件8项中7通过，1项互斥的直连PG测试跳过，0失败。实际经过prepare dry/execute、forward baseline、fnOS delta、reverse dry/execute及post_reverse_assertions；临时库覆盖七表、六序列、触发器、微秒和独立回读。
- 终态后主代理分别独立查询云端与VM pg_database，本次source/target_21596_b19ed457f94040df两个精确名称remainingDatabases均0；云端receiver/worker仍active且PID3132800/3132801不变，8793/healthz ok=true。
- 这是合成fixture规模的真实连接验证，不是41837条生产差量的耗时证据。没有新生产冻结或公网切流；下一步仍需实际规模阶段测量与最终备份。

## 真实SSH隔离集成运行中（9月6日）

- 主代理按实际tests/webhook/fnos-cutover.pg.test.mjs门禁启用FNOS_WEBHOOK_PG_INTEGRATION=1、FNOS_WEBHOOK_PG_TEST_SSH=1、FNOS_WEBHOOK_PG_TEST_ACK=CREATE_AND_DROP_DEDICATED_DATABASES_OVER_SSH_STDIO，启动session88308；只在随机fnos_cutover_test_source/target前缀临时库执行已有fixture与prepare/forward/reverse流程。未冻结业务库。
- 原代理只读答复的TEST_REAL_SSH/MAINTENANCE_URL等并不存在，已明确拒绝采用；prepare dry-run会beginFrozen并加锁，也不能当作无冻结业务诊断。以源码为准执行。
- 实时pg_stat_activity确认本次source_21596_b19ed457f94040df连接存在，测试会话仍在运行，尚无终态。后续必须捕获终态与临时库零残留，不将运行中或超时观察称成功。
- 测试入口代码SHA256：core=02ec05887479b96d31eb1505723d4caf1eb6d4558f3f18701b3ae665ac531539；ssh=4f5115ef4ba3e91f99579b0794e84e297d6739515e1f42c6c939ce983f3829b3；progress-test=2e7a99c7a646abb54f8a8d3fec1ad9c6c6301759638ccf6431f4d8d06c09aae6。

## Webhook阶段计时修正版本地复核（9月6日00:01后）

- 主代理复读固定计数键白名单、按表BigInt汇总、sink同步throw/异步reject隔离实现，独立运行8套测试：130项，128通过，2项真实PG集成未启用而跳过，0失败。修复初稿三项已知反例；该结果仅为本地逻辑验证，不是实际规模耗时定位或生产迁移成功。
- 进度为显式opt-in，stdout仍仅最终JSON；尚未据此执行新冻结/迁移。下一步需真实SSH隔离集成和实际阶段测量，不能以静态推论替代耗时证据。
- 云端正确单元shein-fm-webhook-receiver.service与worker均active，PID3132800/3132801；8793/healthz返回ok=true。曾查询不存在的shein-fm-webhook.service，其inactive/PID0不是receiver停机证据，已用正确单元纠正。
- 备份预检：VM标准db目录仍仅9月2日weekly归档，backup/sync均inactive/PID0；脚本同一上海ISO周会跳过新weekly生成。不能将之后旧文件幂等同步称为今日补数后的新备份。切流前最新数据备份及恢复验证仍待完成，未改变既有备份排班。

## Webhook阶段计时初稿复核：暂不准入现场

- 主代理独立运行8套Webhook测试：126项，124通过，2项真实PG集成未启用而跳过，0失败。不能称全量真实端到端验证完成。
- 原代码PlanAccumulator.finish返回按表的inserted/updated字符串计数，初稿读取不存在的counts.inserts/updates会产生NaN并丢失进度数字；既有新测试未断言实际非零计数，因此绿色不足以验收。
- 主代理实际合成反例createProgressEvent('plan',1,{password:123456,inserts:1})保留password字段，违反仅固定计数字段边界。需固定键白名单，不只检查数字类型。
- emitProgress直接调用sink，提交后的sink异常可阻断独立权威读回；已要求同步异常与异步拒绝不改变数据库流程，并覆盖提交阶段反例。数据库自身错误不可吞掉。
- 三文件交回原代理继续独占修正；没有新冻结、重试、生产部署或公网切流。耗时主因仍未实测，不能依据静态推论断言单行写入是根因。

## 财务日任务完成与既有定时器转移（23:53）

- 本轮8月28日至9月3日窗口与canonical25逐店核验全部SUCCEEDED、source_contract_version=2，最后完成2026-09-05T15:43:16.746Z。协调器PUBLISHED，updatedAt=2026-09-05T15:43:50.719Z，finance COMPLETE/attempts1/pendingStores空/exit0。
- 既有dashboard-materialize服务终态inactive/PID0/Result=success；首页产物mtime=2026-09-05T15:43:36.412Z，SHA256=f05372f2545b426eeb29cd44b5dc25c4afee9f74a0655914c62bdfd82b72ba3b。23:53再次实时读取协调器及物化服务一致。
- 先读回云端finance timer disabled/inactive且service inactive/PID0，再启用VM既有shein-fm-home-finance-daily.timer，终态enabled/active，NextElapse=2026-09-06 03:15:00 CST；随后再次读回云端仍disabled/inactive/PID0。无新建定时器，无额外即时重跑。
- 财务链路准入不代表realtime数据质量或Webhook迁移完成；公网仍未切流，Webhook阶段计时实现仍由原代理独占负责。

## 财务日任务首轮进度读回

- 原finance服务PID124009/InvocationID8ca3f1a807314c63a51c3ed891902a1b仍activating；协调器fm-finance-daily-2026-09-05.json为RUNNING/attempts1，非终态。
- VM数据库精确查询8月28日至9月3日窗口，完成时间限定本次启动之后，已11店SUCCEEDED；最晚完成时间2026-09-05T15:41:32.048Z。因此本次已有实际入库进展，但尚非25店完成，不提前enable财务timer。

## 财务基线数据库核验与既有日任务验证启动

- 主代理直接查询VM ops.full_home_finance_sync_window：8月18–24、8月25–31、9月1–4三个窗口各25店SUCCEEDED，完成时间均9月5日。逐店与部署版本canonical25对照，75项一一匹配、source_contract_version全部2，无缺店/多店/重复；额外DL单日canary不混入75项。
- 依据该新鲜数据库证据，先确认云端finance.service inactive/PID0，disable --now云端既有finance.timer并读回disabled/inactive，避免重启双跑。
- VM财务/realtime/materializer皆inactive/PID0后，独占创建home-finance-backfill.enabled准入标志，仅标志不伪造数据或报告。手动启动既有shein-fm-home-finance-daily.service：PID124009/InvocationID8ca3f1a807314c63a51c3ed891902a1b，当前activating。
- 本次既有协调器计划查询当日八天前至两天前（8月28至9月3日），仅官方查询与VM财务入库；现有OpenAPI代理、资源锁和35分钟上限不变。VM财务timer尚未enable，需等本服务与数据结果终验。没有重启Webhook迁移。

## 回滚后不停服务的后续检查

- 23:32 VM仍仅health/daily/renewal三个既有timer启用。finance-daily服务inactive/PID0，但 /srv/shein-fm/runtime/home-finance-backfill.enabled 不存在；不依据历史补数叙述直接伪造准入或启用财务timer。
- VM数据库只读查询pg_extension确认pg_stat_statements未安装，无法从该扩展追溯此次语句耗时。未安装扩展、未改变数据库参数、未为诊断重启服务。继续原代理已持有的可选阶段计时实现，保持无新冻结。

## 精确执行超时后的完整回滚终验

- execute session62729终结exit1，ROLLBACK_UNVERIFIED/failed_closed，readyForCloudStart与readyForForwardBaseline均false。不能称提交成功，也不重放a5ce42...计划。
- 云端立即恢复receiver/worker PID3132800/3132801。首次healthz遭遇服务启动窗口连接拒绝，后续独立healthz已ok=true，才确认恢复；公网upstream始终未改。
- 两个恢复实例@900/@1260均inactive/PID0后，主代理终止引用进程3095872，原SSH session97305已终结。不存在运行中的恢复保护或源冻结。
- 独立target完整rollback核验session98326终结exit0：tablesMatchPreExecute=true、sequencesMatchPreExecute=true、triggersEnabled=true；pending63834/retry1，running/jobs/owned/expiring均0。本轮完整回滚已确认，VM Webhook仍未启动。
- 此次8阶段交接与冻结生命周期保持均通过，故不能再将超时归因于旧保护失效。已委派独立阶段计时与安全progress测试，默认行为/planHash/事务门禁不变，禁止再靠盲增超时重复冻结。尚未定位耗时主因，正式迁移未完成。

## 新鲜冻结预演通过并进入精确执行（23:04之后）

- VM db-heavy READY，相关采集/物化/备份无运行PID。云端D-Bus引用进程PID3095872（本地SSH session97305）保持7单元引用，2100秒有界，覆盖源5单元与两个恢复实例。
- @900恢复保护启动PID3096736/InvocationID8bf6a5ada3264b529b05a4168b1552fc后，冻结云端5单元；两端观察写锁0、VM五单元inactive。源baseline指纹1c4837312828e9a9ff454586b5b0b451b29b8fa9dd50ef6b84fd9ee19733e4b8，原始结构位于工具store fmPinnedSourceEvidence。
- prepare-forward dry-run session57108终结exit0/planned，planHash=a5ce42c4ac7df7ac61539c4f052622fcd5c89784f2ae937d653704b3e3f05a12；receipt/job/event各插6685，heartbeat18328，directive3454，共41837，全部updated0。未写迁移数据。工具输出正文发生截断，不能声称完整dry JSON已保存；可见精确hash/counts与planned回执用于本次准入，执行仍须自行重算同hash。
- 真实handover通过OLD_ACTIVE/SOURCE_BEFORE/NEW_START/NEW_ACTIVE/OLD_STOP/OLD_STOPPED/SOURCE_AFTER/NEW_RECHECK八阶段；新@1260保护PID3105898/InvocationID6430c22d374a4e4db0eefbf36554da45，旧@900已停。全过程源freezeFingerprint一致。
- 主代理在既有迁移授权下准入上述精确hash。新execute session62729已启动，入口再次用真实源和新guard身份验证freezeContinuity=true/guardFresh=true，操作上限960000ms；所有输出后续以较高限额完整捕获至工具store fmPinnedExecuteOutput。当前未有提交/终验结论。
- 重要：云端仍冻结，@1260保护与引用进程仍需持续核对；VM Webhook未启动，公网未改。执行失败/不确定时先权威回滚检查，不复用hash重试。任何VM启动或公网切流前必须停止全部云端恢复保护。

## 冻结生命周期证据保留的现场对照

- runtime模板仅保证停止后loaded，不能单独保留InvocationID与时间戳；上轮停止后字段归空/0，说明源被冻结后也必须防止systemd回收历史。
- 云端实际D-Bus introspect确认Manager.RefUnit/UnrefUnit存在，系统python-dbus=1.3.2。通过持有同一SystemBus连接调用RefUnit，针对不影响业务的@900恢复保护实例进行启动/停止对照。
- 运行PID3091515，InvocationID5e2ce70592554428a7539733b41ca38f；引用存续时停止后PID0/inactive，InvocationID仍相同，ActiveEnterTimestampMonotonic=2774971760266、InactiveEnterTimestampMonotonic=2774971797717，invocationRetained=true。finally再次确认stop并UnrefUnit，未留下运行保护。
- 下一次冻结必须先持有源五单元及保护实例的D-Bus引用连接，覆盖整个预演/交接/执行窗口；引用进程消失必须废弃计划。此处只验证证据保留机制，未冻结云端业务、未产生新planHash。

## 恢复保护可查询性现场验收

- 主代理部署临时runtime模板 /run/systemd/system/shein-fm-webhook-migration-recovery@.service，本地来源infra/systemd同名文件，SHA-256 a0df7296054fdd61929a308ccda3aa54de374a71131ff9bbd15f38fd5607e271；部署前systemd-analyze verify通过、目标不存在、部署后哈希一致。未enable、无timer，重启后runtime定义消失。
- 模板仅接受900/1260秒实例，超时只恢复云端receiver/worker，必须在任何VM Webhook启用或公网切流前停止所有实例并读回。不能用于切流后的自动恢复。
- 云端当前active状态下短暂启动再停止@900实例（非冻结、未等待恢复动作）：运行PID3085705/InvocationID78611cac17a14798991f26f9bf115c1b；停止后loaded/inactive/PID0，source receiver/worker全部生命周期字段前后精确相等。模板定义解决transient回收导致not-found问题，停止实例的InvocationID归空是现场事实。
- 主代理将真实运行/停止对象输入本地validateGuardUnit与assertOldGuardHandoverStopped，返回liveGuardSchemaAccepted=true。当前@900已停止，没有定时恢复动作存活，尚未发起新预演或切流。

## 切流接线预检与协调器修订复核

- VM五Webhook单元真实schema均loaded/inactive；服务PID0，所有生命周期时间戳0、InvocationID空。这是从未启动的候选主机状态。sourceFreezeBaseline连续性门禁仅对云端被冻结源使用，不能把VM缺少历史InvocationID当作需要人为启动业务的理由。
- 云端systemd255，/run/systemd/system可用；无旧*safety*单元留存，receiver/worker仍active且InvocationID与先前一致。尚未创建新的guard或冻结源。
- Faraday协调器初稿主代理定向15/15通过，但独立混合反例（DL5477 loaded/PARTIAL + UNKNOWN error）仍返回complete=true，未知店被过滤丢弃。已交回要求逐条schema/canonical/status/重复冲突检查与原始无qualityReason生产形状测试；未部署初稿。

## 健康定时器准入与guard实现接手

- 飞牛手动执行既有system-health.service后，权威健康文件generatedAt=2026-09-05T14:45:03.622Z、mtime=14:45:03.774Z，服务终态inactive/PID0/success/exit0。随后enable --now既有system-health.timer并读回enabled/active；未创建新timer。
- 此健康采集仅AF_UNIX、更新本机独立system-health.json；云端仍服务公网，故暂保留其本机健康timer，不属于双端采集同一业务队列。VM只有健康、daily、renewal三个timer准入，realtime仍未启用。
- Jason的guard编排任务返回终端错误“stream disconnected before completion / 上游模型未产生有效输出”，未交付两个目标文件。主代理已向用户披露并在记录终态后关闭该代理，接手明确的两个新文件，不涉及Faraday独占的协调器代码。
- 新增scripts/lib/fnos-webhook-guard-handover.mjs与tests/webhook/fnos-guard-handover.test.mjs，全部I/O以callback注入；强制旧guard新鲜身份、两次source连续性、新guard两次身份/PID、旧guard停止读回。任何步骤失败立即停止后续callback，只返回固定错误阶段，不运行数据库或自动恢复。
- 主代理六套完整测试105/105通过，包含8个callback逐阶段throw截断、旧guard消失/仍活、源重启再停、新guard替换/PID变化。此为本地逻辑验收，尚未接线生产；生产需保证旧guard单元可查询，不能把transient GC后的not-found接受为成功交接。

## 实时采集终态：连接可用，但销售数据仍PARTIAL

- realtime服务 invocation abb5bdf5b2744891836785358f9015ef 已inactive/PID0/Resultsuccess/exit0；物化 invocation 35a507da621b478dbd15f9dac018a46e 也已inactive/PID0/Resultsuccess/exit0。这些进程成功不等于业务全量通过。
- 协调器14:38:03.317Z显示READY_TO_PUBLISH，两阶段COMPLETE，但sales lastExitCode=2且terminalWarnings/details空。主代理从该次journal独立解析出销售原始摘要：loadedStores=25、partialStores=25、qualityBlockedStores=0，25条结果的qualityStatus全部PARTIAL。
- 安全计数读回显示各店均有unanchoredZeroSkuCount>0，部分有quarantinedSkuCount>0；statisticsDateRetryCount均0。不得把缺锚点零销量记录当作已验证的零值，也不将平台连接正常等同库存/销售全覆盖。
- 源码确认协调器sales分支忽略status=loaded且qualityStatus=PARTIAL，最后retryStores空会给complete=true且无说明。已分派独占修复给Faraday（01a07203-c109-76a3-880f-d8985102bae7），仅协调器及直接测试；不改采集数据、质量门禁或发布规则，不部署生产。
- VM realtime.timer保持disabled；云端对应timer已disabled/inactive，原失败服务保留。此次手动采集已停止，不盲目重跑。Webhook交接编排仍由Jason单独持有。

## 实时链路阶段读回（启动之后）

- fm-realtime-cockpit-2026-09-05T22.json 在 updatedAt=2026-09-05T14:34:16.809Z 仍为 RUNNING；home-realtime 已首轮 COMPLETE/pending0/exit0，sales-realtime 仍首轮 RUNNING。不把其pending0或服务暂存Resultsuccess当成销售采集完成。
- 对原服务PID112271、invocation abb5bdf5b2744891836785358f9015ef 连续读回仍activating；没有重新启动。VM realtime.timer仍未准入。

## 22:30 后增量：实时采集调度迁移验证启动

- 双端新鲜核验：云端Webhook receiver/worker仍active/PID3019200/3019201，healthz ok=true；VM二者inactive/PID0，IO full avg10=0.50。未切公网。
- timer盘点确认此前只有daily/renewal转到VM；云端realtime/finance/supply/hydration虽无下一次触发，仍enabled，不能称全部调度迁移。
- realtime云端service实际为loaded/failed/PID0/ExecMainStatus2。第一次仅允许inactive的前置检查正确拒绝，未修改任何状态；重新读取确认其为已终结历史失败后，精确disable --now既有realtime.timer，读回disabled/inactive。保留历史失败未reset-failed。
- VM对应服务、daily、renewal、materializer皆inactive/PID0且人工登录state.active=null后，手动启动既有shein-fm-home-realtime.service，invocation abb5bdf5b2744891836785358f9015ef，初始PID112271。计划为当日25店home WebAPI与sales OpenAPI两阶段，原资源锁和仅OpenAPI代理配置不变。
- 尚未启用VM realtime.timer；须等此服务、两阶段权威结果与后续物化终验。未新增timer，未重复采集订单候选，guard编排仍等待原作者交付。

## 订单异常解释复核边界

- 子代理将“请先登录！”归因于 authExpired 正则命中，主代理用源码与本地表达式反例否定：该正则仅匹配未登录/登录失效/login等，测试结果 false。既有100004测试明确使用HTTP302，由HTTP状态分支分类。未保存本次HTTP状态，不能把测试302当作本次现场状态。
- 因此质量接口是否为子系统权限缺失、独立认证或其他平台限制仍未知；不得依据错误码直接确认未开通，也不认定25店全部过期。
- 聚合候选rows只保留gates通过店的行，不能以失败店在最终候选中0行反推出原始orderNo丢失数量。stock内容门禁失败支持构建丢弃或未获得可构建数据等路径，但本次未记录raw/built/dropped计数，不伪造确切计数或平台字段变化。
- guard交接callback编排仍由原代理持有；已对该具体agent执行有界等待，未因文件尚未出现或等待超时重复实现、重启或夺取所有权。

## 订单补采终态与逐页证据（补采启动之后）

- 一次性补采 invocation 80de2abd338c434190ef8783db9d9819 已终结；journal 明确 Deactivated successfully，systemctl inactive/PID0。该 transient unit 随后被回收，LoadState=not-found/InvocationID空，因此不以消失状态单独证明成功，更不能把此语义用于迁移旧guard交接。
- 候选 updatedAt=2026-09-05T14:19:42.127Z；waybills 3378行、return-applications 472行、return-orders 696行、value-added-services 382行，四页各25店且四项门禁全true。
- stock-records 仅3店通过、154候选行；失败22店一致为分页/去重true、total/content false且fetch failures为空，需查行转换/拒绝，不能称接口没数据。
- exceptions 16店通过、30候选行；其余9店一致 PAGE_1_FETCH_FAILED:ORDER_MANAGEMENT_BUSINESS_STATUS_FAILED:PLATFORM_SSO100010，PAGING_INCOMPLETE。quality-reports 全25店 PLATFORM_100004、被传输层分类为 AUTH_EXPIRED，未取得第一页。其他端点通过，不据此认定全部会话失效。
- 候选未提升、旧缓存未替换。已无覆盖复制到 /srv/shein-fm/backups/migration-20260905-postcatchup/order-management-candidate-20260905.json，0600，12096553字节，源/目标SHA-256均 d50b27360f382cff6d4ce953d960878a612b38cb2dc17a271c714676e66f6f42。
- 正在独立开发callback注入的guard交接编排与逐阶段失败测试，无SSH/生产副作用；订单异常分派只读因果检查。未重新启动补采，未冻结或切公网。

## 22:20 附近增量：连续性专项验收与订单页面补采启动

- 连续性门禁经两轮返修，主代理审读恢复的关键反例及严格 assert.throws，五套完整回归87/87通过。期间一次80/81结果发生在作者尚在修改时，不作为终稿结果。门禁尚未接入生产执行，未生成新冻结计划。
- 订单管理候选实时读回 updatedAt=2026-09-05T13:45:20.420Z：数据库页 delivery-notes AVAILABLE/9922行，waybills AVAILABLE/9757行，25店覆盖；其余6页 UNAVAILABLE，原因明确为 SESSION_SNAPSHOT_ABSENT。不是数据库发货事实缺店。
- 只读分析初次交付的店码清单与源码不符，主代理拒绝并要求撤回，未执行错误命令。正式启动从部署版本 FULL_MANAGED_STORE_CODES 动态导入25店，不手抄名单。
- 已核对本地/VM补采脚本SHA-256一致：35b85469ab8d2263036aee17933aac51c5ae02d504d0883510c5306201516cc1；state.active=null，daily/renewal均inactive/PID0，续期下次00:30。传输代码会在结束时保存响应更新的会话密文，不能把其本地副作用描述为完全只读。
- 已启动一次性 shein-fm-order-session-catchup-20260905.service：固定25店、2026-08-07至2026-09-05、并发1、api-light资源通道、1200秒上限。无新增timer。仅写独立候选 /run/shein-fm-webapi/order-management-candidate-20260905.json 及既有会话密文，不自动物化或发布。后续必须读取该服务终态与逐页门禁，不能凭启动回执认定补齐。

## 交接连续性门禁复审（22:03 记录之后）

- 主代理取得纯逻辑门禁初版并独立运行五套测试，82/82 通过；审读仍发现旧 guard 缺失 LoadState 可被接受、错误消息回显原字段、基线结构校验不完整。因此测试通过不代表生产准入，已交回原作者修订，尚未接入执行或重新冻结。
- 云端实时读取 receiver/worker 仍 active（PID3019200/3019201），healthz ok=true。VM 对应两个单元均 inactive/MainPID0；本轮未改变所有权或公网路由。
- 真实 systemctl schema 显示 timer/path 也含 InvocationID；hydration.service 的 ActiveEnterTimestampMonotonic=0 合法。已要求实现与现场字段一致，不能以虚构 schema 放宽或误拦截。
- VM home-daily 与 session-renewal 服务均终态 inactive/MainPID0/Resultsuccess/exit0；磁盘可用159G，IO full avg10=0.47。此处只是新鲜运行状态，不替代各业务产物完整性验收。
- 并行委派订单管理补采的本地只读执行契约核查，尚未启动补采或提升 PARTIAL 产物。

## 22:03 增量核验：新预演成功，但保护恢复导致计划失效，已撤下执行

- 正式_writev版本受控dry-run进程36055终结exit0，planHash `4c12fda0bdbdb348b154628483e3d15ae215126de0e616875c3aef717c521a9a`，计划仅插入receipt/job/event各6635、heartbeat18072、directive3429，共41406，updated全部0。完整原始结果保存在当前工具会话 `fmVectoredDryOutput/fmVectoredDryPlan`。
- 转换执行保护时，旧dry保护已终结并卸载。主代理随后核实云端receiver/worker在21:58:59被保护启动、21:59:18再次停止，因此刚生成的旧hash已失效，不能继续执行。
- 已启动的进程52734使用该失效hash，主代理按安全边界撤下：分别精确终止两端本次application、backend_start>=13:59:18Z且唯一的迁移连接。进程终结exit1/ROLLBACK_UNVERIFIED，不复用、不称成功。后续执行必须在新鲜冻结中重新生成并批准planHash。
- 云端已恢复receiver/worker（PID3019200/3019201），healthz已返回ok=true；新的vectored-exec保护已停止。未切公网，未启用VM Webhook。正在再次核对VM完整摘要与序列，不能只凭提前撤下便假定回滚完成。
- 本轮暴露的是保护交接顺序缺陷：若旧保护已执行，必须立即废弃hash并恢复，不能先启动execute再核对。下轮必须在旧保护尚活时先建立新保护、确认旧保护停止且源服务自预演以来从未重启，再允许execute。
- 撤下后独立VM完整snapshot核验进程43789已exit0：tablesMatchPreExecute=true、sequencesMatchPreExecute=true、triggersEnabled=true，readiness与旧VM相同。本轮完整回滚已核验。

## 21:47 增量核验：每日采集发布闭环通过

- daily invocation `a7c932d7c2d14446b455f99aa41daec4`终结inactive/MainPID0/Resultsuccess/exit0，两阶段home-history与home-ledger均首轮COMPLETE、pending0。
- 后续既有dashboard-materialize invocation `0736acab37c04c26a8815657f8357df2`亦终结inactive/MainPID0/Resultsuccess/exit0。daily协调器状态已由READY_TO_PUBLISH转为PUBLISHED，updatedAt=`2026-09-05T13:45:27.867Z`。
- `dashboard.home.json`业务updatedAt=`2026-09-05T13:44:23.660Z`，SHA-256 `2ac639af6d768252a7a21156bc6c7a68730f7d43289a44fa9af83a2e44a4c50a`。总体dashboard仍以9月2日数据为时间，订单管理候选仍PARTIAL/promotable=false，旧订单管理缓存未替换，不能声称所有业务域已完整。
- 据此仅启用VM既有home-daily.timer；云端对应timer重新读回disabled/inactive。其余财务、供应链、实时、Webhook调度仍单独待验。
- 主代理独立复核新增协议边界断言并重跑四套74/74通过。批量物化后曾观测VM ioFullAvg10=7.57，下一次迁移冻结须重新通过资源检查，不沿用过期压力快照。

## 21:45 增量核验：每日采集准入及正式传输修复复测

- 新鲜确认云端daily服务无PID，timer inactive但enabled；先disable并读回disabled/inactive。VM对应服务无PID、timer disabled/inactive。
- 重读canonical25店completed/verified和两小时内renewal 25 ACTIVE，独占创建 `webapi-history.enabled` 与 `store-login/all-25-completed` 准入标志。只手动启动既有daily service，不启用daily timer。
- `shein-fm-home-daily.service` invocation `a7c932d7c2d14446b455f99aa41daec4`，初始PID102288；`fm-daily-operations-2026-09-05.json`已新鲜写入RUNNING，home-history第一轮RUNNING。范围25店2026-09-03至09-04，history后ledger，禁止把RUNNING与pendingCount0解读为已完成。
- `_writev`正式实现交付后，主代理审读并独立71项测试通过；无猴补丁真实只读30次parameterized查询中位0.9074ms/p951.9919（simple中位1.0034ms）。SSH授权/远端命令/事务门禁未改变。
- 两组协议边界测试（合法帧长度、单Buffer复合Terminate及payload反例、标准流错误回调恰好一次）已交原代理补齐，尚未用新实现执行迁移。

## 21:38 增量核验：同连接只读ABA定位传输层

- 主代理阅读本地node_modules/pg/lib/query.js确认extended query通过cork/uncork批量提交多个frame，现有SshPgDuplex仅有_write无_writev。
- 不改文件、不改远端命令、不停服务；在同一个VM SSH Pg连接READ ONLY事务中做三组各30次参数化SELECT：baseline中位41.7285ms/p9543.2563；只在本进程该stream实例增加_writev合并chunks后中位0.833ms/p951.3765；删除实例覆盖恢复baseline后中位41.9729ms/p9542.9919。
- 因而参数化往返的主要差异已由可逆对照实验定位到本条SSH transport的frame发送方式。尚未证明所有写入性能、错误路径或完整迁移成功，不能直接拿实验猴补丁执行迁移。
- 已授权原执行代理仅修改ssh launcher与对应测试，补齐标准_writev、背压/字节顺序/错误回调/组合Terminate与teardown回归；主代理保留生产执行权。

## 21:34 增量核验：执行超时已回滚；参数化往返延迟异常

- 准入hash执行进程58942使用960000ms上限，执行前两端写入单元停止且观察锁0。独立1020秒恢复保护 `shein-fm-webhook-execute-safety-20260905.service`（invocation `81b81f584c304a5ca5203a1aebba7ba6`）替换并停止旧预演保护。
- 执行终结exit1/ROLLBACK_UNVERIFIED，两个readiness=false，无成功提交回执。随后云端receiver/worker active，PID2983560/2983561，healthz返回ok=true。一次性保护已终结并卸载（停止时报not loaded），没有新增timer。
- VM迁移连接0，行数仍为执行前。进一步独立锁定VM七表并完整snapshot核对（进程15936，exit0）：tablesMatchPreExecute=true、sequencesMatchPreExecute=true、triggersEnabled=true；readiness仍为pending63834/retry1，running/owned/expiring/jobs均0。因此本轮回滚已用完整内容摘要和序列读回证明，不仅是count相等。禁止重放旧hash；云端恢复后旧计划已不能直接复用。
- 不停服务的新只读诊断：相同VM SSH PgPool中30次simple `SELECT 1`中位0.8914ms/p951.3297ms；30次parameterized `SELECT $1::int`中位42.0552ms/p9543.6153ms。逐条参数化写入可能被此延迟放大，不能仅按普通SELECT往返估算41,196条写入时间。
- SSH Duplex缺少_writev、extended protocol与cork/uncork交互的因果核查已委派只读；这是待验证假设，不宣称TCP原因已经确认。未修改SSH授权/远端命令，暂不发起第三次写入。

## 21:15 增量核验：受控预演成功，精确计划准入

- measured-safety一次性保护先启动（invocation `6bc38cbb6d984e2bb092427d4ac06b83`），两端五Webhook单元inactive且观察写锁0后，以600000ms上限执行prepare-forward dry-run。
- 进程45721终结exit0、ok=true/state=planned、commitOutcome=not_attempted；planHash=`f4a768bfaa4f1160ff8766681b5341cee14cd7369c248388c471b7a435a2f87a`。未写数据。
- 精确插入计划：receipt6594、heartbeat18006、job6594、event6594、directive3408，subscription/gate0，共41196；所有表updated=0。源行数143873/234883/143873/143873/75139，目标137279/216877/137279/137279/71731。两端身份仍为原批准pin，八触发器全部O，非终态jobs/running/owned/expiring均0。
- 主代理在既有迁移授权下准入该精确hash，仅允许cloud到VM追平，公网不切流。执行必须重新计算相同planHash再写入，并以新连接完整回读为准；预演readiness=false不是允许启用VM Webhook的证据。

## 21:08 增量核验：不停服务的完整摘要扫描耗时

- 只读测量进程47822已正常exit0；两端分别使用 REPEATABLE READ READ ONLY，逐表调用相同PgEndpoint.scanDigestEntries（digestBatch10000），不获取迁移排他锁、不停Webhook、不写数据。测量期间云端healthz仍ok=true。
- 云端receipt/heartbeat/job/event/directive/subscription/gate分别为22283/26434/15978/18979/7647/356/360ms，合计92037ms；对应行数143863/234865/143863/143863/75134/0/0。
- VM对应耗时7519/2744/1968/2639/1168/44/44ms，合计16126ms；行数137279/216877/137279/137279/71731/0/0。
- 双端单次摘要扫描合计108163ms。优化后的dry-run仍需快照扫描+计划扫描各一遍，仅此约216秒，另有契约/身份/序列/依赖检查、完整差异payload拉取和磁盘spool；因此270秒上限不足的解释已有量化依据。不能把这项只读计时当作新的frozen planHash或真实PG迁移验收。
- 下一次受控预演需按该耗时重新设置有界运行窗口与独立恢复保护，而不是删减完整校验或重复沿用270秒盲试；尚未启动下一次冻结。

## 21:04 增量核验：单遍预演仍超时，云端恢复

- 一次性恢复保护 `shein-fm-webhook-singlepass-safety-20260905.service` 先启动，invocation `100923095d4a4b44a5e708dd2ffd4685`；无新增timer。
- 两端五个Webhook写入/激活单元停止，锁观察均0。以原身份pin、batch1000/digestBatch10000/270000ms运行新的单遍prepare-forward dry-run，进程37158；未传--execute，未修改公网upstream。
- 该运行仍终结exit1/ROLLBACK_UNVERIFIED，两个readiness=false，无planHash。后段只读pg_stat_activity观察已推进到event表，不能据此推断剩余耗时。
- 主代理立即启动云端receiver/worker（PID2943977/2943978）。初次健康探测遇到启动窗口连接拒绝，必须随后独立重试健康检查；不能只凭systemctl active认定业务恢复。两端cutover application连接数均0，一次性保护已停止。下一步应读取性能分段证据，不继续盲停服务重复预演。
- 随后的独立 `/healthz` 探测已返回ok=true，两进程仍active，保护服务inactive/MainPID0；本轮云端恢复已核验。

## 20:56 增量核验：Webhook优化本地验证与现场只读预检

- 第三次交付终于直接捕获新planner emit，使用先遇到小主键insert、后遇到大主键update的对抗fixture，比对旧两遍oracle、新planner与完整dry-run三方planHash全等；主代理独立审读决定性断言并重跑四套测试66/66通过。未将此前捕获apply路径的测试当作planner证明。
- 当前公网反向18788的Portal健康探测返回ok/readOnly=true，VM8788返回同样健康结果；仍未修改公网路由。
- 只读事务重新读取云端/VM身份，fingerprint仍为原批准的 `e7eaa9b45871fcabf4933a7c98d645e791057f813b8d0dda35810156f0c2b748` / `0b97c36b3b103f13c1970be940aaad36a47b8874141d8027fa0f3e88a8ce81cd`。两端nonterminalJobs/runningDirectives/ownedDirectiveLeases/expiringDirectiveLeases/subscriptions/gates均0。云端pending67237/retry1；VMpending63834/retry1。这里只读预检，无冻结、无execute、无新planHash，不等于已完成追平。

## 20:52 增量核验：会话续期迁移准入通过

- 新鲜读取发现云端续期timer虽inactive但仍enabled，先执行disable并读回disabled/inactive，无运行续期PID，排除云端重启双跑。
- VM逐个检查canonical 25店state completed且verified=true，原renewal报告独占备份为 `renewal-report.pre-admission-20260905.json`（0600）。创建 `renewal.enabled` 准入文件；没有创建历史采集或daily总门禁。
- 手动执行既有 `shein-fm-session-renewal.service`，invocation `a12cbd257a08484e8791f300fb28116e`，终结inactive/Result=success/ExecMainStatus=0；权威报告generatedAt=`2026-09-05T12:51:32.135Z`，completedProfileCount=25、activeCount=25、recoveryQueuedCount=0。
- 据此仅将既有续期timer启用到VM，不新建timer。云端disabled/inactive；整体Webhook/Portal与其他业务调度仍未迁移，不能把此单链路准入称为整体完成。
- 回滚此调度所有权：先停用VM续期timer并确认服务终态，再按需恢复云端timer原enabled设置；需重新验证云端会话，不以VM会话成功推断云端可用。保留本轮报告和备份。

## 20:48 历史增量核验：健康页面与调度状态

- VM手动运行既有健康物化服务 invocation `a0083c73442d4bf7a363589dbb7e4bef`，终结inactive/Result=success/ExecMainStatus=0；新健康文件generatedAt=`2026-09-05T12:47:51.747Z`。独立聚合读取人工登录完成且verified=25/25。
- 健康文件中续期报告来源仍是 `2026-09-02T14:09:06.630Z`，其activeCount不能作为当前会话有效性的证据；不得将旧报告0解释为当天新恢复的25店全失效。要更新此指标须执行现有续期验证链路，不能手改报告冒充验证。
- 云端业务timer（daily/finance/realtime/renewal/supply/hydration）本次读取均无下一次时间；维护timer（health/disk/backup/restore/prune）仍由云端运行。VM本次无全托timer启用。所有权迁移必须按各单元分别处理，不能因业务timer停用便认定全部调度已迁移。
- Webhook单遍优化交付经主代理独立四套测试得62pass/1fail；全局临时目录计数的清理测试与并行套冲突，且未实际证明旧新planHash等价。已交回原执行代理修订，未用于真实切流。

## 20:45 增量核验：归档同步与接线通过，尚非新备份全链路验收

- 文件句柄修复经主代理审读、7项本地测试及 VM 真归档 `pg_restore --list` 后原fd完整重读验证。已部署脚本SHA-256 `b99ad964cf74c7630dee14ec17cc5a8bbf4842a32793b9c22e27fa654f780586`，旧脚本原位保留 `.pre-fd-fix`，哈希 `2f0552c97e145133da52c27d65e236b3de1f2ede9b12995fb762abaa63d7abd4`。
- 首次修复后真实同步 invocation `64f3fea480c341bdaf04ccadc5e8fd87`：20:43:34终结 inactive/Result=success/ExecMainStatus=0，回执 `already_present`；NAS独立读回1279019556字节、0600与原SHA-256完全一致。
- 既有备份服务安装专用 `60-nas-sync.conf`（SHA-256 `8c9d8722542b9070d2a3cb76fcfa85485fcc5b6c7ce0a18ec2ad495baf8e46a3`），systemd verify通过，OnSuccess读回准确。未新增或启用timer。
- 手动启动既有备份服务 invocation `302828685f694a20926d1f021e79aa81`：READY后因本周已有备份正常跳过，退出0。随后由OnSuccess实际触发同步 invocation `bfa536b4f08546ffa7c95426ee57dc4d`，20:45:01终结 inactive/Result=success/ExecMainStatus=0，再次返回相同 `already_present` 和准确哈希。
- 以上证明真实SSH传输、幂等无覆盖与既有服务接线；不能据此称今天生成了新备份，亦非业务切流或自动调度已完成。

## 20:35 历史增量核验：备份同步尚未通过

- 同步单元首次 invocation `5d6eebcde31044438a08a3a05dc28979` 退出75，原因 `IO_STALL_PRESSURE`，不是传输完成。
- 当前压力下降后仅重启一次：invocation `278179d5b13f4bd9a7c1bba4b1941666` 先 READY，后退出1、`BACKUP_NAS_SYNC_FAILED`。
- 直接在 VM 以固定备份进行只读阶段复现：初次哈希成功；`pg_restore --list` 的提前 EOF 处理阶段发生 `EBADF`，原固定文件句柄 fd=-1。归档清单校验管道销毁了后续传输所需句柄；修复与真实子进程回归测试已交执行代理，尚未部署修复、未产生成功同步回执。
- 既有 `shein-fm-db-backup.timer` 仍 disabled/inactive，未新增排班，未安装 OnSuccess 接线。标准备份目录仍只有 `shein-fm-weekly-20260902T151520Z.dump`（1279019556 字节）；当天补数后的备份在独立 migration 目录，不能把标准目录最新文件称为当天快照。
- 云端 Webhook receiver/worker 再次读回 active，PID 分别为2877237、2877238；`/healthz` 返回 ok=true。未正式切流，保留云端回滚。
- 下文各节保留历史检查时间；会话与恢复演练的后续增量记录优先，不能把旧“剩余登录”状态当作当前阻塞。

## 一、运行环境与发布基线

- **发布版本（Release Commit）**：`afcb8e8cecb55a155dedf06904ae33023e7636b4`
- **fnOS 内 Linux 虚拟机**：`192.168.1.79`（非 NAS 管理宿主）。
- **时间口径**：本文 ISO 时间中的 `Z` 为 UTC，北京时间需加 8 小时。
- **宿主只读回读**：`virsh --readonly -c qemu:///system dominfo ocajdmwz` 返回 running、Persistent=yes、Autostart=enable、4 CPU、12GiB 内存；`domblklist --details` 确认 sda/sdb 两虚拟盘均在 `/vol2/vm/pool/`（1TB 盘），不是 500GB 备份盘。
- **生产与流量状态**：
  - 公网 Portal（8788）与 Webhook（8793）仍绑定 cloud-local，全程未切流。
  - 仅 StoreLogin 通过公网反向隧道（18794）指向 fnOS 混合入口。
  - 本轮未删除 cloud 既有服务与数据资产，继续保留回滚。

## 二、数据库恢复验证（DB Restore Verification）

- **最新完成时间（completedAt）**：`2026-09-05T09:03:22Z`
- **执行结果**：`ok: true`
- **备份快照文件**：`shein-fm-weekly-20260902T151520Z.dump`
- **备份文件校验**：
  - 大小：`1279019556` 字节（约 1.19 GiB）
  - SHA-256：`01cc73191ac3f7eaa04c3f2e277b344a45f570015245ba548e6c8825c57f88eb`
- **环境清理**：本次恢复在独立隔离临时库完成校验，验证完成后已完全清理，未污染正式库或残留多余库。

## 三、OpenAPI 补数状态（财务与采购）

所有 bulk 批量任务均已终结，未新建任何系统定时器。

### 1. 财务数据补数
- **店铺范围**：全量 25 店。
- **时间窗口**：`2026-08-18` 至 `2026-09-04`（明确为受控时间窗口，**非全历史**）。
- **执行结果**：75/75 窗口状态全部为 `SUCCEEDED`（基于 v2 协议）。

### 2. 采购单数据补数（不代表其他供需域完成）
- **店铺范围**：全量 25 店。
- **时间窗口**：`2026-08-19` 至 `2026-09-04`，共计 425 个日窗口。
- **去重 SQL 校验**：按“店铺 + 日期”去重校验，`424 passed`，存在 1 个已知缺口。
- **唯一已知缺口记录**：
  - **店铺与日期**：`MZ2406`，`2026-08-19`
  - **错误特征**：底层 `WAREHOUSE_LOAD_ERROR`，外层 `PURCHASE_DOMAIN_NOT_LOADED`
  - **复核结论**：经隔离单并发独立复验一次后仍然失败。**严禁归咎为登录问题**；具体底层根因目前未知，停止盲目重试，按已知缺口归档。

## 四、候选仪表盘缓存物化（Candidate Dashboard Materialization）

- **基线缓存备份**：
  - 备份目录：`/srv/shein-fm/runtime/dashboard/fnos-pre-refresh-20260905T0945`
  - 目录权限：`0700`；文件权限：`0600`
  - 原始 4 个核心缓存文件已全部受控备份，并完成 SHA-256 哈希比对锁存。
- **物化器调度状态**：
  - 初次运行：因触发 `IO_STALL_PRESSURE` 自适应保护，已安全暂缓并中止。
  - 第二次运行：在系统恢复 `fresh READY` 状态后重新发起。
    - 调度标识（invocationId）：`9b99b9994a8b44c98c644612d96b8107`
    - **最终状态**：已终结。该 invocation 日志先返回 `READY`，末尾返回 `ok: true`；`.materialize-pending` 已清除。未绕过资源保护。
    - `dashboard.json`：mtime `2026-09-05T09:58:05.554Z`，内容 `updatedAt=2026-09-02T18:51:20.024Z`。文件刷新不代表业务源已追到今天。
    - `dashboard.home.json`：mtime `2026-09-05T09:58:04.915Z`，内容 `updatedAt=2026-09-05T09:18:43.023Z`。
    - `shipping-orders.json`：mtime `2026-09-05T09:58:10.235Z`，内容 `updatedAt=2026-09-05T09:58:06.166Z`。
    - 以上三文件均经主代理 SHA-256 前后比对，内容已改变。
    - `order-management.next.json` 已生成，但 `coverage.status=PARTIAL`、`promotable=false`，日志明确 `gate failed`；旧 `order-management.json` 未替换，SHA-256 仍为 `3b95cbf3d4d9b210596b25829e3719c71cdb90629626925236e7e2ef11796eca`。

## 五、门禁状态与并行解耦边界

- **门禁标记当前状态**：
  - `/srv/shein-fm/runtime/store-login/all-25-completed`：`false`（未创建）
  - `/srv/shein-fm/runtime/store-login/renewal.enabled`：`false`（未创建）
  - `/srv/shein-fm/runtime/webapi-history.enabled`：`false`（未创建）
- **链路解耦原则**：
  - 剩余店铺的 WebAPI 人工登录仅约束 WebAPI 自身的调度门禁，绝不提前伪造。
  - **严禁以“剩余店铺尚未完成登录”为由阻断 OpenAPI 补数、数据库恢复验证、候选 Portal 验证等完全独立的业务链路**。
  - 各独立链路依据其自身的受控计划、权限边界与主代理终验结果推进。

## 六、后续只读复核与未完成项

- 新大页线上只读探针：相同SSH transport、BEGIN READ ONLY、statement_timeout20s，只取receipt首10000条摘要，耗时2209.60ms、Node heap增量11664672字节，进程exit0。不是整表/全流程耗时证明。
- 随后受控prepare-forward预演：两端fresh身份pin与历史批准一致；先停止cloud五个Webhook单元并核实两端五单元inactive、写锁观察均0，batch1000/digestBatch10000/operationTimeout270000运行。没有--execute、没有改公网upstream。独立一次性330秒恢复保护 `shein-fm-webhook-dryrun-safety-20260905.service` 已实际成功执行并终结（不是timer/排班）。预演进程24179最终exit1，`ROLLBACK_UNVERIFIED`、outcome failed_closed、无planHash、两个readiness flag false；当次不能用于执行或切流。
- 预演后主代理再次start并读回cloud receiver/worker均active（PID2877237/2877238），两端迁移application连接均0，receiver healthz ok=true。保护单元已完成回收，不是仍待取消。下一步必须解决完整预演剩余耗时/收尾证据，禁止把单页加速和60单测通过当整迁移可用。

- **25店后台会话恢复完成**：四店promotion guardian终结 inactive/MainPID0/Resultsuccess/ExecMainStatus0；最后TS于 `2026-09-05T12:06:35.558Z` 完成双读匹配。主代理重读本轮四份报告全部ok，并逐店解密25份会话核对绑定及identityProvenAt属于当天本轮，freshBoundHttpSessions=25/25。人工state completed且verified=25，activeLogin=false，临时gate=false。此前“21有效/4过期”已由本条终态更新；未开启生产调度，不代表迁移全目标完成。

- 用户明确授权直接登录四店并要求仅操作VM。主代理通过现有store-login服务打开独占Profile，直接VM CDP点击保存凭据及登录按钮，不读取密码值、不要求短信。DL5477、LQ7173、TS8263、NM7397 均经既有finish接口 `verified=true`。NM首次完成核对false，随后确认别名匹配，重新打开既有已登录Profile，等到精确 sameOrigin=true/onLoginUrl=false/loginText=false/aliasPresent=true 后再finish成功；未改身份别名或绕过门禁。本机仅此前用于启动维护入口的自建标签已关闭，用户标签保留。
- 四店后台推广进行中：`shein-fm-bootstrap-manual-four-20260905.service`，invocation `2d052a9ac47046e59fa6c6d8a89a4a04`，启动PID82186；既有逐店bootstrap/资源门禁/锁，限定四店。DL、NM已双读匹配成功；整批尚待终态回读，不把人工verified替代HTTP会话验证。
- 摘要分页补丁由Hegel交回后主代理实读diff：PgEndpoint只在摘要扫描使用独立digestBatchSize，完整行与写入仍batchSize；launcher闭包向包括权威readback的endpoint注入可选值，未配置保持原行为。主代理本地运行三套migration/SSH/digest测试60/60通过，尚未做新线上冻结或摘要大页性能实测。
- 主代理补齐备份发送端 `scripts/sync_full_managed_backup_nas.mjs` 与5项本地单测（5/5通过）；源规范路径、文件句柄/inode/大小/纳秒mtime/ctime锁定、PGDMP检查、execute前pg_restore --list、SSH固定命令、源目标哈希回执及源结束再hash、安全错误输出。尚未安装部署或建立NAS专用受限key，service/runbook待完成，不能称自动备份完成。

- 后台接入批次最终终态：限流guardian `454ee17ce18b45aaaab724e92ac2de0b` 已 inactive/MainPID0/Resultsuccess/ExecMainStatus0，临时webapi-history gate不存在；23份逐店报告20成功、3失败，加之前CX成功、DL失败，最终 **21/25** 更新加密后台会话。主代理逐店解密read验证21份identityProvenAt属于本次执行。NM7397、LQ7173、TS8263、DL5477仍旧会话，均为本轮Browser opening阶段WEBAPI_SESSION_AUTH_EXPIRED；不自动再试，不伪造all25/renewal门禁。人工state的25completed与后台21有效须分开报告。
- 自动备份接收实现：备份代理上游空输出终止后主代理接回该scope，新增 `scripts/receive_full_managed_backup_nas.py` 和 `tests/maintenance/backup-nas-receiver-test.py`。NAS Linux Python标准库下在独占临时目录测试8/8通过：复制+幂等、路径逃逸、hash错误、短/长传输、冲突保留、符号链接拒绝、互斥锁、FIFO不阻塞。只在内存加载测试代码，未安装receiver、未配置授权key、未改正式备份、未启动自动同步；sender/service/runbook仍待完成。
- 云端Webhook七表只读计数：receipt143804、heartbeat234549、job143804、event143804、directive75104、subscription0、gate0，合计741065行。原分析代理上游错误终止，主代理实读源码发现摘要与完整行共用batch。已委派Hegel（01a0715e-9481-72b2-858d-2d7fada2e448）本地受限优化：独立可选摘要batch上限10000，默认兼容，完整payload与写入batch上限1000不变；全七表、全部hash/顺序/回读不删减。代码仍归该代理，尚未验收部署或再冻结。

- 切流通道真实延迟只读测量：同一 SSH stdio PG transport，每端 BEGIN READ ONLY、statement_timeout=5s、40次 SELECT 1、ROLLBACK，未调用 beginFrozen、未锁业务表、未停接收。cloud 中位374.96ms、p95=376.47ms、总15003.50ms；fnOS 中位0.761ms、p95=1.254ms、总33.21ms。进程exit0。此证据支持先计算分页往返成本，再评估batch1000，不等同于已证明完整迁移耗时或已获新planHash。

- 剩余23店限流接入启动：fresh browser READY（ioFullAvg10=1.87）后，一次性 `shein-fm-bootstrap-admission-remaining23-paced-20260905.service`，invocation `454ee17ce18b45aaaab724e92ac2de0b`，PID 67279。每店之前只读检查资源，75时每30秒等资源、最多20次；不重复平台请求，无终态报告就停止批次。仍使用原服务及门禁，批次结束清理专属marker。已报告 XL2801、QY8886、DX0571 双读匹配成功，加之前CX4412共4店；NM7397 返回 WEBAPI_SESSION_AUTH_EXPIRED，与DL一样单独保留失败，不阻断其余独立店。主代理已独立解密读回CX/XL的identityProvenAt为当天，DL仍为旧值。批次此时仍运行，不得重复启动。
- 自动独立盘同步确认缺口：既有backup脚本/service没有成功后同步hook，COS归档器固定cosfs不是NAS适配。已委派本地同步脚本/测试/独立触发service/runbook实现，限定不新增timer、不执行生产、专用受限SSH身份由主代理另行配置，不能把制品完成当部署完成。

- 上述剩余24店 guardian 已终结，gate 已清理，不再运行。逐店 journal 权威结果：CX4412 于 `2026-09-05T11:24:11.074Z` 完成 browser/HTTP 双读匹配并更新后台会话，responseSha256 `b40132bf42c4ebd0c412251558760a36227068b981a4d7c30ecfc15f42179601`。XL2801 被 browser 资源准入以 `IO_STALL_PRESSURE` 暂缓（ioFullAvg10=10.27）；其他店无 bootstrap 最终报告，不计通过。systemctl start exit0 和实例回收后 show 默认success不能作为逐店成功证据，必须读实际 invocation journal 与加密会话。批次没有重试暂缓项，需 fresh READY 后继续未完成店，禁止绕过 IO 门禁。

- 后台会话接入实际执行：DL5477 沿用既有 `shein-fm-session-bootstrap@DL5477.service`，invocation `21a5bffb5d554e75afa15bb1f6b4a81a`，browser 资源准入 READY；报告 `2026-09-05T11:21:49.754Z` 为 requested=1、succeeded=0、`WEBAPI_SESSION_AUTH_EXPIRED`，不是接入通过。外层一次性准入 guardian 已终结，临时 `webapi-history.enabled` 已核实不存在；未替换失败店会话，未重置人工登录记录。
- 其余 24 店已启动串行一次性接入：guardian `shein-fm-bootstrap-admission-remaining24-20260905.service`，invocation `4c01166fb1e342469d9d1ea482f1159b`，初始 PID 65201。每店沿用既有 bootstrap 模板、8分钟上限、browser 资源准入、renewal/profile 锁；每店独立结果，不重试 DL。临时门禁以 wx 独占创建并绑定专用 marker，正常 finally 与 systemd ExecStopPost 均负责清理；后者先停止本批限定模板实例再清理。未建立 all-25/renewal 门禁，未开启 timer，不是正式调度准入。主代理保留本批唯一生产写所有权。
- Webhook SSH 修复终态：代理交回两文件。主代理实读 diff，确认生产超时下限未变、移除 Promise.race/私有 pool 强制释放、保留 await coreMain 生命周期，补 Client/pool error listener；主代理实跑迁移与 SSH 两套测试 52/52 通过。新增 post-commit 测试覆盖 core 的 OUTCOME_UNVERIFIED，但不是完整生产 SSH 写入演练。尚未执行新冻结或上线。

- 新备份完整恢复已通过（终态更新）：`shein-fm-postcatchup-restore-20260905.service` 已 inactive、MainPID=0、Result=success、ExecMainStatus=0。`latest.json` 于 `2026-09-05T11:10:54Z` 返回 ok=true，备份文件 `shein-fm-weekly-20260905T102755Z.dump`，1285479372 字节，SHA-256 `36275570b853851c23f86d7ece93bf267c5deb6112f82806a2556900438ea6bc`；恢复验证 storeCount=43、salesRows=4865852、webhookReceipts=137279、criticalRelationsReady=true。随后独立查询临时恢复数据库数量=0。下文“仍运行/尚未恢复”均为此前时间点记录，不是当前结论。43 是数据库维表店铺数量，不是 canonical 25 店认证覆盖。
- 最新重新读取人工登录状态：25 completed、active=false；飞牛 `systemctl list-timers --all 'shein-fm*'` 为 0。人工登录不再是当前未完成项；后台 HTTP 会话刷新仍须单独证明。

- 会话更新前保护完成：canonical 25 店 completed、无 active 窗口下，原有 25 份加密 HTTP 会话已独占复制到 `/srv/shein-fm/backups/session-prebootstrap-20260905`（目录0700、文件0600，逐文件哈希一致）。state SHA-256 `af87f75b8e74761b7597ce506a3b236ef4cbc7720b5b5a4c31fbc2a5f601952b`，按 canonical 顺序的 store/hash 集合 SHA-256 `8e496e234058685114c3c4f7464f53611ff02eebd189376c117045ee0ad70a76`。以 sheinfm 执行既有 bootstrap --stores=25店 dry-run 通过，profileSessionsOpened=0、sessionBundlesWritten=0；尚未执行或宣称后台会话已更新。

- 登录进度后续实读：state `updatedAt=2026-09-05T10:26:31.677Z`，canonical 25 店全部 completed、active=false。逐店只读解密现有后台 HTTP 会话，25/25 可读且绑定校验通过，但 identityProvenAt 最早 `2026-08-15T16:38:47.690Z`、最晚 `2026-08-16T16:45:51.831Z`；这是旧 HTTP 会话，不能用 completed 数直接证明后台认证有效。下一步使用现有 bootstrap 脚本从新 Profile 导出，经浏览器/HTTP UPDATE_TIME 双读哈希匹配后才替换加密会话；不重置登录记录。

- 新备份隔离恢复已启动：`shein-fm-postcatchup-restore-20260905.service`，invocation `135cc9c387b941658573877defc4b2f7`，启动 PID 58854。fresh db-heavy READY 后使用既有恢复脚本，限定新备份目录，创建独立 `shein_fm_restore_check_*` 库，30 分钟超时；无定时器、未覆盖 `shein_fm`。旧恢复报告保存在 `/srv/shein-fm/runtime/backup-restore-test/pre-postcatchup-20260905.json`。当前仍运行，不算通过。

- 采购诊断代码：原实现代理上游空响应终止，主代理接回 `src/warehouse/supply-repository.mjs` 和相关测试所有权。原有九个采购入库 guard 保持消息、SQL、事务和拒绝条件不变，只补固定 `error.code`。新增三类实际失败测试（完整行集、JIT 证据、同时间戳漂移）断言固定码不含样本订单标识、ROLLBACK、无 COMMIT、连接释放。仓库测试 23/23，供需 CLI/采购 adapter/runner wiring 测试 28/28，通过；未部署、未发版、未重试 MZ 请求，MZ 根因仍未知。

- Webhook 冻结预演：主代理经专用 SSH/PG 连接在 READ ONLY 事务中独立读回两端身份和 readiness；cloud pin `e7eaa9b45871fcabf4933a7c98d645e791057f813b8d0dda35810156f0c2b748`，fnOS pin `0b97c36b3b103f13c1970be940aaad36a47b8874141d8027fa0f3e88a8ce81cd`。47 项本地迁移/SSH 测试通过。随后停止云端五个 Webhook 激活/执行单元，确认两端 inactive、写锁观察计数为 0，运行默认 250 条分页的 prepare-forward dry-run，设置 300000ms 上限。预演未产出计划，达到上限后出现 `SSH_OPERATION_TIMEOUT` 及未处理 Client error，退出 1；没有执行 --execute。
- 预演失败恢复：云端 receiver/worker 已重新启动并读回 active；两端迁移应用连接数均回到 0，fnOS receipt 仍为 137279。公网 upstream 未改，业务定时器未新增。receiver 的实际健康接口为 `/healthz`，不是 `/health`。后续需修正超时处理并改善分页耗时后，再发起新冻结计划；本次没有可复用的 planHash 或 forward baseline。

- 补数后新备份：一次性单元 `shein-fm-postcatchup-backup-20260905.service`，invocation `7b18708e852749a0b77765e3dd1b7b98`，在 fresh io-heavy READY 后执行并以 0 成功终结。文件 `/srv/shein-fm/backups/migration-20260905-postcatchup/shein-fm-weekly-20260905T102755Z.dump`，1285479372 字节，SHA-256 `36275570b853851c23f86d7ece93bf267c5deb6112f82806a2556900438ea6bc`。既有脚本已执行 pg_restore --list；尚未对这份新文件完成整库恢复演练。保留旧备份、跳过清理、不启用定时器。
- 新备份独立盘复制已完成：二进制流传输源/目标进程均 exit 0、1285479372 字节，NAS 临时文件 fsync 后 SHA-256 完全一致；同目录无覆盖改名为 `/vol3/shein-fm-backups/shein-fm-weekly-20260905T102755Z.dump`，正式路径再算 SHA-256 仍一致，权限精确收紧并读回 0600。9 月 2 日旧副本仍保留。此为本次人工触发副本，不是自动同步完成。

- 2026-09-05 补数后只读快照：云端 Webhook receipt 为 143722，飞牛为 137279，相差 6443；这不是冻结快照、逐行一致性证明或获批迁移计划。云端 receiver/worker 仍 active，飞牛对应服务 disabled/inactive。
- 当次两端 `nonterminal_jobs=0`、占用或到期租约为 0；PENDING 指令云端 67163、飞牛 63834，仍有待处理积压，不能称全部消费完成。
- 主代理已核对 `inspect-identities` 同样进入 `beginFrozen()` 并取得 ACCESS EXCLUSIVE 锁，未把它当成在线无扰动探针执行。
- 飞牛 `shein-fm-db-backup.timer` 当前 disabled/inactive。VM 内备份目录位于 `/srv/shein-fm` 的 `/dev/sdb1` ext4 业务盘。
- 后续通过现有专用 SSH 密钥读回 NAS 宿主：`/vol3` 属于 `/dev/sda1`，容量 465.8GiB（500GB 标称盘），与 `/vol2` 的 931.5GiB 盘独立。`/vol3/shein-fm-backups/shein-fm-weekly-20260902T151520Z.dump` 存在、1279019556 字节、0600，SHA-256 与上述已通过恢复测试的文件完全相同。独立盘副本已验证，不再标记为缺失。
- NAS 该 ZFS 池当次 ONLINE、无已知数据错误；SMART 读取因权限不足未完成，不能据此称硬盘健康。9 月 2 日旧副本和补数后新副本均已核验，但尚未证明自动同步链路完成；也不是整机/Profile 备份验证。
- 未完成：MZ 单日入库根因、订单管理完整性、剩余人工登录、自动备份链路及新备份整库恢复演练、Webhook 可逆追平与正式切流、调度所有权转移及稳定观察后的版本管理。
- 文档代理因上游空响应终止后，主代理接回本文件所有权并补入上述已核验结果；未接管仍在运行的代码代理。
