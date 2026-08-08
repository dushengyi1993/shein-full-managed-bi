#!/usr/bin/env bash
set -Eeuo pipefail

readonly dashboard_dir="/srv/shein-fm/runtime/dashboard"
readonly home_staging="${dashboard_dir}/dashboard.home.next.json"
readonly core_staging="${dashboard_dir}/dashboard.next.json"
readonly shipping_staging="${dashboard_dir}/shipping-orders.next.json"
readonly order_staging="${dashboard_dir}/order-management.next.json"
readonly home_current="${dashboard_dir}/dashboard.home.json"
readonly core_current="${dashboard_dir}/dashboard.json"
readonly shipping_current="${dashboard_dir}/shipping-orders.json"
readonly order_current="${dashboard_dir}/order-management.json"
readonly materialize_started_at="$(/usr/bin/date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"

/usr/bin/node scripts/materialize_full_managed_dashboard.mjs
/usr/bin/node scripts/materialize_full_managed_shipping_orders.mjs

# The order-management index is built from the OpenAPI fact database and,
# when a session snapshot exists, from the fixed read-only Session HTTP
# contracts.  The snapshot is produced by
# sync_full_managed_order_management_sessions.mjs and never fetched here.
order_session_snapshot="${dashboard_dir}/order-management.sessions.json"
if [[ -f "${order_session_snapshot}" ]]; then
  FULL_BI_ORDER_MANAGEMENT_SESSION_SNAPSHOT="${order_session_snapshot}" \
    FULL_BI_ORDER_MANAGEMENT_FILE="${order_staging}" \
    /usr/bin/node scripts/materialize_full_managed_order_management.mjs
else
  FULL_BI_ORDER_MANAGEMENT_FILE="${order_staging}" \
    /usr/bin/node scripts/materialize_full_managed_order_management.mjs
fi

/usr/bin/chgrp sheinfm-dashboard "${home_staging}" "${core_staging}" "${shipping_staging}" "${order_staging}"
/usr/bin/chmod 0640 "${home_staging}" "${core_staging}" "${shipping_staging}" "${order_staging}"
/usr/bin/mv -f "${home_staging}" "${home_current}"
/usr/bin/mv -f "${shipping_staging}" "${shipping_current}"
# The order-management index only moves into place when every page gate
# passed (paging/total/dedupe/25-store coverage).  A failed gate keeps the
# staged file for inspection and never promotes the new index.
if ORDER_STAGING="${order_staging}" /usr/bin/node -e '
  const fs = require("fs");
  try {
    const value = JSON.parse(fs.readFileSync(process.env.ORDER_STAGING, "utf8"));
    if (value && value.coverage && value.coverage.status === "COMPLETE" && value.promotable === true) {
      process.exit(0);
    }
  } catch {}
  process.exit(1);
'; then
  /usr/bin/mv -f "${order_staging}" "${order_current}"
else
  echo "order-management index gate failed; staged file kept at ${order_staging}" >&2
fi
# The core file is the observable publication boundary. Promote it last so an
# SSE refresh can never see the new core beside an older shipping-order index.
/usr/bin/mv -f "${core_staging}" "${core_current}"
FULL_BI_MATERIALIZE_STARTED_AT="${materialize_started_at}" \
  /usr/bin/node scripts/mark_full_managed_coordinators_published.mjs
