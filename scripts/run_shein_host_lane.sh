#!/usr/bin/env bash
set -euo pipefail

# Neutral host resource-lane launcher shared by the two SHEIN projects.
#
#   api-light PROJECT PRESSURE_CLASS COMMAND...
#   browser-read PROJECT PRESSURE_CLASS COMMAND...
#   browser-write PROJECT PRESSURE_CLASS COMMAND...
#   db-heavy PROJECT PRESSURE_CLASS COMMAND...
#   io-heavy PROJECT PRESSURE_CLASS COMMAND...
#
# The host-heavy lock is a read/write gate: read-only browsers take a shared
# lock and one of two browser slots; business writes, DB-heavy work and IO-heavy
# work take the exclusive lock. Existing semi-managed exclusive flock users
# remain compatible and therefore cannot accidentally create a third Chrome.

if (( $# < 4 )); then
  printf '{"ok":false,"errorCode":"HOST_LANE_ARGUMENT_INVALID"}\n' >&2
  exit 64
fi

readonly lane="$1"
readonly project="$2"
readonly pressure_class="$3"
shift 3

case "$project" in
  fm|bi) ;;
  *) printf '{"ok":false,"errorCode":"HOST_LANE_PROJECT_INVALID"}\n' >&2; exit 64 ;;
esac

readonly defer_code=75
readonly host_gate='/run/lock/shein-host-heavy.lock'
host_lane_slot=''

run_pressure_gate() {
  /usr/bin/node scripts/check_full_managed_resource_pressure.mjs \
    "--class=${1}"
}

take_preferred_slot() {
  local family="$1"
  local preferred secondary
  if [[ "$project" == 'fm' ]]; then
    preferred=0
    secondary=1
  else
    preferred=1
    secondary=0
  fi

  exec 8>"/run/lock/shein-${family}-${preferred}.lock"
  if /usr/bin/flock -n 8; then
    host_lane_slot="$preferred"
    return 0
  fi
  exec 8>&-
  exec 8>"/run/lock/shein-${family}-${secondary}.lock"
  if /usr/bin/flock -n 8; then
    host_lane_slot="$secondary"
    return 0
  fi
  exec 8>&-
  return 1
}

other_slot_busy() {
  local family="$1"
  local held="$2"
  local other=0
  [[ "$held" == '0' ]] && other=1
  exec 7>"/run/lock/shein-${family}-${other}.lock"
  if /usr/bin/flock -n 7; then
    /usr/bin/flock -u 7
    exec 7>&-
    return 1
  fi
  exec 7>&-
  return 0
}

case "$lane" in
  api-light)
    if ! take_preferred_slot api-light; then
      printf '{"ok":true,"status":"DEFERRED","reasonCodes":["API_LIGHT_SLOTS_BUSY"]}\n'
      exit "$defer_code"
    fi
    run_pressure_gate "$pressure_class" || exit $?
    ;;
  browser-read)
    exec 9>"$host_gate"
    if ! /usr/bin/flock -s -n 9; then
      printf '{"ok":true,"status":"DEFERRED","reasonCodes":["HOST_EXCLUSIVE_BUSY"]}\n'
      exit "$defer_code"
    fi
    if ! take_preferred_slot browser-read; then
      printf '{"ok":true,"status":"DEFERRED","reasonCodes":["BROWSER_READ_SLOTS_BUSY"]}\n'
      exit "$defer_code"
    fi
    if other_slot_busy browser-read "$host_lane_slot"; then
      run_pressure_gate browser-secondary || exit $?
    else
      run_pressure_gate "$pressure_class" || exit $?
    fi
    ;;
  browser-write|db-heavy|io-heavy)
    exec 9>"$host_gate"
    if ! /usr/bin/flock -n 9; then
      printf '{"ok":true,"status":"DEFERRED","reasonCodes":["HOST_EXCLUSIVE_BUSY"]}\n'
      exit "$defer_code"
    fi
    run_pressure_gate "$pressure_class" || exit $?
    ;;
  *)
    printf '{"ok":false,"errorCode":"HOST_LANE_INVALID"}\n' >&2
    exit 64
    ;;
esac

exec "$@"
