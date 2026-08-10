import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@openpims/db/client";
import {
  appointments,
  clients,
  emailSuppressions,
  locations,
  patients,
  practices,
} from "@openpims/db";
import {
  appointmentReminderDispatchEligible,
  currentAppointmentReminderEmailRecipient,
} from "@/lib/messaging/appointment-reminder";

const describeWithPostgres = process.env.REMINDER_POLICY_DB_INTEGRATION
  ? describe
  : describe.skip;

describeWithPostgres("appointment reminder dispatch eligibility SQL", () => {
  it("honors each clinic's enablement, lead window, and current appointment state", async () => {
    const enabledPracticeId = randomUUID();
    const disabledPracticeId = randomUUID();
    const enabledClientId = randomUUID();
    const disabledClientId = randomUUID();
    const enabledLocationId = randomUUID();
    const disabledLocationId = randomUUID();
    const enabledPatientId = randomUUID();
    const disabledPatientId = randomUUID();
    const soonAppointmentId = randomUUID();
    const laterAppointmentId = randomUUID();
    const disabledAppointmentId = randomUUID();
    const now = new Date("2026-08-10T12:00:00.000Z");
    const in12Hours = new Date("2026-08-11T00:00:00.000Z");
    const in48Hours = new Date("2026-08-12T12:00:00.000Z");

    await db.transaction(async (tx) => {
      try {
        await tx.insert(practices).values([
          {
            id: enabledPracticeId,
            name: "Reminder integration enabled",
            appointmentRemindersEnabled: true,
            appointmentReminderLeadHours: 24,
          },
          {
            id: disabledPracticeId,
            name: "Reminder integration disabled",
            appointmentRemindersEnabled: false,
            appointmentReminderLeadHours: 72,
          },
        ]);
        await tx.insert(locations).values([
          {
            id: enabledLocationId,
            practiceId: enabledPracticeId,
            name: "Enabled reminder location",
            isPrimary: true,
          },
          {
            id: disabledLocationId,
            practiceId: disabledPracticeId,
            name: "Disabled reminder location",
            isPrimary: true,
          },
        ]);
        await tx.insert(clients).values([
          {
            id: enabledClientId,
            practiceId: enabledPracticeId,
            firstName: "Enabled",
            lastName: "Client",
          },
          {
            id: disabledClientId,
            practiceId: disabledPracticeId,
            firstName: "Disabled",
            lastName: "Client",
          },
        ]);
        await tx.insert(patients).values([
          {
            id: enabledPatientId,
            practiceId: enabledPracticeId,
            clientId: enabledClientId,
            name: "Miso",
            species: "feline",
          },
          {
            id: disabledPatientId,
            practiceId: disabledPracticeId,
            clientId: disabledClientId,
            name: "Pico",
            species: "canine",
          },
        ]);
        await tx.insert(appointments).values([
          {
            id: soonAppointmentId,
            practiceId: enabledPracticeId,
            locationId: enabledLocationId,
            clientId: enabledClientId,
            patientId: enabledPatientId,
            startTime: in12Hours,
            endTime: new Date(in12Hours.getTime() + 30 * 60 * 1000),
            status: "confirmed",
          },
          {
            id: laterAppointmentId,
            practiceId: enabledPracticeId,
            locationId: enabledLocationId,
            clientId: enabledClientId,
            patientId: enabledPatientId,
            startTime: in48Hours,
            endTime: new Date(in48Hours.getTime() + 30 * 60 * 1000),
            status: "confirmed",
          },
          {
            id: disabledAppointmentId,
            practiceId: disabledPracticeId,
            locationId: disabledLocationId,
            clientId: disabledClientId,
            patientId: disabledPatientId,
            startTime: in48Hours,
            endTime: new Date(in48Hours.getTime() + 30 * 60 * 1000),
            status: "confirmed",
          },
        ]);

        const eligible = (options: {
          practiceId: string;
          appointmentId: string;
          clientId: string;
          startTime: Date;
        }) =>
          appointmentReminderDispatchEligible(tx, {
            ...options,
            now,
          });

        await expect(
          eligible({
            practiceId: enabledPracticeId,
            appointmentId: soonAppointmentId,
            clientId: enabledClientId,
            startTime: in12Hours,
          }),
        ).resolves.toBe(true);

        await tx
          .update(clients)
          .set({ email: "updated@example.com" })
          .where(eq(clients.id, enabledClientId));
        await tx.insert(emailSuppressions).values({
          practiceId: enabledPracticeId,
          email: "updated@example.com",
          reason: "complaint",
        });
        await expect(
          currentAppointmentReminderEmailRecipient(tx, {
            practiceId: enabledPracticeId,
            appointmentId: soonAppointmentId,
            clientId: enabledClientId,
            startTime: in12Hours,
            now,
          }),
        ).resolves.toMatchObject({
          recipientEmail: "updated@example.com",
          suppressionReason: "complaint",
        });
        await expect(
          eligible({
            practiceId: enabledPracticeId,
            appointmentId: laterAppointmentId,
            clientId: enabledClientId,
            startTime: in48Hours,
          }),
        ).resolves.toBe(false);
        await expect(
          eligible({
            practiceId: disabledPracticeId,
            appointmentId: disabledAppointmentId,
            clientId: disabledClientId,
            startTime: in48Hours,
          }),
        ).resolves.toBe(false);

        await tx
          .update(practices)
          .set({ appointmentReminderLeadHours: 72 })
          .where(eq(practices.id, enabledPracticeId));
        await expect(
          eligible({
            practiceId: enabledPracticeId,
            appointmentId: laterAppointmentId,
            clientId: enabledClientId,
            startTime: in48Hours,
          }),
        ).resolves.toBe(true);

        await tx
          .update(appointments)
          .set({ status: "cancelled" })
          .where(eq(appointments.id, laterAppointmentId));
        await expect(
          eligible({
            practiceId: enabledPracticeId,
            appointmentId: laterAppointmentId,
            clientId: enabledClientId,
            startTime: in48Hours,
          }),
        ).resolves.toBe(false);

        await tx
          .update(appointments)
          .set({ status: "confirmed", startTime: in12Hours })
          .where(eq(appointments.id, laterAppointmentId));
        await expect(
          eligible({
            practiceId: enabledPracticeId,
            appointmentId: laterAppointmentId,
            clientId: enabledClientId,
            startTime: in48Hours,
          }),
        ).resolves.toBe(false);
      } finally {
        await tx
          .delete(emailSuppressions)
          .where(eq(emailSuppressions.practiceId, enabledPracticeId));
        await tx
          .delete(appointments)
          .where(
            inArray(appointments.id, [
              soonAppointmentId,
              laterAppointmentId,
              disabledAppointmentId,
            ]),
          );
        await tx
          .delete(patients)
          .where(inArray(patients.id, [enabledPatientId, disabledPatientId]));
        await tx
          .delete(clients)
          .where(inArray(clients.id, [enabledClientId, disabledClientId]));
        await tx
          .delete(locations)
          .where(
            inArray(locations.id, [enabledLocationId, disabledLocationId]),
          );
        await tx
          .delete(practices)
          .where(
            inArray(practices.id, [enabledPracticeId, disabledPracticeId]),
          );
      }
    });
  });
});
