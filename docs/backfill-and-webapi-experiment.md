# Backfill control plane, purchase-order history and isolated WebAPI experiment

Date: 2026-07-29
Status: the purchase-order adapter is the only executable historical backfill
path. It is manual, plan-hash gated and unscheduled. The WebAPI path remains an
isolated `UNMAPPED` experiment with no production gate or timer.

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
| `store-identity` | UNSUPPORTED | current membership has no per-business-date history |
| `product-identity` | UNSUPPORTED | current catalog identity has no historical identity grain |
| `sales-window-snapshot` | UNSUPPORTED | the four rolling windows exist only at the current observation instant |
| `purchase-orders` | VERIFIED | `updateTime` supports an exact one-day replay through the existing supply pagination and reconciliation gate |
| `deliveries` | UNVERIFIED | the endpoint filters creation time only, so late updates cannot be replayed completely |
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

Executable purchase-order windows are exactly one day. Non-executable domains
are not repeated once per business date: the planner produces the fewest
31-day-or-shorter blocker chunks required by the immutable
`ops.backfill_window` range constraint. A 65-day blocked request therefore
records 3 explicit blockers, not 65 duplicates and not one invalid 65-day row.

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

An exact failed-plan replay also reads the persisted attempt count for every
incomplete window. The resumed call continues at the next attempt ordinal instead
of reusing `a01`; the delegated supply run ID is scoped by both `plan_hash` and
`window_key`. This keeps retries auditable without colliding with the immutable
supply-attempt ledger, while a different reviewed plan receives an independent
attempt namespace for the same business-date window.

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

The execute runtime is created only after the plan hash and exact allow-lists
have passed authorization. It accepts only `FULL_BI_DATABASE_URL` plus one of
`FULL_BI_OPENAPI_CONFIG` / `FULL_BI_OPENAPI_CONFIG_FILE`; the generic
`DATABASE_URL` fallback is deliberately rejected. Only
`openapi.purchase-orders.v1` is registered. Dry-run dynamically imports none of
the database, credential, OpenAPI or adapter modules.

For every planned day the adapter delegates exactly once to the existing supply
sync with one store, the `purchase-orders` domain, `mode=BACKFILL`, and the exact
half-open `updateTime` range. `backfillEnd` is the historical window boundary;
`now` remains the real observation instant. The adapter advances a checkpoint
only after terminal-page, page-count, exact-range and warehouse persisted-count
evidence all agree.

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
Chrome's `HOME` and XDG write locations are bounded to that same store-owned
Profile. The runtime never broadens write permission on `/srv/shein-fm`.

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

The 2026-07-29 live DL catalog evidence and the matching official SSO frontend
bundle establish the current contract: catalog rows live at
`info.dataModels[].dataIndexes[]`, `dataMetaIndexId` is sent as
`metaIndexIds`, and detail rows are matched from `info.list` by
`metaIndexId`. Titles, labels and values are not retained by catalog discovery.

### Runtime prerequisites

- migration 0012 must already be applied;
- the `sheinfm_webapi_login` credential must exist and be reachable as
  `FULL_BI_WEBAPI_DATABASE_URL`, which is read only after execute authorization
  succeeds and is never printed;
- `/srv/shein-fm/runtime/webapi-locks` must be mode `0700`, owned by `sheinfm`;
- the explicit gate `/srv/shein-fm/runtime/webapi-experiment.enabled` must exist
  only for the bounded manual execution window.

The generic discovery experiment still ships no timer. Its gate is created only
around one bounded manual run and removed immediately afterward. WebAPI
observations do not authorize or feed the purchase-order backfill.

## 9. Verified homepage history contract

The homepage history loader is a separate, production contract rather than a
promotion of the generic experiment. It supports the canonical 25-store roster
and uses one cloud Profile at a time.

Store history is fetched in contiguous windows of at most 90 days from
`/sbn/index/get_critical_indicator_curve_chart`. The official endpoint may
return dated rows whose unavailable metrics are null outside its retained
operating window; those nulls remain null and are never backfilled with zero.
Before any window request, the loader reads
`/sbn/common/get_update_time` with `{pageCode: "Index", areaCd: "cn"}` and
pins every store, trade, region and product request to that returned `dt`.
The range end is not a valid substitute for this data-version anchor: during
the platform settlement interval a newer requested date can legally exist
while the official `dt` is still the prior day.

