# StoreLogin → fnOS 混合切换（25 店人工登录窗口）

面向对象：主代理与授权同事。主代理负责全部技术动作与验收；同事只负责逐店登录。
本文只覆盖"仅 StoreLogin 路由临时指向 fnOS"的窗口，公共路由不切（Portal 8788 与 Webhook 8793 公共路由不动），Portal 内部代理需协调指向 18794。
准备阶段不执行任何生产操作，所有切换只在人工登录窗口进行。

硬性禁令：

- Nginx 切换只允许 "sudo nginx -t" 通过后 "sudo systemctl reload nginx"；
  禁止 restart，禁止 "nginx -s"。
- batch URL（含 token）只通过私密渠道交给授权同事本人，不得写入文档、
  日志、群公告或截图。
- 登录过程中不创建任何完成/启用类门禁标记（见文末"另行决策"）。

## 一、登录前 fresh preflight（主代理）

0. stale 门禁与继续登录预检：
   - 当前处于 25 店分批登录推进中（例如已完成大部分店铺，剩余 1-2 天窗口）；
     **严禁为了推进进度而绕过全店门禁**。
   - 检查 `/srv/shein-fm/runtime/store-login/` 与相关目录是否存在旧残留标记
     （`all-25-completed`、`renewal.enabled`、`webapi-history.enabled` 等）。
     **必须明确：历史或遗留的标记不代表当前会话有效，具体运行快照不可作为永远有效的门禁**。
   - 全托业务 timers（续期与回补）必须继续保持 disabled 与 inactive。
   - 若发现非本次有效授权的旧残留标记需要移除或隔离，必须由主代理在独立 fresh scope
     中核实、受控备份并完成 readback，不得向操作人员直接发实施命令或草率就地删除。
   - **首次重置与续登场景区分**：下文第 1 项全店非 ACTIVE 事故基线与第 4 项状态重置（reset）
     门禁仅用于首次事故接管/全量重置，**不适用于已有已完成进度的续登窗口**；续登场景必须读回
     canonical 25 店完整集合并核验当前实际进度（已完成店铺数与待登店铺数），**严禁对已完成店铺重复 reset 或重复重建会话**。
1. 三份状态文件 exact readback（路径与读法以
   docs/runbooks/data-disk-and-profile-login.md 为准）：
   state.json、renewal-report.json、session-recovery.json。
   当前/预期事故基线必须同时满足：
   - state.json 的 active 为 null，stores 是无缺失、无额外店码的 canonical 25 店；
   - renewal-report.json 的 results 是 canonical 25 店，25 店均为非 ACTIVE
     且 recoveryQueued=true，completedProfileCount=25、activeCount=0、
     recoveryQueuedCount=25；
   - session-recovery.json 的 stores 是无重复的 canonical 25 店，并与续期报告中
     “非 ACTIVE 且 recoveryQueued=true”的店码集合 exact 一致；
   - renewal-report.json 的结果集合、activeCount、recoveryQueuedCount 与
     session-recovery.json 的集合/计数相互一致。
   查询失败不是 0，任何读取失败或集合/计数不一致都停下处理，不得视为通过。
   若登录窗口开始时任一事实变化，准备阶段预期和旧计划全部作废：基于真实文件重新执行 fresh
   dry-run；输入不满足校验则 fail closed，店码或计数变化则由主代理重新评审并重规划。
2. 无活跃登录会话：确认没有正在运行的登录进程/浏览器会话；
   fnOS 上 25 个 Profile 目录均无 Chrome Singleton locks
   （SingletonLock / SingletonCookie / SingletonSocket）。
3. timers disabled：全托相关 systemd timers 准备阶段与登录全程保持
   disabled，读回 is-enabled / is-active 作为证据。
4. 状态重置（只由主代理执行，具体参数以
   docs/runbooks/data-disk-and-profile-login.md 与脚本输出为准）：
   - 先跑 scripts/reset_full_managed_store_login_state.mjs dry-run，
     取得 exact-plan 五值：plannedUpdatedAt、plannedStateSha256，
     以及 apply 所需的三个 --expected-*-sha256 输入
     （state / renewal-report / recovery queue）。同时确认 storeCodes、
     unchangedStoreCodes、resettableStoreCount、preservedStoreCount。
     dry-run 不产生、也不输出 backupBasename。
     reset 脚本的各值参数只接受参数名和值以空格分隔，不能使用等号，例如
     --planned-updated-at '<val>'；其余四个 exact-plan 参数同样如此。
   - 在状态服务停写窗口内执行 --apply，五值原样回传，任何漂移即中止。
     窗口内主代理是唯一写 owner；状态文件 owner 与 0600 mode 由脚本保留。
   - apply 输出必须与 dry-run 的 plannedUpdatedAt、plannedStateSha256、
     inputSha256、计划店码及上述计数 exact 一致；apply 额外产生
     backupBasename。按该 basename 读回同目录备份文件，必须确认文件存在、
     mode=0600，owner 与原 state 相同（预期 sheinfm:sheinfm）。
     随后对新状态文件做最终 exact readback，确认哈希、owner、mode，
     才能恢复写入。

