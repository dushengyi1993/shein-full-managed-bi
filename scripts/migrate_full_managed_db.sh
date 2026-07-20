#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
container_name="${SHEIN_FM_DB_CONTAINER:-shein-fm-db}"

docker inspect "$container_name" >/dev/null
docker exec "$container_name" sh -ceu '
  test -n "${POSTGRES_USER:-}"
  test -n "${POSTGRES_DB:-}"
  test -n "${SHEIN_FM_APP_DB_PASSWORD:-}"
  pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null
'

apply_sql() {
  local sql_file="$1"
  docker exec -i "$container_name" sh -ceu '
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
