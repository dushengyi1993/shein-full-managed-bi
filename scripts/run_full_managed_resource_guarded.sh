#!/usr/bin/env bash
set -u

if (( $# < 2 )); then
  printf '{"ok":false,"errorCode":"RESOURCE_GUARDED_ARGUMENT_INVALID"}\n' >&2
  exit 64
fi

readonly resource_class="$1"
shift

case "${resource_class}" in
  browser|openapi|materializer) ;;
  *)
    printf '{"ok":false,"errorCode":"RESOURCE_GUARDED_CLASS_INVALID"}\n' >&2
    exit 64
    ;;
esac

set +e
/usr/bin/node scripts/check_full_managed_resource_pressure.mjs \
  "--class=${resource_class}"
readonly gate_status=$?
set -e

if (( gate_status == 75 )); then
  exit 75
fi
if (( gate_status != 0 )); then
  printf '{"ok":false,"errorCode":"RESOURCE_GUARDED_CHECK_FAILED"}\n' >&2
  exit 70
fi

exec "$@"
