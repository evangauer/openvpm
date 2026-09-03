\set ON_ERROR_STOP on

BEGIN;

INSERT INTO practices (id, name) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Fixture A'),
  ('22222222-2222-4222-8222-222222222222', 'Fixture B');
INSERT INTO users (id, email, password_hash, name, role, practice_id) VALUES
  ('11111111-1111-4111-8111-111111111112', 'a@example.test', 'x', 'Doctor A', 'veterinarian', '11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222223', 'b@example.test', 'x', 'Doctor B', 'veterinarian', '22222222-2222-4222-8222-222222222222');
INSERT INTO clients (id, practice_id, first_name, last_name) VALUES
  ('11111111-1111-4111-8111-111111111113', '11111111-1111-4111-8111-111111111111', 'Client', 'A'),
  ('22222222-2222-4222-8222-222222222224', '22222222-2222-4222-8222-222222222222', 'Client', 'B');
INSERT INTO patients (id, practice_id, client_id, name, species) VALUES
  ('11111111-1111-4111-8111-111111111114', '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111113', 'Duke', 'canine'),
  ('22222222-2222-4222-8222-222222222225', '22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222224', 'Milo', 'feline');
INSERT INTO services (id, practice_id, name, default_price, taxable) VALUES
  ('11111111-1111-4111-8111-111111111115', '11111111-1111-4111-8111-111111111111', 'Exam', 100, true),
  ('22222222-2222-4222-8222-222222222226', '22222222-2222-4222-8222-222222222222', 'Exam', 90, true);

SET ROLE openpims_app;
SELECT set_config('app.current_practice_id', '11111111-1111-4111-8111-111111111111', true);
INSERT INTO visit_treatment_plans (
  id, practice_id, client_id, patient_id, created_by, title,
  operation_id, operation_payload_hash
) VALUES (
  '11111111-1111-4111-8111-111111111116',
  '11111111-1111-4111-8111-111111111111',
  '11111111-1111-4111-8111-111111111113',
  '11111111-1111-4111-8111-111111111114',
  '11111111-1111-4111-8111-111111111112',
  'Duke exam treatment plan',
  '11111111-1111-4111-8111-111111111117', repeat('a', 64)
);
INSERT INTO visit_treatment_plan_revision_lines (
  id, practice_id, plan_id, revision_id, sort_order, description,
  offered_quantity, unit_price, line_subtotal, tax_amount, line_total,
  taxable, item_type, service_id
) VALUES (
  '11111111-1111-4111-8111-111111111118',
  '11111111-1111-4111-8111-111111111111',
  '11111111-1111-4111-8111-111111111116',
  '11111111-1111-4111-8111-111111111119', 0, 'Comprehensive exam',
  1, 100, 100, 8, 108, true, 'service',
  '11111111-1111-4111-8111-111111111115'
);
INSERT INTO visit_treatment_plan_revisions (
  id, practice_id, plan_id, revision_number, currency, subtotal, tax,
  total, authored_by, operation_id, operation_payload_hash, content_sha256
) SELECT
  '11111111-1111-4111-8111-111111111119',
  '11111111-1111-4111-8111-111111111111',
  '11111111-1111-4111-8111-111111111116', 1, 'USD', 100, 8, 108,
  '11111111-1111-4111-8111-111111111112',
  '11111111-1111-4111-8111-111111111120', repeat('b', 64),
  compute_visit_treatment_plan_revision_sha256(
    '11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111116',
    '11111111-1111-4111-8111-111111111119', 1, 'USD', 100, 8, 108
  );
SELECT set_config('app.current_practice_id', '11111111-1111-4111-8111-111111111111', false);

DO $do$
DECLARE
  response_hash text;
  signature_bytes bytea := decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  signature_hash text := encode(sha256(signature_bytes), 'hex');
  decision_time timestamptz := clock_timestamp();
  lease_token uuid := '11111111-1111-4111-8111-111111111130';
