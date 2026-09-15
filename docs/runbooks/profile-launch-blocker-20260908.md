# 本地公司 Profile 启动拒绝：证据与未解边界

## 当前状态

- 公司 Profile 没有重建、复制或清理；未修改密码库。
- 全托主体映射为 17 个公司、25 家店。其中 14 个主体复用半托 Profile，GJ/RH/WY 使用内部 Default，其余使用 Profile 1。
- CX Profile 存在且启动前没有占用，调试端口 19321 未监听。
- 用户已重启电脑；Chrome 扩展已安装、设置已启用。刷新 CUA 会话后已识别日常 Profile“萝卜”，并实际打开了 SHEIN 开放平台登录页。该日常 Profile 未登录，检查页已关闭。
- **扩展连接恢复不等于公司 Profile 启动拒绝已解决。** 公司白名单仍未修改，业务继续使用旧 OpenAPI 出口。

## 两任务直接对照

全托任务和半托任务当前都使用 PowerShell Core 7.6.5，外层可执行文件：

`C:\Users\dushengyi\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe`

两边可见的权限上下文均为 approval_policy=never、sandbox_mode=danger-full-access、filesystem unrestricted、network enabled。不能据此认定所有入口审核也相同。

半托任务 `01a07909-5c0e-7683-9a82-ffb0f9890c5c` 提供并经本任务核验的成功证据：

- 2026-09-08 12:53:42 北京时间，已有入口 `node scripts/launch_store_browser.mjs JY --headless` 创建 PID29364，reused=false，最终 pageReady=true。
- 日志：`E:\Codex WorkSpace\Shein销售统计\tmp\marketing-local-20260908-1242\JY-launch-recovery.log`。
- 该旧会话已由原任务清理，不能作为可交接会话。
- 启动器内部有 Node → Windows PowerShell → Chrome 的进程层级；全托遭拒调用是外层 PowerShell 直接启动 Chrome。**这只是已观测差异，不是允许/拒绝原因的证明，不能据此换包装绕过拒绝。**

## 全托拒绝的可定位记录

任务 ID：`019ffa37-8926-7e03-94bf-86dd2b088646`。

本任务会话原始日志：

`C:\Users\dushengyi\.codex\sessions\2026\08\13\rollout-2026-08-13T16-22-51-019ffa37-8926-7e03-94bf-86dd2b088646.jsonl`

- 2026-09-08 13:31:08.949 北京时间，调用 `call_i23aLIh4cZ0tMVJpWqyMmX1r`：只读策略检查命令在工具执行入口被拒绝，诊断子进程未运行。
- 2026-09-08 13:55:27.472 北京时间，调用 `call_ZgCnwqT6fhG3Plqkh3A839dN`：电脑重启后重试直接启动 CX；已去掉 password-store 参数，并明确绑定调试地址 127.0.0.1，仍在 CreateProcess 前返回 `Rejected / blocked by policy`。
- 本机 default.rules 有 344 行，未检出显式 deny/forbidden；这不能排除其他入口审核。

## 仍缺的决定性证据

上述调用对应的入口审批记录、实际 policy source、reason 或可用审批入口。现有工具错误未提供这些字段。不得把未知原因归为用户未安装扩展、未改默认浏览器、Profile 损坏或需要重新提供密码。

不应再要求用户为同一未查明原因反复重启、重装、清缓存。若由产品支持查询，应以任务 ID 和调用 ID 定位入口记录；不要发送 Cookie、密码、完整会话日志或其他项目资料。
