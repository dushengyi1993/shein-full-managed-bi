# fnOS Portal/Webhook/Store Login cutover runbook

This runbook switches only the three public business routes behind
https://fm.dushengyi.cc from cloud-local services to loopback reverse-SSH
listeners.  OpenAPI remains on the separately permitted cloud relay at
127.0.0.1:18080, and Authorization remains cloud-local at
127.0.0.1:8789.  Do not set HTTP_PROXY, HTTPS_PROXY, or ALL_PROXY; ordinary
WebAPI and Chrome egress stays on the office direct path.

## Invariants

- Cloud Nginx is the only public TLS entry.  It routes the fixed hostname and
  forwards only to cloud loopback addresses.
- Reverse listeners are exactly cloud 127.0.0.1:18788, 18793, and 18794.
  No tunnel or service port is published on a public interface.
- The dedicated key remains restricted with
  restrict,port-forwarding,permitopen="127.0.0.1:18080",permitlisten="127.0.0.1:18788",permitlisten="127.0.0.1:18793",permitlisten="127.0.0.1:18794",command="/usr/bin/false".
  permitopen and each permitlisten stay independent.
- Use nginx -t followed by systemctl reload nginx; do not restart Nginx or
  HAProxy.  Reload keeps established connections available while replacing
  routing configuration.
- Do not create a new timer, cron, heartbeat, business branch, database
  migration, or deployment during this cutover.

## 1. Zero-downtime preflight

Before starting any OpenAPI business unit, install the existing fnOS template
as the mandatory root-private environment file:

```bash
sudo install -o root -g root -m 0600 \
  infra/systemd/shein-fm-openapi-proxy.env.example \
  /srv/shein-fm/secrets/openapi-proxy.env
sudo stat -c '%U:%G %a %n' /srv/shein-fm/secrets/openapi-proxy.env
sudo grep -Fx 'SHEIN_FM_OPENAPI_PROXY_URL=http://127.0.0.1:18080' \
  /srv/shein-fm/secrets/openapi-proxy.env
sudo grep -Fx 'SHEIN_FM_OPENAPI_PROXY_REQUIRED=1' \
  /srv/shein-fm/secrets/openapi-proxy.env
```

The file must read back as `root:root 600`.  The sales, supply, finance daily,
finance backfill, realtime, purchase-order backfill, and Webhook hydration
units use a non-optional
`EnvironmentFile=/srv/shein-fm/secrets/openapi-proxy.env`; a missing file must
stop the unit before `ExecStart`.  With `REQUIRED=1`, a missing or failed
tunnel must fail the official OpenAPI request instead of falling back to the
office public IP.

If the same new units are installed on the cloud host, create the same
`root:root 0600` path with the compatible direct-egress values:

```text
SHEIN_FM_OPENAPI_PROXY_URL=
SHEIN_FM_OPENAPI_PROXY_REQUIRED=0
```

Do not reuse the fnOS `REQUIRED=1` content on a cloud host without its local
proxy listener.  Neither host may export `HTTP_PROXY`, `HTTPS_PROXY`, or
`ALL_PROXY`.

Run from a clean checkout and record the exact commit and working-tree hashes
in the cutover log.  Keep user-owned uncommitted files intact.

```bash
git status --porcelain=v1
git diff --check
sha256sum infra/nginx/shein-fm.conf \
  infra/nginx/shein-fm-upstreams-cloud.conf \
  infra/nginx/shein-fm-upstreams-fnos.conf \
  infra/systemd/shein-fm-openapi-relay-ssh_config.example
```

On fnOS, verify the three real services and confirm that their listeners are
loopback-only:

```bash
curl --fail --max-time 3 http://127.0.0.1:8788/health
curl --fail --max-time 3 http://127.0.0.1:8793/health
curl --fail --max-time 3 http://127.0.0.1:8794/health
ss -ltnp | grep -E '127\.0\.0\.1:(8788|8793|8794)\b'
```

