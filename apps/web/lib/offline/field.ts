import { z } from "zod";
import { calculateInvoiceTaxTotals } from "../billing/invoice-tax";
import { moneyToCents } from "../billing/invoice-balance";
import { soapSectionsSchema, EMPTY_SOAP } from "./workspace";
import {
  EncryptedDeviceVault,
  encryptedValueExists,
  type EncryptedVaultRecovery,
} from "./encrypted-vault";

const uuid = z.string().uuid();
const label = z.string().max(500);
const money = z.string().regex(/^\d{1,8}\.\d{2}$/);
const date = z.iso.date();
export const fieldPacketSchema = z
  .object({
    id: uuid,
    userId: uuid,
    practiceId: uuid,
    patientId: uuid,
    clientId: uuid,
    preparedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    appointment: z
      .object({ id: uuid, updatedAt: z.iso.datetime() })
      .strict()
      .nullable(),
    locationId: uuid,
    practice: z
      .object({
        name: label,
        address: label.nullable(),
        phone: label.nullable(),
        currency: z.literal("usd"),
        country: z.literal("US"),
        taxRate: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/),
        timezone: z.string().max(100),
      })
      .strict(),
    clinician: z.object({ name: label, license: label.nullable() }).strict(),
    patient: z
      .object({
        name: label,
        species: label,
        breed: label.nullable(),
        dob: z.string().nullable(),
      })
      .strict(),
    client: z
      .object({
        name: label,
        phone: label.nullable(),
        address: label.nullable(),
      })
      .strict(),
    allergies: z
      .array(
        z
          .object({
            allergen: label,
            reaction: z.string().max(10000).nullable(),
            severity: label,
          })
          .strict(),
      )
      .max(50),
    medications: z
      .array(
        z
          .object({
            name: label,
            dosage: label,
            frequency: label,
            instructions: z.string().max(10000).nullable(),
          })
          .strict(),
      )
      .max(100),
    vaccinations: z
      .array(
        z
          .object({
            name: label,
            administeredAt: z.iso.datetime(),
            nextDueDate: z.string().nullable(),
          })
          .strict(),
      )
      .max(50),
    history: z
      .array(
        z
          .object({ at: z.iso.datetime(), sections: soapSectionsSchema })
          .strict(),
      )
      .max(10),
    notes: z
      .array(
        z
          .object({ content: z.string().max(20000), at: z.iso.datetime() })
          .strict(),
      )
      .max(20),
    services: z
      .array(
        z
          .object({ id: uuid, name: label, price: money, taxable: z.boolean() })
          .strict(),
      )
      .max(500),
  })
  .strict();
export type FieldPacket = z.infer<typeof fieldPacketSchema>;

export const fieldVaccinationSchema = z
  .object({
    id: uuid,
    vaccineName: z.string().trim().min(1).max(255),
    productName: z.string().trim().max(255),
    manufacturer: z.string().trim().max(128),
    lotNumber: z.string().trim().max(64),
    productExpirationDate: date.nullable(),
    administeredAt: z.iso.datetime(),
    nextDueDate: date.nullable(),
    doseType: z.enum(["initial", "booster"]),
    rabiesTagNumber: z.string().trim().max(64),
    serviceId: uuid,
  })
  .strict();
