import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import type { Database } from "@openpims/db/client";
import {
  appointments,
  auditLog,
  clients,
  clinicalNotes,
  clinicalRecordCorrections,
  invoiceItems,
  invoices,
  locations,
  offlineFieldBatches,
  patientAllergies,
  patients,
  payments,
  practices,
  prescriptions,
  services,
  soapNotes,
  users,
  vaccinationRecords,
  visitWorkItems,
} from "@openpims/db";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import { effectiveAmbulatoryWorkspaceSettings } from "../ambulatory-rollout";
import {
  fieldPacketSchema,
  fieldResultSchema,
  fieldSubmissionSchema,
  validateFieldSubmission,
  fieldReceiptSnapshot,
} from "@/lib/offline/field";
import { centsToMoney } from "@/lib/billing/invoice-balance";
import {
  saveAppointmentSoapDraft,
  SoapLifecycleError,
} from "@/lib/records/soap-lifecycle";
import {
  resolveAppointmentLocation,
  takeAppointmentSchedulingLock,
} from "@/lib/scheduling/location";
import { assertVisitInvoiceReadyForFinancialAction } from "../visit-billing-integrity";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(
  message: string,
  code:
    | "CONFLICT"
    | "FORBIDDEN"
    | "PRECONDITION_FAILED" = "PRECONDITION_FAILED",
): never {
  throw new TRPCError({ code, message });
}
const fieldProcedure = protectedProcedure
  .use(requireRole("admin"))
  .use(async ({ ctx, next }) => {
    const [actor] = await ctx.db
      .select({
        role: users.role,
        isVeterinarian: users.isVeterinarian,
        name: users.name,
        license: users.licenseNumber,
        practice: practices,
      })
      .from(users)
      .innerJoin(
        practices,
        and(eq(practices.id, users.practiceId), isNull(practices.deletedAt)),
      )
      .where(
        and(
          eq(users.id, ctx.user.id),
          eq(users.practiceId, ctx.practiceId),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
    if (
      !actor ||
      actor.role !== "admin" ||
      !actor.isVeterinarian ||
      actor.practice.recoveryHold
    )
      fail(
        "Field billing requires an active veterinarian with clinic administrator access.",
        "FORBIDDEN",
      );
    return next({ ctx: { ...ctx, fieldActor: actor } });
  });

export const offlineFieldRouter = createRouter({
  availability: protectedProcedure.query(async ({ ctx }) => {
    if (
      ctx.user.role !== "admin" ||
      process.env.OFFLINE_FIELD_VISITS_ENABLED !== "true"
    )
      return { enabled: false };
    const [row] = await ctx.db
      .select({
        veterinarian: users.isVeterinarian,
        settings: practices.settings,
        recoveryHold: practices.recoveryHold,
      })
      .from(users)
      .innerJoin(practices, eq(practices.id, users.practiceId))
      .where(
        and(
          eq(users.id, ctx.user.id),
          eq(users.practiceId, ctx.practiceId),
          isNull(users.deletedAt),
          isNull(practices.deletedAt),
        ),
      )
      .limit(1);
    return {
      enabled:
        !!row?.veterinarian &&
        !row.recoveryHold &&
        effectiveAmbulatoryWorkspaceSettings(row.settings).enabled,
    };
  }),
  session: fieldProcedure.query(({ ctx }) => ({
    userId: ctx.user.id,
    practiceId: ctx.practiceId,
    name: ctx.user.name,
    enabled:
      process.env.OFFLINE_FIELD_VISITS_ENABLED === "true" &&
      effectiveAmbulatoryWorkspaceSettings(ctx.fieldActor.practice.settings)
        .enabled,
  })),
  patients: fieldProcedure
    .input(z.object({ query: z.string().trim().max(100) }))
    .query(async ({ ctx, input }) =>
      ctx.db
        .select({
          id: patients.id,
          name: patients.name,
          species: patients.species,
          clientName: sql<string>`${clients.firstName} || ' ' || ${clients.lastName}`,
        })
        .from(patients)
        .innerJoin(
          clients,
          and(
            eq(clients.id, patients.clientId),
            eq(clients.practiceId, ctx.practiceId),
            isNull(clients.deletedAt),
          ),
        )
        .where(
          and(
            eq(patients.practiceId, ctx.practiceId),
            eq(patients.status, "active"),
            isNull(patients.deletedAt),
            input.query
              ? or(
                  ilike(patients.name, `%${input.query}%`),
                  ilike(clients.lastName, `%${input.query}%`),
                )
              : undefined,
          ),
        )
        .orderBy(asc(patients.name))
        .limit(30),
    ),
  day: fieldProcedure
    .input(z.object({ start: z.iso.datetime(), end: z.iso.datetime() }))
    .query(async ({ ctx, input }) => {
      if (
        Date.parse(input.end) - Date.parse(input.start) > 86_400_000 ||
        input.end <= input.start
      )
        fail("Choose one day.");
      return ctx.db
        .select({
          id: appointments.id,
          patientId: patients.id,
          name: patients.name,
          time: appointments.startTime,
        })
        .from(appointments)
        .innerJoin(
          patients,
          and(
            eq(patients.id, appointments.patientId),
            eq(patients.practiceId, ctx.practiceId),
            isNull(patients.deletedAt),
          ),
        )
        .where(
          and(
            eq(appointments.practiceId, ctx.practiceId),
            eq(appointments.doctorId, ctx.user.id),
            inArray(appointments.status, [
              "scheduled",
              "confirmed",
              "checked_in",
            ]),
            gte(appointments.startTime, new Date(input.start)),
            lt(appointments.startTime, new Date(input.end)),
            isNull(appointments.deletedAt),
          ),
        )
        .orderBy(asc(appointments.startTime))
        .limit(20);
    }),
  prepare: fieldProcedure
    .input(
      z.object({
        patientId: z.string().uuid(),
        appointmentId: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const practice = ctx.fieldActor.practice;
      if (
        process.env.OFFLINE_FIELD_VISITS_ENABLED !== "true" ||
        !effectiveAmbulatoryWorkspaceSettings(practice.settings).enabled
      )
        fail(
          "Enable the offline field pilot and the clinic's ambulatory workspace before preparing visits.",
        );
      if (
        practice.country !== "US" ||
        practice.currency?.toLowerCase() !== "usd"
      )
        fail("This field billing pilot supports US clinics billing in USD.");
      const [identity] = await ctx.db
        .select({ patient: patients, client: clients })
        .from(patients)
        .innerJoin(
          clients,
          and(
            eq(clients.id, patients.clientId),
            eq(clients.practiceId, ctx.practiceId),
            isNull(clients.deletedAt),
          ),
        )
        .where(
          and(
            eq(patients.id, input.patientId),
            eq(patients.practiceId, ctx.practiceId),
            eq(patients.status, "active"),
            isNull(patients.deletedAt),
          ),
        )
        .limit(1);
      if (!identity) fail("Active patient and client not found.");
      let appointment = null;
      let locationId: string | null = null;
      if (input.appointmentId) {
        const [row] = await ctx.db
          .select()
          .from(appointments)
          .where(
            and(
              eq(appointments.id, input.appointmentId),
              eq(appointments.practiceId, ctx.practiceId),
              eq(appointments.patientId, input.patientId),
              eq(appointments.clientId, identity.client.id),
              eq(appointments.doctorId, ctx.user.id),
              inArray(appointments.status, [
                "scheduled",
                "confirmed",
                "checked_in",
              ]),
              isNull(appointments.deletedAt),
            ),
          )
          .limit(1);
        if (!row)
          fail(
            "Choose an unstarted appointment assigned to you. Existing in-exam notes use the chart workspace.",
          );
        appointment = { id: row.id, updatedAt: row.updatedAt.toISOString() };
        locationId = row.locationId;
      }
      const location = await resolveAppointmentLocation(ctx.db, {
        practiceId: ctx.practiceId,
        doctorId: ctx.user.id,
        locationId,
      });
      if (!location.ok)
        fail(
          "Choose an active clinic location for this clinician before preparing field visits.",
        );
      const [allergies, medications, vaccinations, notes, catalog, history] =
        await Promise.all([
          ctx.db
            .select({
              allergen: patientAllergies.allergen,
              reaction: patientAllergies.reaction,
              severity: patientAllergies.severity,
            })
            .from(patientAllergies)
            .where(
              and(
                eq(patientAllergies.patientId, input.patientId),
                isNull(patientAllergies.deletedAt),
                sql`not exists (select 1 from ${clinicalRecordCorrections} where ${clinicalRecordCorrections.practiceId} = ${ctx.practiceId} and ${clinicalRecordCorrections.patientAllergyId} = ${patientAllergies.id})`,
              ),
            )
            .limit(51),
          ctx.db
            .select({
              name: prescriptions.medicationName,
              dosage: prescriptions.dosage,
              frequency: prescriptions.frequency,
              instructions: prescriptions.instructions,
            })
            .from(prescriptions)
            .where(
              and(
                eq(prescriptions.patientId, input.patientId),
                eq(prescriptions.practiceId, ctx.practiceId),
                eq(prescriptions.status, "active"),
                isNull(prescriptions.deletedAt),
              ),
            )
            .limit(101),
          ctx.db
            .select({
              name: vaccinationRecords.vaccineName,
              administeredAt: vaccinationRecords.administeredAt,
              nextDueDate: vaccinationRecords.nextDueDate,
            })
            .from(vaccinationRecords)
            .where(
              and(
                eq(vaccinationRecords.patientId, input.patientId),
                eq(vaccinationRecords.practiceId, ctx.practiceId),
                isNull(vaccinationRecords.deletedAt),
                sql`not exists (select 1 from ${clinicalRecordCorrections} where ${clinicalRecordCorrections.practiceId} = ${ctx.practiceId} and ${clinicalRecordCorrections.vaccinationRecordId} = ${vaccinationRecords.id})`,
              ),
            )
            .orderBy(desc(vaccinationRecords.administeredAt))
            .limit(50),
          ctx.db
            .select({
              content: clinicalNotes.content,
              at: clinicalNotes.createdAt,
            })
            .from(clinicalNotes)
            .where(
              and(
                eq(clinicalNotes.patientId, input.patientId),
                eq(clinicalNotes.practiceId, ctx.practiceId),
                eq(clinicalNotes.isChartNote, true),
                isNull(clinicalNotes.deletedAt),
              ),
            )
            .orderBy(desc(clinicalNotes.createdAt))
            .limit(20),
          ctx.db
            .select({
              id: services.id,
              name: services.name,
              price: services.defaultPrice,
              taxable: services.taxable,
            })
            .from(services)
            .where(
              and(
                eq(services.practiceId, ctx.practiceId),
                isNull(services.deletedAt),
              ),
            )
            .orderBy(asc(services.name))
            .limit(501),
          ctx.db
            .select()
            .from(soapNotes)
            .where(
              and(
                eq(soapNotes.practiceId, ctx.practiceId),
                eq(soapNotes.patientId, input.patientId),
                eq(soapNotes.status, "finalized"),
                isNull(soapNotes.deletedAt),
                sql`not exists (select 1 from ${clinicalRecordCorrections} where ${clinicalRecordCorrections.practiceId} = ${ctx.practiceId} and ${clinicalRecordCorrections.soapNoteId} = ${soapNotes.id})`,
              ),
            )
            .orderBy(desc(soapNotes.createdAt))
            .limit(10),
        ]);
      if (
        allergies.length > 50 ||
        medications.length > 100 ||
        catalog.length > 500
      )
        fail(
          "This clinic exceeds the pilot's preparation limits. Review online; no partial safety list was saved.",
        );
      const now = new Date();
      const packet = fieldPacketSchema.parse({
        id: randomUUID(),
        userId: ctx.user.id,
        practiceId: ctx.practiceId,
        patientId: input.patientId,
        clientId: identity.client.id,
        preparedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
        appointment,
        locationId: location.locationId,
        practice: {
          name: practice.name,
          address: practice.address,
          phone: practice.phone,
          currency: "usd",
          country: "US",
          taxRate: practice.taxRatePercent ?? "8.00",
          timezone: practice.timezone,
        },
        clinician: {
          name: ctx.fieldActor.name,
          license: ctx.fieldActor.license,
        },
        patient: {
          name: identity.patient.name,
          species: identity.patient.species,
          breed: identity.patient.breed,
          dob: identity.patient.dob,
        },
        client: {
          name: `${identity.client.firstName} ${identity.client.lastName}`,
          phone: identity.client.phone,
          address: identity.client.address,
        },
        history: history.map((n) => ({
          at: n.createdAt.toISOString(),
          sections: {
            subjective: n.subjective ?? "",
            objective: n.objective ?? "",
            assessment: n.assessment ?? "",
            plan: n.plan ?? "",
          },
        })),
        allergies,
        medications,
        vaccinations: vaccinations.map((v) => ({
          ...v,
          administeredAt: v.administeredAt.toISOString(),
        })),
        notes: notes.map((n) => ({ ...n, at: n.at.toISOString() })),
        services: catalog,
      });
      await ctx.db
        .insert(offlineFieldBatches)
        .values({
          id: packet.id,
          practiceId: ctx.practiceId,
          userId: ctx.user.id,
          patientId: packet.patientId,
          preparationHash: hash(packet),
          expiresAt: new Date(packet.expiresAt),
        });
      await ctx.db
        .insert(auditLog)
        .values({
          practiceId: ctx.practiceId,
          userId: ctx.user.id,
          action: "offline_field_prepared",
          entityType: "offline_field_batch",
          entityId: packet.id,
          changes: { patientId: packet.patientId, expiresAt: packet.expiresAt },
        });
      return packet;
    }),
  sync: fieldProcedure
    .input(fieldSubmissionSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        let totals;
        try {
          totals = validateFieldSubmission(input);
        } catch (error) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              error instanceof Error
                ? error.message
                : "Review field visit details.",
          });
        }
        const { packet, visit } = input;
        if (
          packet.userId !== ctx.user.id ||
          packet.practiceId !== ctx.practiceId
        )
          fail("Sign in as the person who prepared this visit.", "FORBIDDEN");
        return await ctx.db.transaction(async (tx) => {
          const db = tx as unknown as Database;
          const [batch] = await tx
            .select()
            .from(offlineFieldBatches)
            .where(
              and(
                eq(offlineFieldBatches.id, packet.id),
                eq(offlineFieldBatches.practiceId, ctx.practiceId),
                eq(offlineFieldBatches.userId, ctx.user.id),
                isNull(offlineFieldBatches.deletedAt),
              ),
            )
            .for("update");
          if (!batch || batch.preparationHash !== hash(packet))
            fail(
              "The prepared visit could not be verified. Keep the device copy and contact support.",
              "FORBIDDEN",
            );
          const requestHash = hash(input);
          if (batch.result) {
            if (batch.requestHash !== requestHash)
              fail(
                "This receipt was already synchronized with different contents. The issued receipt cannot be replaced.",
                "CONFLICT",
              );
            return fieldResultSchema.parse(batch.result);
          }
          if (Date.parse(visit.issuedAt) > Date.now() + 60_000)
            fail(
              "The recorded visit is in the future. Check the device clock.",
            );
          const practice = ctx.fieldActor.practice;
          if (
            practice.country !== packet.practice.country ||
            practice.currency?.toLowerCase() !== packet.practice.currency ||
            Number(practice.taxRatePercent) !== Number(packet.practice.taxRate)
          )
            fail(
              "Clinic currency or tax settings changed. Keep the receipt for reconciliation; nothing was posted.",
              "CONFLICT",
            );
          const [patient] = await tx
            .select({ id: patients.id })
            .from(patients)
            .innerJoin(
              clients,
              and(
                eq(clients.id, patients.clientId),
                eq(clients.practiceId, ctx.practiceId),
                isNull(clients.deletedAt),
              ),
            )
            .where(
              and(
                eq(patients.id, packet.patientId),
                eq(patients.clientId, packet.clientId),
                eq(patients.practiceId, ctx.practiceId),
                eq(patients.status, "active"),
                isNull(patients.deletedAt),
              ),
            )
            .for("share", { of: patients });
          if (!patient)
            fail(
              "Patient ownership or availability changed. Review this field visit online.",
              "CONFLICT",
            );
          const location = await resolveAppointmentLocation(db, {
            practiceId: ctx.practiceId,
            doctorId: ctx.user.id,
            locationId: packet.locationId,
          });
          if (!location.ok)
            fail(
              "The prepared clinic location is no longer available.",
              "CONFLICT",
            );
          const catalog = await tx
            .select()
            .from(services)
            .where(
              and(
                eq(services.practiceId, ctx.practiceId),
                inArray(
                  services.id,
                  totals.lines.map((l) => l.id),
                ),
                isNull(services.deletedAt),
              ),
            )
            .for("share");
          for (const line of totals.lines) {
            const current = catalog.find((s) => s.id === line.id);
            if (
              !current ||
              current.name !== line.name ||
              current.defaultPrice !== line.price ||
              current.taxable !== line.taxable
            )
              fail(
                "A charged service changed after preparation. Keep the issued receipt for reconciliation; nothing was posted.",
                "CONFLICT",
              );
          }
          await takeAppointmentSchedulingLock(db, ctx.practiceId);
          const start = new Date(visit.startedAt),
            end = new Date(
              Math.max(Date.parse(visit.issuedAt), start.getTime() + 60_000),
            );
          const conflicts = await tx
            .select({ id: appointments.id })
            .from(appointments)
            .where(
              and(
                eq(appointments.practiceId, ctx.practiceId),
                eq(appointments.doctorId, ctx.user.id),
                lt(appointments.startTime, end),
                gt(appointments.endTime, start),
                inArray(appointments.status, [
                  "scheduled",
                  "confirmed",
                  "checked_in",
                  "in_exam",
                ]),
                packet.appointment
                  ? ne(appointments.id, packet.appointment.id)
                  : undefined,
                isNull(appointments.deletedAt),
              ),
            )
            .limit(1);
          if (conflicts.length)
            fail(
              "Another appointment overlaps this field visit. Reconcile the schedule before retrying; your receipt is unchanged.",
              "CONFLICT",
            );
          let appointmentId: string;
          if (packet.appointment) {
            const [current] = await tx
              .select()
              .from(appointments)
              .where(
                and(
                  eq(appointments.id, packet.appointment.id),
                  eq(appointments.practiceId, ctx.practiceId),
                  eq(appointments.patientId, packet.patientId),
                  eq(appointments.clientId, packet.clientId),
                  eq(appointments.doctorId, ctx.user.id),
                  isNull(appointments.deletedAt),
                ),
              )
              .for("update");
            if (
              !current ||
              current.updatedAt.toISOString() !==
                packet.appointment.updatedAt ||
              !["scheduled", "confirmed", "checked_in"].includes(current.status)
            )
              fail(
                "The prepared appointment changed. Review it online; this visit has not overwritten it.",
                "CONFLICT",
              );
            const [existingNote] = await tx
              .select({ id: soapNotes.id })
              .from(soapNotes)
              .where(
                and(
                  eq(soapNotes.appointmentId, current.id),
                  eq(soapNotes.practiceId, ctx.practiceId),
                  isNull(soapNotes.deletedAt),
                ),
              )
              .limit(1);
            const [existingInvoice] = await tx
              .select({ id: invoices.id })
              .from(invoices)
              .where(
                and(
                  eq(invoices.appointmentId, current.id),
                  eq(invoices.practiceId, ctx.practiceId),
                  ne(invoices.status, "void"),
                  isNull(invoices.deletedAt),
                ),
              )
              .limit(1);
            if (existingNote || existingInvoice)
              fail(
                "The visit already has documentation or billing. Reconcile online before retrying.",
                "CONFLICT",
              );
            await tx
              .update(appointments)
              .set({
                status: "in_exam",
                origin: "field",
                startTime: start,
                endTime: end,
              })
              .where(eq(appointments.id, current.id));
            appointmentId = current.id;
          } else {
            const [active] = await tx
              .select({ id: appointments.id })
              .from(appointments)
              .where(
                and(
                  eq(appointments.practiceId, ctx.practiceId),
                  eq(appointments.patientId, packet.patientId),
                  eq(appointments.status, "in_exam"),
                  isNull(appointments.deletedAt),
                ),
              )
              .limit(1);
            if (active)
              fail(
                "This patient already has an open visit. Reconcile it before posting another.",
                "CONFLICT",
              );
            const [created] = await tx
              .insert(appointments)
              .values({
                practiceId: ctx.practiceId,
                patientId: packet.patientId,
                clientId: packet.clientId,
                doctorId: ctx.user.id,
                locationId: packet.locationId,
                origin: "field",
                status: "in_exam",
                startTime: start,
                endTime: end,
              })
              .returning();
            appointmentId = created!.id;
          }
          const note = await saveAppointmentSoapDraft(db, {
            practiceId: ctx.practiceId,
            patientId: packet.patientId,
            appointmentId,
            expectedRevision: 0,
            actor: { id: ctx.user.id, name: ctx.user.name },
            sections: visit.sections,
          });
          if (note.outcome !== "saved")
            fail("The clinical note changed. Review it online.", "CONFLICT");
          const [invoice] = await tx
            .insert(invoices)
            .values({
              practiceId: ctx.practiceId,
              clientId: packet.clientId,
              patientId: packet.patientId,
              appointmentId,
              status: "draft",
              subtotal: centsToMoney(totals.subtotalCents),
              tax: centsToMoney(totals.taxCents),
              total: centsToMoney(totals.totalCents),
              paidAmount: "0.00",
            })
            .returning();
          const lines = totals.lines.map((l) => ({
            id: randomUUID(),
            invoiceId: invoice!.id,
            itemType: "service" as const,
            itemId: l.id,
            description: l.name,
            quantity: l.quantity,
            unitPrice: l.price,
            total: centsToMoney(l.lineTotalCents),
            taxable: l.taxable,
          }));
          await tx.insert(invoiceItems).values(lines);
          const vaccinationIds: string[] = [];
          // One vaccine per invoice line preserves the existing one-work-item-per-line invariant.
          for (const vaccine of visit.vaccinations) {
            const linked = lines.find((l) => l.itemId === vaccine.serviceId)!;
            if (
              visit.vaccinations.filter(
                (v) => v.serviceId === vaccine.serviceId,
              ).length > 1
            )
              fail(
                "Use distinct services for multiple vaccine records in this pilot.",
              );
            const [record] = await tx
              .insert(vaccinationRecords)
              .values({
                id: vaccine.id,
                practiceId: ctx.practiceId,
                patientId: packet.patientId,
                appointmentId,
                vaccineName: vaccine.vaccineName,
                productName: vaccine.productName || null,
                lotNumber: vaccine.lotNumber || null,
                manufacturer: vaccine.manufacturer || null,
                productExpirationDate: vaccine.productExpirationDate,
                doseType: vaccine.doseType,
                rabiesTagNumber: vaccine.rabiesTagNumber || null,
                administeredAt: new Date(vaccine.administeredAt),
                administeredBy: ctx.user.id,
                supervisingVeterinarianId: ctx.user.id,
                nextDueDate: vaccine.nextDueDate,
              })
              .returning();
            vaccinationIds.push(record!.id);
            await tx
              .insert(visitWorkItems)
              .values({
                practiceId: ctx.practiceId,
                appointmentId,
                vaccinationRecordId: record!.id,
                status: "charged",
                invoiceId: invoice!.id,
                invoiceItemId: linked.id,
                resolvedBy: ctx.user.id,
                resolvedAt: new Date(),
              });
          }
          await assertVisitInvoiceReadyForFinancialAction(
            { db, practiceId: ctx.practiceId },
            appointmentId,
          );
          let paymentId: string | null = null;
          if (visit.payment) {
            const [payment] = await tx
              .insert(payments)
              .values({
                invoiceId: invoice!.id,
                amount: visit.payment.amount,
                method: visit.payment.method,
                receivedBy: ctx.user.id,
                receivedAt: new Date(visit.payment.receivedAt),
                externalId: `offline-field:${packet.id}`,
                notes: visit.payment.reference || null,
              })
              .returning();
            paymentId = payment!.id;
          }
          await tx
            .update(invoices)
            .set({
              status: totals.balanceCents === 0 ? "paid" : "sent",
              paidAmount: centsToMoney(totals.paidCents),
            })
            .where(eq(invoices.id, invoice!.id));
          const result = {
            appointmentId,
            noteId: note.draft.id,
            invoiceId: invoice!.id,
            paymentId,
            vaccinationIds,
            syncedAt: new Date().toISOString(),
          };
          await tx
            .update(offlineFieldBatches)
            .set({ requestHash, result, receipt: fieldReceiptSnapshot(input) })
            .where(eq(offlineFieldBatches.id, batch.id));
          await tx
            .insert(auditLog)
            .values({
              practiceId: ctx.practiceId,
              userId: ctx.user.id,
              action: "offline_field_synced",
              entityType: "offline_field_batch",
              entityId: packet.id,
              changes: { ...result, preparationId: packet.id },
            });
          return result;
        });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        if (error instanceof SoapLifecycleError)
          throw new TRPCError({ code: error.code, message: error.message });
        // Driver exceptions can contain clinical text and payment references.
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "The field visit could not be posted. Your device copy is unchanged. Retry the same receipt.",
        });
      }
    }),
});
