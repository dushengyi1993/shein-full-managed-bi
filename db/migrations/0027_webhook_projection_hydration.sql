BEGIN;

ALTER TABLE ops.webhook_hydration_directive
    ADD COLUMN IF NOT EXISTS lease_owner text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
    ADD COLUMN IF NOT EXISTS last_error_code text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS last_error_message text NOT NULL DEFAULT '';

ALTER TABLE ops.webhook_hydration_directive
    DROP CONSTRAINT IF EXISTS ck_ops_webhook_hydration_lease,
    DROP CONSTRAINT IF EXISTS ck_ops_webhook_hydration_error;

ALTER TABLE ops.webhook_hydration_directive
    ADD CONSTRAINT ck_ops_webhook_hydration_lease CHECK (
        (state = 'RUNNING' AND btrim(lease_owner) <> '' AND lease_expires_at IS NOT NULL)
        OR (state <> 'RUNNING' AND lease_owner = '' AND lease_expires_at IS NULL)
    ),
    ADD CONSTRAINT ck_ops_webhook_hydration_error CHECK (
        length(last_error_code) <= 80
        AND length(last_error_message) <= 240
    );

CREATE INDEX IF NOT EXISTS ix_ops_webhook_hydration_lease
    ON ops.webhook_hydration_directive (lease_expires_at, hydration_directive_id)
    WHERE state = 'RUNNING';

GRANT SELECT, UPDATE ON ops.webhook_hydration_directive
TO sheinfm_supply_loader;

COMMIT;
