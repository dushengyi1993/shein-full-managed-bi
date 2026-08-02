# 全托店铺远程授权流程

## 目标

由全托同事在自己的电脑上登录 24 家店铺并确认授权。系统统一使用 DL 的全托 OpenAPI 应用，但每家店铺独立换取并保存自己的 `openKeyId / secretKey`。

店铺内部代码统一采用“公司简称拼音首字母 + 店铺账号后四位”，例如公司简称为
`CX`、账号后四位为 `4412` 时，对应代码为 `CX4412`。系统不保存或展示完整店铺账号。

同事不需要使用本机 Chrome Profile，也不需要拿到 DL 应用密钥、服务器账号或 BI 登录账号。

## 角色与边界

### 管理员

1. 在云服务器生成一批有效期不超过 24 小时的交接链接。
2. 私下把唯一的 `handoffUrl` 发给指定全托同事。
3. 查看脱敏状态，把平台回传的 `supplierId` 只当作“候选值”。
4. 从 SHEIN 商家后台或其他独立权威来源核对该店 `supplierId`，写入 root 专用身份映射；不得直接复制候选值当作核验。
5. 对确认无误的店铺显式执行凭据晋级。脚本会再次实时调用 `query-store-info`，四方结果一致才会启用。
6. 晋级后运行销量权限只读探针。探针成功前不启用定时同步。

### 全托同事

1. 打开管理员发送的完整链接，确认域名是 `fm.dushengyi.cc`。
2. 页面会显示 24 家店铺清单。每次只选择一家。
3. 点击“开始授权”，在新窗口核对域名是 SHEIN 官方授权域名。
4. 登录该店对应的全托账号，核对页面展示的是 DL 全托应用及权限范围。
5. 由本人点击确认授权，等待自动跳回结果页。
6. 结果页显示“等待管理员核验”后，关闭该页，回到原清单刷新状态。
7. 切换下一店前退出旧账号，或使用明确隔离的浏览器 Profile。

同事不得：

- 在 `fm.dushengyi.cc` 页面输入 SHEIN 密码；
- 转发回调地址、授权口令、Cookie 或带 token 的截图；
- 在账号不确定时继续点击确认；
- 把“授权已收到”理解为已正式接入。

## 服务端安全流程

1. 交接链接格式为 `https://fm.dushengyi.cc/authorize#<随机口令>`。
2. `#` 后的 256 位随机口令只在浏览器内读取，不会出现在 Cloudflare、Caddy、Nginx 或应用请求 URL 中。
3. 口令通过 HTTPS 请求体建立 `HttpOnly / Secure / SameSite=Lax` 的短期授权会话。
4. 点击单店按钮后，服务器生成 256 位一次性 `state`，只保存 SHA-256，最长有效 10 分钟。
5. SHEIN 回调必须同时包含且只包含一个 `state` 和一个 `tempToken`。缺失、重复、过期、未知或已消费的 `state` 全部拒绝。
6. 服务器立即用 DL 应用级凭据调用 `/open-api/auth/get-by-token`，并严格核对返回的 `appid` 与原样 `state`。
7. 用新换取的店铺凭据调用 `/open-api/openapi-business-backend/query-store-info`，要求其 `supplierId` 与换证结果唯一且一致。
8. 通过双重核对后，凭据只写入独立的 `REVIEW_REQUIRED` 收件箱，不写正式 `openapi.json`，也不自动启用。
9. 管理员从独立来源确认目标店铺与 `supplierId`，写入一对一权威映射后，使用显式确认命令晋级。
10. 晋级脚本使用待核验凭据实时回读 `query-store-info`；CLI 候选值、receipt、权威映射和实时接口四方一致才原子启用。成功后含密钥 receipt 被精确删除，只保留审计指纹。

状态文件只保存 token/state 哈希、店铺代码、脱敏商户身份、时间和结果码；不保存原始口令、`state`、`tempToken`、Cookie 或店铺密钥。

## 生成交接批次

本地演练：

```powershell
npm run authorization:create-batch
```

生产环境应以授权服务用户运行，并把输出写入仅管理员可读的位置：