BEGIN
  INSERT INTO visit_treatment_plan_response_lines (
    id, practice_id, revision_id, response_id, revision_line_id,
    decision, accepted_quantity
  ) VALUES (
    '11111111-1111-4111-8111-111111111121',
    '11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111119',
    '11111111-1111-4111-8111-111111111122',
    '11111111-1111-4111-8111-111111111118',
    'accepted', 1
  );
  SELECT compute_visit_treatment_plan_response_sha256(
    '11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111116',
    '11111111-1111-4111-8111-111111111119',
    '11111111-1111-4111-8111-111111111122'
  ) INTO response_hash;
  INSERT INTO consent_requests (
    id, practice_id, patient_id, created_by, token_hash, expires_at, title,
    body_text, status
  ) VALUES (
    '11111111-1111-4111-8111-111111111124',
    '11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111114',
    '11111111-1111-4111-8111-111111111112', repeat('d', 64), now() + interval '1 hour',
    'Duke exam treatment plan',
    'Treatment plan response SHA-256: ' || response_hash,
    'pending'
  );
  UPDATE consent_requests
  SET status = 'signing',
      signer_name = 'Client A',
      signed_at = decision_time,
      signature_png_bytes = signature_bytes,
      signature_sha256 = signature_hash,
      signature_method = 'drawn',
      signer_attestation_version = 'owner-authority-v1',
      document_render_version = 'consent-pdf-v2'
  WHERE id = '11111111-1111-4111-8111-111111111124'
    AND practice_id = '11111111-1111-4111-8111-111111111111';
  INSERT INTO files (
    id, practice_id, uploaded_by, file_name, file_key, file_url,
    mime_type, file_size_bytes, checksum_sha256, storage_status,
    category, source, idempotency_key, entity_type, entity_id, patient_id
  ) VALUES (
    '11111111-1111-4111-8111-111111111123',
    '11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111112', 'signed-plan.pdf',
    '11111111-1111-4111-8111-111111111111/consents/signed-plan.pdf',
    '/api/files/11111111-1111-4111-8111-111111111111/consents/signed-plan.pdf',
    'application/pdf', 4, repeat('c', 64), 'pending_upload', 'consents',
    'consent_signature', '11111111-1111-4111-8111-111111111124',
    'patient', '11111111-1111-4111-8111-111111111114',
    '11111111-1111-4111-8111-111111111114'
  );
  UPDATE consent_requests
  SET file_id = '11111111-1111-4111-8111-111111111123'
  WHERE id = '11111111-1111-4111-8111-111111111124'
    AND practice_id = '11111111-1111-4111-8111-111111111111';
  UPDATE consent_requests
  SET storage_lease_token = lease_token,
      storage_lease_expires_at = clock_timestamp() + interval '2 minutes'
  WHERE id = '11111111-1111-4111-8111-111111111124'
    AND practice_id = '11111111-1111-4111-8111-111111111111';
  IF NOT finalize_consent_request(
    '11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111124',
    '11111111-1111-4111-8111-111111111123', lease_token,
    '11111111-1111-4111-8111-111111111111/consents/signed-plan.pdf',
    repeat('c', 64), 4, NULL, NULL
  ) THEN
    RAISE EXCEPTION 'legitimate consent finalization failed';
  END IF;
  UPDATE files
  SET storage_status = 'available', storage_verified_at = clock_timestamp()
  WHERE id = '11111111-1111-4111-8111-111111111123'
    AND practice_id = '11111111-1111-4111-8111-111111111111';
  IF response_hash <> compute_visit_treatment_plan_response_sha256_from_decisions(
    '11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111116',
    '11111111-1111-4111-8111-111111111119',
    '11111111-1111-4111-8111-111111111122',
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'revisionLineId', '11111111-1111-4111-8111-111111111118',
      'decision', 'accepted', 'acceptedQuantity', '1.000',
      'declineReason', null
    ))
  ) THEN
    RAISE EXCEPTION 'staged and sealed response hashes diverged';
  END IF;
  INSERT INTO visit_treatment_plan_presentations (
    id, practice_id, plan_id, revision_id, response_id, created_by,
    token_hash, expires_at, status, decisions, response_sha256,
    consent_request_id
  ) VALUES (
    '11111111-1111-4111-8111-111111111126',
    '11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111116',
    '11111111-1111-4111-8111-111111111119',
    '11111111-1111-4111-8111-111111111122',
    '11111111-1111-4111-8111-111111111112', repeat('f', 64),
    now() + interval '1 hour', 'awaiting_signature',
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'revisionLineId', '11111111-1111-4111-8111-111111111118',
      'decision', 'accepted', 'acceptedQuantity', '1.000',
      'declineReason', null
    )), response_hash, '11111111-1111-4111-8111-111111111124'
  );
  BEGIN
    INSERT INTO visit_treatment_plan_revision_lines (
      id, practice_id, plan_id, revision_id, sort_order, description,
      offered_quantity, unit_price, line_subtotal, tax_amount, line_total,
      taxable, item_type, service_id
    ) VALUES (
      '11111111-1111-4111-8111-111111111127',
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111116',
      '11111111-1111-4111-8111-111111111128', 0, 'Concurrent exam',
      1, 100, 100, 8, 108, true, 'service',
      '11111111-1111-4111-8111-111111111115'
    );
    INSERT INTO visit_treatment_plan_revisions (
      id, practice_id, plan_id, revision_number, currency, subtotal, tax,
      total, authored_by, operation_id, operation_payload_hash, content_sha256
    ) SELECT
      '11111111-1111-4111-8111-111111111128',
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111116', 2, 'USD', 100, 8, 108,
      '11111111-1111-4111-8111-111111111112',
      '11111111-1111-4111-8111-111111111129', repeat('1', 64),
      compute_visit_treatment_plan_revision_sha256(
        '11111111-1111-4111-8111-111111111111',
        '11111111-1111-4111-8111-111111111116',
        '11111111-1111-4111-8111-111111111128', 2, 'USD', 100, 8, 108
      );
    RAISE EXCEPTION 'revision while awaiting signature unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE visit_treatment_plans SET status = 'cancelled'
      WHERE id = '11111111-1111-4111-8111-111111111116';
    RAISE EXCEPTION 'close while awaiting signature unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO visit_treatment_plan_responses (
    id, practice_id, plan_id, revision_id, consent_request_id,
    signed_file_id, signature_sha256, signed_document_sha256,
    signer_name, decided_at, operation_id, operation_payload_hash,
    response_sha256
  ) VALUES (
    '11111111-1111-4111-8111-111111111122',
    '11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111116',
    '11111111-1111-4111-8111-111111111119',
    '11111111-1111-4111-8111-111111111124',
    '11111111-1111-4111-8111-111111111123', signature_hash, repeat('c', 64),
    'Client A', decision_time,
    '11111111-1111-4111-8111-111111111125', repeat('e', 64), response_hash
  );
  UPDATE visit_treatment_plan_presentations SET status = 'completed'
    WHERE id = '11111111-1111-4111-8111-111111111126';
  UPDATE visit_treatment_plans SET status = 'completed'
    WHERE id = '11111111-1111-4111-8111-111111111116';
