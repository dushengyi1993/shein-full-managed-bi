DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'ops'
           AND table_name = 'webhook_hydration_directive'
           AND column_name IN (
               'lease_owner', 'lease_expires_at',
               'last_error_code', 'last_error_message'
           )
         GROUP BY table_schema, table_name
        HAVING count(*) = 4
    ) THEN
        RAISE EXCEPTION 'webhook hydration lease/error columns are incomplete';
    END IF;
    IF NOT has_table_privilege(
        'sheinfm_supply_loader',
        'ops.webhook_hydration_directive',
        'SELECT,UPDATE'
    ) THEN
        RAISE EXCEPTION 'supply loader cannot claim webhook hydration directives';
    END IF;
END
$$;