```bash
sudo -u sheinfm-auth env \
  FULL_AUTH_STATE_FILE=/srv/shein-fm-auth/runtime/authorization-state.json \
  FULL_AUTH_PUBLIC_ORIGIN=https://fm.dushengyi.cc \
  node scripts/create_full_managed_authorization_batch.mjs \
  --output /srv/shein-fm-auth/runtime/current-batch.secret.json \
  --valid-hours 24
```

脚本标准输出只显示批次编号、店铺数、有效期和文件位置，不打印交接链接。

## 核验与晋级

管理员先查看脱敏状态：

```bash
sudo -u sheinfm-auth env \
  FULL_AUTH_STATE_FILE=/srv/shein-fm-auth/runtime/authorization-state.json \
  node scripts/report_full_managed_authorization_status.mjs
```

首次授权必须先从独立来源建立私密映射，例如：

```json
{
  "schemaVersion": 1,
  "cooperationMode": "FULL_MANAGED",
  "bindings": [
    {
      "storeCode": "DX0571",
      "platformSupplierId": "<从 SHEIN 独立核验的商户 ID>"
    }
  ]
}
```

保存为 `/srv/shein-fm/secrets/store-identity-map.secret.json`，权限设为 `root:root 0600`。
`storeCode` 和 `platformSupplierId` 必须分别唯一。确认后使用 root 执行单店晋级：

```bash
sudo env \
  SHEIN_FM_CLOUD_EXECUTION=1 \
  FULL_AUTH_APPLICATION_FILE=/srv/shein-fm-auth/secrets/application.secret.json \
  FULL_AUTH_STATE_FILE=/srv/shein-fm-auth/runtime/authorization-state.json \
  FULL_AUTH_RECEIPT_DIRECTORY=/srv/shein-fm-auth/secrets/receipts \
  FULL_AUTH_IDENTITY_MAP_FILE=/srv/shein-fm/secrets/store-identity-map.secret.json \
  FULL_BI_OPENAPI_CONFIG_FILE=/srv/shein-fm/secrets/openapi.json \
  node scripts/finalize_full_managed_authorization_receipt.mjs \
  --store DX0571 \
  --supplier-id <已人工核验的商户 ID> \
  --confirm SHEIN_FULL_AUTH_APPROVE
```

脚本会先用 receipt 凭据实时回读身份，再创建私密备份，原子更新指定店铺配置并把状态改为
`APPROVED`。它保留
`openapi.json` 原有 owner、group 和权限，不覆盖现有 `platformShopId`，而是把官方商户 ID
单独保存为 `platformSupplierId`。成功后删除已消费 receipt；任一步失败会回滚配置、审核状态和
receipt。标准输出不包含凭据、receipt 名称或私密路径。

登录错账号时，先从状态报告取得精确的 `batchId / storeCode / supplierId`，再拒绝该收件结果：

```bash
sudo env \
  FULL_AUTH_STATE_FILE=/srv/shein-fm-auth/runtime/authorization-state.json \
  FULL_AUTH_RECEIPT_DIRECTORY=/srv/shein-fm-auth/secrets/receipts \
  node scripts/reject_full_managed_authorization_receipt.mjs \
  --batch-id <批次 ID> \
  --store DX0571 \
  --supplier-id <本次错误授权的候选商户 ID> \
  --confirm SHEIN_FULL_AUTH_REJECT
```

拒绝命令会把状态改为 `REJECTED` 并精确删除该 receipt，之后该店才能重新授权。

## 失败处理

- 链接过期：生成新批次，旧批次自动撤销。
- 登录错账号：凭据不晋级；管理员拒绝该店后重新授权。
- `state` 或 `tempToken` 过期：回原清单重新开始，不刷新旧回调。
- 换证或店铺信息查询失败：不启用凭据，重新授权。
- 回调重复：不重复换证，不覆盖已有收件结果。
- 服务重启：批次和一次性状态保存在权限收紧的状态文件中，可继续核验；处理中断的会话不得自动宣称成功。

## 日志与反代

Nginx 对 `/authorize` 与 `/openapi/authorize/callback` 使用独立安全日志，只记录请求方法和
`$uri`，明确不记录 `$args` 或 `$request`；回调处理后立即 `303` 到不含参数的结果页。该日志按
20 MB / 14 天轮转。Caddy 不为该站点启用 URI 访问日志，HAProxy 保持 TCP 模式。公网入口
采用源站直连 HTTPS，不依赖 Cloudflare 代理或其日志能力。
