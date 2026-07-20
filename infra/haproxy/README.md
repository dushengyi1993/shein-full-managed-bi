# `fm.dushengyi.cc` HAProxy SNI change

The production host multiplexes SSH and HTTPS on port 443. Do not replace the
whole HAProxy configuration from this repository. Patch the live file while an
existing SSH session remains open, validate it, and use `reload`, never
`restart`.

The HTTPS frontend must define the full-managed SNI alongside the existing
semi-managed SNI, apply the same Cloudflare direct-peer restriction, and route
only that SNI to the full-managed loopback-only Caddy listener:

```haproxy
acl is_shein_fm_sni req.ssl_sni -i fm.dushengyi.cc
tcp-request content reject if is_tls is_shein_fm_sni !is_cloudflare
use_backend bk_shein_fm_https if is_tls is_shein_fm_sni

backend bk_shein_fm_https
    mode tcp
    server caddy_shein_fm_https 127.0.0.1:11443 check
```

Keep the pre-existing generic TLS backend and SSH detection unchanged. The
dedicated `11443` listener prevents direct public access from bypassing the
Cloudflare peer ACL or injecting a fake `CF-Connecting-IP` value.

Validation gate:

```bash
sudo haproxy -c -f /etc/haproxy/haproxy.cfg
sudo systemctl reload haproxy
```

After reload, verify that `127.0.0.1:11443` is listening, the server's public
IP does not accept port 11443, and a new SSH connection through port 443 still
succeeds before closing the deployment session.

The existing SSH payload detection, default SSH backend, Cloudflare networks,
and HTTPS backend must remain unchanged.
