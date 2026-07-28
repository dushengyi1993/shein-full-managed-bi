# Backfill control plane and isolated WebAPI experiment (Batch 2)

Date: 2026-07-28
Status: control framework only. No real backfill, no real WebAPI request, no
production gate, no enabled timer, no 14-day validation.

## 1. What this batch is

Two independent things:

1. A **control plane** for bounded historical backfill: deterministic plans,
   append-mostly run/window evidence, and fail-closed checkpoints.
2. An **isolated read-only WebAPI experiment contract** for `DL5477` and
   `MZ2406`, stored as schema-only `UNMAPPED` observations.

Neither feeds the homepage. Neither writes a formal money fact. The dashboard
JSON contract is unchanged.

## 2. Capability catalog

`src/backfill/capability-catalog.mjs` is the single source of truth.

| Domain | Status | Rule |
|---|---|---|
| `store-identity` | VERIFIED | existing OpenAPI store contract |
| `product-identity` | VERIFIED | existing catalog/detail/identity repositories |
| `sales-window-snapshot` | VERIFIED | refreshes the four rolling windows only; `dailyHistoryReconstructable: false` |
| `purchase-orders` | VERIFIED | existing supply pagination + reconciliation gate |
| `deliveries` | VERIFIED | existing supply pagination + reconciliation gate |
| `financial-settlement` | UNVERIFIED | endpoint, permission, pagination and money caliber unproven |
| `inventory-history` | UNSUPPORTED | cannot be rebuilt from a current snapshot |
| `webhook-history` | UNSUPPORTED | pre-subscription events do not exist |
| `webapi-home-snapshot` | EXPERIMENT_ONLY | isolated evidence layer only |

Only `VERIFIED` is executable. Everything else is planned, recorded and reported
as an explicit blocker with a sanitized reason code — never as empty success.

## 3. Window grain and determinism

Grain: `run × store × domain × adapter × [window_start, window_end)`.

`window_end` is exclusive, so adjacent windows never overlap and a late fact
replays exactly one business-date range. Planning walks backward from the most
recent date. Store codes and domains are normalized and sorted before hashing, so
input ordering cannot change the plan hash.

The plan hash covers the plan version, requested scope, planner bounds and the
window list — not the mode, the operator or a timestamp. A reviewed dry-run hash
is therefore the exact value that authorizes one execute run.

## 4. Checkpoint safety

A checkpoint advances only when all of these hold:

- capability is `VERIFIED`;
- the adapter returned complete counts;
- observed pages equal expected pages;
- the schema fingerprint is present and matches the stored fingerprint;
- exactly one business date is present, inside the window;
- zero illegal decimals, zero unknown metrics, zero rejected rows;
- persisted rows equal accepted rows;
- the new watermark is strictly greater than the stored one.

This is enforced three times: in the pure gate (`quality-gate.mjs`), in the
transaction (`checkpoint-repository.mjs`), and in the schema. In PostgreSQL,
`ops.backfill_checkpoint` can only reference a window row that is simultaneously
`SUCCEEDED` + `PASSED` + `VERIFIED`, and can only cite an `EXECUTE` run. A
partial window, a dry-run, or a drifted fingerprint is rejected by the database
even if application code were wrong.

Window and checkpoint writes commit in one transaction, so a crash cannot leave a
window marked complete while losing its checkpoint move.

The checkpoint foreign key spans window id, run id, grain, all three statuses,
the business watermark and the schema fingerprint together, so a checkpoint
cannot mix evidence from two different successful windows. A window's
`source_business_watermark` is additionally constrained to lie inside its own
half-open range, and `ops.guard_backfill_checkpoint_progress()` makes the grain
and `created_at` immutable while forcing the business date strictly forward.

`openRun` writes one validated instant into both `created_at` and `started_at`,
so the column default can never stamp a later time than the recorded start.
`closeRun` requires exactly one `EXECUTE` row to update and fails closed
otherwise.

### Scheduling

Windows are grouped by checkpoint grain (`store + domain + adapter`). Each grain
runs strictly sequentially in newest-first order, so the second window of a grain
observes the checkpoint and schema fingerprint the first one just wrote — that is
what makes same-grain schema drift detectable. Bounded concurrency applies only
across different grains, capped by the plan's `concurrency` value.

## 5. CLI

- `npm run backfill:plan` — read-only. No database, no adapter, no network.
- `npm run backfill:run` — dry-run by default.

