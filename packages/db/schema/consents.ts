import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  index,
  timestamp,
  uniqueIndex,
  foreignKey,
  check,
  customType,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { baseColumns } from "./common";
import { practices } from "./practices";
import { patients } from "./patients";
import { users } from "./users";
import { files } from "./files";
import { appointments } from "./scheduling";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

const SIGNATURE_PNG_MAX_BYTES = 500_000;

/**
 * Per-practice consent form templates. Seeded from the starter library
 * (apps/web/lib/consult/consent-form-library.ts) the first time a practice
 * reads its form list; practices edit titles/bodies to fit how they work.
 * Every e-sign dispatch picks one of these, so a signed document always
 * answers "what did they sign".
 */
export const consentForms = pgTable(
  "consent_forms",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    /** Stable key from the starter library (e.g. "surgery-anesthesia"). */
    slug: varchar("slug", { length: 64 }).notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    body: text("body").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
  },
  (table) => ({
    practiceSlugUq: uniqueIndex("consent_forms_practice_slug_uq").on(
      table.practiceId,
      table.slug,
    ),
    practiceIdx: index("consent_forms_practice_idx").on(
      table.practiceId,
      table.deletedAt,
    ),
    practiceIdUq: uniqueIndex("consent_forms_practice_id_uq").on(
      table.practiceId,
      table.id,
    ),
  }),
);

export const consentFormsRelations = relations(consentForms, ({ one }) => ({
  practice: one(practices, {
    fields: [consentForms.practiceId],
    references: [practices.id],
  }),
}));

/**
 * E-sign consent requests. A staff member dispatches one from a patient
 * chart (same QR capability-link model as capture_sessions); the client
 * opens the no-login /sign/[token] page, reads the consent text snapshot
 * stored here, and signs. The durable record is the signed PDF in the
 * files table plus an audit row; this row carries the expiring token and
 * the signing metadata.
 */
