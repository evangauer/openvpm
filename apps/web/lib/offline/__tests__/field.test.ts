import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import {
  fieldWorkspaceSchema,
  assertFieldWorkspaceCapacity,
  fieldTotals,
  newFieldEntry,
  openFieldWorkspace,
  parseFieldBackup,
  serializeFieldBackup,
  validateFieldSubmission,
  fieldReceiptSnapshot,
  type FieldPacket,
  type FieldSubmission,
} from "../field";
import { EMPTY_SOAP } from "../workspace";

function sample(): FieldSubmission {
  const serviceId = randomUUID();
  const packet: FieldPacket = {
    id: randomUUID(),
    userId: randomUUID(),
    practiceId: randomUUID(),
    patientId: randomUUID(),
    clientId: randomUUID(),
    locationId: randomUUID(),
    preparedAt: "2026-11-13T12:00:00.000Z",
    expiresAt: "2026-11-14T12:00:00.000Z",
    appointment: null,
    practice: {
      name: "Synthetic clinic",
      address: null,
      phone: null,
      currency: "usd",
      country: "US",
      taxRate: "6.00",
      timezone: "America/New_York",
    },
    clinician: { name: "Synthetic clinician", license: null },
    patient: {
      name: "Synthetic patient",
      species: "feline",
      breed: null,
      dob: null,
    },
    client: { name: "Synthetic owner", phone: null, address: null },
    allergies: [],
    medications: [],
    vaccinations: [],
    history: [],
    notes: [],
    services: [
      {
        id: serviceId,
        name: "Synthetic vaccine",
        price: "20.25",
        taxable: true,
      },
    ],
  };
  return {
    packet,
    visit: {
      startedAt: "2026-11-13T13:00:00.000Z",
      issuedAt: "2026-11-13T14:00:00.000Z",
      sections: { ...EMPTY_SOAP, subjective: "Synthetic offline history" },
      charges: [{ serviceId, quantity: 1 }],
      payment: {
        method: "check",
        amount: "10.00",
        reference: "Synthetic check",
        receivedAt: "2026-11-13T13:55:00.000Z",
      },
      vaccinations: [
        {
          id: randomUUID(),
          serviceId,
          vaccineName: "Synthetic vaccine",
          productName: "Synthetic product",
          manufacturer: "",
          lotNumber: "SYNTHETIC",
          productExpirationDate: "2026-11-13",
          administeredAt: "2026-11-13T13:30:00.000Z",
          nextDueDate: "2027-11-13",
          doseType: "initial",
          rabiesTagNumber: "",
        },
      ],
    },
  };
}
beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
describe("offline field documents", () => {
  it("reserves encrypted capacity for issuance before accepting more drafts", () => {
    const x = sample(),
      entry = newFieldEntry(x.packet);
    const w = {
      version: 1 as const,
      userId: x.packet.userId,
      practiceId: x.packet.practiceId,
      entries: [entry],
    };
    expect(() => assertFieldWorkspaceCapacity(w)).not.toThrow();
    entry.draft.sections.subjective = "x".repeat(4_000_000);
    expect(() => assertFieldWorkspaceCapacity(w)).toThrow(/full/);
  });
  it("calculates the same cents, tax, tender and balance used in the immutable receipt", () => {
    const input = sample();
    expect(validateFieldSubmission(input)).toMatchObject({
      subtotalCents: 2025,
      taxCents: 122,
      totalCents: 2147,
      paidCents: 1000,
      balanceCents: 1147,
    });
    const receipt = fieldReceiptSnapshot(input);
    expect(receipt.reference).toBe(input.packet.id);
    expect(receipt.payment?.receivedAt).toBe(input.visit.payment!.receivedAt);
  });
  it.each([
    "expiry",
    "clock",
    "unbilled",
    "overpay",
    "expired-product",
    "duplicate",
    "empty-note",
  ])("refuses an invalid issued document: %s", (kind) => {
    const x = sample();
    if (kind === "expiry") x.visit.issuedAt = x.packet.expiresAt;
    if (kind === "clock") x.visit.startedAt = "2026-11-12T12:00:00.000Z";
    if (kind === "unbilled") x.visit.vaccinations[0]!.serviceId = randomUUID();
    if (kind === "overpay") x.visit.payment!.amount = "999.00";
    if (kind === "expired-product")
      x.visit.vaccinations[0]!.productExpirationDate = "2026-11-12";
    if (kind === "duplicate")
      x.visit.vaccinations.push({ ...x.visit.vaccinations[0]! });
    if (kind === "empty-note") x.visit.sections = { ...EMPTY_SOAP };
    expect(() => validateFieldSubmission(x)).toThrow();
  });
  it("uses the clinic's date for product expiration around midnight UTC", () => {
    const x = sample();
    x.visit.vaccinations[0]!.administeredAt = "2026-11-14T01:00:00.000Z";
    x.visit.issuedAt = "2026-11-14T01:30:00.000Z";
    expect(() => validateFieldSubmission(x)).not.toThrow();
  });
  it("allows editing incomplete drafts without permitting issuance", () => {
    const x = sample(),
      e = newFieldEntry(x.packet);
    e.draft.vaccinations = [{ ...x.visit.vaccinations[0]!, vaccineName: "" }];
    e.draft.payment = { ...x.visit.payment!, amount: "500.00" };
    const w = {
      version: 1 as const,
      userId: x.packet.userId,
      practiceId: x.packet.practiceId,
      entries: [e],
    };
    expect(fieldWorkspaceSchema.parse(w)).toEqual(w);
    expect(fieldTotals(e.packet, e.draft).balanceCents).toBe(-50000);
    expect(() =>
      validateFieldSubmission({
        packet: e.packet,
        visit: { ...e.draft, issuedAt: x.visit.issuedAt },
      }),
    ).toThrow();
  });
  it("restores encrypted pending documents with original identity and rejects wrong secrets, tampering and occupied storage", async () => {
    const x = sample(),
      phrase = "Synthetic recovery phrase";
    const e = {
      ...newFieldEntry(x.packet),
      started: true,
      draft: x.visit,
      submission: x,
    };
    const { issuedAt: _, ...draft } = x.visit;
    e.draft = draft as typeof e.draft;
    const w = fieldWorkspaceSchema.parse({
      version: 1,
      userId: x.packet.userId,
      practiceId: x.packet.practiceId,
      entries: [e],
    });
    const original = await openFieldWorkspace(phrase);
    await original.vault.save(w);
    const text = serializeFieldBackup(await original.vault.sealForRecovery(w));
    expect(text).not.toContain("Synthetic offline history");
    expect(text).not.toContain(x.packet.patientId);
    const recovery = parseFieldBackup(text);
    vi.stubGlobal("indexedDB", new IDBFactory());
    await expect(
      openFieldWorkspace("Wrong secret phrase", recovery),
    ).rejects.toThrow();
    const restored = await openFieldWorkspace(phrase, recovery);
    expect(restored.value).toEqual(w);
    await restored.vault.save(w);
    await expect(openFieldWorkspace(phrase, recovery)).rejects.toThrow();
    vi.stubGlobal("indexedDB", new IDBFactory());
    const tampered = parseFieldBackup(text);
    new Uint8Array(tampered.record.ciphertext)[0] ^= 1;
    await expect(openFieldWorkspace(phrase, tampered)).rejects.toThrow();
  });
});
