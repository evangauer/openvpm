import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as schema from "../../../../packages/db/schema/index";
import { createRouter, type TRPCContext } from "../trpc";
import { offlineRouter } from "../routers/offline";
import { recordsRouter } from "../routers/records";
import { EMPTY_SOAP } from "@/lib/offline/workspace";
import { disposableClinic } from "./helpers/disposable-clinic";

vi.mock("@/lib/webhook-dispatcher", () => ({ dispatchWebhookEvent: vi.fn() }));
const integration =
  process.env.OFFLINE_WORKSPACE_DB_INTEGRATION === "1"
    ? describe
    : describe.skip;
integration("Offline workspace on restricted disposable PostgreSQL", () => {
  it("scopes snapshots, rejects revoked access, and safely reconciles retries, conflicts, signed notes and audit failures", async () => {
    const fixture = await disposableClinic();
    const originalUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = fixture.appUrl;
    vi.stubEnv("NEXT_PUBLIC_OFFLINE_WORKSPACE_ENABLED", "true");
    try {
      const db = fixture.ownerDb;
      const [practice, foreign] = await db
        .insert(schema.practices)
        .values([
          { name: "Synthetic offline clinic" },
          { name: "Synthetic other clinic" },
        ])
        .returning();
      const [doctor, other] = await db
        .insert(schema.users)
        .values(
          [practice!, foreign!].map((clinic, i) => ({
            practiceId: clinic.id,
            role: "veterinarian" as const,
            name: "Synthetic Doctor",
            email: `offline-${i}@example.invalid`,
            passwordHash: "synthetic",
          })),
        )
        .returning();
      const [owner, otherOwner] = await db
        .insert(schema.clients)
        .values(
          [practice!, foreign!].map((clinic) => ({
            practiceId: clinic.id,
            firstName: "Synthetic",
            lastName: "Owner",
          })),
        )
        .returning();
      const [patient, otherPatient] = await db
        .insert(schema.patients)
        .values([
          {
            practiceId: practice!.id,
            clientId: owner!.id,
            name: "Offline Patient",
            species: "feline" as const,
          },
          {
            practiceId: foreign!.id,
            clientId: otherOwner!.id,
            name: "Foreign Patient",
            species: "feline" as const,
          },
        ])
        .returning();
      await db
        .insert(schema.locations)
        .values(
          [practice!, foreign!].map((clinic) => ({
            practiceId: clinic.id,
            name: "Synthetic clinic location",
            isPrimary: true,
          })),
        );
      const [visit, foreignVisit, auditVisit, raceVisit] = await db
        .insert(schema.appointments)
        .values(
          [
            {
              practiceId: practice!.id,
              patientId: patient!.id,
              clientId: owner!.id,
            },
            {
              practiceId: foreign!.id,
              patientId: otherPatient!.id,
              clientId: otherOwner!.id,
            },
            {
              practiceId: practice!.id,
              patientId: patient!.id,
              clientId: owner!.id,
            },
            {
              practiceId: practice!.id,
              patientId: patient!.id,
              clientId: owner!.id,
            },
          ].map((item) => ({
            ...item,
            status: "in_exam" as const,
            startTime: new Date(),
            endTime: new Date(Date.now() + 3_600_000),
          })),
        )
        .returning();
      await db.insert(schema.patientAllergies).values({
        patientId: patient!.id,
        allergen: "Synthetic allergy",
        severity: "severe",
      });
      await db.insert(schema.clinicalNotes).values([
        {
          practiceId: practice!.id,
          patientId: patient!.id,
          authorId: doctor!.id,
          content: "Public chart note",
          isChartNote: true,
        },
        {
          practiceId: practice!.id,
          patientId: patient!.id,
          authorId: doctor!.id,
          content: "Private legacy note",
          isChartNote: false,
        },
        {
          practiceId: foreign!.id,
          patientId: otherPatient!.id,
          authorId: other!.id,
          content: "Foreign clinic note",
          isChartNote: true,
        },
      ]);
      const router = createRouter({
        offline: offlineRouter,
        records: recordsRouter,
      });
      const caller = (actor = doctor!, role = actor.role) =>
        router.createCaller({
          db: fixture.db,
          session: {
            expires: "2099-01-01",
            user: {
              id: actor.id,
              practiceId: actor.practiceId,
              name: actor.name,
              email: actor.email,
              role,
            },
          },
        } as TRPCContext);
      const clinician = caller();
      const prepared = await clinician.offline.prepareChart({
        patientId: patient!.id,
        appointmentId: visit!.id,
      });
      expect(prepared.chart.notes.map((note) => note.content)).toEqual([
        "Public chart note",
      ]);
      expect(prepared.chart.allergies[0]?.allergen).toBe("Synthetic allergy");
      expect(prepared.chart.visit).toMatchObject({
        appointmentId: visit!.id,
        revision: 0,
        noteId: null,
      });
      expect(prepared.identity).toMatchObject({
        userId: doctor!.id,
        practiceId: practice!.id,
      });
      expect(
        new Date(prepared.identity.expiresAt).getTime() -
          new Date(prepared.identity.authorizedAt).getTime(),
      ).toBe(86_400_000);
      for (const id of [otherPatient!.id, randomUUID()])
        await expect(
          clinician.offline.prepareChart({ patientId: id }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        clinician.offline.prepareChart({
          patientId: patient!.id,
          appointmentId: foreignVisit!.id,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      for (const role of ["technician", "front_desk", "viewer"] as const)
        await expect(
          caller(doctor!, role).offline.session(),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });

      const payload = {
        userId: doctor!.id,
        practiceId: practice!.id,
        request: {
          patientId: patient!.id,
          appointmentId: visit!.id,
          noteId: null as string | null,
          expectedRevision: 0,
          sections: {
            ...EMPTY_SOAP,
            subjective: "<p>Synthetic offline note</p>",
          },
        },
      };
      const first = await clinician.offline.saveSoapDraft(payload);
      expect(first.outcome).toBe("saved");
      if (first.outcome !== "saved") throw new Error("Expected saved draft");
      expect(await clinician.offline.saveSoapDraft(payload)).toEqual(first);
      expect(
        await clinician.offline.saveSoapDraft({
          ...payload,
          request: {
            ...payload.request,
            sections: { ...EMPTY_SOAP, plan: "Competing local text" },
          },
        }),
      ).toMatchObject({
        outcome: "conflict",
        sections: { subjective: payload.request.sections.subjective },
      });
      await expect(
        clinician.offline.saveSoapDraft({ ...payload, userId: other!.id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        caller(other!).offline.saveSoapDraft(payload),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const rows = await db
        .select()
        .from(schema.soapNotes)
        .where(eq(schema.soapNotes.appointmentId, visit!.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.revision).toBe(1);
      const audits = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.entityId, first.noteId));
      expect(audits.length).toBeGreaterThan(0);
      expect(JSON.stringify(audits)).not.toContain("Synthetic offline note");
      expect(
        audits.every((audit) => audit.action === "offline_draft_saved"),
      ).toBe(true);

      // Turning off new preparation must not strand existing device drafts.
      vi.stubEnv("NEXT_PUBLIC_OFFLINE_WORKSPACE_ENABLED", "false");
      await expect(
        clinician.offline.prepareChart({ patientId: patient!.id }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      const update = await clinician.offline.saveSoapDraft({
        ...payload,
        request: {
          ...payload.request,
          noteId: first.noteId,
          expectedRevision: 1,
          sections: {
            ...payload.request.sections,
            plan: "<p>Updated plan</p>",
          },
        },
      });
      expect(update).toMatchObject({ outcome: "saved", revision: 2 });
      vi.stubEnv("NEXT_PUBLIC_OFFLINE_WORKSPACE_ENABLED", "true");
      await clinician.records.finalizeSoapNote({
        patientId: patient!.id,
        appointmentId: visit!.id,
        noteId: first.noteId,
        expectedRevision: 2,
      });
      expect(await clinician.offline.saveSoapDraft(payload)).toMatchObject({
        outcome: "already_finalized",
        sections: { plan: "<p>Updated plan</p>" },
      });
      await expect(
        clinician.offline.prepareChart({
          patientId: patient!.id,
          appointmentId: visit!.id,
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      expect(
        (await clinician.offline.prepareChart({ patientId: patient!.id })).chart
          .soapHistory[0]?.sections.plan,
      ).toBe("<p>Updated plan</p>");

      const competing = await Promise.all(
        ["A", "B"].map((text) =>
          clinician.offline.saveSoapDraft({
            ...payload,
            request: {
              ...payload.request,
              appointmentId: raceVisit!.id,
              sections: { ...EMPTY_SOAP, plan: text },
            },
          }),
        ),
      );
      expect(competing.map((result) => result.outcome).sort()).toEqual([
        "conflict",
        "saved",
      ]);
      expect(
        await db
          .select()
          .from(schema.soapNotes)
          .where(eq(schema.soapNotes.appointmentId, raceVisit!.id)),
      ).toHaveLength(1);

      await fixture.owner.unsafe(
        "create function public.synthetic_offline_audit_failure() returns trigger language plpgsql as $$ begin if new.action = 'offline_draft_saved' then raise exception 'synthetic audit failure'; end if; return new; end $$",
      );
      await fixture.owner.unsafe(
        "create trigger synthetic_offline_audit_failure before insert on public.audit_log for each row execute function public.synthetic_offline_audit_failure()",
      );
      await expect(
        clinician.offline.saveSoapDraft({
          ...payload,
          request: { ...payload.request, appointmentId: auditVisit!.id },
        }),
      ).rejects.toThrow();
      expect(
        await db
          .select()
          .from(schema.soapNotes)
          .where(eq(schema.soapNotes.appointmentId, auditVisit!.id)),
      ).toHaveLength(0);
      await fixture.owner.unsafe(
        "drop trigger synthetic_offline_audit_failure on public.audit_log",
      );

      // A stale privileged session cannot override current membership or holds.
      await db
        .update(schema.users)
        .set({ role: "front_desk" })
        .where(eq(schema.users.id, doctor!.id));
      await expect(clinician.offline.session()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(
        clinician.offline.saveSoapDraft(payload),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await db
        .update(schema.users)
        .set({ role: "veterinarian" })
        .where(eq(schema.users.id, doctor!.id));
      await db
        .update(schema.practices)
        .set({
          recoveryHold: true,
          recoveryHoldReason: "Synthetic recovery verification",
          recoveryHoldSetAt: new Date(),
        })
        .where(eq(schema.practices.id, practice!.id));
      await expect(clinician.offline.session()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await db
        .update(schema.practices)
        .set({ recoveryHold: false })
        .where(eq(schema.practices.id, practice!.id));
      await db.insert(schema.patientAllergies).values(
        Array.from({ length: 49 }, (_, i) => ({
          patientId: patient!.id,
          allergen: `Synthetic allergy ${i}`,
          severity: "severe" as const,
        })),
      );
      expect(
        (await clinician.offline.prepareChart({ patientId: patient!.id })).chart
          .allergies,
      ).toHaveLength(50);
      await db.insert(schema.patientAllergies).values({
        patientId: patient!.id,
        allergen: "Synthetic allergy beyond snapshot limit",
        severity: "severe",
      });
      await expect(
        clinician.offline.prepareChart({ patientId: patient!.id }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      await db
        .update(schema.patients)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(schema.patients.id, patient!.id),
            eq(schema.patients.practiceId, practice!.id),
          ),
        );
      await expect(
        clinician.offline.prepareChart({ patientId: patient!.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      vi.unstubAllEnvs();
      process.env.DATABASE_URL = originalUrl;
      await fixture.close();
    }
  }, 240_000);
});
