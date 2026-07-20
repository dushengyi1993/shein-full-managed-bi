# Full-managed BI database

This directory owns the PostgreSQL contract for the isolated SHEIN full-managed BI warehouse.

## Apply

Run migrations in lexical order with `ON_ERROR_STOP` enabled:

```powershell
psql $env:FULL_BI_DATABASE_URL -v ON_ERROR_STOP=1 -f .\db\migrations\0001_full_managed_bi.sql
```

The initial migration is transaction-wrapped and safe to rerun against the same completed schema. Schema evolution must use a new numbered migration; editing an already-deployed migration is not an upgrade strategy.

On the cloud host, the versioned migration runner applies every migration and
verification file through the database-owner container account:

```bash
sudo bash scripts/migrate_full_managed_db.sh
```

`0002_runtime_role.sql` creates the non-superuser `sheinfm_app` login used by
the ingestion and materialization services. Its password is read inside the
PostgreSQL container from `SHEIN_FM_APP_DB_PASSWORD`; it is never embedded in a
migration, process argument, or repository file.

## Verify

```powershell
psql $env:FULL_BI_DATABASE_URL -v ON_ERROR_STOP=1 -f .\db\verify\0001_schema_contract.sql
```

The database URL is never committed. Migrations and verification scripts contain no shop credentials, OpenAPI tokens, cookies, or signatures.