If a service has no /health route, use the same method used by its existing
systemd health check and record the exact response code; do not treat a TCP
accept alone as business health.

On the cloud host, verify that the three reverse ports are currently absent,
so the later test cannot mistake an old listener for the new tunnel:

```bash
if ss -ltn | grep -E '127\.0\.0\.1:187(88|93|94)\b'; then
  echo 'REFUSE: reverse ports already exist' >&2
  exit 1
fi
```

Capture baseline public responses before changing Nginx.  Save status codes,
the Portal body, and response time; after cutover compare the same probes.

```bash
curl -sS -o /tmp/fnos-baseline-portal \
  -w '/health %{http_code} %{time_total}\n' \
  --max-time 10 https://fm.dushengyi.cc/health
curl -sS -o /tmp/fnos-baseline-authorize \
  -w '/authorize %{http_code} %{time_total}\n' \
  --max-time 10 https://fm.dushengyi.cc/authorize
curl -sS -o /tmp/fnos-baseline-store-login \
  -w '/store-login %{http_code} %{time_total}\n' \
  --max-time 10 https://fm.dushengyi.cc/store-login
curl -sS -o /tmp/fnos-baseline-store-login-status \
  -w '/api/store-login/status %{http_code} %{time_total}\n' \
  --max-time 10 https://fm.dushengyi.cc/api/store-login/status
```

The webhook receiver must be probed with its existing controlled signing
fixture.  Record its deterministic rejection result before the switch; do not
send an unsigned write into production and do not treat connection success as
webhook success.

## 2. Install the cloud upstream baseline

The running Nginx must not be reloaded until both the updated main file and a
valid selected template are present.

```bash
sudo install -d -m 0755 /var/backups/shein-fm/nginx
stamp="\$(date -u +%Y%m%dT%H%M%SZ)"
if sudo test -f /etc/nginx/shein-fm-upstreams.conf; then
  sudo cp -a /etc/nginx/shein-fm-upstreams.conf \
    "/var/backups/shein-fm/nginx/shein-fm-upstreams.conf.\$stamp"
fi
sudo cp -a /etc/nginx/shein-fm.conf \
  "/var/backups/shein-fm/nginx/shein-fm.conf.\$stamp"
sudo sha256sum /etc/nginx/shein-fm.conf \
  "/var/backups/shein-fm/nginx/shein-fm.conf.\$stamp"
```

Install the updated main file and the cloud template, then verify before any
reload:

```bash
sudo install -o root -g root -m 0644 \
  infra/nginx/shein-fm.conf /etc/nginx/shein-fm.conf
sudo install -o root -g root -m 0644 \
  infra/nginx/shein-fm-upstreams-cloud.conf /etc/nginx/shein-fm-upstreams.conf
sudo nginx -t
sudo systemctl reload nginx
```

Repeat the baseline probes.  Results must match the preflight; this reload
changes only the name through which cloud-local services are reached.

## 3. Start and test the restricted reverse tunnel

Use the existing dedicated key and SSH config, including the existing
LocalForward 127.0.0.1:18080 127.0.0.1:18080 plus exactly these reverse
forwards:

```text
RemoteForward 127.0.0.1:18788 127.0.0.1:8788
RemoteForward 127.0.0.1:18793 127.0.0.1:8793
RemoteForward 127.0.0.1:18794 127.0.0.1:8794
```

Before starting, independently confirm the cloud authorized_keys line.  It
must contain restrict, port-forwarding, the single permitopen, the three
independent permitlisten values, and command="/usr/bin/false".  Then start
the existing OpenAPI tunnel unit; ExitOnForwardFailure yes must abort if any
of the four forwards cannot be established.

On the cloud host, all three listeners must be loopback-only:

