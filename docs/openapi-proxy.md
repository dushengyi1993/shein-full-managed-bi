# Optional local HTTP CONNECT proxy for SHEIN OpenAPI

## Purpose

This is an opt-in transport for a future VM-side 127.0.0.1 proxy tunnel. When
configured, only requests made by SheinOpenApiClient against the official
origin https://openapi.sheincorp.com are sent through the proxy. Everything
else in the process, including the browser automation, WebAPI transports, the
BI portal and ordinary Node HTTP calls, keeps using its normal network path.

## Configuration

SHEIN_FM_OPENAPI_PROXY_URL enables the proxy. When the variable is unset,
empty, or blank, behaviour is unchanged and no proxy code runs for a request.

SHEIN_FM_OPENAPI_PROXY_REQUIRED is a separate runtime safety gate. The current
cloud runtime leaves it unset (or sets it to 0), preserving direct OpenAPI
behaviour. The fnOS VM must set it to 1. In that mode an unset or blank proxy
URL fails with OPENAPI_PROXY_REQUIRED before any network activity, so a tunnel
or configuration failure can never fall back to the office public IP. Values
other than empty, 0, or 1 fail closed as INVALID_PROXY_CONFIG.

Accepted values are credential-free HTTP(S) loopback URLs, for example:

    SHEIN_FM_OPENAPI_PROXY_URL=http://127.0.0.1:8080

localhost, ::1, and any 127.x.x.x address are accepted. The proxy itself may
use http:// or https://; the tunnel to openapi.sheincorp.com:443 is still
CONNECT-based TLS.

## Fail-closed validation

The value is validated when the client is constructed and rejects with
SheinOpenApiError code INVALID_PROXY_CONFIG (the raw value is never echoed)
for:

- non-string values or a malformed URL;
- schemes other than http: or https:;
- URLs containing credentials, a query string, a fragment, or a non-root path;
- non-loopback hostnames, missing hosts, or ports outside 1..65535.

The loopback restriction is deliberate: signed SHEIN requests carry
authorization headers, so they must never be routed through an arbitrary
remote proxy. The Windows and cloud-execution gates are unchanged and always
run before any network activity, so the proxy can never bypass
REAL_OPENAPI_BLOCKED_ON_WINDOWS or REAL_OPENAPI_CLOUD_ATTESTATION_REQUIRED.
The required-proxy gate is scoped to the exact official OpenAPI origin; local
and test fake origins retain their injected transports.

## Implementation

src/openapi/proxy-transport.mjs validates the configuration, checks that the
client base URL resolves to exactly https://openapi.sheincorp.com, and only
then creates an undici ProxyAgent. SheinOpenApiClient attaches that dispatcher
to both request() and getByToken() fetches. The dispatcher and the fetch
implementation come from the same installed undici copy so their internal
contracts always match, independent of the Node-bundled undici version.

Proxy connection failures surface through the existing sanitized NETWORK_ERROR
and REQUEST_TIMEOUT paths, which never include credentials or the proxy URL in
user-facing messages.

## Fixed-IP relay topology

The relay is deliberately narrower than a whole-machine VPN:

    SheinOpenApiClient
      -> HTTP CONNECT 127.0.0.1:18080 on the fnOS VM
      -> SSH local forward over the cloud host's existing SSH port
      -> 127.0.0.1:18080 on the cloud host
      -> openapi.sheincorp.com:443 from the cloud fixed public IP

The same dedicated key also carries the audited edge reverse forwards for the
cloud TLS entry: cloud 127.0.0.1:18788/18793/18794 return to fnOS
127.0.0.1:8788/8793/8794.  Those reverse listeners must remain cloud-loopback
only; Nginx still terminates TLS on the cloud fixed hostname.

The cloud-side `serve_shein_openapi_connect_relay.mjs` process always binds
`127.0.0.1`; it rejects ordinary HTTP and every CONNECT authority except
`openapi.sheincorp.com:443`. It never receives or logs decrypted SHEIN traffic:
TLS still terminates only at SHEIN. The VM tunnel unit reads an explicit SSH
config and key from `/srv/shein-fm/secrets/openapi-relay/` and publishes only a
VM-loopback port. No HAProxy, SSH daemon, router, browser or WebAPI default route
is changed.

Use a dedicated SSH key whose cloud `authorized_keys` entry is constrained to
the relay listener:

    restrict,port-forwarding,permitopen="127.0.0.1:18080",permitlisten="127.0.0.1:18788",permitlisten="127.0.0.1:18793",permitlisten="127.0.0.1:18794",command="/usr/bin/false" ssh-ed25519 ... shein-fm-openapi-relay

The forced command blocks shell and remote-command use of this key. The
`SessionType none` tunnel requests no remote session, so the permitted local
forward remains available.

The matching SSH config must include `ExitOnForwardFailure yes`,
`ServerAliveInterval 30`, `ServerAliveCountMax 3`, `StrictHostKeyChecking yes`,
an explicitly pinned `UserKnownHostsFile`, `IdentitiesOnly yes`, and exactly
these forwards:

    LocalForward 127.0.0.1:18080 127.0.0.1:18080
    RemoteForward 127.0.0.1:18788 127.0.0.1:8788
    RemoteForward 127.0.0.1:18793 127.0.0.1:8793
    RemoteForward 127.0.0.1:18794 127.0.0.1:8794

On the VM, the OpenAPI-only environment file is:

    SHEIN_FM_OPENAPI_PROXY_URL=http://127.0.0.1:18080
    SHEIN_FM_OPENAPI_PROXY_REQUIRED=1

Do not export `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, or a Docker daemon proxy.
Those global settings would violate the browser/WebAPI direct-routing boundary.

Acceptance requires all of the following: both listeners are loopback-only; an
allowed CONNECT completes a TLS handshake with the official host; lookalike
targets return 403; stopping the SSH tunnel makes an OpenAPI client with the
required flag fail rather than connect directly; and an ordinary direct egress
probe continues to show the office public IP.

## Tests

tests/openapi/proxy-transport.test.mjs covers default-disable, validation
fail-closed behaviour, exact-origin scoping, dispatcher selection, a real
loopback CONNECT probe proving only CONNECT openapi.sheincorp.com:443 is
issued, both client methods, and gate preservation. The probe never contacts
the SHEIN network.

tests/openapi/connect-relay.test.mjs exercises the cloud relay entirely on
loopback: exact allow-listing, byte tunnelling to a fake local TLS target,
lookalike denial before dial, ordinary-HTTP denial, and sanitized upstream
failure handling.