## 二、安装混合 selector 与 Portal 内部路由（主代理）

2026-09-05 settled live 事实：cloud 公共 Portal 8788 与 Webhook 8793 未切；
StoreLogin 公网经 18794 隧道切向 fnOS。除 Nginx upstream 外，cloud Portal
管理后台（`#system`）的内部代理也必须通过 systemd drop-in 显式指向 18794，
否则内部请求仍会穿透到旧 cloud StoreLogin 8794，造成外部与内部视图分裂。

1. 备份当前 cloud selector：
   复制 /etc/nginx/shein-fm-upstreams.conf 到受控备份位置，记录 SHA-256。
2. 安装本仓库 infra/nginx/shein-fm-upstreams-store-login-fnos.conf
   到 /etc/nginx/shein-fm-upstreams.conf。
3. sudo nginx -t 必须通过，然后 sudo systemctl reload nginx。
4. 配置 Portal 内部路由 drop-in（仅修改本次明确授权的配置项）：
   - 创建 drop-in 目录：`/etc/systemd/system/shein-fm-portal.service.d/`。
     若目录下已有该文件，先对旧文件做受控备份；**严禁盲目删除该目录下其他未知的既有配置**。
   - 写入 `/etc/systemd/system/shein-fm-portal.service.d/90-fnos-store-login.conf`：

     ```ini
     [Service]
     Environment=FULL_BI_STORE_LOGIN_INTERNAL_URL=http://127.0.0.1:18794
     ```

   - 执行配置生效与独立重启（**仅重启 Portal，不重启 Nginx，不触碰 StoreLogin 活跃窗口**）：

     ```bash
     sudo systemctl daemon-reload
     sudo systemctl restart shein-fm-portal.service
     ```

   - 用户认证状态验证：Portal 配置重启后应先验证原用户会话；已知此前认证失效源自角色
     credentialTag 变更而非重启必然失效。只有在实际请求收到 HTTP 401 时才提示重新登录，
     不预先宣称重启必失效；现有用户角色体系（仅系统管理员 admin，其余不变）保持不变。
5. 混合入口双路径一致性检查（必须全部通过）：
   - **公网入口路径（Path A）**：Nginx upstream exact readback，必须同时满足：
     shein_fm_portal = 127.0.0.1:8788，
     shein_fm_webhook = 127.0.0.1:8793，
     shein_fm_store_login = 127.0.0.1:18794。
     前两值就是"公共 Portal/Webhook 全程没切"的证据。
   - **Portal 内部路径（Path B）**：`systemctl show -p Environment` 仅代表 unit 管理器配置，
     不能作为实际进程确证。必须通过 `systemctl show shein-fm-portal.service -p MainPID --value`
     取得实际 MainPID，在受控脚本中只提取 `/proc/<MainPID>/environ`（NUL 分隔）中
     `FULL_BI_STORE_LOGIN_INTERNAL_URL` 单一键值，**禁止输出完整 environ 或凭据内容**；
     随后请求 Portal 内部接口（`#system` 管理页 internal status），必须返回 HTTP 200，
     且其返回状态内容与同一 fnOS 实例的 state.json 完全一致。
   - **一致性判定**：双路径必须同时收敛于 18794，禁止出现公网与内部端口不一致。
6. 任一步失败：立即把备份装回 /etc/nginx/shein-fm-upstreams.conf，
   复原或移除 drop-in，并执行：
   `sudo systemctl daemon-reload && sudo systemctl restart shein-fm-portal.service` 与
   `sudo nginx -t && sudo systemctl reload nginx`，
   读回确认三值回到 8788 / 8793 / 8794。

## 三、Batch bearer（主代理）

1. `batch.json` 的生产不变量是 regular、非 symlink、`root:sheinfm 0640`。
   `shein-fm-store-login.service` 以 `sheinfm:sheinfm` 运行，并通过
   `ReadOnlyPaths` 只读该文件，因此不能把 batch 改成 `0600`，也不能改成
   `sheinfm:sheinfm`。先读回现有文件；create 只允许替换 schema 有效且已经过期
   或已经撤销的旧 batch，文件缺失、活动 batch、错误 owner/mode、symlink 或坏
   schema 均 fail closed。
