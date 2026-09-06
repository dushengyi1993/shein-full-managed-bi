import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");

test("cloud and fnOS upstream templates expose the same loopback names on distinct ports", () => {
  const cloud = read("infra/nginx/shein-fm-upstreams-cloud.conf");
  const fnos = read("infra/nginx/shein-fm-upstreams-fnos.conf");
  const mappings = [
    ["shein_fm_portal", "8788", "18788"],
    ["shein_fm_webhook", "8793", "18793"],
    ["shein_fm_store_login", "8794", "18794"],
  ];

  for (const [name, cloudPort, fnosPort] of mappings) {
    const cloudPattern = new RegExp(
      "upstream " + name + "\\s*{\\s*server 127\\.0\\.0\\.1:" + cloudPort + ";",
    );
    const fnosPattern = new RegExp(
      "upstream " + name + "\\s*{\\s*server 127\\.0\\.0\\.1:" + fnosPort + ";",
    );
    assert.match(cloud, cloudPattern);
    assert.match(fnos, fnosPattern);
  }

  const cloudPorts = [...cloud.matchAll(/server 127\.0\.0\.1:(\d+);/g)].map(
    (match) => match[1],
  );
  const fnosPorts = [...fnos.matchAll(/server 127\.0\.0\.1:(\d+);/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(cloudPorts, ["8788", "8793", "8794"]);
  assert.deepEqual(fnosPorts, ["18788", "18793", "18794"]);

  for (const config of [cloud, fnos]) {
    assert.ok(!config.includes("listen "), "upstream template must not listen");
    assert.ok(!config.includes("0.0.0.0"), "upstream template must be loopback-only");
    assert.ok(!config.includes("[::]"), "upstream template must be loopback-only");
  }
  for (const forbiddenPort of ["18788", "18793", "18794"]) {
    assert.ok(
      !cloudPorts.includes(forbiddenPort),
      "cloud template must not contain reverse port " + forbiddenPort,
    );
  }
  for (const forbiddenPort of ["8788", "8793", "8794"]) {
    assert.ok(
      !fnosPorts.includes(forbiddenPort),
      "fnOS template must not contain cloud-local port " + forbiddenPort,
    );
  }
});

test("main nginx switches the three business routes through named upstreams", () => {
  const main = read("infra/nginx/shein-fm.conf");

  assert.match(main, /include \/etc\/nginx\/shein-fm-upstreams\.conf;/);
  assert.equal(
    (main.match(/proxy_pass http:\/\/shein_fm_portal;/g) ?? []).length,
    1,
  );
  assert.equal(
    (main.match(/proxy_pass http:\/\/shein_fm_webhook;/g) ?? []).length,
    1,
  );
  assert.equal(
    (main.match(/proxy_pass http:\/\/shein_fm_store_login;/g) ?? []).length,
    3,
  );
  assert.equal(
    (main.match(/proxy_pass http:\/\/127\.0\.0\.1:18789;/g) ?? []).length,
    3,
    "Authorization must use its dedicated loopback VM reverse tunnel on port 18789",
  );
  assert.doesNotMatch(main, /proxy_pass http:\/\/127\.0\.0\.1:8789;/);

  for (const businessPort of ["8788", "8793", "8794"]) {
    assert.ok(
      !main.includes(businessPort),
      "main nginx must not directly reference business port " + businessPort,
    );
  }
});

test("VM authorization broker retains loopback, fixed-egress and production guards", () => {
  const unit = read("infra/systemd/shein-fm-authorization-fnos.service");
  const lines = unit.split(/\r?\n/);
  const required = [
    "Requires=shein-fm-openapi-tunnel.service",
    "After=network-online.target shein-fm-openapi-tunnel.service",
    "ConditionPathExists=/srv/shein-fm/runtime/authorization/authorization.enabled",
    "User=sheinfm-auth",
    "Group=sheinfm-auth",
    "UMask=0077",
    "Environment=NODE_ENV=production",
    "Environment=SHEIN_FM_CLOUD_EXECUTION=1",
    "Environment=SHEIN_FM_OPENAPI_PROXY_URL=http://127.0.0.1:18080",
    "Environment=SHEIN_FM_OPENAPI_PROXY_REQUIRED=1",
    "Environment=FULL_AUTH_HOST=127.0.0.1",
    "Environment=FULL_AUTH_PORT=8789",
    "Environment=FULL_AUTH_PUBLIC_ORIGIN=https://fm.dushengyi.cc",
    "Environment=FULL_AUTH_COOKIE_SECURE=true",
    "ExecStart=/usr/bin/node src/authorization/index.mjs",
    "NoNewPrivileges=true",
    "ProtectSystem=strict",
    "ProtectHome=true",
    "ReadOnlyPaths=/srv/shein-fm/secrets/authorization/application.secret.json",
    "ReadWritePaths=/srv/shein-fm/runtime/authorization /srv/shein-fm/secrets/authorization/receipts",
  ];
  for (const line of required) {
    const key = line.slice(0, line.indexOf("=")) === "Environment"
      ? line.slice(0, line.indexOf("=", line.indexOf("=") + 1) + 1)
      : line.slice(0, line.indexOf("=") + 1);
    assert.deepEqual(lines.filter((entry) => entry.startsWith(key)), [line], key);
  }
  assert.doesNotMatch(unit, /^EnvironmentFile=/m);
});

test("authorization reverse tunnel remains separately configured and sandboxed", () => {
  const unit = read("infra/systemd/shein-fm-authorization-tunnel.service");
  const lines = unit.split(/\r?\n/);
  for (const line of [
    "ExecStart=/usr/bin/ssh -F /srv/shein-fm/secrets/openapi-relay/authorization_ssh_config -NT shein-openapi-relay",
    "User=sheinops",
    "Group=sheinops",
    "UMask=0077",
    "Restart=always",
    "NoNewPrivileges=true",
    "ProtectSystem=strict",
    "ProtectHome=true",
    "ReadOnlyPaths=/srv/shein-fm/secrets/openapi-relay",
    "CapabilityBoundingSet=",
  ]) {
    const key = line.slice(0, line.indexOf("=") + 1);
    assert.deepEqual(lines.filter((entry) => entry.startsWith(key)), [line], key);
  }
  assert.ok(lines.includes("ConditionPathExists=/srv/shein-fm/secrets/openapi-relay/authorization_ssh_config"));
  assert.ok(lines.includes("ConditionPathExists=/srv/shein-fm/secrets/openapi-relay/id_ed25519"));
  // RemoteForward and host-key policy live in the environment-owned SSH config;
  // this static contract does not claim to validate that unavailable file.
});

test("SSH example preserves OpenAPI forward and adds only the audited reverse listeners", () => {
  const ssh = read("infra/systemd/shein-fm-openapi-relay-ssh_config.example");
  const lines = ssh.split(/\r?\n/);
  const expectedForwards = [
    "LocalForward 127.0.0.1:18080 127.0.0.1:18080",
    "RemoteForward 127.0.0.1:18788 127.0.0.1:8788",
    "RemoteForward 127.0.0.1:18793 127.0.0.1:8793",
    "RemoteForward 127.0.0.1:18794 127.0.0.1:8794",
  ];

  for (const forward of expectedForwards) {
    assert.ok(lines.includes("    " + forward), "missing forward: " + forward);
    assert.match(
      "    " + forward,
      /^    (?:Local|Remote)Forward 127\.0\.0\.1:\d+ 127\.0\.0\.1:\d+$/,
      "every forward must remain loopback-to-loopback",
    );
  }
  assert.equal(
    lines.filter((line) => line.startsWith("    LocalForward ")).length,
    1,
  );
  assert.equal(
    lines.filter((line) => line.startsWith("    RemoteForward ")).length,
    3,
  );

  const guards = [
    "ExitOnForwardFailure yes",
    "StrictHostKeyChecking yes",
    "IdentitiesOnly yes",
    "BatchMode yes",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "UserKnownHostsFile /srv/shein-fm/secrets/openapi-relay/known_hosts",
    "RequestTTY no",
    "SessionType none",
  ];
  for (const guard of guards) {
    assert.ok(
      lines.includes("    " + guard),
      "missing SSH guard: " + guard,
    );
  }
});

test("tunnel unit retains its fail-closed execution boundary", () => {
  const unit = read("infra/systemd/shein-fm-openapi-tunnel.service");

  assert.match(unit, /^ExecStart=\/usr\/bin\/ssh .* -NT shein-openapi-relay$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^ReadOnlyPaths=\/srv\/shein-fm\/secrets\/openapi-relay$/m);
  assert.match(unit, /^CapabilityBoundingSet=$/m);
});

test("documentation keeps permitopen and permitlisten restrictions explicit", () => {
  const docs = read("docs/openapi-proxy.md");
  const runbook = read("docs/runbooks/fnos-cutover.md");
  const restrictedKey = [
    "restrict,port-forwarding",
    'permitopen="127.0.0.1:18080"',
    'permitlisten="127.0.0.1:18788"',
    'permitlisten="127.0.0.1:18793"',
    'permitlisten="127.0.0.1:18794"',
    'command="/usr/bin/false"',
  ].join(",");

  assert.ok(
    docs.includes(restrictedKey),
    "OpenAPI docs must show the complete independently scoped key options",
  );
  assert.ok(runbook.includes('permitopen="127.0.0.1:18080"'));
  for (const reversePort of ["18788", "18793", "18794"]) {
    assert.match(
      runbook,
      new RegExp('permitlisten="127\\.0\\.0\\.1:' + reversePort + '"'),
    );
    assert.match(
      runbook,
      new RegExp("RemoteForward 127\\.0\\.0\\.1:" + reversePort + " 127\\.0\\.0\\.1:"),
    );
  }
});

test("runbook requires audited backup, reload, rollback, and cloud retention", () => {
  const runbook = read("docs/runbooks/fnos-cutover.md");

  const requiredText = [
    "Zero-downtime preflight",
    "sha256sum",
    "sudo nginx -t",
    "sudo systemctl reload nginx",
    "Rollback",
    "do not restart Nginx or",
    "do not delete or decommission",
    "friend server's fixed IP",
    "cold backup",
  ];
  for (const required of requiredText) {
    assert.ok(
      runbook.includes(required),
      "runbook is missing: " + required,
    );
  }

  for (const reversePort of ["18788", "18793", "18794"]) {
    assert.match(
      runbook,
      new RegExp("127\\.0\\.0\\.1:" + reversePort + "\\b"),
      "runbook must retain cloud reverse port " + reversePort + " on loopback",
    );
  }
});
