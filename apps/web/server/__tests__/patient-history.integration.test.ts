import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { eq, sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import * as schema from "../../../../packages/db/schema/index";
import type { Database } from "@openpims/db/client";
import { withTenant } from "@/lib/tenant-db";
import {
  addFinalizedSoapAddendum,
  replaceFinalizedSoapNote,
} from "@/lib/records/soap-lifecycle";
import { buildPatientHistoryQuery } from "../patient-history";
import { recordsRouter } from "../routers/records";

const repoRoot = resolve(process.cwd(), "../..");
const describeWithPatientHistoryPostgres =
  process.env.PATIENT_HISTORY_DB_INTEGRATION === "1" ? describe : describe.skip;

describeWithPatientHistoryPostgres(
  "patient history PostgreSQL contract",
  () => {
    it("is literal, lifecycle-safe, paginated, role-gated, and tenant isolated", async () => {
      const adminUrl = process.env.DATABASE_URL;
      if (!adminUrl) throw new Error("DATABASE_URL is required");

      const databaseName = `openpims_patient_history_${randomUUID().replaceAll("-", "")}`;
      if (!/^openpims_patient_history_[a-f0-9]+$/.test(databaseName)) {
        throw new Error("unsafe disposable database name");
      }

      const databaseUrl = new URL(adminUrl);
      databaseUrl.pathname = `/${databaseName}`;
      databaseUrl.search = "";
      databaseUrl.hash = "";

      const adminSql = postgres(adminUrl, { max: 1 });
      let ownerSql: ReturnType<typeof postgres> | undefined;
      await adminSql.unsafe(`create database "${databaseName}"`);

      try {
        for (const args of [
          ["--filter", "@openpims/db", "db:migrate"],
          ["--filter", "@openpims/db", "db:rls"],
        ]) {
          execFileSync("pnpm", args, {
            cwd: repoRoot,
            env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
            encoding: "utf8",
            timeout: 45_000,
          });
        }

        ownerSql = postgres(databaseUrl.toString(), { max: 1 });
        const ownerDb = drizzle(ownerSql, { schema });
        const [practiceA, practiceB] = await ownerDb
          .insert(schema.practices)
          .values([
            {
              name: "Synthetic History Clinic A",
              timezone: "America/New_York",
            },
            {
              name: "Synthetic History Clinic B",
              timezone: "America/Los_Angeles",
            },
          ])
          .returning({ id: schema.practices.id });
        if (!practiceA || !practiceB) throw new Error("practice seed failed");

        const [clientA, clientB] = await ownerDb
          .insert(schema.clients)
          .values([
            {
              practiceId: practiceA.id,
              firstName: "Synthetic",
              lastName: "Owner A",
            },
            {
              practiceId: practiceB.id,
              firstName: "Synthetic",
              lastName: "Owner B",
            },
          ])
          .returning({ id: schema.clients.id });
        if (!clientA || !clientB) throw new Error("client seed failed");

        const [userA, userB] = await ownerDb
          .insert(schema.users)
          .values([
            {
              practiceId: practiceA.id,
              email: "history-a@example.invalid",
              passwordHash: "not-a-real-password-hash",
              name: "Synthetic Clinician A",
              role: "veterinarian",
              isVeterinarian: true,
            },
            {
              practiceId: practiceB.id,
              email: "history-b@example.invalid",
              passwordHash: "not-a-real-password-hash",
              name: "Synthetic Clinician B",
              role: "veterinarian",
              isVeterinarian: true,
            },
          ])
          .returning({ id: schema.users.id });
        if (!userA || !userB) throw new Error("user seed failed");

        const [patientA, unrelatedPatient, patientB, deletedPatient] =
          await ownerDb
            .insert(schema.patients)
            .values([
              {
                practiceId: practiceA.id,
                clientId: clientA.id,
                name: "Long History Patient",
                species: "canine",
              },
              {
                practiceId: practiceA.id,
                clientId: clientA.id,
                name: "Unrelated High Cardinality Patient",
                species: "canine",
              },
              {
                practiceId: practiceB.id,
                clientId: clientB.id,
                name: "Cross Tenant Patient",
                species: "canine",
              },
              {
                practiceId: practiceA.id,
                clientId: clientA.id,
                name: "Deleted Patient",
                species: "feline",
                deletedAt: new Date("2026-08-20T00:00:00.000Z"),
              },
            ])
            .returning({ id: schema.patients.id });
        if (!patientA || !unrelatedPatient || !patientB || !deletedPatient) {
          throw new Error("patient seed failed");
        }

        // Make the target chart realistically long while keeping a much larger
        // unrelated population. This is PHI-free and is removed with the DB.
        await ownerSql`
          insert into soap_notes
            (practice_id, patient_id, author_id, author_name, status,
             finalized_at, finalized_by, finalizer_name, subjective, created_at)
          select
            ${practiceA.id}, ${unrelatedPatient.id}, ${userA.id},
            'Synthetic Clinician A', 'finalized',
            '2026-01-01T12:00:00Z'::timestamptz + (series || ' seconds')::interval,
            ${userA.id}, 'Synthetic Clinician A',
            'Unrelated population record ' || series,
            '2026-01-01T12:00:00Z'::timestamptz + (series || ' seconds')::interval
          from generate_series(1, 30000) series
        `;
        await ownerSql`
          insert into soap_notes
            (practice_id, patient_id, author_id, author_name, status,
             finalized_at, finalized_by, finalizer_name, subjective, created_at)
          select
            ${practiceA.id}, ${patientA.id}, ${userA.id},
            'Synthetic Clinician A', 'finalized',
            '2026-02-01T12:00:00Z'::timestamptz + (series || ' seconds')::interval,
            ${userA.id}, 'Synthetic Clinician A',
            case when series <= 60 then 'routine tied history' else 'routine long history' end,
            case when series <= 60
              then '2026-07-01T12:00:00Z'::timestamptz
              else '2026-02-01T12:00:00Z'::timestamptz + (series || ' seconds')::interval
            end
          from generate_series(1, 2050) series
        `;

        const [
          correctedSoap,
          addendumSoap,
          literalSoap,
          decoySoap,
          dstBefore,
          dstInside,
          importedSoap,
          deletedSoap,
          draftSoap,
        ] = await ownerDb
          .insert(schema.soapNotes)
          .values([
            {
              practiceId: practiceA.id,
              patientId: patientA.id,
              authorId: userA.id,
              authorName: "Synthetic Clinician A",
              status: "finalized",
              finalizedAt: new Date("2026-08-10T14:00:00.000Z"),
              finalizedBy: userA.id,
              finalizerName: "Synthetic Clinician A",
              assessment: `<p>${"Long visible clinical context ".repeat(20)}<strong>Carprofen</strong> discussed for osteoarthritis</p>`,
              createdAt: new Date("2026-08-10T14:00:00.000Z"),
              imported: true,
            },
            {
              practiceId: practiceA.id,
              patientId: patientA.id,
              authorId: userA.id,
              authorName: "Synthetic Clinician A",
              status: "finalized",
              finalizedAt: new Date("2026-08-12T14:00:00.000Z"),
              finalizedBy: userA.id,
              finalizerName: "Synthetic Clinician A",
              subjective: "Owner called with an update",
              createdAt: new Date("2026-08-12T14:00:00.000Z"),
            },
            {
              practiceId: practiceA.id,
              patientId: patientA.id,
              authorId: userA.id,
              authorName: "Synthetic Clinician A",
              status: "finalized",
              finalizedAt: new Date("2026-08-13T14:00:00.000Z"),
              finalizedBy: userA.id,
              finalizerName: "Synthetic Clinician A",
              plan: String.raw`Literal 50%_off\plan`,
              createdAt: new Date("2026-08-13T14:00:00.000Z"),
            },
            {
              practiceId: practiceA.id,
              patientId: patientA.id,
              authorId: userA.id,
              authorName: "Synthetic Clinician A",
              status: "finalized",
              finalizedAt: new Date("2026-08-13T13:00:00.000Z"),
              finalizedBy: userA.id,
              finalizerName: "Synthetic Clinician A",
              plan: "Literal 50xxoffXplan wildcard decoy",
              createdAt: new Date("2026-08-13T13:00:00.000Z"),
            },
            {
              practiceId: practiceA.id,
              patientId: patientA.id,
              authorId: userA.id,
              authorName: "Synthetic Clinician A",
              status: "finalized",
              finalizedAt: new Date("2026-03-08T04:30:00.000Z"),
              finalizedBy: userA.id,
              finalizerName: "Synthetic Clinician A",
              plan: "DST boundary marker",
              createdAt: new Date("2026-03-08T04:30:00.000Z"),
            },
            {
              practiceId: practiceA.id,
              patientId: patientA.id,
              authorId: userA.id,
              authorName: "Synthetic Clinician A",
              status: "finalized",
              finalizedAt: new Date("2026-03-08T05:30:00.000Z"),
              finalizedBy: userA.id,
              finalizerName: "Synthetic Clinician A",
              plan: "DST boundary marker",
              createdAt: new Date("2026-03-08T05:30:00.000Z"),
            },
            {
              practiceId: practiceA.id,
              patientId: patientA.id,
              authorId: userA.id,
              authorName: "Synthetic Clinician A",
              status: "finalized",
              finalizedAt: new Date("2025-12-01T15:00:00.000Z"),
              finalizedBy: userA.id,
              finalizerName: "Synthetic Clinician A",
              plan: "Imported history marker; unified surface marker",
              imported: true,
              createdAt: new Date("2025-12-01T15:00:00.000Z"),
            },
            {
              practiceId: practiceA.id,
              patientId: patientA.id,
              authorId: userA.id,
              authorName: "Synthetic Clinician A",
              status: "finalized",
              finalizedAt: new Date("2026-08-14T14:00:00.000Z"),
              finalizedBy: userA.id,
              finalizerName: "Synthetic Clinician A",
              plan: "Deleted history marker",
              createdAt: new Date("2026-08-14T14:00:00.000Z"),
              deletedAt: new Date("2026-08-15T14:00:00.000Z"),
            },
            {
              practiceId: practiceA.id,
              patientId: patientA.id,
              authorId: userA.id,
              authorName: "Synthetic Clinician A",
              status: "draft",
              plan: "Draft-only carprofen should not be legal history",
              createdAt: new Date("2026-08-15T14:00:00.000Z"),
            },
          ])
          .returning({ id: schema.soapNotes.id });
        if (
          !correctedSoap ||
          !addendumSoap ||
          !literalSoap ||
          !decoySoap ||
          !dstBefore ||
          !dstInside ||
          !importedSoap ||
          !deletedSoap ||
          !draftSoap
        ) {
          throw new Error("SOAP evidence seed failed");
        }

        await ownerDb.transaction((tx) =>
          addFinalizedSoapAddendum(tx as unknown as Database, {
            practiceId: practiceA.id,
            patientId: patientA.id,
            noteId: addendumSoap.id,
            operationId: randomUUID(),
            content: "Addendum-only carprofen response",
            actor: { id: userA.id, name: "Synthetic Clinician A" },
          }),
        );
        const replacementResult = await ownerDb.transaction((tx) =>
          replaceFinalizedSoapNote(tx as unknown as Database, {
            practiceId: practiceA.id,
            patientId: patientA.id,
            sourceNoteId: correctedSoap.id,
            operationId: randomUUID(),
            reason: "Dose attribution corrected",
            actor: { id: userA.id, name: "Synthetic Clinician A" },
            sections: {
              subjective: null,
              objective: null,
              assessment: null,
              plan: "Carprofen corrected dose",
            },
          }),
        );
        const replacementSoap = replacementResult.note;

        const [prescription] = await ownerDb
          .insert(schema.prescriptions)
          .values({
            practiceId: practiceA.id,
            patientId: patientA.id,
            medicationName: "Carprofen",
            dosage: "25 mg",
            frequency: "Twice daily",
            prescribedBy: userA.id,
            startDate: "2026-08-09",
            instructions: "Give with food; unified surface marker",
          })
          .returning({ id: schema.prescriptions.id });
        if (!prescription) throw new Error("prescription seed failed");

        await ownerDb.insert(schema.vaccinationRecords).values({
          practiceId: practiceA.id,
          patientId: patientA.id,
          vaccineName: "Unified surface marker vaccine",
          administeredBy: userA.id,
          administeredAt: new Date("2026-08-08T14:00:00.000Z"),
        });
        await ownerDb.insert(schema.labResults).values({
          practiceId: practiceA.id,
          patientId: patientA.id,
          testName: "Unified surface marker lab",
          resultValue: "normal",
          status: "completed",
          orderedBy: userA.id,
          completedAt: new Date("2026-08-07T14:00:00.000Z"),
          followUpStatus: "open",
          followUpAssignedTo: userA.id,
          followUpNote: "PRIVATE_FOLLOW_UP_SENTINEL",
        });
        await ownerDb.insert(schema.procedures).values({
          practiceId: practiceA.id,
          patientId: patientA.id,
          name: "Unified surface marker procedure",
          performedBy: userA.id,
        });
        await ownerDb.insert(schema.problemList).values({
          practiceId: practiceA.id,
          patientId: patientA.id,
          description: "Unified surface marker problem",
        });
        await ownerDb.insert(schema.vitalSigns).values({
          practiceId: practiceA.id,
          patientId: patientA.id,
          recordedBy: userA.id,
          notes: "Unified surface marker vital",
          recordedAt: new Date("2026-08-06T14:00:00.000Z"),
        });
        await ownerDb.insert(schema.patientAllergies).values({
          patientId: patientA.id,
          allergen: "Unified surface marker allergy",
          notedBy: userA.id,
          notedAt: new Date("2026-08-05T14:00:00.000Z"),
        });

        await ownerDb.insert(schema.clinicalNotes).values({
          practiceId: practiceA.id,
          patientId: patientA.id,
          authorId: userA.id,
          noteType: "general",
          content: "PRIVATE_WORKLIST_SENTINEL carprofen",
        });
        await ownerDb.insert(schema.soapNotes).values({
          practiceId: practiceB.id,
          patientId: patientB.id,
          authorId: userB.id,
          authorName: "Synthetic Clinician B",
          status: "finalized",
          finalizedAt: new Date("2026-08-20T14:00:00.000Z"),
          finalizedBy: userB.id,
          finalizerName: "Synthetic Clinician B",
          assessment: "Cross-tenant carprofen secret",
          createdAt: new Date("2026-08-20T14:00:00.000Z"),
        });

        // Historical attribution must survive ordinary staff deactivation.
        await ownerDb
          .update(schema.users)
          .set({ deletedAt: new Date("2026-08-21T00:00:00.000Z") })
          .where(eq(schema.users.id, userA.id));

        const session = (role: string) => ({
          user: {
            id: randomUUID(),
            email: `${role}@example.invalid`,
            name: "Synthetic History User",
            role,
            practiceId: practiceA.id,
          },
        });
        const caller = (role = "veterinarian") =>
          recordsRouter.createCaller({
            db: ownerDb,
            session: session(role),
          } as never);

        await ownerSql`set role openpims_app`;
        const [noContext] = await ownerSql<Array<{ count: number }>>`
          select count(*)::int as count from soap_notes
        `;
        expect(noContext?.count).toBe(0);

        await expect(
          caller("front_desk").searchPatientHistory({ patientId: patientA.id }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        for (const role of ["admin", "veterinarian", "technician", "viewer"]) {
          await expect(
            caller(role).searchPatientHistory({
              patientId: patientA.id,
              query: "carprofen",
              recordTypes: ["soap_note", "prescription"],
            }),
          ).resolves.toMatchObject({ total: 4 });
        }

        const carprofen = await caller().searchPatientHistory({
          patientId: patientA.id,
          query: "CaRpRoFeN",
          recordTypes: ["soap_note", "prescription"],
        });
        expect(carprofen.total).toBe(4);
        expect(carprofen.items.map((item) => item.id).sort()).toEqual(
          [
            correctedSoap.id,
            replacementSoap.id,
            addendumSoap.id,
            prescription.id,
          ].sort(),
        );
        expect(
          carprofen.items.find((item) => item.id === correctedSoap.id),
        ).toMatchObject({
          corrected: true,
          imported: true,
          replacementRecordId: replacementSoap.id,
          authorLabel: "Imported by",
          authorName: "Synthetic Clinician A",
          finalizerName: "Synthetic Clinician A",
        });
        expect(
          carprofen.items.find((item) => item.id === replacementSoap.id),
        ).toMatchObject({
          corrected: false,
          replacesRecordId: correctedSoap.id,
          authorLabel: "Authored by",
          authorName: "Synthetic Clinician A",
          finalizerName: "Synthetic Clinician A",
        });
        expect(
          carprofen.items.find((item) => item.id === prescription.id),
        ).toMatchObject({
          authorLabel: "Prescribed by",
          authorName: "Synthetic Clinician A",
          finalizerName: null,
        });
        expect(JSON.stringify(carprofen)).not.toContain(
          "PRIVATE_WORKLIST_SENTINEL",
        );
        expect(JSON.stringify(carprofen)).not.toContain("Cross-tenant");
        expect(JSON.stringify(carprofen)).not.toContain("Draft-only");
        for (const item of carprofen.items) {
          expect(item.summary).toBeTruthy();
          expect(item.summary).not.toContain("<");
          expect(
            item
              .summary!.split("\n")
              .every((line) => line.toLowerCase().includes("carprofen")),
          ).toBe(true);
        }

        const markupOnly = await caller().searchPatientHistory({
          patientId: patientA.id,
          query: "<strong>",
          recordTypes: ["soap_note"],
        });
        expect(markupOnly.total).toBe(0);

        const unifiedSurface = await caller().searchPatientHistory({
          patientId: patientA.id,
          query: "unified surface marker",
        });
        expect(unifiedSurface.total).toBe(8);
        expect(
          new Set(unifiedSurface.items.map(({ recordType }) => recordType)),
        ).toEqual(
          new Set([
            "soap_note",
            "prescription",
            "vaccination",
            "lab_result",
            "procedure",
            "problem",
            "vital_sign",
            "allergy",
          ]),
        );
        expect(
          unifiedSurface.items
            .filter((item) => item.authorLabel)
            .every((item) => item.authorName === "Synthetic Clinician A"),
        ).toBe(true);
        const privateLabWork = await caller().searchPatientHistory({
          patientId: patientA.id,
          query: "PRIVATE_FOLLOW_UP_SENTINEL",
        });
        expect(privateLabWork.total).toBe(0);

        const literal = await caller().searchPatientHistory({
          patientId: patientA.id,
          query: String.raw`50%_off\plan`,
          recordTypes: ["soap_note"],
        });
        expect(literal.items.map((item) => item.id)).toEqual([literalSoap.id]);
        expect(literal.items.map((item) => item.id)).not.toContain(
          decoySoap.id,
        );

        const correctedOnly = await caller().searchPatientHistory({
          patientId: patientA.id,
          query: "carprofen",
          recordTypes: ["soap_note", "prescription"],
          state: "corrected",
        });
        expect(correctedOnly.items.map((item) => item.id)).toEqual([
          correctedSoap.id,
        ]);

        const dstDay = await caller().searchPatientHistory({
          patientId: patientA.id,
          query: "DST boundary marker",
          recordTypes: ["soap_note"],
          fromDate: "2026-03-08",
          toDate: "2026-03-08",
        });
        expect(dstDay.items.map((item) => item.id)).toEqual([dstInside.id]);
        expect(dstDay.items.map((item) => item.id)).not.toContain(dstBefore.id);

        const firstPage = await caller().searchPatientHistory({
          patientId: patientA.id,
          query: "routine tied history",
          recordTypes: ["soap_note"],
          limit: 25,
        });
        expect(firstPage.total).toBe(60);
        expect(firstPage.items).toHaveLength(25);
        expect(firstPage.nextCursor).not.toBeNull();
        await ownerSql`reset role`;
        await ownerDb.insert(schema.soapNotes).values({
          practiceId: practiceA.id,
          patientId: patientA.id,
          authorId: userA.id,
          authorName: "Synthetic Clinician A",
          status: "finalized",
          finalizedAt: new Date("2026-08-22T14:00:00.000Z"),
          finalizedBy: userA.id,
          finalizerName: "Synthetic Clinician A",
          subjective: "routine tied history newer insert",
          createdAt: new Date("2026-08-22T14:00:00.000Z"),
        });
        await ownerSql`set role openpims_app`;
        const secondPage = await caller().searchPatientHistory({
          patientId: patientA.id,
          query: "routine tied history",
          recordTypes: ["soap_note"],
          limit: 25,
          cursor: firstPage.nextCursor!,
        });
        expect(secondPage.items).toHaveLength(25);
        expect(
          new Set([
            ...firstPage.items.map((item) => item.id),
            ...secondPage.items.map((item) => item.id),
          ]).size,
        ).toBe(50);

        await expect(
          caller().searchPatientHistory({ patientId: patientB.id }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(
          caller().searchPatientHistory({ patientId: deletedPatient.id }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        const deletedRecord = await caller().searchPatientHistory({
          patientId: patientA.id,
          query: "Deleted history marker",
          recordTypes: ["soap_note"],
        });
        expect(deletedRecord.total).toBe(0);

        // Production tables have autovacuum statistics. The disposable test
        // database needs an explicit analyze after its synthetic bulk load so
        // EXPLAIN evaluates the patient and practice paths with real cardinality.
        await ownerSql`reset role`;
        await ownerSql`analyze soap_notes`;
        await ownerSql`analyze prescriptions`;
        await ownerSql`set role openpims_app`;
        const plan = await withTenant(ownerDb, practiceA.id, async (tx) =>
          tx.execute(
            drizzleSql`explain (analyze, buffers, format json) ${buildPatientHistoryQuery(
              {
                practiceId: practiceA.id,
                input: {
                  patientId: patientA.id,
                  query: "carprofen",
                  recordTypes: ["soap_note", "prescription"],
                  state: "all",
                  limit: 25,
                },
              },
            )}`,
          ),
        );
        const planText = JSON.stringify(plan);
        expect(planText).toContain("soap_notes_patient_idx");
        expect(planText).not.toContain('"Rows Removed by Filter":30001');

        const [contextAfterSearch] = await ownerSql<
          Array<{ practiceId: string | null }>
        >`
          select nullif(current_setting('app.current_practice_id', true), '') as "practiceId"
        `;
        expect(contextAfterSearch?.practiceId).toBeNull();
      } finally {
        if (ownerSql) await ownerSql.end();
        await adminSql.unsafe(
          `drop database if exists "${databaseName}" with (force)`,
        );
        await adminSql.end();
      }
    }, 120_000);
  },
);
