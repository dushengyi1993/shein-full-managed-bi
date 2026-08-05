#!/usr/bin/env bash
set -euo pipefail

readonly pending_marker='/srv/shein-fm/runtime/dashboard/.materialize-pending'
umask 0077
/usr/bin/mkdir -p "$(dirname "$pending_marker")"
/usr/bin/touch "$pending_marker"
