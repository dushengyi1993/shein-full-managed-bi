# 飞牛办公室入口：HTTP IP 已上线

## 当前状态（用户随后明确批准 HTTP）

- 可访问入口为 `http://192.168.1.79`，只绑定 VM LAN 地址的80端口、只允许192.168.1.0/24，严格校验Host。无需Cloudflare、证书、改路由器或客户端hosts。HTTPS子域名方案延期。
- `shein-fm-lan-portal.service` 和 `shein-fm-lan-gateway.service` 均active/enabled；前端PID343302，入口最终Invocation `9d8ac6d12f3343fb925cf972e250f148`。gateway NRestarts=1来自本次受控故障恢复测试，不是未知故障。
- 独立代码目录 `/opt/shein-fm/maintenance/lan-http-13fdfabea1df-3fcc1e725d71`，复制已验收9ba release后仅覆盖auth.mjs、index.mjs两项运行代码。未改current或公网服务；同一StoreLogin实例/维护队列继续复用。
- 明确生产LAN HTTP开关必须同时满足：production、回环监听、trustProxy、精确RFC1918 IPv4 HTTP origin、Secure cookie=false。默认公网HTTPS守卫不变，不使用development绕过。内网使用独立cookie名`fm_bi_lan_session`及独立受限会话密钥文件`/srv/shein-fm/secrets/portal/lan-session-secret`，不输出或复制密钥到文档。
- Linux目标目录以sheinfm-portal用户执行23项鉴权测试全部通过，无跳过。使用临时测试账号验证登录、cookie、认证数据和退出；没有伪造生产session，真实员工账号尚未代登录。
- 办公室本机读取：/health200、/login200（约4ms、可见账号密码表单）、未认证/api/dashboard401、跨来源/api/login403、/authorize403。浏览器确认已到`http://192.168.1.79/login`，页面正常显示。
- 从VM以127.0.0.1作为来源访问LAN网关，并伪造X-Forwarded-For为办公室IP，仍HTTP403，证明代理头不能绕过网段ACL。原公网Portal及StoreLogin/receiver/worker的切前后进程元组不变。
- 正常restart成功，旧CID元数据清理；初次在systemd报告active后过早读取Docker容器导致not found，重新观察同次Invocation后确认已正常运行，未因观察过早再重启。随后精确锁定本次gateway容器ID/Invocation执行一次KILL故障测试，自动恢复健康200，数据库容器ID/PID/启动时间不变。
- 配置SHA256：LAN Portal unit `c5402e8d8f33be23453f95da79ef9821c42b2f90dcbd3f36c77b22c12b81c17d`；nginx `c55564d235787a5e382ed5915bce8830a6cdbbbcddb39d492affc904e14d41cd`；gateway unit `4f42e4fe97ae54d02fee7abc15cfe67ed2b076e3ba418a78fec14f2f2ef4cb1d`。
- 生产备份/基线位于`/srv/shein-fm/runtime/migration-evidence/lan-http-20260906/`，包含旧LAN HTTPS前端unit与原服务进程元组。回退只需停用新增LAN gateway/Portal，不改公网；若恢复旧LAN unit应使用保存的旧配置，而非仅更换工作目录。
- 边界：HTTP传输不加密，用户已明确接受办公室使用；VM地址仍为DHCP，未擅自改变路由器或固定地址配置。真实账号登录和店铺维护窗口可由员工正常操作，未为验收创建真实维护会话。没有新业务timer、没有Git推送/发版。

## 历史准备状态（已由上述 HTTP 方案取代）

目标：`https://fm-lan.dushengyi.cc`，DNS-only 指向 `192.168.1.79`，仅允许 `192.168.1.0/24` 访问。公网 `fm.dushengyi.cc` 不变。目标网址尚不可用，不向用户当作完成链接交付。

## 已实施和现场验证

