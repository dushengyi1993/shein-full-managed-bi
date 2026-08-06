# 系统管理与运行态投影

## 页面职责

`#system` 是“运行与数据维护中心”，不是技术能力陈列页，也不是通用远程运维终端。除一个受限的管理员登录维护中心外，其余页面均为只读。它回答五个问题：

1. 当前是否存在会让 BI 过期、缺数或失真的故障；
2. 哪些店铺的 Profile 已完成登录登记，哪些最近一次续期验真有效；
3. 核心服务和计划任务最近一次是否成功、下一次何时运行；
4. 当前负责人或店铺范围内，商品、库存、备货、采购和交付六个数据域覆盖是否完整；
5. 当前版本、授权、Webhook 仓库和写动作总闸是否符合只读阶段的安全边界。

系统问题按影响程度排在最前，Profile、服务、数据覆盖随后，版本和技术边界默认折叠。全局搜索可筛查店铺、负责人、问题和错误码；负责人/店铺筛选会在服务端重新核算 Profile 与数据覆盖，不能只在浏览器隐藏行。

## 两类 Profile 证据

页面刻意区分：

- **登录登记**：同事在一次性页面完成 Profile 登录并被登记为 `completed`；
- **会话验真**：每日 HTTP 探测得到 `ACTIVE / EXPIRED / BLOCKED / UNKNOWN`；只有异常店才打开 Profile 恢复。

“已登记”不等于当前登录态有效。最近续期报告没有覆盖的店铺显示“待续期验真”，不能从旧登记推断为正常。页面只显示店铺、状态、错误码和事实时间，不读取或返回 Cookie、密码、Local Storage、IndexedDB、页面内容或 OpenAPI 凭据。

系统管理员可在同一表格中为单店打开云端 Chrome、完成登录验真或关闭异常窗口。
一次只允许一个 Profile 活动；普通员工只能查看状态。该动作只维护全托店铺后台登录态，
不提交 SHEIN OpenAPI 业务写入。

## 安全数据流

```text
root 私有运行证据 + systemd 固定白名单 + 磁盘守卫 + release 链接
  -> root oneshot 脱敏投影
  -> /srv/shein-fm/runtime/dashboard/system-health.json
  -> Portal 严格校验
  -> 认证后的 GET /api/system
  -> #system
```

`scripts/materialize_full_managed_system_health.mjs` 只读取代码中固定的文件和 unit 白名单，不接受浏览器传入路径或 unit 名，不访问网络，不执行 `systemctl start/restart`，也不触发登录、续期、同步或 SHEIN 写请求。输出使用临时文件加原子替换。

Portal 只读 `dashboard.json` 与脱敏的 `system-health.json`，没有 Profile 目录、数据库或平台凭据权限。`/api/system` 只接受 `owner`、`store` 和 `q`，重复、未知、越界或跨负责人参数均返回 `400`。运行态文件损坏时返回 `503`；文件缺失时页面明确显示 P0 问题，不用零值伪装健康。

登录维护使用独立的 `/api/system/store-login/*`。它要求有效 BI 会话、`admin` 角色、
同源 POST 和 root 通过 systemd `LoadCredential` 注入的内部令牌；Portal 只在
`127.0.0.1` 代理固定动作，不读取 Profile 文件，也不把内部令牌发给浏览器。

## 运行节奏

- `shein-fm-system-health.timer` 每 5 分钟刷新一次脱敏运行态；
- 浏览器的“重新读取运行态”只重读现有快照，不执行任何后台任务；
- HTTP 会话续期由独立的每日轻任务负责；系统页展示最近结果和恢复队列，并允许管理员在掉线时人工重新登录；
- Dashboard、供应链、Webhook 和磁盘仍由各自服务产生事实，系统投影不改变它们的调度。

部署时必须先安装并验证 collector unit，成功生成 `system-health.json`，再重启引用该只读路径的 Portal。

## 验收

生产发布至少回读：

```bash
systemd-analyze verify \
  /etc/systemd/system/shein-fm-system-health.service \
  /etc/systemd/system/shein-fm-system-health.timer \
  /etc/systemd/system/shein-fm-portal.service

systemctl start shein-fm-system-health.service
systemctl enable --now shein-fm-system-health.timer
systemctl status shein-fm-system-health.service shein-fm-system-health.timer
```

还必须确认：

- 输出文件归属、模式、大小和 JSON 契约正确；
- 输出不含 cookie、password、token、secret、authorization 等私密值；
- 未登录 `/api/system` 返回 `401`，登录后返回 `readOnly: true`；
- 负责人/店铺筛选后的 Profile 和六域覆盖与真实快照一致；
- systemd 失败、Profile 失效、磁盘告警和 Webhook 不健康能形成具体问题；
- SHEIN 业务写动作总闸关闭；唯一 mutation 控件是管理员专用的云端 Profile 登录维护；
- Portal 控制台无错误，桌面和窄屏没有横向页面溢出。
