DO $$
DECLARE
    expected_relation text;
    expected_relations constant text[] := ARRAY[
        'raw.webhook_receipt',
        'ops.webhook_runtime_heartbeat',
        'ops.webhook_job',
        'ops.operational_event',
        'ops.webhook_hydration_directive',
        'ops.webhook_subscription_state',
        'ops.webhook_store_gate'
    ];
BEGIN
    FOREACH expected_relation IN ARRAY expected_relations LOOP
        IF to_regclass(expected_relation) IS NULL THEN
            RAISE EXCEPTION 'Missing required relation: %', expected_relation;
        END IF;
    END LOOP;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_trigger
         WHERE tgname = 'trg_raw_webhook_receipt_immutable'
           AND tgrelid = 'raw.webhook_receipt'::regclass
           AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION 'Webhook receipt immutable-field guard is missing';
    END IF;

    IF to_regclass('ops.ix_ops_webhook_job_ready') IS NULL THEN
        RAISE EXCEPTION 'Webhook SKIP LOCKED ready-queue index is missing';
    END IF;

    IF to_regclass('ops.ix_ops_webhook_runtime_heartbeat_latest') IS NULL THEN
        RAISE EXCEPTION 'Webhook runtime heartbeat latest index is missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_trigger
         WHERE tgname = 'trg_ops_webhook_runtime_heartbeat_append_only'
           AND tgrelid = 'ops.webhook_runtime_heartbeat'::regclass
           AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION 'Webhook runtime heartbeat append-only guard is missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'uq_ops_webhook_job_receipt'
           AND conrelid = 'ops.webhook_job'::regclass
    ) THEN
        RAISE EXCEPTION 'Receipt-to-job uniqueness is missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_proc
         WHERE pronamespace = 'ops'::regnamespace
           AND proname = 'reopen_webhook_authorization_gate_after_probe'
    ) THEN
        RAISE EXCEPTION 'Probe-gated authorization recovery function is missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_trigger
         WHERE tgname = 'trg_ops_webhook_store_gate_recovery'
           AND tgrelid = 'ops.webhook_store_gate'::regclass
           AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION 'Authorization gate recovery trigger is missing';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM pg_proc AS proc
          CROSS JOIN LATERAL aclexplode(
              COALESCE(proc.proacl, acldefault('f', proc.proowner))
          ) AS privilege
         WHERE proc.pronamespace = 'ops'::regnamespace
           AND proc.proname = 'reopen_webhook_authorization_gate_after_probe'
           AND privilege.grantee = 0
           AND privilege.privilege_type = 'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'Authorization gate recovery function is executable by PUBLIC';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'raw'
           AND table_name = 'webhook_receipt'
           AND column_name IN (
               'app_id', 'open_key_id', 'secret_key', 'token',
               'decrypted_payload', 'plaintext', 'event_data_json'
           )
    ) THEN
        RAISE EXCEPTION 'Webhook receipt exposes a forbidden credential or plaintext column';
    END IF;
END;
$$;

SELECT 'full-managed webhook runtime contract OK' AS result;
