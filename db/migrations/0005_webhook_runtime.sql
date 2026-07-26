BEGIN;

SELECT pg_advisory_xact_lock(hashtextextended('shein-fm-webhook-runtime-v1', 0));

CREATE TABLE IF NOT EXISTS raw.webhook_receipt (
    receipt_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    idempotency_key character(64) NOT NULL,
    app_key_hash character(64) NOT NULL,
    open_key_hash character(64),
    event_code text,
    event_path text,
    store_id bigint REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    delivery_scope text NOT NULL,
    platform_timestamp timestamptz NOT NULL,
    cipher_sha256 character(64) NOT NULL,
    ciphertext text NOT NULL,
    safe_projection jsonb NOT NULL DEFAULT '{}'::jsonb,
    duplicate_count integer NOT NULL DEFAULT 0,
    last_duplicate_at timestamptz,
    received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_raw_webhook_receipt_idempotency UNIQUE (idempotency_key),
    CONSTRAINT ck_raw_webhook_receipt_idempotency
        CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_raw_webhook_receipt_app_hash
        CHECK (app_key_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_raw_webhook_receipt_open_key_hash
        CHECK (open_key_hash IS NULL OR open_key_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_raw_webhook_receipt_event_identity
        CHECK (
            btrim(COALESCE(event_code, '')) <> ''
            OR btrim(COALESCE(event_path, '')) <> ''
        ),
    CONSTRAINT ck_raw_webhook_receipt_event_code
        CHECK (event_code IS NULL OR length(event_code) <= 40),
    CONSTRAINT ck_raw_webhook_receipt_event_path
        CHECK (
            event_path IS NULL
            OR (
                length(event_path) <= 180
                AND event_path ~ '^/[A-Za-z0-9_./-]+$'
            )
        ),
    CONSTRAINT ck_raw_webhook_receipt_delivery_scope
        CHECK (delivery_scope IN ('STORE', 'APP_ONLY')),
    CONSTRAINT ck_raw_webhook_receipt_store_scope
        CHECK (
            (delivery_scope = 'STORE' AND store_id IS NOT NULL)
            OR (delivery_scope = 'APP_ONLY' AND store_id IS NULL)
        ),
    CONSTRAINT ck_raw_webhook_receipt_cipher_hash
        CHECK (cipher_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_raw_webhook_receipt_ciphertext
        CHECK (
            length(ciphertext) BETWEEN 4 AND 2097152
            AND ciphertext ~ '^[A-Za-z0-9+/]+={0,2}$'
        ),
    CONSTRAINT ck_raw_webhook_receipt_safe_projection
        CHECK (
            jsonb_typeof(safe_projection) = 'object'
            AND octet_length(safe_projection::text) <= 4096
        ),
    CONSTRAINT ck_raw_webhook_receipt_duplicate_count
        CHECK (duplicate_count >= 0)
);

COMMENT ON TABLE raw.webhook_receipt IS
    'Durable full-managed webhook ingress evidence. Only AES ciphertext, hashes, routing identity, and a minimal non-decrypted projection are retained.';
COMMENT ON COLUMN raw.webhook_receipt.app_key_hash IS
    'SHA-256 of the application id. The application id itself is not persisted.';
COMMENT ON COLUMN raw.webhook_receipt.open_key_hash IS
    'SHA-256 of x-lt-openKeyId. Unknown app-level test OpenKeys are never assigned to a store.';
COMMENT ON COLUMN raw.webhook_receipt.ciphertext IS
    'Original canonical-base64 AES ciphertext. Decryption is restricted to a leased asynchronous worker.';
COMMENT ON COLUMN raw.webhook_receipt.safe_projection IS
    'Ingress-only registry metadata; decrypted webhook content is forbidden.';

CREATE INDEX IF NOT EXISTS ix_raw_webhook_receipt_store_received
    ON raw.webhook_receipt (store_id, received_at DESC, receipt_id DESC);
CREATE INDEX IF NOT EXISTS ix_raw_webhook_receipt_app_received
    ON raw.webhook_receipt (app_key_hash, received_at DESC, receipt_id DESC);
CREATE INDEX IF NOT EXISTS ix_raw_webhook_receipt_event_received
    ON raw.webhook_receipt (event_code, received_at DESC, receipt_id DESC);

CREATE OR REPLACE FUNCTION ops.guard_webhook_receipt_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.receipt_id IS DISTINCT FROM OLD.receipt_id
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.app_key_hash IS DISTINCT FROM OLD.app_key_hash
       OR NEW.open_key_hash IS DISTINCT FROM OLD.open_key_hash
       OR NEW.event_code IS DISTINCT FROM OLD.event_code
       OR NEW.event_path IS DISTINCT FROM OLD.event_path
       OR NEW.store_id IS DISTINCT FROM OLD.store_id
       OR NEW.delivery_scope IS DISTINCT FROM OLD.delivery_scope
       OR NEW.platform_timestamp IS DISTINCT FROM OLD.platform_timestamp
       OR NEW.cipher_sha256 IS DISTINCT FROM OLD.cipher_sha256
       OR NEW.ciphertext IS DISTINCT FROM OLD.ciphertext
       OR NEW.safe_projection IS DISTINCT FROM OLD.safe_projection
       OR NEW.received_at IS DISTINCT FROM OLD.received_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'webhook receipt immutable fields cannot be changed';
    END IF;
    IF NEW.duplicate_count < OLD.duplicate_count THEN
        RAISE EXCEPTION 'webhook receipt duplicate count cannot decrease';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_raw_webhook_receipt_immutable
    ON raw.webhook_receipt;
CREATE TRIGGER trg_raw_webhook_receipt_immutable
BEFORE UPDATE ON raw.webhook_receipt
FOR EACH ROW EXECUTE FUNCTION ops.guard_webhook_receipt_immutable();

CREATE TABLE IF NOT EXISTS ops.webhook_runtime_heartbeat (
    webhook_runtime_heartbeat_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    component_code text NOT NULL,
    instance_id text NOT NULL,
    status_code text NOT NULL,
    observed_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    event_fingerprint character(64) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_ops_webhook_runtime_heartbeat_fingerprint
        UNIQUE (event_fingerprint),
    CONSTRAINT ck_ops_webhook_runtime_heartbeat_component
        CHECK (component_code IN ('RECEIVER', 'WORKER')),
    CONSTRAINT ck_ops_webhook_runtime_heartbeat_instance
        CHECK (
            btrim(instance_id) <> ''
            AND length(instance_id) <= 160
            AND instance_id !~ '[[:cntrl:]]'
        ),
    CONSTRAINT ck_ops_webhook_runtime_heartbeat_status
        CHECK (status_code IN ('RUNNING', 'STOPPING')),
    CONSTRAINT ck_ops_webhook_runtime_heartbeat_expiry
        CHECK (
            expires_at > observed_at
            AND expires_at <= observed_at + interval '5 minutes'
        ),
    CONSTRAINT ck_ops_webhook_runtime_heartbeat_fingerprint
        CHECK (event_fingerprint ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE ops.webhook_runtime_heartbeat IS
    'Append-only receiver/worker liveness evidence. Schema presence and an empty queue are not runtime-health evidence.';

CREATE INDEX IF NOT EXISTS ix_ops_webhook_runtime_heartbeat_latest
    ON ops.webhook_runtime_heartbeat (
        component_code,
        observed_at DESC,
        webhook_runtime_heartbeat_id DESC
    );

CREATE OR REPLACE FUNCTION ops.reject_webhook_runtime_heartbeat_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'webhook runtime heartbeat is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_ops_webhook_runtime_heartbeat_append_only
    ON ops.webhook_runtime_heartbeat;
CREATE TRIGGER trg_ops_webhook_runtime_heartbeat_append_only
BEFORE UPDATE OR DELETE ON ops.webhook_runtime_heartbeat
FOR EACH ROW EXECUTE FUNCTION ops.reject_webhook_runtime_heartbeat_mutation();

CREATE TABLE IF NOT EXISTS ops.webhook_job (
    job_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    receipt_id bigint NOT NULL
        REFERENCES raw.webhook_receipt (receipt_id) ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'QUEUED',
    attempt_count integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL DEFAULT 8,
    available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    lease_owner text NOT NULL DEFAULT '',
    lease_expires_at timestamptz,
    last_error_code text NOT NULL DEFAULT '',
    last_error_message text NOT NULL DEFAULT '',
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_ops_webhook_job_receipt UNIQUE (receipt_id),
    CONSTRAINT ck_ops_webhook_job_status
        CHECK (
            status IN (
                'QUEUED', 'RUNNING', 'RETRY', 'SUCCEEDED',
                'QUARANTINED', 'DEAD_LETTER'
            )
        ),
    CONSTRAINT ck_ops_webhook_job_attempts
        CHECK (
            attempt_count >= 0
            AND max_attempts = 8
            AND attempt_count <= max_attempts
        ),
    CONSTRAINT ck_ops_webhook_job_lease
        CHECK (
            (
                status = 'RUNNING'
                AND btrim(lease_owner) <> ''
                AND lease_expires_at IS NOT NULL
            )
            OR (
                status <> 'RUNNING'
                AND lease_owner = ''
                AND lease_expires_at IS NULL
            )
        ),
    CONSTRAINT ck_ops_webhook_job_error_lengths
        CHECK (
            length(last_error_code) <= 80
            AND length(last_error_message) <= 300
        ),
    CONSTRAINT ck_ops_webhook_job_completed
        CHECK (
            (
                status IN ('SUCCEEDED', 'QUARANTINED', 'DEAD_LETTER')
                AND completed_at IS NOT NULL
            )
            OR (
                status IN ('QUEUED', 'RUNNING', 'RETRY')
                AND completed_at IS NULL
            )
        )
);

CREATE INDEX IF NOT EXISTS ix_ops_webhook_job_ready
    ON ops.webhook_job (available_at, job_id)
    WHERE status IN ('QUEUED', 'RETRY');
CREATE INDEX IF NOT EXISTS ix_ops_webhook_job_expired_lease
    ON ops.webhook_job (lease_expires_at, job_id)
    WHERE status = 'RUNNING';
CREATE INDEX IF NOT EXISTS ix_ops_webhook_job_dead_letter
    ON ops.webhook_job (updated_at DESC, job_id DESC)
    WHERE status = 'DEAD_LETTER';

CREATE TABLE IF NOT EXISTS ops.operational_event (
    operational_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    receipt_id bigint NOT NULL
        REFERENCES raw.webhook_receipt (receipt_id) ON DELETE RESTRICT,
    store_id bigint REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    event_code text,
    event_path text,
    event_family text NOT NULL,
    business_type text NOT NULL,
    business_key text,
    occurred_at timestamptz,
    action text NOT NULL,
    platform_status text,
    severity text NOT NULL,
    delivery_scope text NOT NULL,
    safe_projection jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_ops_operational_event_receipt UNIQUE (receipt_id),
    CONSTRAINT ck_ops_operational_event_family
        CHECK (btrim(event_family) <> '' AND length(event_family) <= 80),
    CONSTRAINT ck_ops_operational_event_business_type
        CHECK (btrim(business_type) <> '' AND length(business_type) <= 80),
    CONSTRAINT ck_ops_operational_event_action
        CHECK (btrim(action) <> '' AND length(action) <= 80),
    CONSTRAINT ck_ops_operational_event_status
        CHECK (platform_status IS NULL OR length(platform_status) <= 80),
    CONSTRAINT ck_ops_operational_event_severity
        CHECK (severity IN ('P0', 'P1', 'P2', 'P3')),
    CONSTRAINT ck_ops_operational_event_scope
        CHECK (
            delivery_scope IN ('STORE', 'APP_ONLY')
            AND (
                (delivery_scope = 'STORE' AND store_id IS NOT NULL)
                OR (delivery_scope = 'APP_ONLY' AND store_id IS NULL)
            )
        ),
    CONSTRAINT ck_ops_operational_event_safe_projection
        CHECK (
            jsonb_typeof(safe_projection) = 'object'
            AND octet_length(safe_projection::text) <= 32768
        )
);

COMMENT ON TABLE ops.operational_event IS
    'Whitelisted, normalized full-managed platform activity. Raw decrypted webhook bodies are forbidden.';

CREATE INDEX IF NOT EXISTS ix_ops_operational_event_store_created
    ON ops.operational_event (store_id, created_at DESC, operational_event_id DESC);
CREATE INDEX IF NOT EXISTS ix_ops_operational_event_family_created
    ON ops.operational_event (event_family, created_at DESC, operational_event_id DESC);
CREATE INDEX IF NOT EXISTS ix_ops_operational_event_business
    ON ops.operational_event (store_id, business_type, business_key, created_at DESC)
    WHERE business_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS ops.webhook_hydration_directive (
    hydration_directive_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    operational_event_id bigint NOT NULL
        REFERENCES ops.operational_event (operational_event_id) ON DELETE RESTRICT,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    directive_type text NOT NULL,
    capability_code text NOT NULL,
    lookup_projection jsonb NOT NULL DEFAULT '{}'::jsonb,
    state text NOT NULL DEFAULT 'PENDING',
    attempt_count integer NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_ops_webhook_hydration_event UNIQUE (operational_event_id),
    CONSTRAINT ck_ops_webhook_hydration_type
        CHECK (btrim(directive_type) <> '' AND length(directive_type) <= 100),
    CONSTRAINT ck_ops_webhook_hydration_capability
        CHECK (btrim(capability_code) <> '' AND length(capability_code) <= 100),
    CONSTRAINT ck_ops_webhook_hydration_lookup
        CHECK (
            jsonb_typeof(lookup_projection) = 'object'
            AND octet_length(lookup_projection::text) <= 4096
        ),
    CONSTRAINT ck_ops_webhook_hydration_state
        CHECK (state IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'RETRY', 'FAILED')),
    CONSTRAINT ck_ops_webhook_hydration_attempts
        CHECK (attempt_count >= 0)
);

COMMENT ON TABLE ops.webhook_hydration_directive IS
    'Read-only follow-up instructions emitted by the webhook worker. This runtime never executes OpenAPI calls itself.';

CREATE INDEX IF NOT EXISTS ix_ops_webhook_hydration_pending
    ON ops.webhook_hydration_directive (available_at, hydration_directive_id)
    WHERE state IN ('PENDING', 'RETRY');

CREATE TABLE IF NOT EXISTS ops.webhook_subscription_state (
    webhook_subscription_state_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    app_key_hash character(64) NOT NULL,
    event_code text NOT NULL,
    desired_state text NOT NULL,
    observed_state text NOT NULL,
    callback_validated boolean NOT NULL DEFAULT false,
    checked_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_ops_webhook_subscription_app_event
        UNIQUE (app_key_hash, event_code),
    CONSTRAINT ck_ops_webhook_subscription_app_hash
        CHECK (app_key_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_ops_webhook_subscription_event_code
        CHECK (event_code ~ '^\d{7}$'),
    CONSTRAINT ck_ops_webhook_subscription_desired
        CHECK (desired_state IN ('ACTIVE', 'PAUSED')),
    CONSTRAINT ck_ops_webhook_subscription_observed
        CHECK (observed_state IN ('UNKNOWN', 'REQUESTED', 'ACTIVE', 'PAUSED', 'REJECTED'))
);

CREATE TABLE IF NOT EXISTS ops.webhook_store_gate (
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    gate_key text NOT NULL,
    state text NOT NULL,
    reason_code text NOT NULL DEFAULT '',
    source_operational_event_id bigint
        REFERENCES ops.operational_event (operational_event_id) ON DELETE RESTRICT,
    blocked_at timestamptz,
    reopened_at timestamptz,
    last_probe_id bigint REFERENCES ops.permission_probe (permission_probe_id) ON DELETE RESTRICT,
    recovery_requires_probe boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT pk_ops_webhook_store_gate PRIMARY KEY (store_id, gate_key),
    CONSTRAINT ck_ops_webhook_store_gate_key
        CHECK (gate_key IN ('AUTHORIZATION')),
    CONSTRAINT ck_ops_webhook_store_gate_state
        CHECK (state IN ('OPEN', 'BLOCKED')),
    CONSTRAINT ck_ops_webhook_store_gate_reason
        CHECK (length(reason_code) <= 120),
    CONSTRAINT ck_ops_webhook_store_gate_times
        CHECK (
            (
                state = 'BLOCKED'
                AND blocked_at IS NOT NULL
                AND reopened_at IS NULL
                AND recovery_requires_probe = true
            )
            OR (
                state = 'OPEN'
                AND reopened_at IS NOT NULL
                AND last_probe_id IS NOT NULL
            )
        )
);

COMMENT ON TABLE ops.webhook_store_gate IS
    'Fail-closed store safety gate. Authorization-change recovery requires a newer successful read-only permission probe.';

CREATE INDEX IF NOT EXISTS ix_ops_webhook_store_gate_blocked
    ON ops.webhook_store_gate (updated_at DESC, store_id)
    WHERE state = 'BLOCKED';

CREATE OR REPLACE FUNCTION ops.guard_webhook_store_gate_recovery()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    probe_at timestamptz;
BEGIN
    IF TG_OP = 'INSERT' AND NEW.state = 'OPEN' THEN
        RAISE EXCEPTION 'an authorization gate must first be created in BLOCKED state';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.state = 'BLOCKED' AND NEW.state = 'OPEN' THEN
        SELECT probe.probed_at
          INTO probe_at
          FROM ops.permission_probe AS probe
         WHERE probe.permission_probe_id = NEW.last_probe_id
           AND probe.store_id = OLD.store_id
           AND probe.outcome = 'GRANTED'
           AND probe.capability_code = 'FULL_MANAGED_SKU_SALES'
           AND probe.probed_at > OLD.blocked_at;
        IF probe_at IS NULL
           OR NEW.reopened_at IS DISTINCT FROM probe_at
           OR NEW.recovery_requires_probe THEN
            RAISE EXCEPTION 'a newer successful read-only authorization probe is required';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ops_webhook_store_gate_recovery
    ON ops.webhook_store_gate;
CREATE TRIGGER trg_ops_webhook_store_gate_recovery
BEFORE INSERT OR UPDATE ON ops.webhook_store_gate
FOR EACH ROW EXECUTE FUNCTION ops.guard_webhook_store_gate_recovery();

CREATE OR REPLACE FUNCTION ops.reopen_webhook_authorization_gate_after_probe(
    p_store_code text,
    p_permission_probe_id bigint
)
RETURNS TABLE (
    store_code text,
    gate_key text,
    state text,
    last_probe_id bigint,
    reopened_at timestamptz,
    applied boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops, dim
AS $$
DECLARE
    target_store_id bigint;
    gate_blocked_at timestamptz;
    probe_at timestamptz;
BEGIN
    SELECT store.store_id
      INTO target_store_id
      FROM dim.store AS store
     WHERE store.store_code = upper(btrim(p_store_code))
       AND store.is_active = true;
    IF target_store_id IS NULL THEN
        RAISE EXCEPTION 'active store was not found';
    END IF;

    SELECT gate.blocked_at
      INTO gate_blocked_at
      FROM ops.webhook_store_gate AS gate
     WHERE gate.store_id = target_store_id
       AND gate.gate_key = 'AUTHORIZATION'
       AND gate.state = 'BLOCKED'
     FOR UPDATE;
    IF gate_blocked_at IS NULL THEN
        RETURN QUERY
        SELECT upper(btrim(p_store_code)), 'AUTHORIZATION'::text, 'OPEN'::text,
               NULL::bigint, NULL::timestamptz, false;
        RETURN;
    END IF;

    SELECT probe.probed_at
      INTO probe_at
      FROM ops.permission_probe AS probe
     WHERE probe.permission_probe_id = p_permission_probe_id
       AND probe.store_id = target_store_id
       AND probe.outcome = 'GRANTED'
       AND probe.capability_code = 'FULL_MANAGED_SKU_SALES'
       AND probe.probed_at > gate_blocked_at;
    IF probe_at IS NULL THEN
        RAISE EXCEPTION 'a newer successful read-only authorization probe is required';
    END IF;

    RETURN QUERY
    UPDATE ops.webhook_store_gate AS gate
       SET state = 'OPEN',
           reason_code = 'READ_ONLY_PROBE_CONFIRMED',
           last_probe_id = p_permission_probe_id,
           reopened_at = probe_at,
           recovery_requires_probe = false,
           updated_at = clock_timestamp()
     WHERE gate.store_id = target_store_id
       AND gate.gate_key = 'AUTHORIZATION'
       AND gate.state = 'BLOCKED'
    RETURNING upper(btrim(p_store_code)), gate.gate_key, gate.state,
              gate.last_probe_id, gate.reopened_at, true;
END;
$$;

REVOKE ALL ON FUNCTION
    ops.reopen_webhook_authorization_gate_after_probe(text, bigint)
FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_ops_webhook_job_touch_updated_at
    ON ops.webhook_job;
CREATE TRIGGER trg_ops_webhook_job_touch_updated_at
BEFORE UPDATE ON ops.webhook_job
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_ops_operational_event_touch_updated_at
    ON ops.operational_event;
CREATE TRIGGER trg_ops_operational_event_touch_updated_at
BEFORE UPDATE ON ops.operational_event
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_ops_webhook_hydration_touch_updated_at
    ON ops.webhook_hydration_directive;
CREATE TRIGGER trg_ops_webhook_hydration_touch_updated_at
BEFORE UPDATE ON ops.webhook_hydration_directive
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_ops_webhook_subscription_touch_updated_at
    ON ops.webhook_subscription_state;
CREATE TRIGGER trg_ops_webhook_subscription_touch_updated_at
BEFORE UPDATE ON ops.webhook_subscription_state
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_ops_webhook_store_gate_touch_updated_at
    ON ops.webhook_store_gate;
CREATE TRIGGER trg_ops_webhook_store_gate_touch_updated_at
BEFORE UPDATE ON ops.webhook_store_gate
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_app') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE ON raw.webhook_receipt TO sheinfm_app';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE ON
            ops.webhook_job,
            ops.operational_event,
            ops.webhook_hydration_directive,
            ops.webhook_subscription_state,
            ops.webhook_store_gate
            TO sheinfm_app';
        EXECUTE 'GRANT SELECT, INSERT ON
            ops.webhook_runtime_heartbeat
            TO sheinfm_app';
        EXECUTE 'GRANT EXECUTE ON FUNCTION
            ops.reopen_webhook_authorization_gate_after_probe(text, bigint)
            TO sheinfm_app';
        EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA raw, ops TO sheinfm_app';
    END IF;
END;
$$;

COMMIT;
