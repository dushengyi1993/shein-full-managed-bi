#!/usr/bin/env bash
set -Eeuo pipefail

readonly backup_dir="${FULL_BI_BACKUP_DIR:-/srv/shein-fm/backups/db}"
case "$backup_dir" in
  /srv/shein-fm/backups|/srv/shein-fm/backups/*) ;;
  *) printf '{"ok":false,"errorCode":"RESTORE_BACKUP_PATH_INVALID"}\n' >&2; exit 2 ;;
esac

readonly runtime_dir='/srv/shein-fm/runtime/backup-restore-test'
readonly container_name="${SHEIN_FM_DB_CONTAINER:-shein-fm-db}"
/usr/bin/install -d -o root -g root -m 0700 "$runtime_dir"

latest_backup="$({
  find "$backup_dir" -maxdepth 1 -type f \
    \( -name 'shein-fm-daily-*.dump' -o -name 'shein-fm-deploy-*.dump' \) \
    -printf '%T@ %p\n'
} | sort -nr | head -n 1 | cut -d' ' -f2-)"
if [[ -z "$latest_backup" || ! -f "$latest_backup" ]]; then
  printf '{"ok":false,"errorCode":"RESTORE_BACKUP_MISSING"}\n' >&2
  exit 1
fi

readonly restore_db="shein_fm_restore_check_$(date -u +%Y%m%d)_$$"
if [[ ! "$restore_db" =~ ^shein_fm_restore_check_[0-9]{8}_[0-9]+$ ]]; then
  printf '{"ok":false,"errorCode":"RESTORE_DATABASE_NAME_INVALID"}\n' >&2
  exit 2
fi

cleanup() {
  /usr/bin/docker exec --env "RESTORE_DB=$restore_db" "$container_name" \
    sh -ceu 'dropdb --if-exists --force -U "$POSTGRES_USER" "$RESTORE_DB"' \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 143' TERM INT

# Validate the custom archive before allocating a temporary database.
/usr/bin/docker exec -i "$container_name" pg_restore --list <"$latest_backup" >/dev/null
/usr/bin/docker exec --env "RESTORE_DB=$restore_db" "$container_name" \
  sh -ceu 'createdb -U "$POSTGRES_USER" "$RESTORE_DB"'
/usr/bin/docker exec -i --env "RESTORE_DB=$restore_db" "$container_name" \
  sh -ceu 'pg_restore --exit-on-error --no-owner --no-privileges -U "$POSTGRES_USER" -d "$RESTORE_DB"' \
  <"$latest_backup"

verification="$(/usr/bin/docker exec --env "RESTORE_DB=$restore_db" "$container_name" \
  sh -ceu 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$RESTORE_DB" -Atqc "
    SELECT json_build_object(
      '\''storeCount'\'', (SELECT count(*) FROM dim.store),
      '\''salesRows'\'', (SELECT count(*) FROM fact.full_sku_sales_snapshot),
      '\''webhookReceipts'\'', (SELECT count(*) FROM raw.webhook_receipt),
      '\''criticalRelationsReady'\'',
        to_regclass('\''mart.full_store_sales_latest'\'') IS NOT NULL
        AND to_regclass('\''ops.reconciliation_result'\'') IS NOT NULL
    )
  "')"

if ! grep -Eq '"criticalRelationsReady"[[:space:]]*:[[:space:]]*true' \
  <<<"$verification"; then
  printf '{"ok":false,"errorCode":"RESTORE_CONTRACT_INVALID","evidence":%s}\n' \
    "$verification" >&2
  exit 1
fi

readonly bytes="$(stat -c %s -- "$latest_backup")"
readonly sha256="$(sha256sum -- "$latest_backup" | cut -d' ' -f1)"
readonly completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
readonly report_tmp="$runtime_dir/latest.json.$$"
readonly report="$runtime_dir/latest.json"
printf '{"schemaVersion":1,"ok":true,"backup":"%s","bytes":%s,"sha256":"%s","completedAt":"%s","verification":%s}\n' \
  "$(basename -- "$latest_backup")" "$bytes" "$sha256" "$completed_at" "$verification" \
  >"$report_tmp"
chmod 0600 "$report_tmp"
mv -f -- "$report_tmp" "$report"
cat "$report"
