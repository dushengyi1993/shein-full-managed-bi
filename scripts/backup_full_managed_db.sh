#!/usr/bin/env bash
set -euo pipefail

# Full-managed PostgreSQL backup.
#
#   --mode daily   at most one successful backup per UTC day (systemd timer)
#   --mode deploy  deployment backup, 2h cooldown and a bounded local count
#
# A host lock serializes every mode, so a deployment cannot race the timer. After
# a successful non-duplicate dump the retention/archive tool runs in apply mode;
# if the COS archive is unavailable it fails closed and no local dump is removed.
# Retention days are UTC natural days, matching the archive tool.

mode=""
while (( $# > 0 )); do
  case "$1" in
    --mode)
      mode="${2:-}"
      shift 2
      ;;
    --mode=*)
      mode="${1#--mode=}"
      shift
      ;;
    *)
      printf 'unsupported argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

case "$mode" in
  daily|deploy) ;;
  *) printf 'usage: backup_full_managed_db.sh --mode daily|deploy\n' >&2; exit 2 ;;
esac

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backup_dir="${FULL_BI_BACKUP_DIR:-/srv/shein-fm/backups/db}"
case "$backup_dir" in
  /srv/shein-fm/backups|/srv/shein-fm/backups/*) ;;
  *) echo "Refusing backup path outside /srv/shein-fm/backups" >&2; exit 2 ;;
esac

runtime_dir="${FULL_BI_RUNTIME_DIR:-/srv/shein-fm/runtime}"
case "$runtime_dir" in
  /srv/shein-fm/runtime|/srv/shein-fm/runtime/*) ;;
  *) echo "Refusing runtime path outside /srv/shein-fm/runtime" >&2; exit 2 ;;
esac

install -d -m 0700 "$backup_dir"
install -d -m 0755 "$runtime_dir"

# Serialize every backup mode on one host lock.
lock_file="$runtime_dir/db-backup.lock"
exec 9>"$lock_file"
if ! flock -n 9; then
  printf '{"ok":true,"skipped":"another backup holds the lock","mode":"%s"}\n' "$mode"
  exit 0
fi

deploy_cooldown_seconds="${FULL_BI_DEPLOY_BACKUP_COOLDOWN_SECONDS:-7200}"
deploy_local_max="${FULL_BI_DEPLOY_BACKUP_MAX:-3}"
retain_days="${FULL_BI_BACKUP_RETAIN_DAYS:-3}"
retain_extra="${FULL_BI_BACKUP_RETAIN_EXTRA:-2}"
now_epoch="$(date -u +%s)"
today_utc="$(date -u +%Y%m%d)"

newest_epoch_for() {
  # Newest mtime among dumps matching a glob, or 0 when none exist.
  local pattern="$1"
  local newest=0
  local candidate
  local mtime
  while IFS= read -r -d '' candidate; do
    mtime="$(stat -c %Y -- "$candidate")"
    if (( mtime > newest )); then newest="$mtime"; fi
  done < <(find "$backup_dir" -maxdepth 1 -type f -name "$pattern" -print0)
  printf '%s' "$newest"
}

if [[ "$mode" == daily ]]; then
  if compgen -G "$backup_dir/shein-fm-daily-${today_utc}T*.dump" >/dev/null; then
    printf '{"ok":true,"skipped":"daily backup already exists for %s"}\n' "$today_utc"
    exit 0
  fi
else
  last_deploy="$(newest_epoch_for 'shein-fm-deploy-*.dump')"
  if (( last_deploy > 0 )) \
    && (( now_epoch - last_deploy < deploy_cooldown_seconds )); then
    printf '{"ok":true,"skipped":"deploy backup cooldown active","cooldownSeconds":%s}\n' \
      "$deploy_cooldown_seconds"
    exit 0
  fi
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
tmp_file="$(mktemp "$backup_dir/.shein-fm-${stamp}.XXXXXX.dump")"
final_file="$backup_dir/shein-fm-${mode}-${stamp}.dump"

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

# Deduplicate by content: an identical dump is discarded instead of stored twice.
new_sha="$(sha256sum -- "$tmp_file" | cut -d' ' -f1)"
duplicate_of=""
while IFS= read -r -d '' existing; do
  if [[ "$(sha256sum -- "$existing" | cut -d' ' -f1)" == "$new_sha" ]]; then
    duplicate_of="$existing"
    break
  fi
done < <(find "$backup_dir" -maxdepth 1 -type f -name 'shein-fm-*.dump' -print0)

if [[ -n "$duplicate_of" ]]; then
  rm -f -- "$tmp_file"
  tmp_file=""
  printf '{"ok":true,"skipped":"identical dump already present","duplicateOf":"%s"}\n' \
    "$(basename -- "$duplicate_of")"
  exit 0
fi

mv -- "$tmp_file" "$final_file"
tmp_file=""

# Report when local deployment dumps exceed the bound; the archive tool below
# performs the actual verified reclaim.
if [[ "$mode" == deploy ]]; then
  deploy_count="$(find "$backup_dir" -maxdepth 1 -type f \
    -name 'shein-fm-deploy-*.dump' -printf 'x' | wc -c)"
  if (( deploy_count > deploy_local_max )); then
    printf 'deploy backup count %s exceeds %s; archive tool will reclaim\n' \
      "$deploy_count" "$deploy_local_max" >&2
  fi
fi

# Archive expired dumps to COS and delete locally only after verification. A COS
# failure exits non-zero here, leaving every local dump in place.
archive_status="skipped"
if [[ "${FULL_BI_SKIP_BACKUP_ARCHIVE:-0}" != "1" ]]; then
  node "$project_root/scripts/archive_full_managed_backups.mjs" \
    --apply \
    --retain-days="$retain_days" \
    --retain-extra="$retain_extra" >&2
  archive_status="applied"
fi

printf '{"ok":true,"mode":"%s","backup":"%s","bytes":%s,"sha256":"%s","archive":"%s"}\n' \
  "$mode" "$final_file" "$(stat -c %s -- "$final_file")" "$new_sha" "$archive_status"
