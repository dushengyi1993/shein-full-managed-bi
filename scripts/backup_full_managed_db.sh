#!/usr/bin/env bash
set -euo pipefail

backup_dir="${FULL_BI_BACKUP_DIR:-/srv/shein-fm/backups/db}"
case "$backup_dir" in
  /srv/shein-fm/backups|/srv/shein-fm/backups/*) ;;
  *) echo "Refusing backup path outside /srv/shein-fm/backups" >&2; exit 2 ;;
esac

install -d -m 0700 "$backup_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
tmp_file="$(mktemp "$backup_dir/.shein-fm-${stamp}.XXXXXX.dump")"
final_file="$backup_dir/shein-fm-${stamp}.dump"

cleanup() {
  if [[ -n "${tmp_file:-}" && -f "$tmp_file" ]]; then
    rm -f -- "$tmp_file"
  fi
}
trap cleanup EXIT

docker exec shein-fm-db sh -ceu \
  'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-privileges' \
  >"$tmp_file"
test -s "$tmp_file"
chmod 0600 "$tmp_file"
mv -- "$tmp_file" "$final_file"
tmp_file=""

find "$backup_dir" -maxdepth 1 -type f -name 'shein-fm-*.dump' -mtime +30 -delete
printf '{"ok":true,"backup":"%s","bytes":%s}\n' \
  "$final_file" "$(stat -c %s "$final_file")"