Execute requires all four of `--execute`, `--approved-plan-hash`,
`--allow-stores`, `--allow-domains`, and `parseRunRequest` calls
`assertExecuteAuthorization` immediately, so a wrong hash or any store/domain
mismatch is rejected before the deliberate not-wired blocker. There is no
environment fallback for scope. Only `--flag` / `--flag=value` forms are
accepted; a positional argument, a repeated flag, an unknown flag for that
entrypoint, and an execute-only flag without `--execute` are all errors.
Bounded integers reach the planner's strict validator as literal operator text,
so `--concurrency=1x` is rejected rather than silently parsed as `1`. Output is JSON containing only counts, states, hashes and sanitized codes,
and `assertSafeCliOutput` fails the process rather than print anything
secret-shaped, including a Profile path or a Profile key.

In this batch the execute path exits with
`BACKFILL_EXECUTE_ADAPTERS_NOT_WIRED`: no verified adapter or pool is wired in,
so it fails closed instead of reporting a hollow success.

## 6. WebAPI experiment isolation

Allow-list (read-only, no other route is reachable):

- `GET /sso/homePage/dataOverview/list`
- `GET /sso/homePage/v2/list`
- `POST /sso/homePage/dataOverview/v2/detail`
- `POST /sso/homePage/v4/detail`
- `POST /sso/homePage/key/indicator/keyAndTrends`

The adapter owns no transport. Without an injected read-only transport it returns
`BLOCKED`. It validates request and response shapes, computes schema hashes from
key names and value *types* only, and refuses any formal projection.

Values stay decimal strings end to end: `parseStrictDecimalString` rejects
exponents, `+`, leading zeros, separators, `NaN`, `Infinity`, `-0`, trailing
fraction zeros and over-long precision. PostgreSQL casts the string to
`numeric(38,10)` and a check constraint asserts the mirror equals the text. No
JavaScript `Number` and no `float4`/`float8`/`money` column exists.

Batch metadata and its observations commit in one role-scoped transaction. A
reused `batch_key` or `observation_key` must be a byte-exact replay: every
immutable field is read back and compared, and `raw_value_text` is compared as
exact source text, so `12.3`, `12.30` and `-0` are distinct even though the
`numeric` mirror would normalize them. Any drift throws a stable sanitized code
and rolls the whole batch back. Store isolation is checked before the transaction
opens and again by a composite `(batch_id, store_code)` foreign key, so a DL
observation cannot be filed under an MZ batch.

`meta_index_id` and `metric_code` are nullable only for `REJECTED` rows;
accepted rows are forced to carry and validate both. Response `metaIndexId` is
bounded at 1,000,000 to match the request contract and the database check.

Every metric stays `UNMAPPED`. `VERIFIED` is impossible without a versioned
`dim.webapi_metric_definition` row, and that row itself requires a reviewed
Chinese page label, unit, comparable window, evidence reference and named human
verifier. No label or metric meaning is invented here.

Canonical keys only: `DL5477` / `persistent-dl5477-profile` and `MZ2406` /
`persistent-mz2406-profile`. A bare `DL` or `MZ` is rejected in code and by a
check constraint.

`fact.full_store_realtime_metric_snapshot` is deliberately **not** created; the
verify script fails if it exists.

## 7. Profile launch guard

`assertRealProfileLaunchAllowed` runs before any process could be created and
fails closed on: non-Linux platform, missing explicit gate file
(`/srv/shein-fm/runtime/webapi-experiment.enabled`), missing Chrome/Xvfb,
non-allow-listed store, non-canonical Profile key, or absent Profile directory.
It never reads Cookie, localStorage or any credential file, and the CLI never
prints the resolved directory.

## 8. Least privilege

New roles:

- `sheinfm_webapi_loader` (NOLOGIN capability group)
- `sheinfm_webapi_login` (LOGIN, **NOINHERIT** — it holds nothing until it
  explicitly runs `SET ROLE sheinfm_webapi_loader`)

The loader gets `SELECT, INSERT` on its three evidence relations, `SELECT` on
reviewed definitions, sequence `USAGE`, and `USAGE` on `raw`/`dim`/`ops` only. It
has no `fact` or `mart` schema usage, no store dimension read, no webhook receipt
access, and no backfill control-plane privilege. Conversely, the sales, supply,
webhook and materializer roles gain no WebAPI write access. Both directions are
asserted positively and negatively in 9999 and in the verify script.

Backfill control-plane writes belong only to `sheinfm_sales_loader` and
`sheinfm_supply_loader`; identity columns (`window_key`, `store_code`, `domain`,
`adapter_key`, window bounds, `capability_status`, `plan_hash`, `mode`) are not
updatable, and no role may delete from the ledgers.

`SHEIN_FM_WEBAPI_LOGIN_DB_PASSWORD` is a sixth, independent secret in the
root-private migration manifest. Values still travel to the container by name
only.

## 8a. Batch 4: page-context transport and the two-stage runbook