```bash
reverse_listeners="\$(ss -ltnp | awk '\$4 ~ /127\.0\.0\.1:(18788|18793|18794)\$/')"
printf '%s\n' "\$reverse_listeners"
test "\$(printf '%s\n' "\$reverse_listeners" | grep -c .)" -eq 3
test -z "\$(ss -ltn | awk '\$4 ~ /:(18788|18793|18794)\$/ && \$4 !~ /^127\.0\.0\.1:/')"
```

For each port, run a TCP-only connection test from the cloud host:

```bash
nc -vz 127.0.0.1 18788
nc -vz 127.0.0.1 18793
nc -vz 127.0.0.1 18794
```

Then run the service-specific probes directly through the reverse listeners.
Use the same Portal/Webhook/Store Login probes and expected results recorded
in preflight.  Also verify an OpenAPI CONNECT through fnOS
127.0.0.1:18080, the direct office egress IP, and that Authorization still
reaches cloud 127.0.0.1:8789.

## 4. Switch and read back

Switch only after every tunnel and service probe passes:

```bash
sudo install -o root -g root -m 0644 \
  infra/nginx/shein-fm-upstreams-fnos.conf /etc/nginx/shein-fm-upstreams.conf
sudo sha256sum /etc/nginx/shein-fm-upstreams.conf
sudo nginx -t
sudo systemctl reload nginx
```

Read back all boundaries:

1. https://fm.dushengyi.cc/health returns the expected Portal response
   through the fnOS path.
2. The signed webhook fixture returns the same deterministic receiver result
   as preflight and is persisted by the receiver according to its existing
   read-only reconciliation command.
3. Store Login returns the same preflight application status/result through
   /store-login and its API route.
4. Authorization /authorize and its callback still behave as preflight, with
   the cloud Authorization service unchanged on 127.0.0.1:8789.
5. Cloud Nginx error logs contain no new upstream connection errors.
6. The cloud listeners remain only 127.0.0.1:18788, 18793, and 18794; no
   reverse port appears on a public address.
7. OpenAPI still uses cloud 127.0.0.1:18080; ordinary WebAPI/Chrome still
   shows the office public IP.

Keep the tunnel under the existing service restart policy.  If it exits,
ExitOnForwardFailure yes causes startup to fail closed; Nginx may then return
502 rather than silently falling back to cloud-local services.

## 5. Rollback

Roll back for any of these conditions: any post-switch probe differs from its
predefined result, a reverse port is missing or non-loopback, the tunnel fails
repeatedly, Authorization changes, or Nginx reports upstream failures.  Keep
the reverse tunnel running if its OpenAPI forward is healthy.

```bash
sudo install -o root -g root -m 0644 \
  "/var/backups/shein-fm/nginx/shein-fm-upstreams.conf.\$stamp" \
  /etc/nginx/shein-fm-upstreams.conf
sudo nginx -t
sudo systemctl reload nginx
```

If the timestamped upstream backup is unavailable, reinstall the recorded
cloud template instead.  If the main Nginx file also needs restoration, restore
its timestamped backup first, run nginx -t, and only then reload.  Repeat all
baseline probes and verify OpenAPI and Authorization independently.  Do not
restart Nginx or HAProxy, and do not widen SSH permissions as a recovery
measure.

## 6. Retention gate

Even after several days of successful observation, do not delete or decommission
the current cloud server until all of the following are complete and read back:

1. The friend server's fixed IP has been added to the SHEIN OpenAPI whitelist
   and an OpenAPI request from that exact IP is verified.
2. DNS/domain traffic has been moved and the public fixed-domain boundary has
   been read back.
3. A tested cold backup of required cloud state has been restored or otherwise
   verified independently.

Until those gates are met, the cloud host remains authoritative for OpenAPI,
Authorization, rollback, and recovery.


## 7. Webhook catch-up, forward baseline, and rollback

This procedure covers only the seven Webhook tables below. It does not stop or
start a service, alter Nginx, switch the public Webhook, or decide whether the
cloud host can be stopped. Those remain serial operator steps.

