DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM fact.full_home_bill_daily
        WHERE pending_report_count <> 0
           OR settled_report_count <> report_count
    ) THEN
        RAISE EXCEPTION
            'full_home_bill_daily still contains non-settled report counts';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM fact.full_home_bill_daily AS daily
        WHERE NOT EXISTS (
            SELECT 1
            FROM fact.full_home_finance_report_observation AS report
            WHERE report.store_code = daily.store_code
              AND report.currency = daily.currency
              AND report.settlement_status = 3
              AND report.completed_pay_at IS NOT NULL
              AND (
                report.completed_pay_at AT TIME ZONE 'Asia/Shanghai'
              )::date = daily.business_date
        )
    ) THEN
        RAISE EXCEPTION
            'full_home_bill_daily contains a date without an actual settlement';
    END IF;

    IF obj_description(
        'fact.full_home_bill_daily'::regclass,
        'pg_class'
    ) NOT LIKE '%actual completed payment date%' THEN
        RAISE EXCEPTION
            'full_home_bill_daily settlement-date comment is missing';
    END IF;
END
$$;
