ALTER TABLE "consent_requests" DROP CONSTRAINT "consent_requests_credential_storage_check";--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_credential_storage_check" CHECK (("consent_requests"."token" is not null and "consent_requests"."token_hash" is null) or ("consent_requests"."token" is null and "consent_requests"."token_hash" is not null) or ("consent_requests"."status" = 'signed' and "consent_requests"."token" is null and "consent_requests"."token_hash" is null));--> statement-breakpoint

-- A public signer may classify only a renderer-less row that has no durable
-- file reservation. The version is derived solely from immutable database
-- evidence; the caller supplies neither a renderer label nor checksum slots.
CREATE OR REPLACE FUNCTION public.resolve_unreserved_consent_document_render_version(
  p_practice_id uuid,
  p_consent_request_id uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  selected_version text;
BEGIN
  IF public.app_current_practice_id() IS DISTINCT FROM p_practice_id THEN
    RETURN NULL;
  END IF;

  UPDATE public.consent_requests AS consent
  SET document_render_version = CASE
        WHEN consent.signer_attestation_version = 'owner-authority-v1'
          THEN 'consent-pdf-v2'
        WHEN consent.signer_attestation_version IS NULL
          THEN 'consent-pdf-v1'
        ELSE NULL
      END,
      updated_at = pg_catalog.clock_timestamp()
  WHERE consent.id = p_consent_request_id
    AND consent.practice_id = p_practice_id
    AND consent.status = 'signing'
    AND consent.document_render_version IS NULL
    AND consent.file_id IS NULL
    AND consent.signed_at > pg_catalog.clock_timestamp() - interval '15 minutes'
    AND consent.expires_at > pg_catalog.clock_timestamp()
    AND consent.deleted_at IS NULL
    AND (
      consent.signer_attestation_version = 'owner-authority-v1'
      OR consent.signer_attestation_version IS NULL
    )
  RETURNING consent.document_render_version INTO selected_version;

  RETURN selected_version;
END
$fn$;--> statement-breakpoint

-- Reserved legacy rows are deliberately an offline owner operation. This
-- preserves the unique frozen v1/v2 checksum comparison for disaster repair
-- without exposing caller-swappable digest/label slots to openpims_app.
CREATE OR REPLACE FUNCTION public.resolve_consent_document_render_version(
  p_practice_id uuid,
  p_consent_request_id uuid,
  p_original_file_id uuid,
  p_original_attestation_version text,
  p_v1_checksum text,
  p_v1_size integer,
  p_v2_checksum text,
  p_v2_size integer
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  consent_record record;
  owner_name text;
  selected_version text;
  file_checksum text;
  file_size integer;
  v1_matches boolean;
  v2_matches boolean;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(class.relowner)
  INTO owner_name
  FROM pg_catalog.pg_class AS class
  WHERE class.oid = 'public.consent_requests'::pg_catalog.regclass;
  IF session_user <> owner_name OR p_original_file_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT consent.*
  INTO consent_record
  FROM public.consent_requests AS consent
  WHERE consent.id = p_consent_request_id
    AND consent.practice_id = p_practice_id
    AND consent.status = 'signing'
    AND consent.document_render_version IS NULL
    AND consent.signer_attestation_version IS NOT DISTINCT FROM p_original_attestation_version
    AND consent.file_id = p_original_file_id
    AND consent.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT file.checksum_sha256, file.file_size_bytes
  INTO file_checksum, file_size
  FROM public.files AS file
  WHERE file.id = p_original_file_id
    AND file.practice_id = p_practice_id
    AND file.idempotency_key = p_consent_request_id
    AND file.category = 'consents'
    AND file.source = 'consent_signature'
    AND file.deleted_at IS NULL
  FOR SHARE;
  IF NOT FOUND OR file_checksum IS NULL OR file_size IS NULL THEN RETURN NULL; END IF;

  v1_matches := file_checksum = p_v1_checksum AND file_size = p_v1_size;
  v2_matches := file_checksum = p_v2_checksum AND file_size = p_v2_size;
  IF v1_matches = v2_matches THEN RETURN NULL; END IF;
  selected_version := CASE
    WHEN v1_matches THEN 'consent-pdf-v1'
    ELSE 'consent-pdf-v2'
  END;

  UPDATE public.consent_requests
  SET document_render_version = selected_version,
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_consent_request_id
    AND practice_id = p_practice_id
    AND status = 'signing'
    AND document_render_version IS NULL
    AND signer_attestation_version IS NOT DISTINCT FROM p_original_attestation_version
    AND file_id = p_original_file_id
    AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN selected_version;
END
$fn$;--> statement-breakpoint

COMMENT ON FUNCTION public.resolve_consent_document_render_version(uuid,uuid,uuid,text,text,integer,text,integer)
IS 'OWNER ONLY: offline repair of a reserved legacy consent after independently rendering frozen v1 and v2 bytes and supplying both unique checksum/size pairs.';--> statement-breakpoint

-- Rebuild the deferred verifier so a sealed manifest may be inserted as
-- unverified only by the table owner while the exact practice is recovery-held.
-- Normal signing commits and every released practice still require available.
CREATE OR REPLACE FUNCTION public.validate_signed_consent_file_binding()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
DECLARE
  consent_record record;
  owner_name text;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(class.relowner)
  INTO owner_name
  FROM pg_catalog.pg_class AS class
  WHERE class.oid = 'public.consent_requests'::pg_catalog.regclass;

  IF TG_TABLE_NAME = 'consent_requests' THEN
    IF NEW.status <> 'signed' THEN RETURN NULL; END IF;
    consent_record := NEW;
  ELSE
    IF TG_OP = 'UPDATE' AND NEW.storage_status <> 'available' THEN
      RETURN NULL;
    END IF;
    SELECT consent.*
    INTO consent_record
    FROM public.consent_requests AS consent
    WHERE consent.practice_id = COALESCE(NEW.practice_id, OLD.practice_id)
      AND consent.file_id = COALESCE(NEW.id, OLD.id)
      AND consent.status = 'signed'
    LIMIT 1;
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.files AS file
    WHERE file.id = consent_record.file_id
      AND file.practice_id = consent_record.practice_id
      AND file.idempotency_key = consent_record.id
      AND file.category = 'consents'
      AND file.source = 'consent_signature'
      AND file.mime_type = 'application/pdf'
      AND file.patient_id = consent_record.patient_id
      AND file.appointment_id IS NOT DISTINCT FROM consent_record.appointment_id
      AND file.deleted_at IS NULL
      AND file.file_key = consent_record.signed_file_key
      AND file.checksum_sha256 = consent_record.signed_file_checksum_sha256
      AND file.file_size_bytes = consent_record.signed_file_size_bytes
      AND (
        file.storage_status = 'available'
        OR (
          file.storage_status = 'unverified'
          AND session_user = owner_name
          AND EXISTS (
            SELECT 1
            FROM public.practices AS practice
            WHERE practice.id = consent_record.practice_id
              AND practice.recovery_hold = true
              AND practice.deleted_at IS NULL
          )
        )
      )
      AND (
        TG_TABLE_NAME <> 'consent_requests'
        OR (
          file.object_etag IS NOT DISTINCT FROM consent_record.signed_file_object_etag
          AND file.object_version_id IS NOT DISTINCT FROM consent_record.signed_file_object_version_id
        )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Signed consent must reference its exact recoverable PDF generation';
  END IF;
  RETURN NULL;
END
$fn$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.restore_signed_consent_evidence(
  p_practice_id uuid,
  p_evidence jsonb
) RETURNS TABLE(result_id uuid, was_inserted boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  owner_name text;
  restored_signature_bytes bytea;
  restored_evidence_id uuid;
  restored_patient_id uuid;
  restored_created_by uuid;
  restored_appointment_id uuid;
  restored_form_id uuid;
  restored_file_id uuid;
  restored_created_at timestamptz;
  restored_updated_at timestamptz;
  restored_expires_at timestamptz;
  restored_signed_at timestamptz;
  restored_file_size integer;
  restored_evidence_profile text;
  png_width bigint;
  png_height bigint;
  existing_record public.consent_requests%ROWTYPE;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(class.relowner)
  INTO owner_name
  FROM pg_catalog.pg_class AS class
  WHERE class.oid = 'public.consent_requests'::pg_catalog.regclass;
  IF session_user <> owner_name THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Signed consent evidence restore requires the database owner';
  END IF;
  IF pg_catalog.jsonb_typeof(p_evidence) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'Signed consent evidence must be a JSON object';
  END IF;
  IF p_evidence ?| ARRAY[
    'token', 'tokenHash', 'storageLeaseToken', 'storageLeaseExpiresAt',
    'deletedAt', 'receiptCapability', 'signedFileObjectEtag',
    'signedFileObjectVersionId'
  ] THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'Signed consent backup contains forbidden capability or provider state';
  END IF;

  BEGIN
    restored_evidence_id := (p_evidence->>'id')::uuid;
    restored_patient_id := (p_evidence->>'patientId')::uuid;
    restored_created_by := NULLIF(p_evidence->>'createdBy', '')::uuid;
    restored_appointment_id := NULLIF(p_evidence->>'appointmentId', '')::uuid;
    restored_form_id := NULLIF(p_evidence->>'formId', '')::uuid;
    restored_file_id := (p_evidence->>'fileId')::uuid;
    restored_created_at := (p_evidence->>'createdAt')::timestamptz;
    restored_updated_at := (p_evidence->>'updatedAt')::timestamptz;
    restored_expires_at := (p_evidence->>'expiresAt')::timestamptz;
    restored_signed_at := (p_evidence->>'signedAt')::timestamptz;
    restored_file_size := (p_evidence->>'signedFileSizeBytes')::integer;
    restored_evidence_profile := p_evidence->>'evidenceProfile';
    IF p_evidence->>'signaturePngBase64' IS NOT NULL THEN
      restored_signature_bytes := pg_catalog.decode(
        p_evidence->>'signaturePngBase64',
        'base64'
      );
    ELSE
      restored_signature_bytes := NULL;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'Signed consent backup has invalid encoded fields';
  END;

  IF p_evidence->>'practiceId' IS DISTINCT FROM p_practice_id::text
     OR p_evidence->>'title' IS NULL
     OR pg_catalog.length(p_evidence->>'title') NOT BETWEEN 1 AND 200
     OR p_evidence->>'bodyText' IS NULL
     OR p_evidence->>'signerName' IS NULL
     OR pg_catalog.length(pg_catalog.btrim(p_evidence->>'signerName')) NOT BETWEEN 1 AND 120
     OR p_evidence->>'signedFileKey' IS NULL
     OR p_evidence->>'signedFileKey' NOT LIKE p_practice_id::text || '/%'
     OR p_evidence->>'signedFileChecksumSha256' !~ '^[0-9a-f]{64}$'
     OR restored_file_size <= 0
     OR restored_created_at IS NULL OR restored_updated_at IS NULL
     OR restored_expires_at IS NULL OR restored_signed_at IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Signed consent backup failed terminal evidence validation';
  END IF;

  IF restored_evidence_profile = 'attested-signature-v1' THEN
    IF restored_signature_bytes IS NULL
       OR p_evidence->>'signatureSha256' IS NULL
       OR p_evidence->>'signatureSha256' !~ '^[0-9a-f]{64}$'
       OR p_evidence->>'signatureSha256' <> pg_catalog.encode(pg_catalog.sha256(restored_signature_bytes), 'hex')
       OR p_evidence->>'signatureMethod' IS NULL
       OR p_evidence->>'signatureMethod' NOT IN ('drawn', 'typed')
       OR p_evidence->>'signerAttestationVersion' IS DISTINCT FROM 'owner-authority-v1'
       OR p_evidence->>'documentRenderVersion' IS NULL
       OR p_evidence->>'documentRenderVersion' NOT IN ('consent-pdf-v1', 'consent-pdf-v2')
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Attested signed consent backup has invalid provenance';
    END IF;
  ELSIF restored_evidence_profile = 'legacy-pre-attestation-v1' THEN
    IF p_evidence->'signatureMethod' IS DISTINCT FROM 'null'::jsonb
       OR p_evidence->'signerAttestationVersion' IS DISTINCT FROM 'null'::jsonb
       OR p_evidence->'documentRenderVersion' IS DISTINCT FROM 'null'::jsonb
       OR (
         restored_signature_bytes IS NULL
         AND (
           p_evidence->'signaturePngBase64' IS DISTINCT FROM 'null'::jsonb
           OR p_evidence->'signatureSha256' IS DISTINCT FROM 'null'::jsonb
         )
       )
       OR (
         restored_signature_bytes IS NOT NULL
         AND (
           p_evidence->>'signatureSha256' IS NULL
           OR p_evidence->>'signatureSha256' !~ '^[0-9a-f]{64}$'
           OR p_evidence->>'signatureSha256' <> pg_catalog.encode(pg_catalog.sha256(restored_signature_bytes), 'hex')
         )
       )
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Legacy signed consent backup has invalid evidence provenance';
    END IF;
  ELSE
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Signed consent backup evidence profile is unsupported';
  END IF;

  IF restored_signature_bytes IS NOT NULL THEN
    IF pg_catalog.octet_length(restored_signature_bytes) NOT BETWEEN 24 AND 500000
       OR pg_catalog.substring(restored_signature_bytes, 1, 8) <> pg_catalog.decode('89504e470d0a1a0a', 'hex')
       OR pg_catalog.substring(restored_signature_bytes, 13, 4) <> pg_catalog.convert_to('IHDR', 'UTF8')
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Signed consent backup PNG bytes are invalid';
    END IF;

    png_width :=
      pg_catalog.get_byte(restored_signature_bytes, 16) * 16777216::bigint +
      pg_catalog.get_byte(restored_signature_bytes, 17) * 65536::bigint +
      pg_catalog.get_byte(restored_signature_bytes, 18) * 256::bigint +
      pg_catalog.get_byte(restored_signature_bytes, 19);
    png_height :=
      pg_catalog.get_byte(restored_signature_bytes, 20) * 16777216::bigint +
      pg_catalog.get_byte(restored_signature_bytes, 21) * 65536::bigint +
      pg_catalog.get_byte(restored_signature_bytes, 22) * 256::bigint +
      pg_catalog.get_byte(restored_signature_bytes, 23);
    IF png_width NOT BETWEEN 1 AND 2048
       OR png_height NOT BETWEEN 1 AND 2048
       OR png_width * png_height > 2000000
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Signed consent backup PNG dimensions are invalid';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.practices AS practice
    WHERE practice.id = p_practice_id
      AND practice.recovery_hold = true
      AND practice.deleted_at IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM public.patients AS patient
    WHERE patient.id = restored_patient_id AND patient.practice_id = p_practice_id
  ) OR (restored_created_by IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.users AS staff
    WHERE staff.id = restored_created_by AND staff.practice_id = p_practice_id
  )) OR (restored_appointment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.appointments AS appointment
    WHERE appointment.id = restored_appointment_id
      AND appointment.practice_id = p_practice_id
      AND appointment.patient_id = restored_patient_id
  )) OR (restored_form_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.consent_forms AS form
    WHERE form.id = restored_form_id AND form.practice_id = p_practice_id
  )) OR NOT EXISTS (
    SELECT 1 FROM public.files AS file
    WHERE file.id = restored_file_id
      AND file.practice_id = p_practice_id
      AND file.uploaded_by IN (
        SELECT staff.id FROM public.users AS staff
        WHERE staff.practice_id = p_practice_id
      )
      AND file.file_key = p_evidence->>'signedFileKey'
      AND file.checksum_sha256 = p_evidence->>'signedFileChecksumSha256'
      AND file.file_size_bytes = restored_file_size
      AND file.mime_type = 'application/pdf'
      AND file.category = 'consents'
      AND file.source = 'consent_signature'
      AND file.idempotency_key = restored_evidence_id
      AND file.entity_type = 'patient'
      AND file.entity_id = restored_patient_id
      AND file.patient_id = restored_patient_id
      AND file.appointment_id IS NOT DISTINCT FROM restored_appointment_id
      AND file.storage_status IN ('unverified', 'available')
      AND file.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Signed consent backup parents or exact PDF manifest are unavailable';
  END IF;

  SELECT consent.*
  INTO existing_record
  FROM public.consent_requests AS consent
  WHERE consent.id = restored_evidence_id;
  IF FOUND THEN
    IF ROW(existing_record.created_at, existing_record.updated_at,
           existing_record.practice_id, existing_record.patient_id,
           existing_record.created_by, existing_record.appointment_id,
           existing_record.form_id, existing_record.expires_at,
           existing_record.title, existing_record.body_text,
           existing_record.status, existing_record.signer_name,
           existing_record.signed_at, existing_record.signature_png_bytes,
           existing_record.signature_sha256, existing_record.signature_method,
           existing_record.signer_attestation_version,
           existing_record.document_render_version, existing_record.file_id,
           existing_record.signed_file_key,
           existing_record.signed_file_checksum_sha256,
           existing_record.signed_file_size_bytes,
           existing_record.signed_file_object_etag,
           existing_record.signed_file_object_version_id,
           existing_record.token, existing_record.token_hash,
           existing_record.storage_lease_token,
           existing_record.storage_lease_expires_at,
           existing_record.deleted_at)
       IS DISTINCT FROM
       ROW(restored_created_at, restored_updated_at, p_practice_id,
           restored_patient_id, restored_created_by, restored_appointment_id,
           restored_form_id, restored_expires_at, p_evidence->>'title',
           p_evidence->>'bodyText', 'signed', p_evidence->>'signerName',
           restored_signed_at, restored_signature_bytes,
           p_evidence->>'signatureSha256',
           p_evidence->>'signatureMethod',
           p_evidence->>'signerAttestationVersion',
           p_evidence->>'documentRenderVersion', restored_file_id,
           p_evidence->>'signedFileKey',
           p_evidence->>'signedFileChecksumSha256', restored_file_size,
           NULL, NULL, NULL, NULL, NULL, NULL, NULL)
    THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'Signed consent evidence conflicts with an existing record';
    END IF;
    result_id := restored_evidence_id;
    was_inserted := false;
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO public.consent_requests (
    id, created_at, updated_at, practice_id, patient_id, created_by,
    appointment_id, form_id, token, token_hash, expires_at, title, body_text,
    status, signer_name, signed_at, signature_png_bytes, signature_sha256,
    signature_method, signer_attestation_version, document_render_version,
    storage_lease_token, storage_lease_expires_at, file_id, signed_file_key,
    signed_file_checksum_sha256, signed_file_size_bytes,
    signed_file_object_etag, signed_file_object_version_id, deleted_at
  ) VALUES (
    restored_evidence_id, restored_created_at, restored_updated_at,
    p_practice_id, restored_patient_id, restored_created_by,
    restored_appointment_id, restored_form_id, NULL, NULL,
    restored_expires_at, p_evidence->>'title', p_evidence->>'bodyText',
    'signed', p_evidence->>'signerName', restored_signed_at,
    restored_signature_bytes, p_evidence->>'signatureSha256',
    p_evidence->>'signatureMethod', p_evidence->>'signerAttestationVersion',
    p_evidence->>'documentRenderVersion', NULL, NULL, restored_file_id,
    p_evidence->>'signedFileKey', p_evidence->>'signedFileChecksumSha256',
    restored_file_size, NULL, NULL, NULL
  );

  result_id := restored_evidence_id;
  was_inserted := true;
  RETURN NEXT;
END
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.resolve_consent_document_render_version(uuid,uuid,uuid,text,text,integer,text,integer)
  FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.resolve_unreserved_consent_document_render_version(uuid,uuid)
  FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.restore_signed_consent_evidence(uuid,jsonb)
  FROM PUBLIC;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'openpims_app') THEN
    REVOKE ALL ON FUNCTION public.resolve_consent_document_render_version(uuid,uuid,uuid,text,text,integer,text,integer) FROM openpims_app;
    GRANT EXECUTE ON FUNCTION public.resolve_unreserved_consent_document_render_version(uuid,uuid) TO openpims_app;
    REVOKE ALL ON FUNCTION public.restore_signed_consent_evidence(uuid,jsonb) FROM openpims_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.resolve_consent_document_render_version(uuid,uuid,uuid,text,text,integer,text,integer) FROM anon;
    REVOKE ALL ON FUNCTION public.resolve_unreserved_consent_document_render_version(uuid,uuid) FROM anon;
    REVOKE ALL ON FUNCTION public.restore_signed_consent_evidence(uuid,jsonb) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.resolve_consent_document_render_version(uuid,uuid,uuid,text,text,integer,text,integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.resolve_unreserved_consent_document_render_version(uuid,uuid) FROM authenticated;
    REVOKE ALL ON FUNCTION public.restore_signed_consent_evidence(uuid,jsonb) FROM authenticated;
  END IF;
END
$$;
