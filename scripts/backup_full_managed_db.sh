#!/usr/bin/env bash
set -euo pipefail

# Full-managed PostgreSQL backup.
#
#   --mode daily   at most one successful backup per Shanghai business day
#   --mode deploy  explicit high-risk data/schema change backup only
#
# A host lock serializes every mode, so a high-risk migration cannot race the
# timer. After a successful dump the local cloud-disk retention tool keeps a
# bounded daily/weekly/deploy union. No normal backup is copied to COS.

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
deploy_local_max="${FULL_BI_DEPLOY_BACKUP_MAX:-1}"
retain_daily="${FULL_BI_BACKUP_RETAIN_DAILY:-2}"
retain_weekly="${FULL_BI_BACKUP_RETAIN_WEEKLY:-4}"
retain_deploy="${FULL_BI_BACKUP_RETAIN_DEPLOY:-1}"
now_epoch="$(date -u +%s)"
today_shanghai="$(TZ=Asia/Shanghai date +%Y%m%d)"

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
  while IFS= read -r -d '' existing_daily; do
    existing_epoch="$(stat -c %Y -- "$existing_daily")"
    existing_day="$(TZ=Asia/Shanghai date -d "@${existing_epoch}" +%Y%m%d)"
    if [[ "$existing_day" == "$today_shanghai" ]]; then
      printf '{"ok":true,"skipped":"daily backup already exists for Shanghai day %s"}\n' \
        "$today_shanghai"
      exit 0
    fi
  done < <(find "$backup_dir" -maxdepth 1 -type f -name 'shein-fm-daily-*.dump' -print0)
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
# A non-empty file is not enough: prove PostgreSQL can parse the complete custom
# archive before it is promoted into the retention set.
docker exec -i shein-fm-db pg_restore --list <"$tmp_file" >/dev/null

# Deduplicate by content: an identical dump is discarded instead of stored twice.
new_sha="$(sha256sum -- "$tmp_file" | cut -d' ' -f1)"
duplicate_of=""
while IFS= read -r -d '' existing; do
  if [[ "$(stat -c %s -- "$existing")" != "$(stat -c %s -- "$tmp_file")" ]]; then
    continue
  fi
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

# Report when local deployment dumps exceed the bound; local retention below
# performs the actual reclaim.
if [[ "$mode" == deploy ]]; then
  deploy_count="$(find "$backup_dir" -maxdepth 1 -type f \
    -name 'shein-fm-deploy-*.dump' -printf 'x' | wc -c)"
  if (( deploy_count > deploy_local_max )); then
    printf 'deploy backup count %s exceeds %s; local retention will reclaim\n' \
      "$deploy_count" "$deploy_local_max" >&2
  fi
fi

# Apply bounded local retention on the mounted cloud data disk. The tool keeps
# the final recoverable backup even if its configured counts were ever invalid.
retention_status="skipped"
if [[ "${FULL_BI_SKIP_BACKUP_RETENTION:-0}" != "1" ]]; then
  /usr/bin/node "$project_root/scripts/prune_full_managed_backups.mjs" \
    --apply \
    --retain-daily="$retain_daily" \
    --retain-weekly="$retain_weekly" \
    --retain-deploy="$retain_deploy" >&2
  retention_status="applied"
fi

printf '{"ok":true,"mode":"%s","backup":"%s","bytes":%s,"sha256":"%s","retention":"%s"}\n' \
  "$mode" "$final_file" "$(stat -c %s -- "$final_file")" "$new_sha" "$retention_status"