export const consentRequests = pgTable(
  "consent_requests",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    createdBy: uuid("created_by").references(() => users.id),
    /** The visit open when the request was dispatched (resolved server-side
     * from the patient's checked-in/in-exam appointment); copied onto the
     * signed PDF's file row so the consent attaches to that visit. */
    appointmentId: uuid("appointment_id").references(() => appointments.id),
    /** The form this dispatch was based on ("what are they signing?").
     * Nullable only for requests that predate the form library; the title
     * and body below stay the durable snapshot either way. */
    formId: uuid("form_id").references(() => consentForms.id),
    /** Legacy plaintext capability token. New treatment-plan signing links
     * store only tokenHash so a database read cannot recover the credential. */
    token: varchar("token", { length: 64 }),
    /** SHA-256 digest of a capability token. Exactly one of token/tokenHash
     * is present during the backwards-compatible expand/contract rollout. */
    tokenHash: varchar("token_hash", { length: 64 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Consent copy is snapshotted at dispatch time so later template edits
     * never change what someone already signed. */
    title: varchar("title", { length: 200 }).notNull(),
    bodyText: text("body_text").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    signerName: varchar("signer_name", { length: 120 }),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    /** Exact canonical PNG evidence captured by the first successful claim.
     * Nullable so already-signed legacy rows remain valid. New signing flows
     * persist this before rendering or provider I/O and always reuse it. */
    signaturePngBytes: bytea("signature_png_bytes"),
    signatureSha256: varchar("signature_sha256", { length: 64 }),
    /** How the signer supplied the signature mark. New claims persist this
     * alongside the exact PNG; null is reserved for pre-migration evidence. */
    signatureMethod: varchar("signature_method", { length: 16 }),
    /** Versioned evidence that the signer explicitly confirmed owner or
     * authorized-agent authority before the signature was accepted. */
    signerAttestationVersion: varchar("signer_attestation_version", {
      length: 64,
    }),
    /** Immutable renderer selected by the pending -> signing claim. Null is
     * reserved for pre-migration signing rows. Without a reservation,
     * attested rows infer v2 and older unattested rows v1; with one, the route
     * requires a unique checksum-and-size match before persisting either. */
    documentRenderVersion: varchar("document_render_version", { length: 32 }),
    /** Short durable fence around object-store work. Recovery acquires the
     * practice row exclusively and refuses to start while an unexpired fence
     * exists, so provider I/O never needs to hold a database connection. */
    storageLeaseToken: uuid("storage_lease_token"),
    storageLeaseExpiresAt: timestamp("storage_lease_expires_at", {
      withTimezone: true,
    }),
    /** The signed consent PDF in the files table. */
    fileId: uuid("file_id").references(() => files.id),
    /** Frozen manifest evidence captured by the signing -> signed transition.
     * These columns let PostgreSQL prove that the referenced file still names
     * the exact PDF generation that completed the consent. Older signed rows
     * may keep the whole group null; every new finalization supplies it. */
    signedFileKey: varchar("signed_file_key", { length: 512 }),
    signedFileChecksumSha256: varchar("signed_file_checksum_sha256", {
      length: 64,
    }),
    signedFileSizeBytes: integer("signed_file_size_bytes"),
    signedFileObjectEtag: varchar("signed_file_object_etag", { length: 255 }),
    signedFileObjectVersionId: varchar("signed_file_object_version_id", {
      length: 255,
    }),
  },
  (table) => ({
    tokenUq: uniqueIndex("consent_requests_token_uq").on(table.token),
    tokenHashUq: uniqueIndex("consent_requests_token_hash_uq").on(
      table.tokenHash,
    ),
    practiceIdUq: uniqueIndex("consent_requests_practice_id_uq").on(
      table.practiceId,
      table.id,
    ),
    practiceIdx: index("consent_requests_practice_idx").on(
      table.practiceId,
      table.deletedAt,
    ),
    patientIdx: index("consent_requests_patient_idx").on(table.patientId),
    patientTenantFk: foreignKey({
      columns: [table.practiceId, table.patientId],
      foreignColumns: [patients.practiceId, patients.id],
      name: "consent_requests_patient_tenant_fk",
    }),
    creatorTenantFk: foreignKey({
      columns: [table.practiceId, table.createdBy],
      foreignColumns: [users.practiceId, users.id],
      name: "consent_requests_creator_tenant_fk",
    }),
    appointmentPatientTenantFk: foreignKey({
      columns: [table.practiceId, table.appointmentId, table.patientId],
      foreignColumns: [
        appointments.practiceId,
        appointments.id,
        appointments.patientId,
      ],
      name: "consent_requests_appointment_patient_tenant_fk",
    }),
    formTenantFk: foreignKey({
      columns: [table.practiceId, table.formId],
      foreignColumns: [consentForms.practiceId, consentForms.id],
      name: "consent_requests_form_tenant_fk",
    }),
    fileTenantFk: foreignKey({
      columns: [table.practiceId, table.fileId],
      foreignColumns: [files.practiceId, files.id],
      name: "consent_requests_file_tenant_fk",
    }),
    statusCheck: check(
      "consent_requests_status_check",
      sql`${table.status} in ('pending', 'signing', 'signed')`,
    ),
    credentialStorageCheck: check(
      "consent_requests_credential_storage_check",
      sql`(${table.token} is not null and ${table.tokenHash} is null) or (${table.token} is null and ${table.tokenHash} is not null) or (${table.status} = 'signed' and ${table.token} is null and ${table.tokenHash} is null)`,
    ),
    tokenHashFormatCheck: check(
      "consent_requests_token_hash_format_check",
      sql`${table.tokenHash} is null or ${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    documentRenderVersionCheck: check(
      "consent_requests_document_render_version_check",
      sql`${table.documentRenderVersion} is null or ${table.documentRenderVersion} in ('consent-pdf-v1', 'consent-pdf-v2')`,
    ),
    storageLeasePairCheck: check(
      "consent_requests_storage_lease_pair_check",
      sql`(${table.storageLeaseToken} is null and ${table.storageLeaseExpiresAt} is null) or (${table.storageLeaseToken} is not null and ${table.storageLeaseExpiresAt} is not null)`,
    ),
    storageLeaseStateCheck: check(
      "consent_requests_storage_lease_state_check",
      sql`${table.storageLeaseToken} is null or ${table.status} = 'signing'`,
    ),
    signingEvidenceCheck: check(
      "consent_requests_signing_evidence_check",
      sql`(${table.status} = 'pending' and ${table.signerName} is null and ${table.signedAt} is null and ${table.fileId} is null and ${table.signaturePngBytes} is null and ${table.signatureSha256} is null) or (${table.status} = 'signing' and ${table.signerName} is not null and ${table.signedAt} is not null and ${table.signaturePngBytes} is not null and ${table.signatureSha256} is not null) or (${table.status} = 'signed' and ${table.signerName} is not null and ${table.signedAt} is not null and ${table.fileId} is not null)`,
    ),
    signatureEvidencePairCheck: check(
      "consent_requests_signature_evidence_pair_check",
      sql`(${table.signaturePngBytes} is null and ${table.signatureSha256} is null) or (${table.signaturePngBytes} is not null and ${table.signatureSha256} is not null)`,
    ),
    signatureEvidenceSizeCheck: check(
      "consent_requests_signature_evidence_size_check",
      sql`${table.signaturePngBytes} is null or octet_length(${table.signaturePngBytes}) between 1 and ${sql.raw(String(SIGNATURE_PNG_MAX_BYTES))}`,
    ),
    signatureEvidenceHashCheck: check(
      "consent_requests_signature_evidence_hash_check",
      sql`${table.signatureSha256} is null or (${table.signatureSha256} ~ '^[0-9a-f]{64}$' and ${table.signatureSha256} = pg_catalog.encode(pg_catalog.sha256(${table.signaturePngBytes}), 'hex'))`,
    ),
    signatureMethodCheck: check(
      "consent_requests_signature_method_check",
      sql`${table.signatureMethod} is null or ${table.signatureMethod} in ('drawn', 'typed')`,
    ),
    signedFileBindingCheck: check(
      "consent_requests_signed_file_binding_check",
      sql`(${table.signedFileKey} is null and ${table.signedFileChecksumSha256} is null and ${table.signedFileSizeBytes} is null and ${table.signedFileObjectEtag} is null and ${table.signedFileObjectVersionId} is null) or (${table.fileId} is not null and ${table.signedFileKey} is not null and ${table.signedFileChecksumSha256} ~ '^[0-9a-f]{64}$' and ${table.signedFileSizeBytes} > 0)`,
    ),
  }),
);

/**
 * Short-lived, download-only capabilities returned once after a successful
 * public signing commit. Only the digest is retained. The bound file checksum
 * and size make every claim specific to the exact signed PDF generation.
 */
export const consentReceiptCapabilities = pgTable(
  "consent_receipt_capabilities",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    consentRequestId: uuid("consent_request_id")
      .notNull()
      .references(() => consentRequests.id),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id),
    fileChecksumSha256: varchar("file_checksum_sha256", {
      length: 64,
    }).notNull(),
    fileSizeBytes: integer("file_size_bytes").notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    claimCount: integer("claim_count").notNull().default(0),
    maxClaims: integer("max_claims").notNull().default(3),
    lastClaimedAt: timestamp("last_claimed_at", { withTimezone: true }),
  },
  (table) => ({
    tokenHashUq: uniqueIndex("consent_receipt_capabilities_token_hash_uq").on(
      table.tokenHash,
    ),
    consentUq: uniqueIndex("consent_receipt_capabilities_consent_uq").on(
      table.practiceId,
      table.consentRequestId,
    ),
    practiceExpiryIdx: index("consent_receipt_capabilities_practice_expiry_idx")
      .on(table.practiceId, table.expiresAt)
      .where(sql`${table.deletedAt} is null`),
    consentTenantFk: foreignKey({
      columns: [table.practiceId, table.consentRequestId],
      foreignColumns: [consentRequests.practiceId, consentRequests.id],
      name: "consent_receipt_capabilities_consent_tenant_fk",
    }),
    fileTenantFk: foreignKey({
      columns: [table.practiceId, table.fileId],
      foreignColumns: [files.practiceId, files.id],
      name: "consent_receipt_capabilities_file_tenant_fk",
    }),
    tokenHashCheck: check(
      "consent_receipt_capabilities_token_hash_check",
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    checksumCheck: check(
      "consent_receipt_capabilities_checksum_check",
      sql`${table.fileChecksumSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    fileSizeCheck: check(
      "consent_receipt_capabilities_file_size_check",
      sql`${table.fileSizeBytes} > 0`,
    ),
    expiryCheck: check(
      "consent_receipt_capabilities_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '15 minutes'`,
    ),
    claimsCheck: check(
      "consent_receipt_capabilities_claims_check",
      sql`${table.maxClaims} between 1 and 3 and ${table.claimCount} between 0 and ${table.maxClaims}`,
    ),
    claimEvidenceCheck: check(
      "consent_receipt_capabilities_claim_evidence_check",
      sql`(${table.claimCount} = 0 and ${table.lastClaimedAt} is null) or (${table.claimCount} > 0 and ${table.lastClaimedAt} is not null)`,
    ),
  }),
);

export const consentRequestsRelations = relations(
  consentRequests,
  ({ one, many }) => ({
    practice: one(practices, {
      fields: [consentRequests.practiceId],
      references: [practices.id],
    }),
    patient: one(patients, {
      fields: [consentRequests.patientId],
      references: [patients.id],
    }),
    creator: one(users, {
      fields: [consentRequests.createdBy],
      references: [users.id],
    }),
    file: one(files, {
      fields: [consentRequests.fileId],
      references: [files.id],
    }),
    appointment: one(appointments, {
      fields: [consentRequests.appointmentId],
      references: [appointments.id],
    }),
    form: one(consentForms, {
      fields: [consentRequests.formId],
      references: [consentForms.id],
    }),
    receiptCapabilities: many(consentReceiptCapabilities),
  }),
);

export const consentReceiptCapabilitiesRelations = relations(
  consentReceiptCapabilities,
  ({ one }) => ({
    practice: one(practices, {
      fields: [consentReceiptCapabilities.practiceId],
      references: [practices.id],
    }),
    consentRequest: one(consentRequests, {
      fields: [consentReceiptCapabilities.consentRequestId],
      references: [consentRequests.id],
    }),
    file: one(files, {
      fields: [consentReceiptCapabilities.fileId],
      references: [files.id],
    }),
  }),
);
