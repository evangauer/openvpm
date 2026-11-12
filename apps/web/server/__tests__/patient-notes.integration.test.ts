import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import * as schema from "../../../../packages/db/schema/index";
import { patientNotesRouter } from "../routers/patient-notes";
import { createRouter } from "../trpc";

const router = createRouter({ patientNotes: patientNotesRouter });

const integration =
  process.env.PATIENT_NOTES_DB_INTEGRATION === "1" ? describe : describe.skip;
integration("Direct patient notes PostgreSQL contract", () => {
  it("saves without an appointment, preserves text, audits atomically, retries safely, and isolates clinics", async () => {
    const adminUrl = process.env.DATABASE_URL;
    if (!adminUrl) throw new Error("DATABASE_URL is required");
    const databaseName = `openpims_patient_notes_${randomUUID().replaceAll("-", "")}`;
    if (!/^openpims_patient_notes_[a-f0-9]+$/.test(databaseName))
      throw new Error("unsafe database name");
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    databaseUrl.search = "";
    databaseUrl.hash = "";
    const admin = postgres(adminUrl, { max: 1 });
    let connection: ReturnType<typeof postgres> | undefined;
    await admin.unsafe(`create database "${databaseName}"`);
    try {
      for (const command of ["db:migrate", "db:rls"]) {
        execFileSync("pnpm", ["--filter", "@openpims/db", command], {
          cwd: resolve(process.cwd(), "../.."),
          env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
          stdio: "pipe",
          timeout: 45_000,
        });
      }
      connection = postgres(databaseUrl.toString(), { max: 1 });
      const db = drizzle(connection, { schema });
      const [a, b] = await db
        .insert(schema.practices)
        .values([{ name: "Synthetic Notes A" }, { name: "Synthetic Notes B" }])
        .returning();
      const [ownerA, ownerB] = await db
        .insert(schema.clients)
        .values([
          { practiceId: a!.id, firstName: "Synthetic", lastName: "Owner A" },
          { practiceId: b!.id, firstName: "Synthetic", lastName: "Owner B" },
        ])
        .returning();
      const [author, otherAuthor] = await db
        .insert(schema.users)
        .values([
          {
            practiceId: a!.id,
            name: "Synthetic Doctor",
            email: "notes-a@example.invalid",
            passwordHash: "test",
            role: "veterinarian",
          },
          {
            practiceId: b!.id,
            name: "Other Doctor",
            email: "notes-b@example.invalid",
            passwordHash: "test",
            role: "veterinarian",
          },
        ])
        .returning();
      const [patient, foreignPatient, deletedPatient] = await db
        .insert(schema.patients)
        .values([
          {
            practiceId: a!.id,
            clientId: ownerA!.id,
            name: "Synthetic Cat",
            id: "11111111-2222-3333-4444-555555555555",
            species: "feline",
          },
          {
            practiceId: b!.id,
            clientId: ownerB!.id,
            name: "Other Cat",
            species: "feline",
          },
          {
            practiceId: a!.id,
            clientId: ownerA!.id,
            name: "Deleted Cat",
            species: "feline",
            deletedAt: new Date(),
          },
        ])
        .returning();
      const caller = (
        role = "veterinarian",
        practiceId = a!.id,
        userId = author!.id,
      ) =>
        router.createCaller({
          db,
          session: {
            user: {
              id: userId,
              practiceId,
              role,
              email: "notes@example.invalid",
              name: "Synthetic Doctor",
            },
          },
        } as never).patientNotes;
      const payload = {
        patientId: patient!.id,
        operationId: randomUUID(),
        noteType: "phone_call" as const,
        content:
          "Pasted update\nSecond line: <script>literal text</script> & 50%",
      };
      await connection`set role openpims_app`;
      expect(await db.select().from(schema.clinicalNotes)).toEqual([]);
      const saved = await caller().create(payload);
      expect(saved.content).toBe(payload.content);
      expect(saved.authorId).toBe(author!.id);
      expect(saved.patientId).toBe(patient!.id);
      expect(saved.isChartNote).toBe(true);
      expect((await caller().create(payload)).id).toBe(saved.id);
      expect(
        (await caller().list({ patientId: patient!.id })).items,
      ).toHaveLength(1);
      await expect(
        caller().create({ ...payload, content: "Changed retry" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      for (const role of ["front_desk", "technician", "viewer"]) {
        await expect(
          caller(role).create({ ...payload, operationId: randomUUID() }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
      for (const role of ["front_desk"]) {
        await expect(
          caller(role).list({ patientId: patient!.id }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
      expect(
        (await caller("technician").list({ patientId: patient!.id })).items[0]
          ?.content,
      ).toBe(payload.content);
      expect(
        (await caller("viewer").list({ patientId: patient!.id })).items[0]
          ?.content,
      ).toBe(payload.content);
      for (const patientId of [
        foreignPatient!.id,
        deletedPatient!.id,
        randomUUID(),
      ]) {
        await expect(caller().list({ patientId })).rejects.toMatchObject({
          code: "NOT_FOUND",
        });
        await expect(
          caller().create({ ...payload, patientId, operationId: randomUUID() }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      }
      for (const content of [" \n\t", "x".repeat(20001)]) {
        await expect(
          caller().create({ ...payload, operationId: randomUUID(), content }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      }
      await caller("admin").create({
        ...payload,
        operationId: randomUUID(),
        content: "x".repeat(20000),
      });
      await caller("veterinarian", b!.id, otherAuthor!.id).create({
        ...payload,
        patientId: foreignPatient!.id,
        operationId: randomUUID(),
        content: "Foreign clinic note",
      });
      // Identical timestamps exercise the UUID tie-breaker in pagination.
      await connection`reset role`;
      const [legacyNote] = await db
        .insert(schema.clinicalNotes)
        .values({
          practiceId: a!.id,
          patientId: patient!.id,
          authorId: author!.id,
          noteType: payload.noteType,
          content: payload.content,
        })
        .returning();
      expect(legacyNote!.isChartNote).toBe(false);
      await db.insert(schema.clinicalNotes).values(
        Array.from({ length: 28 }, (_, index) => ({
          practiceId: a!.id,
          patientId: patient!.id,
          authorId: author!.id,
          content: `Older note ${index}`,
          isChartNote: true,
          createdAt: new Date("2026-01-01T12:00:00Z"),
        })),
      );
      const audits = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.entityId, saved.id));
      expect(audits).toHaveLength(1);
      expect(audits[0]?.changes).toEqual({
        patientId: patient!.id,
        noteType: "phone_call",
      });
      // Deactivated staff keep attribution on historical notes.
      await db
        .update(schema.users)
        .set({ deletedAt: new Date() })
        .where(eq(schema.users.id, author!.id));
      await connection`set role openpims_app`;
      await expect(
        caller().create({ ...payload, operationId: legacyNote!.id }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const first = await caller().list({ patientId: patient!.id });
      const second = await caller().list({
        patientId: patient!.id,
        cursor: first.nextCursor,
      });
      expect(first.items).toHaveLength(25);
      expect(second.items).toHaveLength(5);
      expect(
        new Set([...first.items, ...second.items].map((note) => note.id)).size,
      ).toBe(30);
      expect(second.nextCursor).toBeUndefined();
      expect(
        [...first.items, ...second.items].some(
          (note) => note.id === legacyNote!.id,
        ),
      ).toBe(false);
      expect(
        first.items.every((note) => note.authorName === "Synthetic Doctor"),
      ).toBe(true);
      expect(
        [...first.items, ...second.items].some(
          (note) => note.content === "Foreign clinic note",
        ),
      ).toBe(false);
      // Force a failed audit insert. The outer request must roll back the note.
      await connection`reset role`;
      await connection`create function reject_note_audit() returns trigger language plpgsql as $$ begin raise exception 'Synthetic audit failure'; end $$`;
      await connection`create trigger reject_note_audit before insert on audit_log for each row execute function reject_note_audit()`;
      const failedId = randomUUID();
      await connection`set role openpims_app`;
      await expect(
        caller().create({ ...payload, operationId: failedId }),
      ).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
        message: "Unable to save the chart note. Please retry.",
      });
      await connection`reset role`;
      expect(
        await db
          .select()
          .from(schema.clinicalNotes)
          .where(eq(schema.clinicalNotes.id, failedId)),
      ).toEqual([]);
      expect(await db.select().from(schema.appointments)).toEqual([]);
    } finally {
      if (connection) await connection.end();
      await admin.unsafe(
        `drop database if exists "${databaseName}" with (force)`,
      );
      await admin.end();
    }
  }, 120_000);
});
