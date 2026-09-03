/**
 * Real-PostgreSQL contract for signed-consent immutability and exact-file
 * recovery. Run only against an isolated database after migrations + RLS:
 *
 *   DATABASE_URL=... OPENPIMS_APP_DATABASE_URL=... pnpm db:consent-evidence:test
 */
import { createHash, randomUUID } from "crypto";
import postgres, { type Sql } from "postgres";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must name an isolated test database`);
  return value;
}

const ownerUrl = requiredEnv("DATABASE_URL");
const appUrl = requiredEnv("OPENPIMS_APP_DATABASE_URL");
if (ownerUrl === appUrl) {
  throw new Error("Owner and openpims_app connections must be distinct");
}

const owner = postgres(ownerUrl, { max: 1 });
const app = postgres(appUrl, { max: 1 });

const ids = {
  practiceA: randomUUID(),
  practiceB: randomUUID(),
  userA: randomUUID(),
  userB: randomUUID(),
  clientA: randomUUID(),
  clientB: randomUUID(),
  patientA: randomUUID(),
  patientB: randomUUID(),
  consent: randomUUID(),
  file: randomUUID(),
  deferredConsent: randomUUID(),
  deferredFile: randomUUID(),
  ordinaryFile: randomUUID(),
  unreservedConsent: randomUUID(),
  restoreConsent: randomUUID(),
  restoreFile: randomUUID(),
  legacyRestoreConsent: randomUUID(),
  legacyRestoreFile: randomUUID(),
  restoreForm: randomUUID(),
  receipt: randomUUID(),
};
const leaseToken = randomUUID();
const deferredLeaseToken = randomUUID();
const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const signatureHash = createHash("sha256").update(signature).digest("hex");
const portableSignature = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const portableSignatureHash = createHash("sha256")
  .update(portableSignature)
  .digest("hex");
const pdfHash = createHash("sha256").update("signed-pdf-v2").digest("hex");
const wrongHash = createHash("sha256").update("tampered-pdf").digest("hex");
const pdfSize = 13;
const fileKey = `${ids.practiceA}/consents/${ids.file}.pdf`;
const fileUrl = `/api/files/${fileKey}`;
const deferredFileKey = `${ids.practiceA}/consents/${ids.deferredFile}.pdf`;

async function withPractice<T>(
  sql: Sql,
  practiceId: string,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    const scoped = tx as unknown as Sql;
    await scoped`select set_config('app.current_practice_id', ${practiceId}, true)`;
    return fn(scoped);
  }) as Promise<T>;
}

async function expectRejected(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    if (
      code === "22023" ||
      code === "23505" ||
      code === "23514" ||
      code === "42501"
    ) {
      console.log(`  ✓ ${name}`);
      return;
    }
    throw error;
  }
  throw new Error(`${name}: mutation unexpectedly succeeded`);
}

try {
  await owner`insert into practices (id, name) values
    (${ids.practiceA}, 'Consent Guard A'),
    (${ids.practiceB}, 'Consent Guard B')`;
  await owner`insert into users
    (id, email, password_hash, name, role, practice_id) values
    (${ids.userA}, ${`consent-a-${ids.userA}@example.test`}, 'x', 'Doctor A', 'veterinarian', ${ids.practiceA}),
    (${ids.userB}, ${`consent-b-${ids.userB}@example.test`}, 'x', 'Doctor B', 'veterinarian', ${ids.practiceB})`;
  await owner`insert into clients (id, practice_id, first_name, last_name) values
    (${ids.clientA}, ${ids.practiceA}, 'Client', 'A'),
    (${ids.clientB}, ${ids.practiceB}, 'Client', 'B')`;
  await owner`insert into patients (id, practice_id, client_id, name, species) values
    (${ids.patientA}, ${ids.practiceA}, ${ids.clientA}, 'Patient A', 'canine'),
    (${ids.patientB}, ${ids.practiceB}, ${ids.clientB}, 'Patient B', 'feline')`;

  await owner`insert into consent_requests
    (id, practice_id, patient_id, created_by, token_hash, expires_at, title,
     body_text, status, signer_name, signed_at, signature_png_bytes,
     signature_sha256, signature_method, signer_attestation_version)
    values (${ids.unreservedConsent}, ${ids.practiceA}, ${ids.patientA},
      ${ids.userA}, ${"d".repeat(64)}, clock_timestamp() + interval '1 hour',
      'Legacy no-file consent', 'Legacy frozen disclosure', 'signing',
      'Client A', clock_timestamp(), ${signature}, ${signatureHash}, 'drawn',
      'owner-authority-v1')`;
  await withPractice(app, ids.practiceA, async (tx) => {
    const [resolved] = await tx`select
      resolve_unreserved_consent_document_render_version(
        ${ids.practiceA}, ${ids.unreservedConsent}
      ) as version`;
    if (resolved?.version !== "consent-pdf-v2") {
      throw new Error("no-file legacy renderer was not inferred from attestation");
    }
  });
  console.log("  ✓ no-file renderer recovery accepts no caller label or checksum slots");

  await expectRejected("app role cannot swap reserved renderer digest slots", () =>
    withPractice(app, ids.practiceA, (tx) =>
      tx`select resolve_consent_document_render_version(
        ${ids.practiceA}, ${ids.unreservedConsent}, ${ids.file},
        'owner-authority-v1', ${pdfHash}, ${pdfSize}, ${wrongHash}, ${pdfSize}
      )`,
    ),
  );
  await expectRejected("app role cannot invoke sealed evidence restore", () =>
    withPractice(app, ids.practiceA, (tx) =>
      tx`select restore_signed_consent_evidence(${ids.practiceA}, ${"{}"}::jsonb)`,
    ),
  );
  console.log("  ✓ owner-only recovery functions deny openpims_app execution");

  await withPractice(app, ids.practiceA, async (tx) => {
    await tx`insert into consent_requests
      (id, practice_id, patient_id, created_by, token_hash, expires_at,
       title, body_text, status)
      values (${ids.consent}, ${ids.practiceA}, ${ids.patientA}, ${ids.userA},
        ${"a".repeat(64)}, clock_timestamp() + interval '1 hour',
        'Frozen consent', 'Frozen disclosure', 'pending')`;

    await tx`update consent_requests set
      status = 'signing', signer_name = 'Client A',
      signed_at = clock_timestamp(), signature_png_bytes = ${signature},
      signature_sha256 = ${signatureHash}, signature_method = 'drawn',
      signer_attestation_version = 'owner-authority-v1',
      document_render_version = 'consent-pdf-v2'
      where id = ${ids.consent} and practice_id = ${ids.practiceA}`;

    await tx`insert into files
      (id, practice_id, uploaded_by, file_name, file_key, file_url,
       mime_type, file_size_bytes, checksum_sha256, storage_status,
       category, source, idempotency_key, entity_type, entity_id, patient_id)
      values (${ids.file}, ${ids.practiceA}, ${ids.userA}, 'signed.pdf',
        ${fileKey}, ${fileUrl}, 'application/pdf', ${pdfSize}, ${pdfHash},
        'pending_upload', 'consents', 'consent_signature', ${ids.consent},
        'patient', ${ids.patientA}, ${ids.patientA})`;
    await tx`update consent_requests set file_id = ${ids.file}
      where id = ${ids.consent} and practice_id = ${ids.practiceA}`;
    await tx`update consent_requests set
      storage_lease_token = ${leaseToken},
      storage_lease_expires_at = clock_timestamp() + interval '2 minutes'
      where id = ${ids.consent} and practice_id = ${ids.practiceA}`;
  });
  console.log("  ✓ allowed pending→signing→exact-file binding→lease committed");

  await expectRejected("generic lease release cannot clear another worker's fence", () =>
    withPractice(app, ids.practiceA, (tx) =>
      tx`update consent_requests set storage_lease_token = null,
        storage_lease_expires_at = null
        where id = ${ids.consent} and practice_id = ${ids.practiceA}`,
    ),
  );

  await withPractice(app, ids.practiceA, async (tx) => {
    const [completed] = await tx`select finalize_consent_request(
      ${ids.practiceA}, ${ids.consent}, ${ids.file}, ${leaseToken},
      ${fileKey}, ${pdfHash}, ${pdfSize}, 'etag-v1', 'version-v1') as ok`;
    if (completed?.ok !== true) throw new Error("fenced finalization failed");
    await tx`update files set storage_status = 'available',
      storage_verified_at = clock_timestamp(), object_etag = 'etag-v1',
      object_version_id = 'version-v1'
      where id = ${ids.file} and practice_id = ${ids.practiceA}`;
  });
  console.log("  ✓ exact fenced finalization and file availability committed");

  await withPractice(app, ids.practiceA, async (tx) => {
    const ordinaryKey = `${ids.practiceA}/documents/${ids.ordinaryFile}`;
    await tx`insert into files
      (id, practice_id, uploaded_by, file_name, file_key, file_url,
       mime_type, storage_status, category, source, entity_type, entity_id, patient_id)
      values (${ids.ordinaryFile}, ${ids.practiceA}, ${ids.userA}, 'ordinary.txt',
        ${ordinaryKey}, ${`/api/files/${ordinaryKey}`}, 'text/plain',
        'pending_upload', 'documents', 'patient_upload', 'patient',
        ${ids.patientA}, ${ids.patientA})`;
  });
  await expectRejected("ordinary files cannot be relabeled into signature evidence", () =>
    withPractice(app, ids.practiceA, (tx) =>
      tx`update files set category = 'consents', source = 'consent_signature',
        mime_type = 'application/pdf', file_size_bytes = ${pdfSize},
        checksum_sha256 = ${pdfHash}, idempotency_key = ${ids.consent}
        where id = ${ids.ordinaryFile} and practice_id = ${ids.practiceA}`,
    ),
  );

  await expectRejected("signed signer_name is immutable", () =>
    withPractice(app, ids.practiceA, (tx) =>
      tx`update consent_requests set signer_name = 'Changed'
        where id = ${ids.consent} and practice_id = ${ids.practiceA}`,
    ),
  );
  await expectRejected("signed PDF checksum is immutable", () =>
    withPractice(app, ids.practiceA, (tx) =>
      tx`update files set checksum_sha256 = ${wrongHash}
        where id = ${ids.file} and practice_id = ${ids.practiceA}`,
    ),
  );
  await expectRejected("signed PDF size is immutable", () =>
    withPractice(app, ids.practiceA, (tx) =>
      tx`update files set file_size_bytes = ${pdfSize + 1}
        where id = ${ids.file} and practice_id = ${ids.practiceA}`,
    ),
  );
  await expectRejected("signed consent DELETE privilege is revoked", () =>
    withPractice(app, ids.practiceA, (tx) =>
      tx`delete from consent_requests
        where id = ${ids.consent} and practice_id = ${ids.practiceA}`,
    ),
  );

  await withPractice(app, ids.practiceB, async (tx) => {
    const [consentCount] =
      await tx`select count(*)::integer as count from consent_requests where id = ${ids.consent}`;
    const [fileCount] =
      await tx`select count(*)::integer as count from files where id = ${ids.file}`;
    if (consentCount?.count !== 0 || fileCount?.count !== 0) {
      throw new Error("cross-tenant signed evidence became visible");
    }
    const updated = await tx`update consent_requests set signer_name = 'Tenant B'
      where id = ${ids.consent} returning id`;
    if (updated.length !== 0) throw new Error("cross-tenant update succeeded");
  });
  console.log("  ✓ RLS hides and prevents cross-tenant evidence mutation");

  await expectRejected("failed evidence mutation aborts its transaction", () =>
    withPractice(app, ids.practiceA, async (tx) => {
      await tx`update patients set color = 'rollback-sentinel'
        where id = ${ids.patientA} and practice_id = ${ids.practiceA}`;
      await tx`update consent_requests set signer_name = 'Changed'
        where id = ${ids.consent} and practice_id = ${ids.practiceA}`;
    }),
  );
  const [rolledBack] = await owner`select color from patients where id = ${ids.patientA}`;
  if (rolledBack?.color !== null) throw new Error("failed transaction did not roll back");
  console.log("  ✓ prohibited mutation rolls the transaction back atomically");

  await withPractice(app, ids.practiceA, async (tx) => {
    await tx`select set_config('app.rls_bypass', 'on', true)`;
    const [down] = await tx`select transition_signed_consent_file_storage(
      ${ids.practiceA}, ${ids.file}, ${fileKey}, ${pdfHash}, ${pdfSize},
      'available'::file_storage_status, 'missing'::file_storage_status,
      null, null, null) as ok`;
    if (down?.ok !== true) throw new Error("exact-byte unavailable transition failed");
    const [wrong] = await tx`select transition_signed_consent_file_storage(
      ${ids.practiceA}, ${ids.file}, ${fileKey}, ${wrongHash}, ${pdfSize},
      'missing'::file_storage_status, 'available'::file_storage_status,
      clock_timestamp(), 'etag-v2', 'version-v2') as ok`;
    if (wrong?.ok !== false) throw new Error("mismatched recovery unexpectedly succeeded");
    const [up] = await tx`select transition_signed_consent_file_storage(
      ${ids.practiceA}, ${ids.file}, ${fileKey}, ${pdfHash}, ${pdfSize},
      'missing'::file_storage_status, 'available'::file_storage_status,
      clock_timestamp(), 'etag-v2', 'version-v2') as ok`;
    if (up?.ok !== true) throw new Error("exact-byte restore failed");
  });
  const [recovered] = await owner`select storage_status, file_key,
    checksum_sha256, file_size_bytes, object_etag, object_version_id
    from files where id = ${ids.file}`;
  if (
    recovered?.storage_status !== "available" ||
    recovered?.file_key !== fileKey ||
    recovered?.checksum_sha256 !== pdfHash ||
    recovered?.file_size_bytes !== pdfSize ||
    recovered?.object_etag !== "etag-v2" ||
    recovered?.object_version_id !== "version-v2"
  ) {
    throw new Error("recovery changed immutable bytes or lost verified metadata");
  }
  console.log("  ✓ system recovery is exact-byte, tenant-bound, and CAS-scoped");

  await expectRejected("receipt expiry cannot be moved beyond the DB-time window", () =>
    withPractice(app, ids.practiceA, (tx) =>
      tx`insert into consent_receipt_capabilities
        (id, created_at, practice_id, consent_request_id, file_id,
         file_checksum_sha256, file_size_bytes, token_hash, expires_at)
        values (${ids.receipt}, clock_timestamp() + interval '1 year',
          ${ids.practiceA}, ${ids.consent}, ${ids.file}, ${pdfHash}, ${pdfSize},
          ${"c".repeat(64)}, clock_timestamp() + interval '1 year 15 minutes')`,
    ),
  );
  await withPractice(app, ids.practiceA, async (tx) => {
    await tx`insert into consent_receipt_capabilities
      (id, practice_id, consent_request_id, file_id, file_checksum_sha256,
       file_size_bytes, token_hash, expires_at)
      values (${ids.receipt}, ${ids.practiceA}, ${ids.consent}, ${ids.file},
        ${pdfHash}, ${pdfSize}, ${"c".repeat(64)},
        transaction_timestamp() + interval '15 minutes')`;
    await tx`update consent_receipt_capabilities
      set claim_count = claim_count + 1,
          last_claimed_at = clock_timestamp() + interval '1 year',
          updated_at = clock_timestamp() + interval '1 year'
      where id = ${ids.receipt} and claim_count = 0`;
  });
  const [receipt] = await owner`select created_at, updated_at, last_claimed_at,
    expires_at, claim_count from consent_receipt_capabilities where id = ${ids.receipt}`;
  if (
    receipt?.claim_count !== 1 ||
    !(receipt.created_at instanceof Date) ||
    !(receipt.updated_at instanceof Date) ||
    !(receipt.last_claimed_at instanceof Date) ||
    !(receipt.expires_at instanceof Date) ||
    receipt.updated_at.getTime() !== receipt.last_claimed_at.getTime() ||
    receipt.expires_at.getTime() - receipt.created_at.getTime() > 15 * 60_000 ||
    receipt.updated_at.getTime() > Date.now() + 5_000
  ) {
    throw new Error("receipt timestamps or claim evidence were not DB-anchored");
  }
  console.log("  ✓ receipt TTL and claim timestamps are anchored to database time");

  await withPractice(app, ids.practiceA, async (tx) => {
    await tx`insert into consent_requests
      (id, practice_id, patient_id, created_by, token_hash, expires_at,
       title, body_text, status)
      values (${ids.deferredConsent}, ${ids.practiceA}, ${ids.patientA}, ${ids.userA},
        ${"b".repeat(64)}, clock_timestamp() + interval '1 hour',
        'Deferred consent', 'Deferred disclosure', 'pending')`;
    await tx`update consent_requests set status = 'signing',
      signer_name = 'Client A', signed_at = clock_timestamp(),
      signature_png_bytes = ${signature}, signature_sha256 = ${signatureHash},
      signature_method = 'typed', signer_attestation_version = 'owner-authority-v1',
      document_render_version = 'consent-pdf-v2'
      where id = ${ids.deferredConsent} and practice_id = ${ids.practiceA}`;
    await tx`insert into files
      (id, practice_id, uploaded_by, file_name, file_key, file_url,
       mime_type, file_size_bytes, checksum_sha256, storage_status,
       category, source, idempotency_key, entity_type, entity_id, patient_id)
      values (${ids.deferredFile}, ${ids.practiceA}, ${ids.userA}, 'deferred.pdf',
        ${deferredFileKey}, ${`/api/files/${deferredFileKey}`}, 'application/pdf',
        ${pdfSize}, ${pdfHash}, 'pending_upload', 'consents',
        'consent_signature', ${ids.deferredConsent}, 'patient',
        ${ids.patientA}, ${ids.patientA})`;
    await tx`update consent_requests set file_id = ${ids.deferredFile}
      where id = ${ids.deferredConsent} and practice_id = ${ids.practiceA}`;
    await tx`update consent_requests set storage_lease_token = ${deferredLeaseToken},
      storage_lease_expires_at = clock_timestamp() + interval '2 minutes'
      where id = ${ids.deferredConsent} and practice_id = ${ids.practiceA}`;
  });

  await expectRejected("deferred guard rejects signed request with unavailable PDF", () =>
    withPractice(app, ids.practiceA, async (tx) => {
      const [completed] = await tx`select finalize_consent_request(
        ${ids.practiceA}, ${ids.deferredConsent}, ${ids.deferredFile},
        ${deferredLeaseToken}, ${deferredFileKey}, ${pdfHash}, ${pdfSize},
        'etag-deferred', 'version-deferred') as ok`;
      if (completed?.ok !== true) throw new Error("fenced finalization did not run");
    },
    ),
  );
  const [deferred] = await owner`select status, storage_lease_token is not null as leased
    from consent_requests where id = ${ids.deferredConsent}`;
  if (deferred?.status !== "signing" || deferred?.leased !== true) {
    throw new Error("deferred validation failure did not preserve recovery state");
  }
  console.log("  ✓ deferred validation failure preserves signing recovery state");

  const restoreFileKey = `${ids.practiceA}/consents/${ids.restoreFile}.pdf`;
  const legacyRestoreFileKey =
    `${ids.practiceA}/consents/${ids.legacyRestoreFile}.pdf`;
  const restoreCreatedAt = new Date(Date.now() - 60_000).toISOString();
  const restoreUpdatedAt = new Date(Date.now() - 30_000).toISOString();
  const restoreSignedAt = new Date(Date.now() - 45_000).toISOString();
  const restoreExpiresAt = new Date(Date.now() - 15_000).toISOString();
  const sealedEvidence = {
    evidenceProfile: "attested-signature-v1",
    id: ids.restoreConsent,
    createdAt: restoreCreatedAt,
    updatedAt: restoreUpdatedAt,
    practiceId: ids.practiceA,
    patientId: ids.patientA,
    createdBy: ids.userA,
    appointmentId: null,
    formId: ids.restoreForm,
    expiresAt: restoreExpiresAt,
    title: "Portable signed consent",
    bodyText: "Exact frozen legal disclosure.",
    signerName: "Client A",
    signedAt: restoreSignedAt,
    signaturePngBase64: portableSignature.toString("base64"),
    signatureSha256: portableSignatureHash,
    signatureMethod: "typed",
    signerAttestationVersion: "owner-authority-v1",
    documentRenderVersion: "consent-pdf-v2",
    fileId: ids.restoreFile,
    signedFileKey: restoreFileKey,
    signedFileChecksumSha256: pdfHash,
    signedFileSizeBytes: pdfSize,
  };
  const legacySealedEvidence = {
    ...sealedEvidence,
    evidenceProfile: "legacy-pre-attestation-v1",
    id: ids.legacyRestoreConsent,
    title: "Portable legacy signed consent",
    bodyText: "Exact frozen pre-attestation disclosure.",
    signatureMethod: null,
    signerAttestationVersion: null,
    documentRenderVersion: null,
    fileId: ids.legacyRestoreFile,
    signedFileKey: legacyRestoreFileKey,
  };

  await owner`update practices set recovery_hold = true,
    recovery_hold_set_at = clock_timestamp(),
    recovery_hold_reason = 'isolated sealed consent restore test'
    where id = ${ids.practiceA}`;
  await owner`insert into consent_forms
    (id, practice_id, slug, title, body, is_active)
    values (${ids.restoreForm}, ${ids.practiceA}, 'portable-signed',
      'Portable signed consent', 'Exact frozen legal disclosure.', false)`;
  await owner`insert into files
    (id, practice_id, uploaded_by, file_name, file_key, file_url, mime_type,
     file_size_bytes, checksum_sha256, storage_status, category, source,
     idempotency_key, entity_type, entity_id, patient_id)
    values (${ids.restoreFile}, ${ids.practiceA}, ${ids.userA}, 'restored-signed.pdf',
      ${restoreFileKey}, ${`/api/files/${restoreFileKey}`}, 'application/pdf',
      ${pdfSize}, ${pdfHash}, 'unverified', 'consents', 'consent_signature',
      ${ids.restoreConsent}, 'patient', ${ids.patientA}, ${ids.patientA})`;
  await owner`insert into files
    (id, practice_id, uploaded_by, file_name, file_key, file_url, mime_type,
     file_size_bytes, checksum_sha256, storage_status, category, source,
     idempotency_key, entity_type, entity_id, patient_id)
    values (${ids.legacyRestoreFile}, ${ids.practiceA}, ${ids.userA},
      'restored-legacy-signed.pdf', ${legacyRestoreFileKey},
      ${`/api/files/${legacyRestoreFileKey}`}, 'application/pdf', ${pdfSize},
      ${pdfHash}, 'unverified', 'consents', 'consent_signature',
      ${ids.legacyRestoreConsent}, 'patient', ${ids.patientA}, ${ids.patientA})`;

  const [firstRestore] = await owner`select * from restore_signed_consent_evidence(
    ${ids.practiceA}, ${owner.json(sealedEvidence)}
  )`;
  const [replayedRestore] = await owner`select * from restore_signed_consent_evidence(
    ${ids.practiceA}, ${owner.json(sealedEvidence)}
  )`;
  if (firstRestore?.was_inserted !== true || replayedRestore?.was_inserted !== false) {
    throw new Error("owner restore was not insert-only and exactly idempotent");
  }
  console.log("  ✓ owner+hold sealed restore inserts once and exact replay is idempotent");

  const [legacyRestore] = await owner`select * from restore_signed_consent_evidence(
    ${ids.practiceA}, ${owner.json(legacySealedEvidence)}
  )`;
  if (legacyRestore?.was_inserted !== true) {
    throw new Error("truthful legacy sealed evidence was not restored");
  }
  const [legacyRow] = await owner`select signature_method,
    signer_attestation_version, document_render_version, token, token_hash,
    storage_lease_token, storage_lease_expires_at,
    signed_file_object_etag, signed_file_object_version_id
    from consent_requests where id = ${ids.legacyRestoreConsent}`;
  if (
    legacyRow?.signature_method !== null ||
    legacyRow?.signer_attestation_version !== null ||
    legacyRow?.document_render_version !== null ||
    legacyRow?.token !== null ||
    legacyRow?.token_hash !== null ||
    legacyRow?.storage_lease_token !== null ||
    legacyRow?.storage_lease_expires_at !== null ||
    legacyRow?.signed_file_object_etag !== null ||
    legacyRow?.signed_file_object_version_id !== null
  ) {
    throw new Error("legacy restore fabricated provenance or retained secret state");
  }
  console.log("  ✓ legacy restore preserves null provenance and omits capabilities");

  await expectRejected("divergent sealed evidence replay fails closed", () =>
    owner`select restore_signed_consent_evidence(
      ${ids.practiceA}, ${owner.json({ ...sealedEvidence, title: "Changed" })}
    )`,
  );
  await expectRejected("malformed signature hash fails before evidence insertion", () =>
    owner`select restore_signed_consent_evidence(
      ${ids.practiceA}, ${owner.json({
        ...sealedEvidence,
        id: randomUUID(),
        signatureSha256: wrongHash,
      })}
    )`,
  );
  await expectRejected("legacy marker cannot fabricate modern attestation", () =>
    owner`select restore_signed_consent_evidence(
      ${ids.practiceA}, ${owner.json({
        ...legacySealedEvidence,
        id: randomUUID(),
        signerAttestationVersion: "owner-authority-v1",
      })}
    )`,
  );
  await expectRejected("cross-practice sealed restore fails closed", () =>
    owner`select restore_signed_consent_evidence(
      ${ids.practiceB}, ${owner.json({ ...sealedEvidence, practiceId: ids.practiceB })}
    )`,
  );

  await withPractice(app, ids.practiceA, async (tx) => {
    await tx`select set_config('app.rls_bypass', 'on', true)`;
    const [verified] = await tx`select transition_signed_consent_file_storage(
      ${ids.practiceA}, ${ids.restoreFile}, ${restoreFileKey}, ${pdfHash},
      ${pdfSize}, 'unverified'::file_storage_status,
      'available'::file_storage_status, clock_timestamp(), null, null
    ) as ok`;
    if (verified?.ok !== true) throw new Error("restored exact object verification failed");
    const [legacyVerified] = await tx`select transition_signed_consent_file_storage(
      ${ids.practiceA}, ${ids.legacyRestoreFile}, ${legacyRestoreFileKey},
      ${pdfHash}, ${pdfSize}, 'unverified'::file_storage_status,
      'available'::file_storage_status, clock_timestamp(), null, null
    ) as ok`;
    if (legacyVerified?.ok !== true) {
      throw new Error("restored legacy exact object verification failed");
    }
  });
  const [restoredEvidence] = await owner`select token, token_hash,
    storage_lease_token, storage_lease_expires_at, deleted_at,
    signed_file_object_etag, signed_file_object_version_id
    from consent_requests where id = ${ids.restoreConsent}`;
  if (
    restoredEvidence?.token !== null ||
    restoredEvidence?.token_hash !== null ||
    restoredEvidence?.storage_lease_token !== null ||
    restoredEvidence?.storage_lease_expires_at !== null ||
    restoredEvidence?.deleted_at !== null ||
    restoredEvidence?.signed_file_object_etag !== null ||
    restoredEvidence?.signed_file_object_version_id !== null
  ) {
    throw new Error("restored evidence retained a capability, lease, or provider identity");
  }
  console.log("  ✓ restored evidence is capability-free and exact object recovery succeeds");

  console.log("Consent evidence integrity: PASS");
} finally {
  try {
    await owner`delete from consent_receipt_capabilities where id = ${ids.receipt}`;
    await owner`delete from consent_requests where id in (${ids.consent}, ${ids.deferredConsent}, ${ids.unreservedConsent}, ${ids.restoreConsent}, ${ids.legacyRestoreConsent})`;
    await owner`delete from files where id in (${ids.file}, ${ids.deferredFile}, ${ids.ordinaryFile}, ${ids.restoreFile}, ${ids.legacyRestoreFile})`;
    await owner`delete from consent_forms where id = ${ids.restoreForm}`;
    await owner`delete from patients where id in (${ids.patientA}, ${ids.patientB})`;
    await owner`delete from clients where id in (${ids.clientA}, ${ids.clientB})`;
    await owner`delete from users where id in (${ids.userA}, ${ids.userB})`;
    await owner`delete from practices where id in (${ids.practiceA}, ${ids.practiceB})`;
  } finally {
    await app.end();
    await owner.end();
  }
}