2. create 必须由 root 执行。与 reset/revoke 脚本相反，create parser 只接受
   等号格式。登录窗口开始前生成 24 小时批次的真实 CLI 语法是：

   ```bash
   sudo node scripts/create_full_managed_store_login_batch.mjs --expires-hours=24
   ```

   工具先对旧 batch 做同目录独占 `0600` 备份，再以独占临时文件、`fchown`、
   `fchmod 0640`、文件 fsync、rename 前二次漂移检查和原子 rename 安装新 batch；
   最终读回失败会尽力恢复旧 bytes/owner/mode。成功输出只给备份 basename，不能
   把 stdout 重定向到文件，因为其中含新 bearer URL。随后立即用 `stat` 和哈希
   读回确认新 batch 是 `root:sheinfm 640`，哈希对应当前文件；同目录备份必须存在、
   owner/group 与旧 batch 一致、mode 为更严格的 `600`。

   ```bash
   sudo sh -c 'cd /srv/shein-fm/secrets/store-login && stat -c "%U:%G %a" batch.json && sha256sum batch.json'
   ```

   `stat` 首行必须精确为 `root:sheinfm 640`；备份只用成功输出的 basename 在同目录
   做同样读回，不把绝对备份路径写入日志。
3. 这是可复用至到期或撤销的短期 batch bearer：在到期或撤销之前，
   同一个 bearer 可供多位授权同事使用。服务端批次文件只保存 token 的
   SHA-256 hash；生成 CLI 的 stdout 会显示含明文 token 的 URL，主代理不得
   将该输出重定向到文件或写入日志。
4. 登录页 URL 形如 `https://fm.dushengyi.cc/store-login#token=...`。
   `#token` 是 URL fragment，不随首次或后续 HTTP 请求发送给 Nginx/upstream；
   页面只从 `location.hash` 读取 bearer，转入 `sessionStorage` 后立即用
   `replaceState` 清除地址栏。旧的 query 链接明确不兼容，不保留 query fallback。
   URL 只以私密渠道交给授权同事；Nginx 对 `/store-login`、`/store-login/`、
   `/api/store-login/` 仍全部 `access_log off`。

## 四、登录纪律（同事人话版，可直接转发）

一次只开一家店，同一时间只有一个操作员在登录。

1. 打开主代理发的登录链接，在打开的登录窗口中完成该店登录，
   并允许 Chrome 保存密码。
2. 点"登录完成并验证"。必须看到这一家显示"完成（completed）"，
   才能开始下一家。
3. 单店失败会显示"需要注意（needs_attention）"：跳过它继续下一家，
   但不许把失败当成功。结束前把店铺名和看到的提示告诉主代理。
4. 页面上没有任何"启用续期""全店完成"之类的开关，也不要寻找或
   手工创建这类文件；这些由主代理事后统一决定。

## 五、登录结束后（主代理）

1. 撤销 batch：
   - 先执行 fresh dry-run，零写读取当前 batch，确认 `owner.uid=0`、gid 对应
     `sheinfm`、`owner.mode=0640`，并保存三项 exact-plan 值：
     `plannedRevokedAt`、`inputSha256`、`plannedSha256`。

     ```bash
     sudo node scripts/revoke_full_managed_store_login_batch.mjs
     ```

     若输出 `alreadyRevoked=true`，停止，不执行 apply，也不改写原撤销时间。
   - 把 dry-run 三值原样回传；revoke 参数只能用“参数名 空格 值”，拒绝等号：

     ```bash
     sudo node scripts/revoke_full_managed_store_login_batch.mjs --apply \
       --planned-revoked-at '<plannedRevokedAt>' \
       --expected-input-sha256 '<inputSha256>' \
       --expected-planned-sha256 '<plannedSha256>'
     ```

     apply 会重新读取并校验 schema/hash/metadata，要求当前 batch 为
     `root:<原 gid> 0640`，且父目录为 `root:<同 gid> 0750`；只把
     `revokedAt:null` 改成计划时间。它先创建同目录
     独占 `0600` 备份和随机独占临时文件，fsync 后做 rename 前第二次漂移检查，
     原子替换并最终读回；任何写后失败都会尽力恢复原 bytes/uid/gid/mode。
   - apply 输出必须与 dry-run 三值、owner/mode exact 一致，并只额外出现
     `backupBasename`。按该 basename 读回同目录备份，再确认当前 batch 的 SHA-256
     等于 `plannedSha256`、owner/group 为 `root:sheinfm`、mode 为 `640`，备份 mode
     为 `600`；不得把 bearer、tokenHash、文件正文或绝对备份路径写入证据日志。

     ```bash
     sudo sh -c 'cd /srv/shein-fm/secrets/store-login && stat -c "%U:%G %a" batch.json && sha256sum batch.json'
     ```

     `stat` 必须精确读到 `root:sheinfm 640`，`sha256sum` 必须等于
     `plannedSha256`。
   - 保留撤销前已经打开且持有该 batch bearer 的外部登录页。撤销读回完成后刷新
     该页，让它用 `sessionStorage` 中的已知 bearer 再请求
     `/api/store-login/status`，Network 必须读到 HTTP 401。无需把 bearer 粘贴进
     命令行或文档。注意验收是 API 401，不要求页面 404；登录页面本身仍由本机
     服务托管。
