-- Real PostgreSQL semantic checks for migration 091.
-- Run only against a disposable schema after applying the migration:
--   psql -v ON_ERROR_STOP=1 "$TEST_DATABASE_URL" -f api/engagement-reporting.pgtest.sql

BEGIN;

DO $$
BEGIN
  IF engagement_evidence_classification(
    '2026-09-01T12:00:00Z', '2026-09-01', 'resolved', NULL, NULL, NULL,
    NULL, NULL, '2026-09-08T16:00:00Z', 3
  ) <> 'same-day activity — sequence unknown' THEN
    RAISE EXCEPTION 'same-day Salesforce activity must remain ambiguous';
  END IF;

  IF engagement_evidence_classification(
    '2026-08-01T12:00:00Z', NULL, 'resolved', NULL,
    '2026-08-02T12:00:00Z', NULL, NULL, NULL,
    '2026-09-08T16:00:00Z', 3
  ) <> 'automation only' THEN
    RAISE EXCEPTION 'automation must not count as human follow-up';
  END IF;

  IF engagement_evidence_classification(
    '2026-08-01T12:00:00Z', NULL, 'unresolved',
    '2026-08-02T12:00:00Z', NULL, NULL, NULL, NULL,
    '2026-09-08T16:00:00Z', 3
  ) <> 'unable to verify' THEN
    RAISE EXCEPTION 'unknown coverage must take precedence over engagement inference';
  END IF;

  IF engagement_evidence_classification(
    '2026-08-01T12:00:00Z', NULL, 'resolved', NULL, NULL, NULL,
    '2026-08-03T12:00:00Z', NULL, '2026-09-08T16:00:00Z', 3
  ) <> 'reply awaiting verified response' THEN
    RAISE EXCEPTION 'a genuine reply without later human outbound must remain awaiting response';
  END IF;

  IF engagement_opportunity_last_touch(
    '2026-07-01', '2026-09-01T12:00:00Z', '2026-06-01T12:00:00Z'
  ) <> '2026-09-01' THEN
    RAISE EXCEPTION 'opportunity movement must use the newest evidence date';
  END IF;
END $$;

INSERT INTO clients(id) VALUES ('90000000-0000-0000-0000-000000000001');
INSERT INTO contacts(
  id, client_id, email, salesforce_id, record_type, unsubscribed,
  salesforce_created_date
) VALUES (
  '90000000-0000-0000-0000-000000000003',
  '90000000-0000-0000-0000-000000000001',
  'one@example.test', '003000000000001AAA', 'contact', false,
  '2026-09-07T12:00:00Z'
);

DO $$
DECLARE candidates integer; reported_total bigint;
BEGIN
  SELECT count(*), max(total_count)
    INTO candidates, reported_total
    FROM engagement_reporting_candidates(
      '90000000-0000-0000-0000-000000000001',
      '2026-08-09T16:00:00Z', '2026-09-08T16:00:00Z', 5000
    );
  IF candidates <> 1 OR reported_total <> 1 THEN
    RAISE EXCEPTION 'dashboard cohort enumeration was not exact';
  END IF;
END $$;
INSERT INTO engagement_refresh_runs(
  id, client_id, scope, cohort_type, as_of, window_start, window_end_exclusive,
  status, started_at, completed_at, expected_count, resolved_count,
  cohort_discovery_complete, opportunity_discovery_complete
) VALUES (
  '90000000-0000-0000-0000-000000000002',
  '90000000-0000-0000-0000-000000000001',
  'recent_leads', 'salesforce_leads', '2026-09-08T16:00:00Z',
  '2026-08-09T16:00:00Z', '2026-09-08T16:00:00Z', 'complete',
  '2026-09-08T15:59:00Z', '2026-09-08T16:00:00Z', 2, 2, true, true
);
INSERT INTO engagement_refresh_records(
  run_id, client_id, contact_id, salesforce_id, record_type, email,
  salesforce_created_date, verification_status, verified_at
) VALUES
  ('90000000-0000-0000-0000-000000000002','90000000-0000-0000-0000-000000000001','90000000-0000-0000-0000-000000000003','003000000000001AAA','contact','one@example.test','2026-09-07T12:00:00Z','resolved','2026-09-08T16:00:00Z'),
  ('90000000-0000-0000-0000-000000000002','90000000-0000-0000-0000-000000000001',NULL,'00Q000000000002AAA','lead','two@example.test','2026-09-06T12:00:00Z','resolved','2026-09-08T16:00:00Z');

INSERT INTO salesforce_opportunities(
  client_id, salesforce_id, name, stage, is_closed, sf_contact_id,
  sf_created_date, last_stage_change, verification_status,
  last_verified_at, visible_in_last_snapshot
) VALUES (
  '90000000-0000-0000-0000-000000000001', '006000000000001AAA',
  'Synthetic open opportunity', 'Open', false, '003000000000001AAA',
  '2026-09-01T12:00:00Z', '2026-09-07T12:00:00Z', 'resolved',
  '2026-09-08T16:00:00Z', true
);

SELECT freeze_engagement_snapshot_evidence('90000000-0000-0000-0000-000000000002', true);

DO $$
DECLARE report jsonb; report_after_late_write jsonb;
BEGIN
  SELECT engagement_snapshot_report(
    '90000000-0000-0000-0000-000000000001',
    '90000000-0000-0000-0000-000000000002',
    'recent_leads', 1, 0, '{}'::jsonb, 3
  ) INTO report;
  IF (report #>> '{totals,population_count}')::int <> 2 THEN
    RAISE EXCEPTION 'snapshot population count was not exact: %', report;
  END IF;
  IF (report #>> '{pagination,returned_count}')::int <> 1
     OR (report #>> '{pagination,has_more}')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'snapshot pagination was not stable: %', report;
  END IF;
  IF report #>> '{freshness,status}' <> 'complete' THEN
    RAISE EXCEPTION 'snapshot freshness missing: %', report;
  END IF;
  IF (report #>> '{totals,open_opportunities}')::int <> 1
     OR (report #>> '{totals,pipeline_coverage_unavailable}')::int <> 1 THEN
    RAISE EXCEPTION 'pipeline evidence was not frozen into the snapshot: %', report;
  END IF;

  INSERT INTO email_conversations(client_id, contact_id, direction, subject, body, ai_generated, created_at)
  VALUES ('90000000-0000-0000-0000-000000000001','90000000-0000-0000-0000-000000000003',
          'outbound','Late-ingested evidence','hello',false,'2026-09-08T15:00:00Z');
  SELECT engagement_snapshot_report(
    '90000000-0000-0000-0000-000000000001',
    '90000000-0000-0000-0000-000000000002',
    'recent_leads', 1, 0, '{}'::jsonb, 3
  ) INTO report_after_late_write;
  IF report_after_late_write #>> '{results,0,classification}' <>
     report #>> '{results,0,classification}' THEN
    RAISE EXCEPTION 'later page reads changed frozen snapshot evidence';
  END IF;
END $$;

ROLLBACK;