### 7.1 Audited scope and invariants

The implementation is `scripts/fnos_webhook_cutover.mjs`. The preferred
passwordless transport is `scripts/fnos_webhook_cutover_ssh.mjs`. Tests are
`tests/webhook/fnos-cutover.test.mjs`,
`tests/webhook/fnos-cutover-ssh.test.mjs`, and the explicitly gated
`tests/webhook/fnos-cutover.pg.test.mjs`.

The exact table set is:

1. `raw.webhook_receipt`
2. `ops.webhook_runtime_heartbeat`
3. `ops.webhook_job`
4. `ops.operational_event`
5. `ops.webhook_hydration_directive`
6. `ops.webhook_subscription_state`
7. `ops.webhook_store_gate`

There are six identity sequences: receipt, heartbeat, job, event, directive,
and subscription. Gate has the composite primary key `(store_id, gate_key)`
and no sequence. Sequence state is compared as `logicalNext`, calculated as
`is_called ? last_value + increment : last_value`. A target sequence is moved
only with transactional `ALTER SEQUENCE ... RESTART WITH`; `setval` is never
used. Every `logicalNext` must be greater than its table's maximum identity.

Heartbeat is strictly append-only. Receipt permits only monotonic
`duplicate_count` and `last_duplicate_at` changes; its other fields, including
ciphertext, are immutable. Existing job, event, directive, subscription, and
gate rows are mutable and source-authoritative. The tool copies no table
outside this list. A missing `dim.store` or `ops.permission_probe` reference is
a blocker, not permission to copy the external table.

All scans use primary-key keyset pages. The default batch is 250 and the hard
maximum is 1000 (`FNOS_WEBHOOK_BATCH_SIZE`). Plans retain only operation counts
and an incremental SHA-256, never all rows or a full operation list. A plan
hash excludes clocks and `generatedAt`, but includes the mode, stable database
identities, frozen table/sequence/readiness/trigger fingerprints, action, full
primary key, and source-row fingerprint.

Each database takes its own transaction-scoped advisory lock and its own
`ACCESS EXCLUSIVE` locks. These are independent locks on independent
PostgreSQL systems; they are not a cross-host lock. All external Webhook
writers must already be stopped.

### 7.2 Database and SSH identity gate

Every connection must read back all of the following exactly before table
content is planned or changed:

- `session_user = current_user = sheinfm`;
- `rolsuper = true` and `rolbypassrls = true`;
- `current_database = shein_fm` and
  `application_name = shein_fm_fnos_webhook_cutover_v4`;
- server endpoint `127.0.0.1/32:5432` and
  `server_version_num = 160014`;
- the PostgreSQL `system_identifier`;
- owner `sheinfm` and exact OID for all seven tables and six sequences.

The stable identity is included in the plan or forward-baseline fingerprint.
The two `system_identifier` values must differ. A forward baseline records
cloud as `sourceIdentity` and fnOS as `targetIdentity`; reverse requires fnOS
to match the saved target identity and cloud to match the saved source
identity. Prepare-forward requires the operator-approved cloud and fnOS
identity SHA-256 values before even a dry-run.

The observed role is intentionally powerful: `sheinfm` is superuser,
`rolbypassrls`, and owner of all 13 managed objects. Do not describe this as a
least-privilege database connection. The SSH caller already has permission to
run `sudo -n docker exec`; the launcher neither grants nor widens that access.
Container-loopback HBA currently permits passwordless access, so the launcher
does not read, accept, or transmit a database password.

For each PostgreSQL checkout the pool is fixed at `max=1`, `min=0`, and
`maxUses=1`. Post-commit authoritative readback must show a different backend
PID/start. Under the SSH launcher it must also show a new SSH child generation.
The generation comparison is within one launcher invocation; its counter may
restart in a later process. Neither PID/start nor generation is part of
`planHash`, because all three are volatile session evidence rather than stable
database identity.

### 7.3 Configure the passwordless stdio launcher