END $do$;

-- Force the deferred signed-file and response graph checks before the fixture
-- continues. The outer rollback keeps this fixed-ID contract repeatable
-- without bypassing the immutable legal-evidence triggers during teardown.
SET CONSTRAINTS ALL IMMEDIATE;

DO $do$
BEGIN
  BEGIN
    UPDATE visit_treatment_plan_revision_lines SET description = 'Changed'
      WHERE id = '11111111-1111-4111-8111-111111111118';
    RAISE EXCEPTION 'sealed line update unexpectedly succeeded';
  EXCEPTION WHEN check_violation OR insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM visit_treatment_plan_revisions
      WHERE id = '11111111-1111-4111-8111-111111111119';
    RAISE EXCEPTION 'sealed revision delete unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE visit_treatment_plan_response_lines SET decline_reason = 'Changed'
      WHERE id = '11111111-1111-4111-8111-111111111121';
    RAISE EXCEPTION 'sealed response line update unexpectedly succeeded';
  EXCEPTION WHEN check_violation OR insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO visit_treatment_plans (
      practice_id, client_id, patient_id, created_by, title,
      operation_id, operation_payload_hash
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111113',
      '11111111-1111-4111-8111-111111111114',
      '11111111-1111-4111-8111-111111111112', 'Replay mismatch',
      '11111111-1111-4111-8111-111111111117', repeat('c', 64)
    );
    RAISE EXCEPTION 'operation replay mismatch unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $do$;

RESET app.current_practice_id;
DO $do$
DECLARE visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM visit_treatment_plans;
  IF visible_count <> 0 THEN RAISE EXCEPTION 'no-context read leaked rows'; END IF;
  SELECT count(*) INTO visible_count FROM visit_treatment_plan_presentations;
  IF visible_count <> 0 THEN RAISE EXCEPTION 'no-context presentation read leaked rows'; END IF;
END $do$;

SAVEPOINT cross_tenant_scope;
SELECT set_config('app.current_practice_id', '22222222-2222-4222-8222-222222222222', true);
DO $do$
DECLARE visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM visit_treatment_plans;
  IF visible_count <> 0 THEN RAISE EXCEPTION 'cross-tenant read leaked rows'; END IF;
  SELECT count(*) INTO visible_count FROM visit_treatment_plan_presentations;
  IF visible_count <> 0 THEN RAISE EXCEPTION 'cross-tenant presentation read leaked rows'; END IF;
  BEGIN
    INSERT INTO visit_treatment_plan_presentations (
      practice_id, plan_id, revision_id, response_id, created_by,
      token_hash, expires_at
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111116',
      '11111111-1111-4111-8111-111111111119',
      '22222222-2222-4222-8222-222222222228',
      '11111111-1111-4111-8111-111111111112', repeat('2', 64),
      now() + interval '1 hour'
    );
    RAISE EXCEPTION 'cross-tenant presentation write unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO visit_treatment_plans (
      practice_id, client_id, patient_id, created_by, title,
      operation_id, operation_payload_hash
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111113',
      '11111111-1111-4111-8111-111111111114',
      '11111111-1111-4111-8111-111111111112', 'Cross tenant',
      '22222222-2222-4222-8222-222222222227', repeat('d', 64)
    );
    RAISE EXCEPTION 'cross-tenant write unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $do$;
ROLLBACK TO SAVEPOINT cross_tenant_scope;
RELEASE SAVEPOINT cross_tenant_scope;

RESET ROLE;
SELECT 'openvpm-73 client decision contract pass' AS result;
ROLLBACK;
