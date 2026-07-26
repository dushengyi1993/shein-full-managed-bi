# Full-managed BI database

This directory owns the PostgreSQL contract for the isolated SHEIN full-managed BI warehouse.

## Apply

Run every migration in lexical order with `ON_ERROR_STOP` enabled, then run every verification file:

```powershell
Get-ChildItem .\db\migrations\*.sql | Sort-Object Name | ForEach-Object {
  psql $env:FULL_BI_DATABASE_URL -X -v ON_ERROR_STOP=1 -f $_.FullName
}
Get-ChildItem .\db\verify\*.sql | Sort-Object Name | ForEach-Object {
  psql $env:FULL_BI_DATABASE_URL -X -v ON_ERROR_STOP=1 -f $_.FullName
}
```

The initial migration is transaction-wrapped and safe to rerun against the same completed schema. Schema evolution must use a new numbered migration; editing an already-deployed migration is not an upgrade strategy.

On the cloud host, the versioned migration runner applies every migration and
verification file through the database-owner container account:

```bash
sudo bash scripts/migrate_full_managed_db.sh
```

The migration chain is:

- `0001`: base raw/dim/fact/mart/ops warehouse;
- `0002`: legacy `sheinfm_app` bootstrap;
- `0003`: trusted sales runs, business-date watermarks and legal-zero semantics;
- `0004`: canonical product identity and employee-store assignments;
- `0005`: Webhook receipts, jobs, safe events, gates and runtime heartbeats;
- `0006`: products, inventory, shortage, purchase, delivery and supply attempt evidence;
- `9999`: final runtime-role reconciliation and least-privilege grants.

`0002` reads `SHEIN_FM_APP_DB_PASSWORD`. During the first split-role production
rollout this must be the current production value; do not rotate the legacy
login before the new services have cut over. `9999` reads five new independent
runtime LOGIN passwords. The root migration runner receives them from
`/srv/shein-fm/secrets/db-migrate/runtime-role-passwords.env` and passes only
environment variable names through `docker exec`, never values in arguments.

Portal has no database role. Materializer, sales, supply, Webhook ingress and
Webhook worker each inherit exactly one NOLOGIN capability group.

## Verify

Production must first run the complete migration and verification chain twice
against an explicit temporary database on the same PostgreSQL version. Only
after role allow/deny probes pass may the chain run on production.

The database URL is never committed. Migrations and verification scripts contain no shop credentials, OpenAPI tokens, cookies, or signatures.