The launcher permanently names endpoints `CLOUD` and `FNOS`; operators do not
swap generic source/target variables for reverse. Set these process-only
variables to audited local files under the operator's `.ssh` directory:

```powershell
$env:FNOS_WEBHOOK_SSH_CLOUD_HOST = '<audited cloud SSH host>'
$env:FNOS_WEBHOOK_SSH_CLOUD_PORT = '<audited cloud SSH port>'
$env:FNOS_WEBHOOK_SSH_CLOUD_USER = '<audited cloud SSH user>'
$env:FNOS_WEBHOOK_SSH_CLOUD_IDENTITY_FILE = '<absolute cloud key path>'
$env:FNOS_WEBHOOK_SSH_CLOUD_KNOWN_HOSTS_FILE = '<absolute cloud known_hosts path>'

$env:FNOS_WEBHOOK_SSH_FNOS_HOST = '<audited fnOS SSH host>'
$env:FNOS_WEBHOOK_SSH_FNOS_PORT = '<audited fnOS SSH port>'
$env:FNOS_WEBHOOK_SSH_FNOS_USER = '<audited fnOS SSH user>'
$env:FNOS_WEBHOOK_SSH_FNOS_IDENTITY_FILE = '<absolute fnOS key path>'
$env:FNOS_WEBHOOK_SSH_FNOS_KNOWN_HOSTS_FILE = '<absolute fnOS known_hosts path>'
```

The launcher uses a custom Node `Duplex`; it creates no local listener. Every
new PostgreSQL connection spawns exactly one Windows OpenSSH child with a
fixed argument array and fixed remote argv:

```text
sudo -n docker exec -i shein-fm-db nc 127.0.0.1 5432
```

There is no shell concatenation, automatic reconnect, or execute replay.
Password, keyboard-interactive, agent, X11, local/remote/dynamic forwarding,
ControlMaster, ProxyCommand, and ProxyJump are disabled; strict host-key
checking and one connection attempt are mandatory. Child stdout and stdin
honour Node stream backpressure. SSH stderr is never forwarded or printed: at
most 8192 bytes are hashed, excess bytes are discarded, and only bounded
counts/hash metadata are retained. The default SSH connect timeout is 15
seconds and the whole-operation/child lifetime limit is two hours; bounded
overrides are `FNOS_WEBHOOK_SSH_CONNECT_TIMEOUT_MS` and
`FNOS_WEBHOOK_SSH_OPERATION_TIMEOUT_MS`.

This metadata is diagnostic only. If an active PostgreSQL stream sees SSH
stdout EOF or child exit, it still fails closed without reconnecting or
replaying any statement. The reported fields are restricted to `cloud` or
`fnos`, the local child generation, a bounded exit kind/code/signal, and the
bounded stderr byte counts/truncation/SHA-256; host, user, paths, commands, and
raw stderr are never reported. After any such disconnect, discard the prior
approval and run a fresh dry-run. Never automatically replay an execute.

After both sides are frozen, inspect identities without setting identity pins:

```powershell
node scripts/fnos_webhook_cutover_ssh.mjs inspect-identities `
  2>webhook-identities-error.json | Tee-Object webhook-identities.json
```

Independently associate the returned `cloud` and `fnos` identities with the
known systems, record the artifact hash, and explicitly approve the two
`identityFingerprint` values:

```powershell
$env:FNOS_WEBHOOK_SSH_CLOUD_IDENTITY_SHA256 = '<approved cloud identityFingerprint>'
$env:FNOS_WEBHOOK_SSH_FNOS_IDENTITY_SHA256 = '<approved fnOS identityFingerprint>'
```

Do not derive and approve them silently in one command. Any owner, OID, role,
server, application, or system-identifier change invalidates the approval.

### 7.4 Freeze gate before either direction

Run these external service steps separately on cloud and fnOS. Stop activation
sources first, then the running units:

```bash
sudo systemctl stop \
  shein-fm-webhook-hydration.timer \
  shein-fm-webhook-hydration.path \
  shein-fm-webhook-hydration.service \
  shein-fm-webhook-worker.service \
  shein-fm-webhook-receiver.service

