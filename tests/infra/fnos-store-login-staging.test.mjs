import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readRaw = (relativePath) => readFileSync(join(root, relativePath), "utf8");

function stripFullLineComments(config) {
  return config.replace(/^[ \t]*#.*$/gm, "");
}

const readNginx = (relativePath) =>
  stripFullLineComments(readRaw(relativePath));

const CLOUD_TEMPLATE = "infra/nginx/shein-fm-upstreams-cloud.conf";
const LOGIN_STAGING_TEMPLATE =
  "infra/nginx/shein-fm-upstreams-store-login-fnos.conf";
const FNOS_TEMPLATE = "infra/nginx/shein-fm-upstreams-fnos.conf";
const MAIN_CONFIG = "infra/nginx/shein-fm.conf";

const UPSTREAM_NAMES = [
  "shein_fm_portal",
  "shein_fm_webhook",
  "shein_fm_store_login",
];

const TEMPLATE_PORTS = new Map([
  [
    CLOUD_TEMPLATE,
    { shein_fm_portal: "8788", shein_fm_webhook: "8793", shein_fm_store_login: "8794" },
  ],
  [
    LOGIN_STAGING_TEMPLATE,
    { shein_fm_portal: "8788", shein_fm_webhook: "8793", shein_fm_store_login: "18794" },
  ],
  [
    FNOS_TEMPLATE,
    { shein_fm_portal: "18788", shein_fm_webhook: "18793", shein_fm_store_login: "18794" },
  ],
]);

const ALL_KNOWN_PORTS = ["8788", "8793", "8794", "18788", "18793", "18794"];

function balancedBlock(config, directive) {
  const markerIndex = config.indexOf(directive);
  assert.notEqual(markerIndex, -1, "missing nginx directive " + directive);
  assert.equal(
    config.indexOf(directive, markerIndex + directive.length),
    -1,
    "nginx directive must occur exactly once: " + directive,
  );
  const open = config.indexOf("{", markerIndex + directive.length);
  const openFallback = config.indexOf("{", markerIndex);
  const braceIndex = directive.endsWith("{")
    ? openFallback
    : open;
  assert.notEqual(braceIndex, -1, "nginx directive has no opening brace: " + directive);
  let depth = 0;
  for (let index = braceIndex; index < config.length; index += 1) {
    if (config[index] === "{") depth += 1;
    if (config[index] === "}") {
      depth -= 1;
      if (depth === 0) return config.slice(markerIndex, index + 1);
    }
  }
  assert.fail("nginx directive has no closing brace: " + directive);
}

function serverEntries(config) {
  return [...config.matchAll(
    /\bserver[ \t]+([^\s;{}]+)(?:[ \t]+[^;{}\r\n]+)?;/g,
  )].map((match) => ({
    address: match[1],
    directive: match[0],
  }));
}

function assertTemplateSemantics(templatePath, template, expectedPorts) {
  const expectedPortList = UPSTREAM_NAMES.map((name) => expectedPorts[name]);

  assert.equal(
    (template.match(/\bupstream\s/g) ?? []).length,
    3,
    templatePath + " must define exactly three upstreams",
  );

  const servers = serverEntries(template);
  assert.equal(
    servers.length,
    3,
    templatePath + " must contain exactly three server entries",
  );
  for (const server of servers) {
    assert.match(
      server.address,
      /^127\.0\.0\.1:\d+$/,
      templatePath + " must be loopback-only",
    );
  }

  for (const foreignPort of ALL_KNOWN_PORTS) {
    if (expectedPortList.includes(foreignPort)) continue;
    assert.ok(
      !new RegExp(":" + foreignPort + "\\b").test(template),
      templatePath + " must not contain foreign port " + foreignPort,
    );
  }

  for (const name of UPSTREAM_NAMES) {
    const occurrences =
      template.match(new RegExp("upstream " + name + "\\b", "g")) ?? [];
    assert.equal(
      occurrences.length,
      1,
      "upstream " + name + " must appear once in " + templatePath,
    );
    const block = balancedBlock(template, "upstream " + name);
    const blockServers = serverEntries(block);
    assert.equal(
      blockServers.length,
      1,
      "upstream " + name + " must contain exactly one server in " + templatePath,
    );
    assert.match(
      blockServers[0].directive,
      new RegExp(":" + expectedPorts[name] + "\\b"),
      "upstream " + name + " must use port " + expectedPorts[name] + " in " + templatePath,
    );
    assert.equal(
      blockServers[0].address,
      "127.0.0.1:" + expectedPorts[name],
      "upstream " + name + " must have its exact loopback mapping in " + templatePath,
    );
  }

  assert.deepEqual(
    servers.map(({ address }) => address.split(":").at(-1)).sort(),
    [...expectedPortList].sort(),
    templatePath + " must expose exactly its own ports and no fourth port",
  );

  assert.ok(!template.includes("listen "), templatePath + " must not listen");
  assert.ok(!template.includes("0.0.0.0"), templatePath + " must not bind wildcard");
  assert.ok(!template.includes("[::]"), templatePath + " must not bind IPv6 wildcard");
}

test("three upstream templates keep exact loopback ports per environment", () => {
  for (const [templatePath, expectedPorts] of TEMPLATE_PORTS) {
    assertTemplateSemantics(
      templatePath,
      readNginx(templatePath),
      expectedPorts,
    );
  }
});

test("full-line comments cannot create pseudo upstream or server directives", () => {
  const rawWithPseudoDirectives = [
    "  # upstream shein_fm_shadow {",
    "\t# server 203.0.113.8:4444 backup;",
    readRaw(CLOUD_TEMPLATE),
    "# upstream shein_fm_portal { server 127.0.0.1:18788 weight=2; }",
  ].join("\n");
  const parsed = stripFullLineComments(rawWithPseudoDirectives);

  assert.doesNotMatch(parsed, /shein_fm_shadow|203\.0\.113\.8|:18788\b/);
  assertTemplateSemantics(
    "comment-hardened cloud fixture",
    parsed,
    TEMPLATE_PORTS.get(CLOUD_TEMPLATE),
  );
});

test("foreign ports remain forbidden when an nginx server has parameters", () => {
  const withParameterizedForeignPort = readNginx(CLOUD_TEMPLATE).replace(
    "server 127.0.0.1:8788;",
    "server 127.0.0.1:18788 weight=2 max_fails=1;",
  );

  assert.throws(
    () => assertTemplateSemantics(
      "parameterized foreign-port fixture",
      withParameterizedForeignPort,
      TEMPLATE_PORTS.get(CLOUD_TEMPLATE),
    ),
    /must not contain foreign port 18788/,
  );
});

test("login-staging template is the exact hybrid of cloud portal and fnOS store-login", () => {
  const staging = readNginx(LOGIN_STAGING_TEMPLATE);
  assert.match(staging, /server 127\.0\.0\.1:8788\b/, "portal must stay cloud-local");
  assert.match(staging, /server 127\.0\.0\.1:8793\b/, "webhook must stay cloud-local");
  assert.match(
    staging,
    /server 127\.0\.0\.1:18794\b/,
    "store-login must use the fnOS reverse port",
  );
  assert.ok(
    !/127\.0\.0\.1:8794\b/.test(staging),
    "staging must not keep the cloud store-login port",
  );
  assert.ok(
    !/:18788\b/.test(staging) && !/:18793\b/.test(staging),
    "staging must not move portal or webhook to fnOS ports",
  );
});

test("main nginx routes store-login only through the named upstream with access_log off", () => {
  const main = readNginx(MAIN_CONFIG);

  assert.match(main, /include \/etc\/nginx\/shein-fm-upstreams\.conf;/);
  assert.equal(
    (main.match(/include \/etc\/nginx\/shein-fm-upstreams\.conf;/g) ?? []).length,
    1,
    "the stable upstream include must occur exactly once",
  );

  const storeLoginDirectives = [
    "location = /store-login",
    "location ^~ /store-login/",
    "location ^~ /api/store-login/",
  ];
  for (const directive of storeLoginDirectives) {
    const block = balancedBlock(main, directive);
    assert.match(
      block,
      /access_log off;/,
      directive + " must disable access logging",
    );
    assert.doesNotMatch(
      block,
      /access_log \/var\/log/,
      directive + " must not write an access log file",
    );
    const proxyPasses = block.match(/proxy_pass [^;]+;/g) ?? [];
    assert.equal(
      proxyPasses.length,
      1,
      directive + " must have exactly one proxy_pass",
    );
    assert.equal(
      proxyPasses[0],
      "proxy_pass http://shein_fm_store_login;",
      directive + " must use only the shein_fm_store_login upstream",
    );
  }

  const portalBlock = balancedBlock(main, "location / {");
  assert.match(
    portalBlock,
    /proxy_pass http:\/\/shein_fm_portal;/,
    "normal traffic must stay on the portal upstream",
  );
  const webhookBlock = balancedBlock(
    main,
    "location = /api/shein/webhook/v1/events",
  );
  assert.match(
    webhookBlock,
    /proxy_pass http:\/\/shein_fm_webhook;/,
    "webhook traffic must stay on the webhook upstream",
  );

  assert.equal(
    (main.match(/proxy_pass http:\/\/shein_fm_portal;/g) ?? []).length,
    1,
    "portal upstream must be referenced exactly once",
  );
  assert.equal(
    (main.match(/proxy_pass http:\/\/shein_fm_webhook;/g) ?? []).length,
    1,
    "webhook upstream must be referenced exactly once",
  );
  assert.equal(
    (main.match(/proxy_pass http:\/\/shein_fm_store_login;/g) ?? []).length,
    3,
    "store-login upstream must back exactly the three store-login routes",
  );
  assert.doesNotMatch(
    main,
    /proxy_pass http:\/\/127\.0\.0\.1:(?:8788|8793|8794|18788|18793|18794)\b/,
    "business routes must never bypass the named upstreams",
  );
});
