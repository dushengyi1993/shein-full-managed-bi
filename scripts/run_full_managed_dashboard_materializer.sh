#!/usr/bin/env bash
set -u

readonly pending_marker='/srv/shein-fm/runtime/dashboard/.materialize-pending'
readonly only_pending="${1:-}"

if [[ -n "${only_pending}" && "${only_pending}" != '--only-pending' ]]; then
  printf '{"ok":false,"errorCode":"MATERIALIZER_RETRY_ARGUMENT_INVALID"}\n' >&2
  exit 64
fi
if [[ "${only_pending}" == '--only-pending' && ! -f "${pending_marker}" ]]; then
  exit 0
fi

umask 0077
/usr/bin/touch "${pending_marker}"

set +e
/usr/bin/bash scripts/run_shein_host_lane.sh \
  db-heavy fm db-heavy \
  /usr/bin/flock -n -E 75 /run/lock/shein-fm-heavy.lock \
  /usr/bin/bash scripts/materialize_and_promote_full_managed_dashboard.sh
readonly materialize_status=$?
set -e

if (( materialize_status == 0 )); then
  /usr/bin/rm -f -- "${pending_marker}"
fi
exit "${materialize_status}"