systemctl is-active \
  shein-fm-webhook-hydration.timer \
  shein-fm-webhook-hydration.path \
  shein-fm-webhook-hydration.service \
  shein-fm-webhook-worker.service \
  shein-fm-webhook-receiver.service
```

All five must read `inactive` or `failed`, and the operator must separately
confirm there is no existing writer lock on any managed table or sequence. Run
this read-only check inside each database container; its only accepted result
is `0`:

Before switching the public Webhook upstream, the fnOS host VM gate must pass.
Verified on 2026-09-03: the fnOS guest VM is named `ocajdmwz`, and only its
DB, migrate, OpenAPI tunnel, Portal, and StoreLogin units are enabled; the
business Webhook services and timers are not enabled. The main agent has
changed that persistent VM's libvirt autostart from `disable` to `enable`
and read back `State=running`, `Persistent=yes`, and
`Autostart=enable`. The standing gate is:

1. The fnOS host VM autostart must be `enable`, verified by a fresh readback
   of `Autostart=enable` (with `Persistent=yes`) before cutover. Without it,
   a host restart leaves the public Webhook pointing at a target that never
   starts.
2. Inside the VM, no unauthorized business timer or service may be
   `enabled`. If the Webhook receiver/worker/hydration units are enabled at
   this point, disable them first; the cutover itself starts them only as an
   explicit operator step after the forward baseline succeeds.

```bash
sudo -n docker exec shein-fm-db psql -X -U sheinfm -d shein_fm -Atc "
WITH managed(oid) AS (
  SELECT unnest(ARRAY[
    'raw.webhook_receipt'::regclass,
    'ops.webhook_runtime_heartbeat'::regclass,
    'ops.webhook_job'::regclass,
    'ops.operational_event'::regclass,
    'ops.webhook_hydration_directive'::regclass,
    'ops.webhook_subscription_state'::regclass,
    'ops.webhook_store_gate'::regclass,
    'raw.webhook_receipt_receipt_id_seq'::regclass,
    'ops.webhook_runtime_heartbeat_webhook_runtime_heartbeat_id_seq'::regclass,
    'ops.webhook_job_job_id_seq'::regclass,
    'ops.operational_event_operational_event_id_seq'::regclass,
    'ops.webhook_hydration_directive_hydration_directive_id_seq'::regclass,
    'ops.webhook_subscription_state_webhook_subscription_state_id_seq'::regclass
  ])
)
SELECT count(DISTINCT held.pid)
FROM pg_catalog.pg_locks AS held
JOIN managed ON managed.oid = held.relation
WHERE held.pid <> pg_backend_pid()
  AND held.mode <> 'AccessShareLock';"
