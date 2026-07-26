# 全托商品身份解析 CLI 运行手册

## 作用和安全边界

该 CLI 把一个已经封存的商品身份观察批次解析为严格的跨店标准商品计划。默认只生成计划；只有操作员复核同一份计划的计数和 `planHash` 后，显式执行 apply，才会写入本项目仓库中的标准商品、证据关系、候选、决定和映射表。

它有以下硬边界：

- 不加载 SHEIN 配置、应用密钥或店铺授权；
- 不发起 SHEIN 请求，也不编辑平台商品；
- 数据库连接串只从进程环境变量 `FULL_BI_DATABASE_URL` 读取；
- 禁止 `--database-url`，也不会回退读取通用 `DATABASE_URL`；
- 日志只输出安全审计字段、计数和计划 hash，不输出货号、标题、条码、型号、观察证据或商品节点；
- 活跃 SKU 缺少该批次的官方详情证据时，必须计入 `excludedMissingEvidenceSkuCount` 并从解析输入中安全排除；
- apply 必须同时提供 `--apply` 和 dry-run 返回的精确 `--approved-hash`。

## 前置条件

1. 已执行当前仓库的数据库迁移和校验；
2. 目标证据同步批次已经全部封存为 `SEALED`；
3. 已知该批次的显式 `observation_run_id`；
4. 运行环境已安全注入 `FULL_BI_DATABASE_URL`。

不要把数据库连接串写进命令行参数、脚本、工单或截图。例如在 PowerShell 当前进程中注入：

```powershell
$env:FULL_BI_DATABASE_URL = '<由密钥管理系统注入>'
```

## 第一步：dry-run

为便于审计和复现，显式固定 `--now` 和 `--run-id`：

```powershell
npm run resolve:product-identity -- `
  --observation-run-id identity-evidence-20260727-v1 `
  --now 2026-07-27T10:00:00+08:00 `
  --run-id identity-resolution-20260727-v1
```

默认版本为：

```text
matcher-version = observed-matcher-v1
policy-version  = strict-global-clique-v1
```

升级匹配器或政策时必须显式传入版本，并在 apply 时原样复用：

```text
--matcher-version observed-matcher-v2
--policy-version strict-global-clique-v2
```

安全输出示例：

```json
{
  "ok": true,
  "mode": "dry-run",
  "observationRunId": "identity-evidence-20260727-v1",
  "runId": "identity-resolution-20260727-v1",
  "evaluatedAt": "2026-07-27T02:00:00.000Z",
  "matcherVersion": "observed-matcher-v1",
  "policyVersion": "strict-global-clique-v1",
  "planHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "inputNodeCount": 120,
  "excludedMissingEvidenceSkuCount": 38,
  "acceptedComponentCount": 20,
  "acceptedNodeCount": 48,
  "acceptedSkuSetCount": 72,
  "rejectedRecallGroupCount": 31,
  "rejectedNodeCount": 72
}
```

复核输入节点数、`excludedMissingEvidenceSkuCount`、接受与拒绝数量是否符合预期，并保存 `planHash`。dry-run 不写解析结果。

`excludedMissingEvidenceSkuCount` 不是零销量，也不是可忽略的展示缺口。它表示活跃 SKU 没有进入本次封存证据全集，因此：

- 这些 SKU 绝不能被自动或人工归并到本次标准商品组件；
- 它们继续保留为店铺内未归并 SKU，等待后续官方详情证据补齐；
- 它们不会混入跨店标准商品排行，也不能被同货号、标题或历史映射替代；
- 该缺口计数和缺口集合指纹参与 `planHash`；缺口变化后必须重新 dry-run 和审批。

## 第二步：apply

使用完全相同的观察批次、时间、运行 ID 和版本，加上 `--apply` 以及刚才的 hash：

```powershell
npm run resolve:product-identity -- `
  --observation-run-id identity-evidence-20260727-v1 `
  --now 2026-07-27T10:00:00+08:00 `
  --run-id identity-resolution-20260727-v1 `
  --apply `
  --approved-hash aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

repository 会在受控事务内重新读取并锁定证据、重算计划，再比对 approved hash。任何观察集、集合指纹、当前映射、matcher 版本或 policy 版本漂移都会拒绝 apply，不会“尽量写入”。

apply 成功输出除 dry-run 计数（包括 `excludedMissingEvidenceSkuCount`）外，还会返回标准商品、溯源、候选、关系证据、决定和映射的总数及本次新建数。它仍然不会返回任何证据明文。

## 参数

| 参数 | 必需 | 说明 |
| --- | --- | --- |
| `--observation-run-id` | 是 | 选择一个显式证据批次；8–120 位安全字符 |
| `--now` | 建议固定 | 带时区的 ISO-8601 时刻；未传时使用进程当前时刻 |
| `--run-id` | 建议固定 | 本次解析审计 ID；未传时由时刻确定性生成 |
| `--matcher-version` | 否 | 匹配器版本，默认 `observed-matcher-v1` |
| `--policy-version` | 否 | 证据政策版本，默认 `strict-global-clique-v1` |
| `--apply` | apply 必需 | 切换到事务应用模式 |
| `--approved-hash` | apply 必需 | 精确的小写 64 位 dry-run `planHash` |

## 失败处理

CLI 失败时只输出：

```json
{"ok":false,"errorCode":"ERROR_CODE"}
```

常见处理：

- `OBSERVATION_RUN_ID_REQUIRED`：补充合法的 `--observation-run-id`；
- `FULL_BI_DATABASE_URL_REQUIRED`：通过密钥管理环境注入专用连接串；
- `APPROVED_HASH_REQUIRED`：先 dry-run，再用返回的 hash 执行 apply；
- `PLAN_HASH_MISMATCH`：证据或映射状态已变化，重新 dry-run 和复核；
- `REPOSITORY_RESULT_INVALID`：停止操作，检查部署版本和 repository 返回契约，不要绕过校验。

失败后不得复用旧 hash 猜测重试。重新执行 dry-run、复核计数，再批准新 hash。