- 独立 `shein-fm-lan-portal.service` 已安装并启动，未 enable；仅监听 `127.0.0.1:8787`，PID335816，NRestarts0。工作目录固定 release `9ba4a533c08e4a96689af1ae1b759c73d32532fc`。
- 复用原五项数据文件、用户/会话凭据文件及同一 StoreLogin 8794 服务。保留生产 Secure cookie、独立精确 Origin 和既有沙箱。没有新采集器、业务调度、StoreLogin 实例或 timer。
- `/health` HTTP200/status=ok，`/login` HTTP200/含密码输入表单，未认证 `/api/dashboard` HTTP401。上述为回环 HTTP 检查，不证明完整 HTTPS 登录已通过。
- 公网 Portal 仍 PID163597/Invocationfc31a34d5669483a99f0e372df1587cd，未重启；8788仍只监听回环。
- LAN Portal unit SHA256：`953f9e853cb8fce26e7fcb2a8229bcc51d9e82723495803be16bbc8d86944b94`。

## 网关准备

- 官方 `nginx:stable-alpine` 办公室拉取因 registry IPv6 超时失败；云端从 Docker 官方仓库拉取后离线传入 VM，没有更换镜像源。镜像 ID `sha256:dc5069ad14f19660b141b21236140b91656bf89bbc3e2417c70ae650cd66104c`。
- 归档 `/tmp/shein-fm-lan-nginx-dc5069ad.tar`，云端、本机、VM SHA256一致：`725cc9e16c0aea62f4401e9414f14cc857de74abb626e77b098436f1b314491d`。VM已 docker load。
- 本地新增 `infra/nginx/shein-fm-lan.conf` 和 `infra/systemd/shein-fm-lan-gateway.service`，已上传 VM `/tmp/`，尚未安装或启动正式网关。
- Nginx配置 SHA256 `6d724512f04e714f12b7ad70e639a54e9633a131fc14c27c3aaf907bd0b5672c`；gateway unit SHA256 `a63bd06802dfc3e72440795c8b96e66ddd131502fb6ad0c938ad80c7070aa91b`。
- 真实 Linux `nginx -t` 与 `systemd-analyze verify` 通过。测试证书仅为 `/tmp/shein-fm-lan-syntax-ljrv92/` 下 `syntax-test.invalid` 一日自签夹具，绝不可用于正式入口。初次 network=none 缺少指定 LAN IP 而失败，改以 host 网络只执行 `-t` 后成功；测试后确认没有443监听。
- `/store-login` 与 `/api/store-login/` 转发至同一8794，内部 token 不接受客户端伪造；维护 URL 不记日志。授权回调与 webhook 不经此入口。仍待真实登录与 WS/SSE 验收。

## 尚缺条件与继续顺序

1. 用户登录 Cloudflare 的 `dushengyi.cc` 后，核实 DNS 管理权限与现有记录，再新增独立 LAN 子域名，不改原公网记录。不得猜测凭据或用未验证 DNS 作为完成证据。
2. 为 LAN 域名取得浏览器信任的证书并安排可持续续期；不能直接使用 Cloudflare Origin CA 或测试自签证书。未获授权不创建长期 DNS 编辑凭据，不新增定时排班。
3. VM `192.168.1.79` 当前仍为 DHCP 地址。正式交付应处理地址稳定性或明确剩余风险；未修改路由器 DHCP/IP范围。
4. 安装网关前保存新鲜状态、锁定上述文件/镜像摘要，配置根用户受限 TLS 目录及镜像环境文件。仅开启 LAN 443，不改原8788、不公开数据库。
5. 验证受信任 HTTPS、有效账号登录/退出、权限/Origin 拒绝、同源数据、维护窗口及公网未受影响，再交付链接。尚未完成前不宣称“局域网已可用”。

## 可逆边界

当前只需停止新 `shein-fm-lan-portal.service` 即可停止新增前端，不动原 Portal、数据库、隧道或调度。新 unit 未启用自启动；网关未启动。未推送、未发版，原 `scripts/__pycache__/` 保留。
