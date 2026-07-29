#!/usr/bin/env bash
set -euo pipefail

# Post-success release pruning.
#
# This is deliberately NOT part of an automatic deployment pipeline. It is an
# explicit command an operator runs only after a deployment has been health
# checked and read back. It performs exactly one action: prune idle full-managed
# releases. It never deploys, restarts, migrates or touches the database.
#
#   scripts/post_deploy_prune_releases.sh            # plan only
#   scripts/post_deploy_prune_releases.sh --apply    # after a verified deploy
#
# The prune tool itself protects current, previous, the newest five and every
# release referenced by a live process working directory, so a running Webhook
# receiver or worker can never have its release removed.

apply=0
while (( $# > 0 )); do
  case "$1" in
    --apply) apply=1; shift ;;
    *) printf 'unsupported argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The Portal listens on 8788; Nginx terminates on 8081. Probing the wrong port
# would either fail outright or health-check the proxy instead of the Portal.
health_url="${FULL_BI_HEALTH_URL:-http://127.0.0.1:8788/health}"

# Gate 1: the portal must be serving. A failed health check aborts before any
# release is considered for deletion.
if ! health_body="$(curl -fsS --max-time 10 "$health_url")"; then
  printf '{"ok":false,"stage":"health","reason":"health endpoint did not respond"}\n' >&2
  exit 1
fi
case "$health_body" in
  *'"status":"ok"'*) ;;
  *)
    printf '{"ok":false,"stage":"health","reason":"health payload is not ok"}\n' >&2
    exit 1
    ;;
esac

# Gate 2: the readback must show a resolvable current release. Without it we
# cannot prove which release is protected, so we refuse rather than guess.
current_link="/opt/shein-fm/current"
if [[ ! -L "$current_link" ]]; then
  printf '{"ok":false,"stage":"readback","reason":"current is not a symlink"}\n' >&2
  exit 1
fi
current_target="$(readlink -f "$current_link")"
case "$current_target" in
  /opt/shein-fm/releases/*) ;;
  *)
    printf '{"ok":false,"stage":"readback","reason":"current resolves outside releases"}\n' >&2
    exit 1
    ;;
esac

printf 'health ok; current release %s\n' "$current_target" >&2

if (( apply == 1 )); then
  node "$project_root/scripts/prune_full_managed_releases.mjs" --apply
else
  node "$project_root/scripts/prune_full_managed_releases.mjs"
fi
