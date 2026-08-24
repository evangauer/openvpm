\set ON_ERROR_STOP on

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
BEGIN;
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
COMMIT;
SELECT set_config('app.current_practice_id', '11111111-1111-4111-8111-111111111111', false);

BEGIN;
DO $do$
DECLARE
  response_hash text;
  signature_hash text := encode(sha256(decode('89504e47', 'hex')), 'hex');
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
  INSERT INTO files (
    id, practice_id, uploaded_by, file_name, file_key, file_url,
    mime_type, file_size_bytes, checksum_sha256, storage_status,
    storage_verified_at, category, patient_id
  ) VALUES (
    '11111111-1111-4111-8111-111111111123',
    '11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111112', 'signed-plan.pdf',
    '11111111-1111-4111-8111-111111111111/consents/signed-plan.pdf',
    '/api/files/11111111-1111-4111-8111-111111111111/consents/signed-plan.pdf',
    'application/pdf', 4, repeat('c', 64), 'available', now(), 'consents',
    '11111111-1111-4111-8111-111111111114'
  );
  INSERT INTO consent_requests (
    id, practice_id, patient_id, created_by, token, expires_at, title,
    body_text, status, signer_name, signed_at, signature_png_bytes,
    signature_sha256, file_id
  ) VALUES (
    '11111111-1111-4111-8111-111111111124',
    '11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111114',
    '11111111-1111-4111-8111-111111111112', repeat('d', 64), now() + interval '1 hour',
    'Duke exam treatment plan',
    'Treatment plan response SHA-256: ' || response_hash,
    'signed', 'Client A', '2026-08-23 20:00:00+00', decode('89504e47', 'hex'),
    signature_hash, '11111111-1111-4111-8111-111111111123'
  );
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
    'Client A', '2026-08-23 20:00:00+00',
    '11111111-1111-4111-8111-111111111125', repeat('e', 64), response_hash
  );
END $do$;
COMMIT;

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
END $do$;

BEGIN;
SELECT set_config('app.current_practice_id', '22222222-2222-4222-8222-222222222222', true);
DO $do$
DECLARE visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM visit_treatment_plans;
  IF visible_count <> 0 THEN RAISE EXCEPTION 'cross-tenant read leaked rows'; END IF;
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
ROLLBACK;

RESET ROLE;
SELECT 'openvpm-73 contract pass' AS result;

SELECT set_config('app.rls_bypass', 'on', false);
DELETE FROM visit_treatment_plan_response_lines
  WHERE practice_id IN ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
DELETE FROM visit_treatment_plan_responses
  WHERE practice_id IN ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
DELETE FROM consent_requests
  WHERE practice_id IN ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
DELETE FROM files
  WHERE practice_id IN ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
DELETE FROM visit_treatment_plan_revision_lines
  WHERE practice_id IN ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
DELETE FROM visit_treatment_plan_revisions
  WHERE practice_id IN ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
DELETE FROM visit_treatment_plans
  WHERE practice_id IN ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
DELETE FROM services
  WHERE practice_id IN ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
DELETE FROM patients
  WHERE practice_id IN ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
DELETE FROM clients
  WHERE practice_id IN ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
DELETE FROM users
  WHERE practice_id IN ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
DELETE FROM practices
  WHERE id IN ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
RESET app.rls_bypass;
