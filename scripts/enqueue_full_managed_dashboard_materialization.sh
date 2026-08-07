#!/usr/bin/env bash
set -euo pipefail

readonly pending_marker="${FULL_BI_MATERIALIZE_PENDING_MARKER:-/srv/shein-fm/runtime/dashboard/.materialize-pending}"
readonly kick_marker="${FULL_BI_MATERIALIZE_KICK_MARKER:-/srv/shein-fm/runtime/dashboard/.materialize-kick}"
readonly request_marker="${FULL_BI_MATERIALIZE_REQUEST_MARKER:-/srv/shein-fm/runtime/webhook-requests/dashboard.request}"
readonly dashboard_file="${FULL_BI_DASHBOARD_FILE:-/srv/shein-fm/runtime/dashboard/dashboard.home.json}"
readonly debounce_seconds="${FULL_BI_MATERIALIZE_DEBOUNCE_SECONDS:-300}"

if [[ ! "$debounce_seconds" =~ ^[0-9]+$ ]] || (( debounce_seconds > 600 )); then
  echo "invalid dashboard materialization debounce: ${debounce_seconds}" >&2
  exit 64
fi

if (( debounce_seconds > 0 )); then
  /usr/bin/sleep "$debounce_seconds"
fi

# Repeated Webhook events can retrigger the Path unit while an earlier debounce
# or materialization is still active. Only publish if an event is still newer
# than the last atomically promoted dashboard snapshot.
if [[ ! -e "$request_marker" ]] || { [[ -e "$dashboard_file" ]] && [[ ! "$request_marker" -nt "$dashboard_file" ]]; }; then
  exit 0
fi

umask 0077
/usr/bin/mkdir -p "$(dirname "$pending_marker")"
/usr/bin/touch "$pending_marker"
# PathModified wakes the event-driven retry service. Its fixed timer stays
# disabled; pressure deferrals remain recoverable without periodic full runs.
/usr/bin/touch "$kick_marker"
