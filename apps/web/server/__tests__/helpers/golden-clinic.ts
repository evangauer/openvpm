import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../../../../../packages/db/schema/index";
import { withTenant, withTenantReadOnlySnapshot } from "@/lib/tenant-db";
import { exportPracticeData } from "@/lib/backup/export";
import { createRouter, type TRPCContext } from "../../trpc";
import type { DisposableClinic } from "./disposable-clinic";

/** Real protected routers and PostgreSQL; only outbound webhooks are stubbed by the suites. */
export async function runGoldenClinic(fixture: DisposableClinic) {
  const [practice, foreignPractice] = await fixture.ownerDb
    .insert(schema.practices)
    .values([
      {
        name: "Synthetic golden clinic",
        timezone: "UTC",
        taxRatePercent: "8.00",
      },
      { name: "Synthetic isolated clinic", timezone: "UTC" },
    ])
    .returning();
  const [doctor, foreignDoctor] = await fixture.ownerDb
    .insert(schema.users)
    .values(
      [practice!, foreignPractice!].map((clinic, index) => ({
        practiceId: clinic.id,
        email: `golden-${index}@example.invalid`,
        name: "Synthetic Doctor",
        passwordHash: "synthetic-not-a-login",
        role: "admin" as const,
        isVeterinarian: true,
      })),
    )
    .returning();
  const [location] = await fixture.ownerDb
    .insert(schema.locations)
    .values({
      practiceId: practice!.id,
      name: "Synthetic clinic location",
      isPrimary: true,
    })
    .returning();
  await fixture.ownerDb.insert(schema.webhooks).values({
    practiceId: practice!.id,
    url: "https://example.invalid/synthetic-webhook",
    events: ["patient.created"],
    secret: "synthetic-webhook-placeholder",
    active: true,
  });
  await fixture.ownerDb.insert(schema.apiKeys).values({
    practiceId: practice!.id,
    name: "Synthetic API key",
    keyPrefix: "synthetic",
    keyHash: "synthetic-key-placeholder",
  });

  const [
    { clientsRouter },
    { patientsRouter },
    { appointmentsRouter },
    { vitalsRouter },
    { recordsRouter },
    { billingRouter },
    { encountersRouter },
    { patientNotesRouter },
  ] = await Promise.all([
    import("../../routers/clients"),
    import("../../routers/patients"),
    import("../../routers/appointments"),
    import("../../routers/vitals"),
    import("../../routers/records"),
    import("../../routers/billing"),
    import("../../routers/encounters"),
    import("../../routers/patient-notes"),
  ]);
  const context = (user = doctor!): TRPCContext => ({
    db: fixture.db,
    session: {
      expires: "2099-01-01",
      user: {
        id: user.id,
        practiceId: user.practiceId,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    },
  });
  const router = createRouter({
    clients: clientsRouter,
    patients: patientsRouter,
    appointments: appointmentsRouter,
    vitals: vitalsRouter,
    records: recordsRouter,
    billing: billingRouter,
    encounters: encountersRouter,
    patientNotes: patientNotesRouter,
  });
  const {
    clients,
    patients,
    appointments,
    vitals,
    records,
    billing,
    encounters,
    patientNotes,
  } = router.createCaller(context());
  const foreignCaller = router.createCaller(context(foreignDoctor!));

  const client = await clients.create({
    firstName: "Synthetic",
    lastName: "Owner",
  });
  const patient = await patients.create({
    clientId: client.id,
    name: "Synthetic Cat",
    species: "feline",
  });
  const chart = await patients.getById({ id: patient.id });
  expect(chart).toMatchObject({ id: patient.id, clientId: client.id });
  const noteInput = {
    patientId: patient.id,
    operationId: randomUUID(),
    noteType: "phone_call" as const,
    content:
      "Synthetic pasted chart update\nLiteral <script>text</script> & 50%.",
  };
  const chartNote = await patientNotes.create(noteInput);
  expect(chartNote).toMatchObject({
    content: noteInput.content,
    authorId: doctor!.id,
    isChartNote: true,
  });
  expect((await patientNotes.create(noteInput)).id).toBe(chartNote.id);
  expect(await fixture.ownerDb.select().from(schema.appointments)).toEqual([]);
  await expect(
    foreignCaller.patients.getById({ id: patient.id }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    foreignCaller.billing.createInvoice({
      clientId: client.id,
      patientId: patient.id,
      items: [],
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });

  const service = await billing.createService({
    name: "Synthetic nail trim",
    defaultPrice: "18.00",
    taxable: true,
  });
  const line = {
    description: service.name,
    quantity: 1,
    unitPrice: "18.00",
    itemType: "service" as const,
    itemId: service.id,
  };
  // Direct patient billing must not require an appointment or SOAP workflow.
  const directInvoice = await billing.createInvoice({
    clientId: client.id,
    patientId: patient.id,
    items: [line],
  });
  expect(directInvoice).toMatchObject({
    appointmentId: null,
    status: "draft",
    subtotal: "18.00",
    tax: "1.44",
    total: "19.44",
  });
  expect(
    (await billing.getInvoice({ id: directInvoice.id })).items,
  ).toHaveLength(1);

  const start = new Date();
  start.setUTCHours(12, 0, 0, 0);
  const appointment = await appointments.create({
    patientId: patient.id,
    clientId: client.id,
    doctorId: doctor!.id,
    locationId: location!.id,
    startTime: start.toISOString(),
    endTime: new Date(start.getTime() + 30 * 60_000).toISOString(),
  });
  await appointments.updateStatus({ id: appointment.id, status: "checked_in" });
  await appointments.updateStatus({ id: appointment.id, status: "in_exam" });
  const vital = await vitals.record({
    patientId: patient.id,
    appointmentId: appointment.id,
    weightKg: 4.2,
    temperatureC: 38.4,
    heartRateBpm: 120,
  });
  expect(
    (await vitals.listByAppointment({ appointmentId: appointment.id }))[0]?.id,
  ).toBe(vital.id);
  const sections = {
    subjective: "Synthetic history\nPasted second line & 50%.",
    objective: "Synthetic examination",
    assessment: "Synthetic assessment",
    plan: "Synthetic plan",
  };
  const saved = await records.saveSoapDraft({
    patientId: patient.id,
    appointmentId: appointment.id,
    expectedRevision: 0,
    ...sections,
  });
  expect(saved.outcome).toBe("saved");
  if (saved.outcome !== "saved") throw new Error("SOAP draft was not saved");
  const draft = saved.draft;
  const signed = await records.finalizeSoapNote({
    patientId: patient.id,
    appointmentId: appointment.id,
    noteId: draft.id,
    expectedRevision: draft.revision,
  });
  expect(signed.note).toMatchObject({
    status: "finalized",
    authorId: doctor!.id,
    ...sections,
  });
  expect(
    await records.saveSoapDraft({
      patientId: patient.id,
      appointmentId: appointment.id,
      noteId: draft.id,
      expectedRevision: draft.revision,
      ...sections,
      subjective: "Attempt to overwrite signed note",
    }),
  ).toMatchObject({
    outcome: "already_finalized",
    note: { subjective: sections.subjective },
  });

  const procedure = await records.createProcedure({
    patientId: patient.id,
    appointmentId: appointment.id,
    name: service.name,
  });
  const invoice = await billing.createInvoice({
    clientId: client.id,
    patientId: patient.id,
    appointmentId: appointment.id,
    items: [line],
  });
  const invoiceDetail = await billing.getInvoice({ id: invoice.id });
  const payment = {
    invoiceId: invoice.id,
    operationId: randomUUID(),
    amount: "19.44",
    method: "cash" as const,
  };
  await expect(
    billing.updateInvoiceStatus({ id: invoice.id, status: "sent" }),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  const handoff = await encounters.finalizeClinical({
    appointmentId: appointment.id,
    expectedRevision: 0,
    diagnosisSummary: "Synthetic assessment",
    dischargeInstructions:
      "Synthetic owner instructions\nSecond line retained.",
    warningSigns: "Synthetic warning signs",
    prescriptionDisposition: "not_needed",
    followUpDisposition: "none",
    followUpAppointmentId: null,
  });
  expect(handoff.status).toBe("clinical_finalized");
  // An unreconciled performed service must block financial handoff.
  await expect(
    billing.updateInvoiceStatus({ id: invoice.id, status: "sent" }),
  ).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
    message: expect.stringContaining("Resolve every performed"),
  });
  const work = await encounters.getVisitReconciliation({
    appointmentId: appointment.id,
  });
  expect(work.unresolvedCount).toBe(1);
  expect(work.items[0]?.sourceId).toBe(procedure.id);
  await encounters.resolveVisitWork({
    appointmentId: appointment.id,
    workItemId: work.items[0]!.id,
    resolution: {
      status: "charged",
      invoiceItemId: invoiceDetail.items[0]!.id,
    },
  });
  expect(
    (await encounters.getVisitReconciliation({ appointmentId: appointment.id }))
      .unresolvedCount,
  ).toBe(0);

  await expect(
    appointments.updateStatus({ id: appointment.id, status: "checked_out" }),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  const completion = {
    appointmentId: appointment.id,
    expectedRevision: handoff.revision,
    chargeDisposition: "paid" as const,
    handoffMethod: "print" as const,
  };
  await expect(encounters.completeVisit(completion)).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });
  await billing.updateInvoiceStatus({ id: invoice.id, status: "sent" });
  await billing.recordPayment(payment);
  await billing.recordPayment(payment); // Retry must not double-charge.
  expect(await billing.listPayments({ invoiceId: invoice.id })).toHaveLength(1);
  expect(await billing.getInvoice({ id: invoice.id })).toMatchObject({
    status: "paid",
    paidAmount: "19.44",
  });
  const completed = await encounters.completeVisit(completion);
  expect(completed.appointment.status).toBe("checked_out");
  expect(completed.closeout).toMatchObject({
    status: "completed",
    invoiceId: invoice.id,
    handoffMethod: "print",
    clinicalFinalizedBy: doctor!.id,
  });
  expect((await encounters.completeVisit(completion)).closeout.id).toBe(
    completed.closeout.id,
  );
  expect(
    (await records.listSoapNotes({ patientId: patient.id }))[0]?.subjective,
  ).toBe(sections.subjective);

  // Existing internal notes are retained by backup, even though not chart-search records.
  const [internalNote] = await withTenant(fixture.db, practice!.id, (tx) =>
    tx
      .insert(schema.clinicalNotes)
      .values({
        practiceId: practice!.id,
        patientId: patient.id,
        authorId: doctor!.id,
        content: "Synthetic internal note\nLiteral <b>text</b>.",
      })
      .returning(),
  );
  const backup = await withTenantReadOnlySnapshot(
    fixture.db,
    practice!.id,
    (tx) => exportPracticeData(tx, practice!.id, new Date().toISOString()),
  );
  expect(backup.patients).toHaveLength(1);
  expect(backup.invoices).toHaveLength(2);
  expect(backup.payments).toHaveLength(1);
  expect(backup.visitCloseouts).toHaveLength(1);
  expect(backup.clinicalNotes).toHaveLength(2);
  // The old internal record stays out of the chart even after a new note exists.
  expect(
    (await patientNotes.list({ patientId: patient.id })).items.map(
      (note) => note.id,
    ),
  ).toEqual([chartNote.id]);
  expect(JSON.stringify(backup)).not.toContain(foreignPractice!.id);
  expect(JSON.stringify(backup)).not.toContain("synthetic-not-a-login");
  expect(JSON.stringify(backup)).not.toContain("synthetic-webhook-placeholder");
  expect(JSON.stringify(backup)).not.toContain("synthetic-key-placeholder");
  const audits = await withTenant(fixture.db, practice!.id, (tx) =>
    tx
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.practiceId, practice!.id)),
  );
  expect(audits.length).toBeGreaterThan(10);
  const noteAudits = audits.filter((entry) => entry.entityId === chartNote.id);
  expect(noteAudits).toHaveLength(1);
  expect(noteAudits[0]?.changes).toEqual({
    patientId: patient.id,
    noteType: "phone_call",
  });
  // A reused connection with no tenant context must see no clinic rows.
  expect(await fixture.db.select().from(schema.patients)).toEqual([]);
  return {
    backup,
    practice: practice!,
    doctor: doctor!,
    patient,
    client,
    appointment,
    invoice,
    internalNote: internalNote!,
    chartNote,
    soap: signed.note,
    completed,
    context,
  };
}
