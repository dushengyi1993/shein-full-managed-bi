# 飞牛下一候选发布验证清单（2026-09-06）

## 状态与所有权

本文件不是可直接执行的部署脚本。业务补丁尚未部署，公网Portal/Webhook仍由云端承接。Faraday文档修订进程报告上游空响应终态错误后，主代理接手本文件；其他协作域不受影响。

已建立三个本地提交：a7d70c6（Webhook）、8e7b83d（备份）、0cc9c30（业务质量/错误码）。尚未推送、创建标签或GitHub Release，线上仍为原部署。

- 飞牛最新归档的独立盘副本及整库恢复已验证，恢复服务于9月6日00:53结束；并非仍在运行。
- 飞牛既有weekly backup和monthly restore timer均已启用；下一次恢复演练为10月4日01:17:22 CST。
- 云端9月6日01:16恢复演练退出75，属延后，不算完成。云端回滚资产保留。
- 详细主机状态、时间戳与归档哈希以fnos-progress-20260905.md逐次实测记录为准。

## 已核实的业务补丁

| 文件 | SHA-256 |
| --- | --- |
| scripts/run_full_managed_business_coordinator.mjs | 007fafecb0ae2a2f09e14a299a3aa16a6a144b7f506e4a75114743afe3455ead |
| src/warehouse/supply-repository.mjs | 53b0449ddbc7c288b4764ee3fc5d4b7eaf446ad7d02eca40eb13eaeb3bb80790 |

协调器补丁保留loaded/PARTIAL的每店质量缺口，异常的exit2摘要不能静默完成。Supply补丁增加固定安全错误码，不改变数据拒绝规则，也不证明MZ2406缺失数据已补齐。

## 主代理独立测试证据

- 两项业务补丁定向测试38/38通过、0跳过（exec chunk38393e，退出0）。
- 备份同步与重试测试11/11通过、0跳过（chunk7ddb25，退出0）。
- 维护域npm run test:maintenance，120/120通过、0跳过（chunk9a38d6，退出0）。
- 主代理完整npm test：1518项，1507通过、11跳过、0失败（chunkdee4cf，退出0）；跳过包含真实数据库及平台限制项，不称100%全部验证。真实SSH集成另以session34109执行。
- Webhook批量INSERT实机SSH集成session34109已exit0：16通过、1直接连接模式跳过；25批5000插入、4单行更新，forward与reverse完成，两端唯一临时库独立确认0残留。核心SHA699dbfdafa53d4802d2c43404217d1695d9ff948b03c56903b808380681e5ef6。生产规模性能尚未证明。

## 发布准入与停止门禁

1. 保留现有dirty worktree；逐个确认本次归属、测试与审查完成，不自动把所有修改提交，不要求变更main分支。
2. 业务代码继续采用不可变release目录；禁止直接覆盖current所指向旧commit中的文件。独立备份维护脚本路径不能当业务模块overlay。
3. docs/runbooks/disk-and-history-governance.md第63行明确本仓库没有单体部署脚本。原清单中的占位tar命令、ln -sfn原子性声称、daemon-reload替代应用重启及自动prune建议已撤除，不得据此部署。
4. 精确部署前必须确认完整归档和commit绑定、依赖安装与自检、受影响服务及锁占用、旧current/previous目标、同文件系统临时软链rename步骤、常驻进程换版与回滚命令。
5. daemon-reload仅重读unit，不能证明常驻Portal已加载新代码；常驻服务需要按实际部署流程换版并读回进程运行目录/版本。
6. Portal源码src/server/app.mjs提供/health和/ready；9月6日主代理在飞牛8788实测分别ok和ready。此只证明当前部署，不证明未来候选或全业务数据完整。
7. 不自动删旧release、归档或云端；不发临时Release消耗CI。先完成当前候选验证，再由主代理执行有边界的Git提交及必要发布。

## 切流边界

docs/runbooks/fnos-cutover.md第7.5至7.8节约束Webhook：新冻结、新planHash、execute后独立连接读回、fresh dry already_applied、forward rollback manifest，全部通过才可启动飞牛Webhook并修改公网路由。文件修改或源状态恢复后旧planHash失效。不得把应用发布、测试通过、门禁预检或备份成功当成切流完成。
