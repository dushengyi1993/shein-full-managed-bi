BEGIN;

DO $verify$
DECLARE
    column_name text;
BEGIN
    FOREACH column_name IN ARRAY ARRAY[
        'webapi_home_fetch_audit_id',
        'store_code',
        'endpoint_code',
        'result_status',
        'sanitized_error_code',
        'observed_at'
    ]
    LOOP
        IF NOT has_column_privilege(
            'sheinfm_materializer_login',
            'raw.webapi_home_fetch_audit',
            column_name,
            'SELECT'
        ) THEN
            RAISE EXCEPTION
                'materializer lacks analysis-capability column %',
                column_name;
        END IF;
    END LOOP;

    FOREACH column_name IN ARRAY ARRAY[
        'fetch_key',
        'request_sha256',
        'response_schema_sha256',
        'response_body_sha256'
    ]
    LOOP
        IF has_column_privilege(
            'sheinfm_materializer_login',
            'raw.webapi_home_fetch_audit',
            column_name,
            'SELECT'
        ) THEN
            RAISE EXCEPTION
                'materializer can read private analysis-audit column %',
                column_name;
        END IF;
    END LOOP;

    IF has_table_privilege(
        'sheinfm_materializer_login',
        'raw.webapi_home_fetch_audit',
        'SELECT'
    ) OR has_table_privilege(
        'sheinfm_materializer_login',
        'raw.webapi_home_fetch_audit',
        'INSERT,UPDATE,DELETE,TRUNCATE'
    ) THEN
        RAISE EXCEPTION
            'materializer analysis-audit privilege is too broad';
    END IF;
END
$verify$;

ROLLBACK;