export const fieldVisitSchema = z
  .object({
    startedAt: z.iso.datetime(),
    sections: soapSectionsSchema,
    vaccinations: z.array(fieldVaccinationSchema).max(30),
    charges: z
      .array(
        z
          .object({
            serviceId: uuid,
            quantity: z.number().int().min(1).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    payment: z
      .object({
        method: z.enum(["cash", "check"]),
        amount: money,
        receivedAt: z.iso.datetime(),
        reference: z.string().trim().max(100),
      })
      .strict()
      .nullable(),
    issuedAt: z.iso.datetime(),
  })
  .strict();
export type FieldVisit = z.infer<typeof fieldVisitSchema>;
export const fieldResultSchema = z
  .object({
    appointmentId: uuid,
    noteId: uuid,
    invoiceId: uuid,
    paymentId: uuid.nullable(),
    vaccinationIds: z.array(uuid),
    syncedAt: z.iso.datetime(),
  })
  .strict();
export const fieldSubmissionSchema = z
  .object({ packet: fieldPacketSchema, visit: fieldVisitSchema })
  .strict();
export type FieldSubmission = z.infer<typeof fieldSubmissionSchema>;

export function fieldTotals(
  packet: FieldPacket,
  visit: Pick<FieldVisit, "charges" | "payment">,
) {
  const seen = new Set<string>();
  const lines = visit.charges.map((charge) => {
    const service = packet.services.find(
      (item) => item.id === charge.serviceId,
    );
    if (!service || seen.has(service.id))
      throw new Error("Choose each prepared service only once.");
    seen.add(service.id);
    return {
      ...service,
      quantity: charge.quantity,
      lineTotalCents: moneyToCents(service.price) * charge.quantity,
    };
  });
  const totals = calculateInvoiceTaxTotals(lines, packet.practice.taxRate);
  const paidCents = visit.payment ? moneyToCents(visit.payment.amount) : 0;
  return {
    ...totals,
    lines,
    paidCents,
    balanceCents: totals.totalCents - paidCents,
  };
}

export function validateFieldSubmission(input: FieldSubmission) {
  const { packet, visit } = fieldSubmissionSchema.parse(input);
  const beginning = Date.parse(packet.preparedAt),
    expiry = Date.parse(packet.expiresAt);
  const start = Date.parse(visit.startedAt),
    issued = Date.parse(visit.issuedAt);
  if (
    expiry - beginning !== 86_400_000 ||
    start < beginning ||
    issued < start ||
    issued >= expiry
  )
    throw new Error(
      "Prepare the visit online and finish within its 24-hour offline window.",
    );
  const ids = new Set<string>();
  const counts = new Map<string, number>();
  for (const vaccine of visit.vaccinations) {
    const at = Date.parse(vaccine.administeredAt);
    if (ids.has(vaccine.id) || at < start || at > issued)
      throw new Error("Check vaccination identity and administration time.");
    ids.add(vaccine.id);
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: packet.practice.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(vaccine.administeredAt));
    if (vaccine.productExpirationDate && vaccine.productExpirationDate < day)
      throw new Error(
        "The vaccine product was expired on the administration date.",
      );
    if (vaccine.nextDueDate && vaccine.nextDueDate <= day)
      throw new Error("Next vaccination due date must follow administration.");
    counts.set(vaccine.serviceId, (counts.get(vaccine.serviceId) ?? 0) + 1);
  }
  for (const [id, count] of counts) {
    if ((visit.charges.find((c) => c.serviceId === id)?.quantity ?? 0) < count)
      throw new Error(
        "Every vaccination must be matched to a charged service.",
      );
  }
  if (
    visit.payment &&
    (Date.parse(visit.payment.receivedAt) < start ||
      Date.parse(visit.payment.receivedAt) > issued)
  )
    throw new Error("Check when the payment was received.");
  const totals = fieldTotals(packet, visit);
  if (
    visit.payment &&
    (totals.paidCents <= 0 || totals.paidCents > totals.totalCents)
  )
    throw new Error(
      "Enter a payment greater than zero and no more than the visit total.",
    );
  if (!Object.values(visit.sections).some((s) => s.trim()))
    throw new Error("Enter a clinical note before issuing the field receipt.");
  if (
    new Set(visit.vaccinations.map((v) => v.serviceId)).size !==
    visit.vaccinations.length
  )
    throw new Error(
      "Choose a distinct service for each vaccination in this pilot.",
    );
  return totals;
}

export const fieldEntrySchema = z
  .object({
    packet: fieldPacketSchema,
    started: z.boolean(),
    draft: fieldVisitSchema.omit({ issuedAt: true }).extend({
      vaccinations: z
        .array(
          fieldVaccinationSchema.extend({ vaccineName: z.string().max(255) }),
        )
        .max(30),
      charges: z.array(fieldVisitSchema.shape.charges.element).max(100),
    }),
    submission: fieldSubmissionSchema.nullable(),
    result: fieldResultSchema.nullable(),
  })
  .strict();
export type FieldEntry = z.infer<typeof fieldEntrySchema>;
export const fieldWorkspaceSchema = z
  .object({
    version: z.literal(1),
    userId: uuid,
    practiceId: uuid,
    entries: z.array(fieldEntrySchema).max(20),
  })
  .strict()
  .superRefine((w, ctx) => {
    const seen = new Set<string>();
    for (const e of w.entries) {
      if (
        seen.has(e.packet.id) ||
        e.packet.userId !== w.userId ||
        e.packet.practiceId !== w.practiceId ||
        (e.submission &&
          JSON.stringify(e.submission.packet) !== JSON.stringify(e.packet)) ||
        (e.result && !e.submission)
      )
        ctx.addIssue({
          code: "custom",
          message: "Saved field workspace identity is inconsistent.",
        });
      seen.add(e.packet.id);
    }
  });
export type FieldWorkspace = z.infer<typeof fieldWorkspaceSchema>;
export function newFieldEntry(packet: FieldPacket): FieldEntry {
  return {
    packet,
    started: false,
    draft: {
      startedAt: packet.preparedAt,
      sections: { ...EMPTY_SOAP },
      vaccinations: [],
      charges: [],
      payment: null,
    },
    submission: null,
    result: null,
  };
}
const vaultOptions = {
  database: "openvpm-offline-field-v1",
  storageKey: "encrypted-field-workspace-v1",
  validate: (x: unknown) => fieldWorkspaceSchema.parse(x),
  maxBytes: 7_999_984,
};
export const fieldWorkspaceExists = () => encryptedValueExists(vaultOptions);
export const openFieldWorkspace = (
  passphrase: string,
  recovery?: EncryptedVaultRecovery,
) => EncryptedDeviceVault.open(vaultOptions, passphrase, recovery);

export function serializeFieldBackup(recovery: EncryptedVaultRecovery): string {
  const bytes = new Uint8Array(recovery.record.ciphertext);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return JSON.stringify({
    format: "openvpm-field-backup-v1",
    record: { ...recovery.record, ciphertext: btoa(binary) },
  });
}
export function parseFieldBackup(text: string): EncryptedVaultRecovery {
  if (text.length > 11_000_000)
    throw new Error("Backup exceeds the field workspace limit.");
  const envelope = z
    .object({
      format: z.literal("openvpm-field-backup-v1"),
      record: z
        .object({
          version: z.literal(1),
          revision: uuid,
          salt: z.array(z.number().int().min(0).max(255)).length(16),
          iv: z.array(z.number().int().min(0).max(255)).length(12),
          ciphertext: z.string().max(10_666_668),
        })
        .strict(),
    })
    .strict()
    .parse(JSON.parse(text));
  const ciphertext = Uint8Array.from(atob(envelope.record.ciphertext), (c) =>
    c.charCodeAt(0),
  ).buffer;
  return { expectedRevision: null, record: { ...envelope.record, ciphertext } };
}

/** Original financial document, independent of later invoice edits. */
export function fieldReceiptSnapshot(input: FieldSubmission) {
  const totals = validateFieldSubmission(input);
  return {
    reference: input.packet.id,
    issuedAt: input.visit.issuedAt,
    practice: input.packet.practice,
    client: input.packet.client,
    patient: input.packet.patient.name,
    payment: input.visit.payment,
    lines: totals.lines,
    subtotalCents: totals.subtotalCents,
    taxCents: totals.taxCents,
    totalCents: totals.totalCents,
    paidCents: totals.paidCents,
    balanceCents: totals.balanceCents,
  };
}

/** Reserve room for every pending draft's immutable issuance copy. */
export function assertFieldWorkspaceCapacity(value: FieldWorkspace) {
  const bytes = (item: unknown) =>
    new TextEncoder().encode(JSON.stringify(item)).byteLength;
  const reserved =
    bytes(value) +
    value.entries
      .filter((e) => !e.submission)
      .reduce(
        (sum, e) =>
          sum +
          bytes({
            packet: e.packet,
            visit: { ...e.draft, issuedAt: "2099-01-01T00:00:00.000Z" },
          }),
        0,
      );
  if (reserved > 7_500_000)
    throw new Error(
      "This device workspace is full. Synchronize and remove completed visits before adding more information. The previous saved text has been kept.",
    );
}
