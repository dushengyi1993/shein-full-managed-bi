#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
container_name="${SHEIN_FM_DB_CONTAINER:-shein-fm-db}"
runtime_secret_names=(
  SHEIN_FM_APP_DB_PASSWORD
  SHEIN_FM_MATERIALIZER_DB_PASSWORD
  SHEIN_FM_SALES_DB_PASSWORD
  SHEIN_FM_SUPPLY_DB_PASSWORD
  SHEIN_FM_WEBHOOK_INGRESS_DB_PASSWORD
  SHEIN_FM_WEBHOOK_WORKER_DB_PASSWORD
  SHEIN_FM_WEBAPI_LOGIN_DB_PASSWORD
)
docker_secret_env_args=()

for secret_name in "${runtime_secret_names[@]}"; do
  secret_value="${!secret_name:-}"
  if (( ${#secret_value} < 24 )); then
    printf 'required migration secret is missing or too short: %s\n' \
      "$secret_name" >&2
    exit 1
  fi
  docker_secret_env_args+=(--env "$secret_name")
  unset secret_value
done

docker inspect "$container_name" >/dev/null
docker exec "$container_name" sh -ceu '
  test -n "${POSTGRES_USER:-}"
  test -n "${POSTGRES_DB:-}"
  pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null
'

apply_sql() {
  local sql_file="$1"
  docker exec -i "${docker_secret_env_args[@]}" "$container_name" sh -ceu '
    exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"
  ' <"$sql_file"
  printf 'applied %s\n' "$(basename "$sql_file")"
}

migration_is_superseded() {
  local migration_name
  migration_name="$(basename "$1")"
  case "$migration_name" in
    0017_full_home_all_store_scope.sql)
      # 0018 extends the same constraints from 24 to 25 stores. Replaying 0017
      # after NM7418 facts exist would temporarily narrow the constraint and
      # fail before 0018 can restore the current roster. Existing migrations
      # remain immutable; the runner explicitly skips only this proven
      # superseded transition once either the current constraint or current
      # evidence proves that 0018 has already taken effect.
      docker exec "$container_name" sh -ceu '
        exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "
          SELECT CASE WHEN
            EXISTS (
              SELECT 1
              FROM pg_constraint
              WHERE conrelid = '\''raw.webapi_home_fetch_audit'\''::regclass
                AND conname = '\''ck_raw_webapi_home_fetch_store'\''
                AND pg_get_constraintdef(oid) LIKE '\''%NM7418%'\''
            )
            OR EXISTS (
              SELECT 1
              FROM raw.webapi_home_fetch_audit
              WHERE store_code = '\''NM7418'\''
            )
          THEN 1 ELSE 0 END
        "
      ' | grep -qx 1
      ;;
    0020_full_home_webapi_audit_contract.sql)
      # 0021 widens the same append-only endpoint constraint with UPDATE_TIME
      # and PRODUCT_DIAGNOSE_LIST. Replaying 0020 after either endpoint has
      # been recorded would temporarily narrow the vocabulary and fail before
      # 0021 can restore it. Preserve both immutable migrations and skip only
      # when the live constraint proves that 0021 already took effect.
      docker exec "$container_name" sh -ceu '
        exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "
          SELECT CASE WHEN EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid = '\''raw.webapi_home_fetch_audit'\''::regclass
              AND conname = '\''ck_raw_webapi_home_fetch_endpoint'\''
              AND pg_get_constraintdef(oid) LIKE '\''%UPDATE_TIME%'\''
              AND pg_get_constraintdef(oid) LIKE '\''%PRODUCT_DIAGNOSE_LIST%'\''
          ) THEN 1 ELSE 0 END
        "
      ' | grep -qx 1
      ;;
    0021_full_home_current_webapi_contract.sql)
      # 0024 widens the same constraint again with STORE_REALTIME_SUMMARY.
      # Replaying 0021 against live summary audit rows would temporarily remove
      # that endpoint and fail before 0024 can restore it.
      docker exec "$container_name" sh -ceu '
        exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "
          SELECT CASE WHEN EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid = '\''raw.webapi_home_fetch_audit'\''::regclass
              AND conname = '\''ck_raw_webapi_home_fetch_endpoint'\''
              AND pg_get_constraintdef(oid) LIKE '\''%STORE_REALTIME_SUMMARY%'\''
          ) THEN 1 ELSE 0 END
        "
      ' | grep -qx 1
      ;;
    *)
      return 1
      ;;
  esac
}

for sql_file in "$project_root"/db/migrations/*.sql; do
  if migration_is_superseded "$sql_file"; then
    printf 'skipped superseded %s\n' "$(basename "$sql_file")"
    continue
  fi
  apply_sql "$sql_file"
done

for sql_file in "$project_root"/db/verify/*.sql; do
  apply_sql "$sql_file"
done

printf '{"ok":true,"database":"schema-and-runtime-role-verified"}\n'