```

This observation does not replace the tool's lock: each core invocation must
then acquire `ACCESS EXCLUSIVE` on all seven tables within its 10-second lock
timeout, closing the race before snapshotting. All eight managed triggers must
be enabled before proceeding. Nonterminal webhook jobs (QUEUED, RUNNING, or
RETRY) must be zero, and hydration directives must have zero RUNNING rows,
zero owned leases (`lease_owner <> ''`), and zero expiring leases
(`lease_expires_at IS NOT NULL`). PENDING and RETRY directives are an idle
backlog: they do not block cutover and are carried by the forward baseline and
merged back by reverse. The v4 readiness schema makes that backlog explicit
with `pendingDirectives`, `retryDirectives`, `runningDirectives`,
`ownedDirectiveLeases`, and `expiringDirectiveLeases`; it is validated
for exact keys, non-negative integers, and
`nonterminalDirectives = pending + retry + running`. The backlog is
transferred, not processed: stopping the receiver, worker, and hydration units
and confirming zero RUNNING rows and zero leases is exactly what makes the
PENDING/RETRY rows safe to migrate; it does not mean the backlog has been
consumed, and the unsupported directive types stay queued for post-cutover
consumers. A service unit being inactive is not inferred from an empty queue,
and the tool never calls `systemctl` itself.

### 7.5 Catch stale fnOS up from authoritative cloud

The 2026-09-03 read-only evidence established that fnOS was then a strict
primary-key prefix of cloud for the identity tables, with an exact heartbeat
prefix and exact receipt immutable prefix. Those watermarks continue to move
and are not embedded in code or reused as a cutover gate. A fresh freeze is
mandatory.

With both sides frozen, `prepare-forward` always maps cloud source to fnOS
target. It dynamically proves every target key exists on source, rejects any
target-only key, compares common heartbeat rows exactly, applies receipt
monotonic rules, updates other mutable tables from cloud, inserts cloud-only
rows, validates dependencies, and aligns all six sequences.

Dry-run and record `planHash`:

```powershell
node scripts/fnos_webhook_cutover_ssh.mjs prepare-forward `
  --approved-source-identity $env:FNOS_WEBHOOK_SSH_CLOUD_IDENTITY_SHA256 `
  --approved-target-identity $env:FNOS_WEBHOOK_SSH_FNOS_IDENTITY_SHA256 `
  2>prepare-forward-dry-error.json | Tee-Object prepare-forward-dry.json
```

Approve that exact plan, then execute under a new frozen snapshot:

```powershell
node scripts/fnos_webhook_cutover_ssh.mjs prepare-forward --execute `
  --approved-plan-hash '<approved planHash>' `
  --approved-source-identity $env:FNOS_WEBHOOK_SSH_CLOUD_IDENTITY_SHA256 `
  --approved-target-identity $env:FNOS_WEBHOOK_SSH_FNOS_IDENTITY_SHA256 `
  2>prepare-forward-execute-error.json | Tee-Object prepare-forward-execute.json
```

Execute first recomputes the complete bounded plan under the same frozen
snapshot and compares the approved hash before writing. Success requires a
fresh post-commit connection and `readyForForwardBaseline: true`. Run a fresh
dry-run again; it must return `state: "already_applied"` and
`readyForForwardBaseline: true`. This catch-up result is not a reverse
baseline.

### 7.6 Create the forward baseline, then switch the public Webhook

Only after prepare-forward is exact may `forward` create the rollback
baseline. Both databases must still be frozen; all seven full digests, all six
`logicalNext` values, readiness, and trigger state must be identical. Cloud
subscription and gate counts must be zero.

```powershell
node scripts/fnos_webhook_cutover_ssh.mjs forward --execute `
  2>forward-baseline-error.json | Tee-Object forward-baseline.json
Get-FileHash -Algorithm SHA256 .\forward-baseline.json
```

Preserve both the manifest and its file hash. Only after this command succeeds
may the operator separately start the fnOS units and switch the public Webhook
upstream. Do not switch Nginx or the SHEIN callback from this tool.

### 7.7 Reverse backfill before returning to cloud

First freeze fnOS writers, then cloud writers, using section 7.4. Leave the
public upstream on fnOS while the merge and readback run. The launcher maps
fnOS source to cloud target automatically; the `CLOUD_*` and `FNOS_*`
variables are not swapped.

```powershell
node scripts/fnos_webhook_cutover_ssh.mjs reverse `
  --baseline .\forward-baseline.json `
  2>reverse-dry-error.json | Tee-Object reverse-dry.json

node scripts/fnos_webhook_cutover_ssh.mjs reverse --execute `
  --baseline .\forward-baseline.json `
  --approved-plan-hash '<approved planHash>' `
  2>reverse-execute-error.json | Tee-Object reverse-execute.json
```