2. 内部路由与 selector 回滚（主代理）：
   - **复原或移除 Portal drop-in**：
     根据部署前实际情况执行对应分支，**严禁一律删除未知既有配置，不触碰 StoreLogin 活跃窗口**：
     * 分支 A（若部署前该文件原本不存在）：安全移除本次创建的 `90-fnos-store-login.conf`。
     * 分支 B（若部署前已存在同名配置并做了受控备份）：从受控备份文件还原原内容。
   - 重新加载 systemd 并仅重启 Portal 服务：

     ```bash
     sudo systemctl daemon-reload
     sudo systemctl restart shein-fm-portal.service
     ```

   - 读回 Portal 实际进程配置与 internal status：
     取 MainPID 后受控检查 `/proc/<MainPID>/environ`，确认 `FULL_BI_STORE_LOGIN_INTERNAL_URL`
     恢复为默认 `http://127.0.0.1:8794`（或无覆盖注入），严禁打印完整 environ；通过内部接口
     验证 internal status 正常返回 HTTP 200 并核对状态。
   - **selector 回滚**：把 cloud 模板装回 /etc/nginx/shein-fm-upstreams.conf，
     sudo nginx -t + sudo systemctl reload nginx，
     三值 readback 回到 8788 / 8793 / 8794。

## 六、另行决策（不在本 runbook 执行）

all-25-completed、renewal.enabled、webapi-history.enabled
三个门禁标记，必须由主代理在 25 店全部 completed、会话真实校验、
且后续授权门禁通过之后另行决定是否创建。准备阶段与登录过程中一律不创建。

严禁将临时的、旧的或单次的运行快照视为永久有效门禁。任何门禁标记的创建与清理
都必须走独立审批和可验证的 fresh readback。

## 七、不等待剩余店铺的并行推进边界

- **严禁泛化 all-25 门禁**：WebAPI 全店调度与全局续期标记（`all-25-completed`、
  `renewal.enabled`）仍恪守真实全店完成要求、绝不伪造，但不可将该门禁泛化并阻断其余独立链路。
- **OpenAPI 财务与供需补数**：基于平台官方 OpenAPI 的单店、单窗口补数不依赖 WebAPI 全 25 店
  登录状态；主代理在遵循 fresh plan、串行生产提交与最终 readback 的前提下即可独立继续推进。
- **候选 Portal 验证与临时 DB 恢复**：候选 Portal 页面逻辑验收与独立临时数据库恢复测试完全解耦，
  不等待剩余店铺登录进度，可并行开展。
- **Bootstrap 子集范围限制**：部分店铺 bootstrap CLI 虽支持 `--stores` 子集参数，但既有 gate
  与 systemd unit 授权须由主代理单独评审，不能仅凭 CLI 参数支持就宣称整体链路可执行。
- **Webhook 追平边界**：Webhook 数据追平仍需独立的流量冻结、数据库身份 pin 与可逆切换计划；
  既不因 WebAPI 登录店铺尚未全齐而自动阻塞，也绝不能无条件直接切公网。

## 八、主代理证据清单（技术归档，含精确值）

- preflight：三份状态文件 readback 原文、canonical 25 集合/计数核对、
  fnOS 上 25 个 Profile 的 Singleton 检查输出、timers 状态。
- reset：dry-run 与 apply 的完整 JSON 输出；两者共享字段、计划店码和计数的
  exact 对比；apply 额外返回的 backupBasename、备份文件存在性/0600/owner
  readback；最终状态文件 exact readback。
- 混合入口双路径一致性：
  Nginx 三 upstream 端口 readback（8788 / 8793 / 18794）、
  Portal drop-in 文件、Portal 实际进程 MainPID `/proc/<MainPID>/environ` 单键提取 readback、
  Portal 重启日志及 `#system` internal status HTTP 200 与 fnOS 状态一致性证据。
- selector：备份 SHA-256、nginx -t 输出、systemctl reload 返回码、
  三 upstream readback、失败时的恢复记录。
- batch：生成时间与 expiresAt（不含 token 明文）、撤销读回、
  HTTP 401 证据。
- 收尾：
  Portal drop-in 移除/复原证据、MainPID `/proc/<MainPID>/environ` 恢复 readback 及 internal status 验证、
  回滚后 Nginx 三值 readback（8788 / 8793 / 8794）；
  Portal 与 Webhook 全程未切的端口证据。