Batch 4 supplies the transport that Batch 2 deliberately left absent. Nothing about
the experiment boundary changes: observations stay `UNMAPPED`, no metric definition
is written, and `fact.full_store_realtime_metric_snapshot` still does not exist.

### How the credential stays inside the browser

`src/webapi-experiment/page-transport.mjs` performs the request *in the page* via
`Runtime.evaluate` with `credentials: 'include'`. The already-authenticated page
attaches its own session, so this process never reads, exports, serializes or logs
a cookie, a storage entry or a request header. Node receives only HTTP status, byte
length and bounded response text. HTTP `401`/`403` and the evidenced HTTP-200
business status `20302` are both reduced to
`WEBAPI_TRANSPORT_AUTH_EXPIRED`; any other non-zero top-level `code`/`status`
is reduced to `WEBAPI_TRANSPORT_BUSINESS_STATUS_FAILED`. Platform messages and
response bodies never enter the error or CLI output.

`src/webapi-experiment/cdp-client.mjs` reaches exactly four protocol methods —
`Runtime.enable`, `Runtime.evaluate`, `Page.navigate`, `Page.getNavigationHistory`.
Every credential-bearing domain is rejected by an allow-list, so a cookie or
storage dump cannot be requested even by mistake.

### One store, one Profile, one session

`src/webapi-experiment/profile-lock.mjs` takes a global lock and then a
per-canonical-Profile lock. A stale lock is reclaimed only when the previous owner
is provably gone; an unparsable record or a throwing liveness probe fails closed.
Release is owner-checked, so a reclaimed lock belonging to somebody else is never
deleted. Lock errors carry a sanitized code only — never a path, never a Profile key.

`src/webapi-experiment/browser-session.mjs` checks platform, then the explicit
gate, the Linux browser dependencies and the Profile directory — all before any
process is created. Each store owns a deterministic loopback debugging port and
display. Navigation targets only `WEBAPI_ORIGIN`. The identity proof asks the page
three yes/no questions (same origin, not a login view, store alias last four digits
present) and returns booleans plus a text length; no identity value crosses the
boundary. Cleanup is deterministic and idempotent, signals only the two PIDs it
started, and is exposed as `close` so the CLI owns signal handling.

### Two-stage runbook

**Stage A — CATALOG.** Only the three endpoints that carry no metric value.
Proves reachability, response schema hashes and the set of technical
`metaIndexId`s, which the adapter returns as `discoveredMetaIndexIds`. Batches
carry `observationCount = 0`. No label, caliber or metric value is produced.

```
npm run webapi:plan -- --stage=CATALOG --stores=DL5477 \
  --endpoints=HOME_DATA_OVERVIEW_LIST,HOME_KEY_INDICATOR_TRENDS \
  --created-by=<operator>
npm run webapi:run  -- <same flags>            # dry-run, zero side effects
npm run webapi:run  -- <same flags> --execute \
  --approved-plan-hash=<hash from the plan> \
  --allow-stores=DL5477 \
  --allow-endpoints=HOME_DATA_OVERVIEW_LIST,HOME_KEY_INDICATOR_TRENDS
```

**Stage B — METRIC_DETAIL.** Only the two value endpoints, and only with
`--meta-index-ids` a human selected after reviewing Stage A. `templateType` is
required exactly when a requested endpoint accepts it. Observations are written
`UNMAPPED` into the migration-0012 experiment relations. Promoting any metric to
`VERIFIED` remains a separate reviewed evidence process, not a code path.

`--allow-stores` and `--allow-endpoints` must equal the plan scope exactly: a
subset and a superset are both refused, so an approval can never silently widen.

### If the real envelope does not match

`validateEndpointResponse` accepts a list at `response`, `response.list` or
`response.data`. If the live response uses another envelope, the run stores a
`FAILED` batch plus the response schema hash and a sanitized code. That is the
intended outcome: the schema is **not** broadened and no response meaning is
guessed. A human reads the hash, captures the shape under review, and a later
batch amends `schema.mjs`.

### Deployment prerequisites (not applied by this batch)

- migration 0012 must already be applied;
- the `sheinfm_webapi_login` credential must exist and be reachable as
  `FULL_BI_WEBAPI_DATABASE_URL`, which is read only after execute authorization
  succeeds and is never printed;
- the explicit gate file must exist on the Linux host.

This batch applies no migration, creates no gate file, ships no systemd unit or
timer, and performs no real WebAPI call. Manual cloud execution runs later as the
existing Profile owner under Codex control.

## 9. Deliberately deferred

- No verified backfill adapter is wired into the runner.
- No WebAPI systemd unit or timer; execution remains a bounded manual run.
- No `fact.full_store_realtime_metric_snapshot`.
- No metric definition rows, so no metric is `VERIFIED`.
- No production gate file, no enabled timer, no migration applied.
