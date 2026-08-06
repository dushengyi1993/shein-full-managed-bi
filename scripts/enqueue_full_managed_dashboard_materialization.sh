#!/usr/bin/env bash
set -euo pipefail

readonly pending_marker='/srv/shein-fm/runtime/dashboard/.materialize-pending'
readonly kick_marker='/srv/shein-fm/runtime/dashboard/.materialize-kick'
umask 0077
/usr/bin/mkdir -p "$(dirname "$pending_marker")"
/usr/bin/touch "$pending_marker"
# PathModified wakes the materializer immediately. The ten-minute timer remains
# only as a lost-event fallback when pressure deferred the first attempt.
/usr/bin/touch "$kick_marker"
