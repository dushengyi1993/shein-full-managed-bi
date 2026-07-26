BEGIN;

ALTER TABLE dim.full_sku
    ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS catalog_run_key text,
    ADD COLUMN IF NOT EXISTS retired_at timestamptz;

CREATE INDEX IF NOT EXISTS ix_dim_full_sku_store_catalog_membership
    ON dim.full_sku (store_id, is_active, platform_sku_id);

COMMENT ON COLUMN dim.full_sku.is_active IS
    'True only when the SKU belongs to the latest complete stable number-list sweep for its store.';
COMMENT ON COLUMN dim.full_sku.catalog_run_key IS
    'Run key of the latest complete catalog sweep that observed this SKU.';
COMMENT ON COLUMN dim.full_sku.retired_at IS
    'Warehouse observation time when a later complete catalog sweep first stopped seeing this SKU.';

CREATE TABLE IF NOT EXISTS ops.sales_sync_run (
    sales_sync_run_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    run_key text NOT NULL,
    status text NOT NULL,
    business_date date,
    date_anchor_status text NOT NULL,
    quality_status text NOT NULL,
    requested_sku_count integer NOT NULL,
    response_sku_count integer NOT NULL,
    dated_sku_count integer NOT NULL,
    unanchored_zero_sku_count integer NOT NULL,
    quarantined_sku_count integer NOT NULL,
    sales_today bigint,
    sales_yesterday bigint,
    sales_7_days bigint,
    sales_30_days bigint,
    source_fetched_at timestamptz NOT NULL,
    completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_ops_sales_sync_run_store_key UNIQUE (store_id, run_key),
    CONSTRAINT ck_ops_sales_sync_run_status
        CHECK (status IN ('SUCCEEDED', 'QUALITY_BLOCKED', 'FAILED')),
    CONSTRAINT ck_ops_sales_sync_run_anchor
        CHECK (date_anchor_status IN ('ANCHORED', 'PARTIAL', 'UNANCHORED_ZERO', 'BLOCKED')),
    CONSTRAINT ck_ops_sales_sync_run_quality
        CHECK (quality_status IN ('VALID', 'LEGAL_ZERO_UNANCHORED', 'PARTIAL', 'UNANCHORED_NONZERO')),
    CONSTRAINT ck_ops_sales_sync_run_counts
        CHECK (
            requested_sku_count >= 0
            AND response_sku_count >= 0
            AND dated_sku_count >= 0
            AND unanchored_zero_sku_count >= 0
            AND quarantined_sku_count >= 0
            AND response_sku_count = dated_sku_count + unanchored_zero_sku_count + quarantined_sku_count
        ),
    CONSTRAINT ck_ops_sales_sync_run_business_date
        CHECK (
            (date_anchor_status = 'UNANCHORED_ZERO' AND business_date IS NULL)
            OR (
                date_anchor_status IN ('ANCHORED', 'PARTIAL')
                AND business_date IS NOT NULL
            )
            OR date_anchor_status = 'BLOCKED'
        ),
    CONSTRAINT ck_ops_sales_sync_run_quantities
        CHECK (
            (sales_today IS NULL OR sales_today >= 0)
            AND (sales_yesterday IS NULL OR sales_yesterday >= 0)
            AND (sales_7_days IS NULL OR sales_7_days >= 0)
            AND (sales_30_days IS NULL OR sales_30_days >= 0)
        )
);

CREATE INDEX IF NOT EXISTS ix_ops_sales_sync_run_store_latest
    ON ops.sales_sync_run (store_id, source_fetched_at DESC, sales_sync_run_id DESC);

COMMENT ON TABLE ops.sales_sync_run IS
    'One store-level SKU sales synchronization outcome. Permission, date anchoring, and data quality are recorded independently.';

CREATE TABLE IF NOT EXISTS ops.sales_quality_event (
    sales_quality_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sales_sync_run_id bigint NOT NULL
        REFERENCES ops.sales_sync_run (sales_sync_run_id) ON DELETE CASCADE,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    event_code text NOT NULL,
    severity text NOT NULL,
    affected_sku_count integer NOT NULL,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    observed_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_ops_sales_quality_event_run_code
        UNIQUE (sales_sync_run_id, event_code),
    CONSTRAINT ck_ops_sales_quality_event_severity
        CHECK (severity IN ('INFO', 'WARNING', 'ERROR')),
    CONSTRAINT ck_ops_sales_quality_event_count
        CHECK (affected_sku_count >= 0),
    CONSTRAINT ck_ops_sales_quality_event_details
        CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX IF NOT EXISTS ix_ops_sales_quality_event_store_latest
    ON ops.sales_quality_event (store_id, observed_at DESC, sales_quality_event_id DESC);

COMMENT ON TABLE ops.sales_quality_event IS
    'Sanitized, actionable sales-quality observations. It must never contain credentials or transport headers.';

CREATE TABLE IF NOT EXISTS ops.sales_business_watermark (
    store_id bigint PRIMARY KEY REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    business_date date NOT NULL,
    sales_sync_run_id bigint
        REFERENCES ops.sales_sync_run (sales_sync_run_id) ON DELETE RESTRICT,
    coverage_status text NOT NULL,
    source_fetched_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_ops_sales_business_watermark_coverage
        CHECK (coverage_status IN ('COMPLETE', 'PARTIAL'))
);

COMMENT ON TABLE ops.sales_business_watermark IS
    'Latest accepted, date-anchored sales business day per store. Quality-blocked runs never advance it.';

INSERT INTO ops.sales_business_watermark (
    store_id, business_date, sales_sync_run_id, coverage_status, source_fetched_at
)
SELECT DISTINCT ON (f.store_id)
       f.store_id,
       (f.metric_window_start AT TIME ZONE 'Asia/Shanghai')::date,
       NULL,
       'COMPLETE',
       f.snapshot_at
FROM fact.full_sku_sales_snapshot AS f
WHERE split_part(f.source_row_key, ':', 1) = 'today'
ORDER BY
    f.store_id,
    (f.metric_window_start AT TIME ZONE 'Asia/Shanghai')::date DESC,
    f.snapshot_at DESC,
    f.sales_snapshot_id DESC
ON CONFLICT (store_id) DO NOTHING;

DROP TRIGGER IF EXISTS trg_ops_sales_sync_run_touch_updated_at ON ops.sales_sync_run;
CREATE TRIGGER trg_ops_sales_sync_run_touch_updated_at
BEFORE UPDATE ON ops.sales_sync_run
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_ops_sales_quality_event_touch_updated_at ON ops.sales_quality_event;
CREATE TRIGGER trg_ops_sales_quality_event_touch_updated_at
BEFORE UPDATE ON ops.sales_quality_event
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_app') THEN
        GRANT SELECT, INSERT, UPDATE ON ops.sales_sync_run TO sheinfm_app;
        GRANT SELECT, INSERT, UPDATE ON ops.sales_quality_event TO sheinfm_app;
        GRANT SELECT, INSERT, UPDATE ON ops.sales_business_watermark TO sheinfm_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ops TO sheinfm_app;
    END IF;
END;
$$;

COMMIT;
