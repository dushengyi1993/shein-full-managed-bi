# Full-managed BI database

This directory owns the PostgreSQL contract for the local-first SHEIN full-managed BI.

## Apply

Run migrations in lexical order with `ON_ERROR_STOP` enabled:

```powershell
psql $env:FULL_BI_DATABASE_URL -v ON_ERROR_STOP=1 -f .\db\migrations\0001_full_managed_bi.sql
```

The initial migration is transaction-wrapped and safe to rerun against the same completed schema. Schema evolution must use a new numbered migration; editing an already-deployed migration is not an upgrade strategy.

## Verify

```powershell
psql $env:FULL_BI_DATABASE_URL -v ON_ERROR_STOP=1 -f .\db\verify\0001_schema_contract.sql
```

The database URL is never committed. Migrations and verification scripts contain no shop credentials, OpenAPI tokens, cookies, or signatures.