The current official merchandise-details page no longer uses
`/sbn/analyse/model_dimension` plus `/sbn/analyse/search` for the product list.
The production product loader uses the paginated
`/sbn/new_goods/get_diagnose_list` contract instead. That response is aggregated
over the requested range, so the loader fixes the request to exactly one
business day, orders by `c1dSaleCnt`, persists positive SPU/day quantity rows,
and stops paging once the sorted page reaches zero. The successful same-day
fetch audit proves catalogue-zero days without writing hundreds of zero rows.
The endpoint currently exposes quantity but not `c1dSaleAmt` for the reviewed
Profiles; product amount therefore remains finance-backed or explicitly
estimated, never invented from the product response.

The retired two-step analysis contract remains isolated to the shop-level
exposure supplement while that source is still authorized. Its failure is a
partial capability result: it cannot invalidate a successful store curve.
Profiles without that permission retain `NULL` exposure with the failed
capability audit instead of being classified as total homepage failures.

New-customer order/sales metrics and top-region evidence are not 90-day curve
responses. The backfill therefore calls `/sbn/trade/overview` and
`/sbn/trade/rank_top` at single-day grain, writes only that business date, and
records a body hash plus accepted-row count. Before each Profile run it reads
successful same-day audit keys and skips those dates. This makes the long
25-store backfill resumable without treating an aggregate range response as a
daily fact. A historical business-status failure is skipped only when that same
store, endpoint and date has no later successful audit. Recent settled dates
can be explicitly re-read with `--refresh-recent-days=N`; this repairs an early
successful-but-not-yet-settled response without reopening all completed dates.

The live management-analysis page sends compact `startDt` / `endDt` values.
Trade overview requires `dtFlag=1`; the region ranking requires `statType=2`.
The similarly named `startDate` / `endDate` plus `queryType` shape belongs to
the store curve contract and must not be reused for these two endpoints.
Within one Profile and one business date the two read-only requests may run in
parallel. Dates remain serial, and the host-wide plus per-Profile leases still
prohibit concurrent Profile sessions.

```bash
npm run sync:home-history -- \
  --stores=DL5477,MZ2406,NM7418 \
  --from=2023-06-07 \
  --to=2026-08-02 \
  --refresh-recent-days=7

touch /srv/shein-fm/runtime/webapi-history.enabled
npm run sync:home-history -- \
  --stores=DL5477,MZ2406,NM7418 \
  --from=2023-06-07 \
  --to=2026-08-02 \
  --refresh-recent-days=7 \
  --execute
rm -f /srv/shein-fm/runtime/webapi-history.enabled
```

Dry-run is the default. Real execution additionally requires the dedicated
`FULL_BI_WEBAPI_DATABASE_URL`, the cloud Linux attestation, the exact Profile
directories and the explicit `webapi-history.enabled` gate. The browser request
executes in page context with `credentials: include`; cookies, storage and
headers never leave the Profile.

Migration 0014 adds:

- `raw.webapi_home_fetch_audit`: append-only hashes, counts and sanitized status;
- `fact.full_home_store_daily`: nullable store/day metrics;
- `fact.full_home_product_daily`: product/day quantity and clearly marked
  estimated amount;
- `fact.full_home_region_daily`: top-region evidence when the contract is
  available;
- `fact.full_product_price_observation`: append-only hashed finance price
  evidence for the estimate.

An unavailable metric remains SQL `NULL` and renders as `—`. Exposure from
brand-level self-analysis is labeled `BRAND_SUMMED`, never described as a
deduplicated store visitor count. Product amount is available only as
`sales quantity × latest matched finance unit price`; an unmatched product stays
unknown and does not enter the amount ranking.

The first full backfill remains an explicit manual operation. After it is
accepted, an incremental service may refresh only today/yesterday under the same
Profile lock and gate; it must never reopen the full historical range on every
timer tick.

## 10. Deliberately deferred

- No historical adapter other than `purchase-orders`.
- No delivery history claim until an update-time-complete contract exists.
- No historical daily sales reconstruction from the four rolling OpenAPI
  snapshots; homepage history uses the verified WebAPI date-grain contract.
- No backfill systemd unit or timer; execution remains an explicitly reviewed,
  hash-locked manual operation.
- No timer for the generic WebAPI discovery experiment.
- No `fact.full_store_realtime_metric_snapshot`.
- No metric definition rows, so no metric is `VERIFIED`.
- No persistent production WebAPI gate file and no enabled WebAPI timer.
