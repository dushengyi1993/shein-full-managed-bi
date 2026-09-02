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
