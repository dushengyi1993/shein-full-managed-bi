#!/usr/bin/env bash
set -Eeuo pipefail

readonly dashboard_dir="/srv/shein-fm/runtime/dashboard"
readonly home_staging="${dashboard_dir}/dashboard.home.next.json"
readonly core_staging="${dashboard_dir}/dashboard.next.json"
readonly home_current="${dashboard_dir}/dashboard.home.json"
readonly core_current="${dashboard_dir}/dashboard.json"
readonly materialize_started_at="$(/usr/bin/date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"

/usr/bin/node scripts/materialize_full_managed_dashboard.mjs

/usr/bin/chgrp sheinfm-dashboard "${home_staging}" "${core_staging}"
/usr/bin/chmod 0640 "${home_staging}" "${core_staging}"
/usr/bin/mv -f "${home_staging}" "${home_current}"
/usr/bin/mv -f "${core_staging}" "${core_current}"
FULL_BI_MATERIALIZE_STARTED_AT="${materialize_started_at}" \
  /usr/bin/node scripts/mark_full_managed_coordinators_published.mjs
