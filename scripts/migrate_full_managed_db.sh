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

for sql_file in "$project_root"/db/migrations/*.sql; do
  apply_sql "$sql_file"
done

for sql_file in "$project_root"/db/verify/*.sql; do
  apply_sql "$sql_file"
done

printf '{"ok":true,"database":"schema-and-runtime-role-verified"}\n'