Cloud must be exactly at the saved forward baseline, or already exactly equal
to the current frozen fnOS source. Any other cloud state, including a partial
apply, fails closed. The merge includes fnOS-new rows, baseline receipt mutable
changes, exact source versions of mutable job/event/directive rows, new
subscription/gate state, and all six sequences. Inserts follow
receipt -> event -> job -> directive -> heartbeat -> subscription -> gate.

The cloud receiver and upstream may be restored only after execute returns
`readyForCloudStart: true` following fresh authoritative readback, and a final
fresh reverse dry-run returns `state: "already_applied"` with
`readyForCloudStart: true`. Starting cloud services and changing upstream are
still separate operator decisions.

### 7.8 Trigger, commit-uncertainty, and recovery rules

Before an execute, all eight managed triggers must be enabled. In the target
transaction the tool disables only the five `touch_updated_at` triggers and
the gate recovery trigger, copies exact source timestamps/state, aligns
sequences, re-enables the same triggers, and verifies their state. Receipt
immutability and heartbeat append-only triggers remain enabled throughout.
Rollback restores both trigger and sequence state transactionally.

After `COMMIT`, including when the commit response throws, the original client
is discarded. A new PostgreSQL backend and, for SSH, a new child generation
must re-read all seven digests, all six `logicalNext` values, readiness,
trigger state, and stable identities. Exact equality to the frozen source is
the only state that can set a readiness flag. If readback is unavailable the
outcome is `outcome_unverified`; if an uncertain commit left target at its
pre-commit state the error is `COMMIT_NOT_APPLIED`. Neither permits service
start or upstream change.

After interruption, never replay an old execute automatically. Run a fresh
dry-run. Exact source/target equality is recognized as `already_applied`; an
exact baseline can produce a new plan; any third state remains blocked for
manual investigation.

### 7.9 Direct-URL core and isolated PostgreSQL test

The core can use `FNOS_WEBHOOK_SOURCE_DATABASE_URL` and
`FNOS_WEBHOOK_TARGET_DATABASE_URL`, but the stdio launcher is preferred for
the actual hosts because it needs no database password or local forwarding
port. Core identity checks are identical and database URLs are never printed.

The real PostgreSQL test is skipped unless explicitly enabled. It requires two
independent PostgreSQL 16.14 systems and accepts only `postgres` or `template1`
as maintenance URLs. It creates random
`fnos_cutover_test_source_*`/`fnos_cutover_test_target_*` databases and force
 drops them in `finally`; it refuses `shein_fm` as a test database. It covers a
 200-row baseline plus 1000-row delta, microsecond timestamps, transactional
 sequence rollback, receipt and other mutable updates, subscription and gate
 reverse delta with `last_probe_id`, all six sequences, trigger restoration,
 and post-commit digest equality. The fixture's initial 200 rows contain 10
 PENDING and 10 RETRY directives. The 1000-row cloud delta adds 50 PENDING and
 50 RETRY directives, so the forward baseline contains 60 PENDING and 60 RETRY.
 The 40-row fnOS directive delta then adds 2 PENDING, 2 RETRY, and 36 SUCCEEDED
 rows, so the SSH reverse final state contains 62 PENDING and 62 RETRY. The
 test asserts zero leases, exact readiness counts, and row-level state
 preservation in both directions.

```powershell
$env:FNOS_WEBHOOK_PG_INTEGRATION = '1'
$env:FNOS_WEBHOOK_PG_TEST_ACK = 'CREATE_AND_DROP_DEDICATED_DATABASES'
$env:FNOS_WEBHOOK_PG_TEST_SOURCE_ADMIN_URL = '<source postgresql admin URL ending in /postgres or /template1>'
$env:FNOS_WEBHOOK_PG_TEST_TARGET_ADMIN_URL = '<target postgresql admin URL ending in /postgres or /template1>'
node --test tests/webhook/fnos-cutover.pg.test.mjs
```

Do not claim this test passed when it was skipped, and never point either test
URL at `shein_fm`.
