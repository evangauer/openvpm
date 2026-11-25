import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import * as schema from "../../../../packages/db/schema/index";
import { createRouter, type TRPCContext } from "../trpc";
import { disposableClinic } from "./helpers/disposable-clinic";
import {
  bytesToBase64,
  encodeWav,
  SCRIBE_SAMPLE_RATE,
  SCRIBE_SEGMENT_MAX_BASE64_LENGTH,
} from "@/lib/scribe/audio";
import { withSystem, withTenant } from "@/lib/tenant-db";

/**
 * Scribe inside a visit, against a real database with row-level security and
 * the restricted application role. Only the AI provider calls are stubbed.
 */

const mocks = vi.hoisted(() => ({
  transcribeScribeSegment: vi.fn(),
  draftScribeNote: vi.fn(),
}));
vi.mock("@/lib/scribe/transcribe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/scribe/transcribe")>()),
  transcribeScribeSegment: mocks.transcribeScribeSegment,
  isScribeAudioConfigured: () => true,
}));
vi.mock("@/lib/scribe/draft", () => ({
  draftScribeNote: mocks.draftScribeNote,
}));

const AUDIO = bytesToBase64(
  encodeWav(new Int16Array(SCRIBE_SAMPLE_RATE).fill(900)),
);

const integration =
  process.env.SCRIBE_DB_INTEGRATION === "1" ? describe : describe.skip;

const DEVICE_A = "a".repeat(48);
const DEVICE_B = "b".repeat(48);

integration("Scribe in a visit", () => {
  it("keeps the transcript with its visit and clinic, meters on the server, binds the phone link, and never outlives the note", async () => {
    vi.stubEnv("NEXT_PUBLIC_SCRIBE_ENABLED", "true");
    vi.stubEnv("AI_MODEL", "gemini-2.5-flash");
    vi.stubEnv("GOOGLE_VERTEX_API_KEY", "test-only");
    const fixture = await disposableClinic();
    const originalUrl = process.env.DATABASE_URL;
    // The phone route and the rate limiter use the app's own connection.
    process.env.DATABASE_URL = fixture.appUrl;
    try {
      const { scribeRouter } = await import("../routers/scribe");
      const { recordsRouter } = await import("../routers/records");
      const phoneRoute = await import("@/app/api/scribe-capture/[token]/route");
      const photoRoute = await import("@/app/api/capture/[token]/route");
      const recordings = await import("@/lib/scribe/recordings");
      const store = await import("@/lib/scribe/visit-store");

      const db = fixture.ownerDb;
      const [practice, otherPractice] = await db
        .insert(schema.practices)
        .values(
          ["Primary", "Other"].map((name) => ({
            name: `Synthetic ${name}`,
            country: "US",
            currency: "usd",
            taxRatePercent: "0.00",
            settings: { scribe: { enabled: true } },
          })),
        )
        .returning();
      const people = await db
        .insert(schema.users)
        .values(
          [
            { practiceId: practice!.id, role: "veterinarian" as const },
            { practiceId: practice!.id, role: "front_desk" as const },
            { practiceId: otherPractice!.id, role: "admin" as const },
            { practiceId: practice!.id, role: "admin" as const },
          ].map((person) => ({
            ...person,
            name: "Synthetic clinician",
            email: `${randomUUID()}@example.invalid`,
            passwordHash: "synthetic",
          })),
        )
        .returning();
      const [vet, frontDesk, outsider, admin] = people;
      const [client] = await db
        .insert(schema.clients)
        .values({
          practiceId: practice!.id,
          firstName: "Synthetic",
          lastName: "Owner",
        })
        .returning();
      const [patient] = await db
        .insert(schema.patients)
        .values({
          practiceId: practice!.id,
          clientId: client!.id,
          name: "Bella",
          species: "canine",
        })
        .returning();
      await db.insert(schema.patientAllergies).values({
        patientId: patient!.id,
        allergen: "Penicillin",
        severity: "severe",
      });
      await db.insert(schema.locations).values({
        practiceId: practice!.id,
        name: "Synthetic Location",
        isPrimary: true,
      });
      const now = Date.now();
      const visits = await db
        .insert(schema.appointments)
        .values(
          [0, 1, 2].map(() => ({
            practiceId: practice!.id,
            patientId: patient!.id,
            clientId: client!.id,
            doctorId: vet!.id,
            startTime: new Date(now - 10 * 60_000),
            endTime: new Date(now + 20 * 60_000),
            status: "in_exam" as const,
          })),
        )
        .returning();
      const [visit, staleVisit, longVisit] = visits;

      const router = createRouter({
        scribe: scribeRouter,
        records: recordsRouter,
      });
      const caller = (actor = vet!) =>
        router.createCaller({
          db: fixture.db,
          session: {
            expires: "2099-01-01",
            user: {
              id: actor.id,
              practiceId: actor.practiceId,
              name: actor.name,
              email: actor.email,
              role: actor.role,
            },
          },
        } as TRPCContext);
      const segmentsFor = (appointmentId: string) =>
        db
          .select({
            text: schema.scribeTranscriptSegments.text,
            source: schema.scribeTranscriptSegments.source,
          })
          .from(schema.scribeTranscriptSegments)
          .where(
            and(
              eq(schema.scribeTranscriptSegments.practiceId, practice!.id),
              eq(schema.scribeTranscriptSegments.appointmentId, appointmentId),
            ),
          )
          .orderBy(schema.scribeTranscriptSegments.createdAt);
      const phonePost = (
        token: string,
        body: unknown,
        device: string | null = DEVICE_A,
      ) =>
        phoneRoute.POST(
          new NextRequest(`http://localhost/api/scribe-capture/${token}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(device ? { "x-scribe-device": device } : {}),
            },
            body: typeof body === "string" ? body : JSON.stringify(body),
          }),
          { params: Promise.resolve({ token }) },
        );

      // --- Recording in the chart -----------------------------------------
      mocks.transcribeScribeSegment
        .mockResolvedValueOnce("Owner says Bella has not eaten for three days.")
        .mockResolvedValueOnce("Temperature is 39.1. Starting maropitant.");
      const recordingKey = randomUUID();
      const first = {
        appointmentId: visit!.id,
        clientKey: randomUUID(),
        recordingKey,
        audio: AUDIO,
      };
      expect(await caller().scribe.transcribeVisitSegment(first)).toEqual({
        text: "Owner says Bella has not eaten for three days.",
      });
      // A retried upload is stored once and does not call the provider again.
      expect(await caller().scribe.transcribeVisitSegment(first)).toEqual({
        text: "Owner says Bella has not eaten for three days.",
      });
      await caller().scribe.transcribeVisitSegment({
        ...first,
        clientKey: randomUUID(),
      });
      expect(mocks.transcribeScribeSegment).toHaveBeenCalledTimes(2);
      // The second part is given the end of the first for continuity.
      expect(mocks.transcribeScribeSegment.mock.calls[1]![0]).toMatchObject({
        previousTail: "Owner says Bella has not eaten for three days.",
        patientName: "Bella",
      });

      const transcript = await caller().scribe.visitTranscript({
        appointmentId: visit!.id,
      });
      expect(transcript.state).toBe("open");
      expect(transcript.segments.map((s) => s.text)).toEqual([
        "Owner says Bella has not eaten for three days.",
        "Temperature is 39.1. Starting maropitant.",
      ]);

      // --- Metering is the server's own count of audio ---------------------
      const recordingRows = () =>
        db
          .select({
            key: schema.scribeRecordings.recordingKey,
            audioSeconds: schema.scribeRecordings.audioSeconds,
            meteredRuns: schema.scribeRecordings.meteredRuns,
            source: schema.scribeRecordings.source,
          })
          .from(schema.scribeRecordings)
          .where(eq(schema.scribeRecordings.practiceId, practice!.id));
      // Two one-second parts; the retry added nothing.
      expect(await recordingRows()).toEqual([
        { key: recordingKey, audioSeconds: 2, meteredRuns: 1, source: "browser" },
      ]);
      // Ten more minutes in the same recording is one more run, exactly.
      const more = await withTenant(fixture.db, practice!.id, (tx) =>
        recordings.addRecordingAudio(tx, {
          practiceId: practice!.id,
          userId: vet!.id,
          appointmentId: visit!.id,
          recordingKey,
          source: "browser",
          seconds: 600,
        }),
      );
      expect(more).toEqual({ runsDue: 1, first: false });

      // One audit entry for the recording: who, which visit, no words.
      const audit = await db
        .select({
          action: schema.auditLog.action,
          entityId: schema.auditLog.entityId,
          changes: schema.auditLog.changes,
        })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.practiceId, practice!.id));
      expect(audit).toEqual([
        { action: "recorded", entityId: visit!.id, changes: { fromPhone: 0 } },
      ]);

      // --- Other people, other clinics, other devices ---------------------
      await expect(
        caller(outsider!).scribe.visitTranscript({ appointmentId: visit!.id }),
      ).rejects.toThrow(/not found/i);
      await expect(
        caller(outsider!).scribe.transcribeVisitSegment({
          ...first,
          clientKey: randomUUID(),
        }),
      ).rejects.toThrow();
      await expect(
        caller(frontDesk!).scribe.visitTranscript({ appointmentId: visit!.id }),
      ).rejects.toThrow();
      // A second device cannot start recording a visit that is being recorded.
      await expect(
        caller(admin!).scribe.transcribeVisitSegment({
          ...first,
          clientKey: randomUUID(),
          recordingKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      // Nor can it borrow the first device's recording.
      await expect(
        caller(admin!).scribe.transcribeVisitSegment({
          ...first,
          clientKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(mocks.transcribeScribeSegment).toHaveBeenCalledTimes(2);

      // --- Drafting uses the chart -----------------------------------------
      mocks.draftScribeNote.mockResolvedValueOnce({
        subjective: "Not eating for three days.",
        objective: "T 39.1",
        assessment: "",
        plan: "Maropitant.",
      });
      await caller().scribe.draftVisitNote({ appointmentId: visit!.id });
      const draftInput = mocks.draftScribeNote.mock.calls[0]![0];
      expect(draftInput.transcript).toContain("Starting maropitant");
      expect(draftInput.chart.patient.name).toBe("Bella");
      expect(draftInput.chart.allergies).toEqual([
        { allergen: "Penicillin", severity: "severe" },
      ]);

      // --- The phone link ----------------------------------------------------
      const phone = await caller().scribe.startPhoneRecording({
        appointmentId: visit!.id,
      });
      const token = phone.url.match(/\/scribe-capture\/([0-9a-f]{64})$/)?.[1];
      expect(token).toBeTruthy();
      const links = await db
        .select({ purpose: schema.captureSessions.purpose })
        .from(schema.captureSessions)
        .where(eq(schema.captureSessions.appointmentId, visit!.id));
      expect(links).toEqual([{ purpose: "scribe" }]);
      expect(
        (await caller().scribe.visitTranscript({ appointmentId: visit!.id }))
          .phoneRecording,
      ).toMatchObject({ connected: false });

      // A recording link cannot upload photos, and a made-up link is nothing.
      const asPhoto = await photoRoute.POST(
        new NextRequest(`http://localhost/api/capture/${token}`, {
          method: "POST",
          body: new FormData(),
        }),
        { params: Promise.resolve({ token: token! }) },
      );
      expect(asPhoto.status).toBe(404);
      expect((await phonePost("f".repeat(64), { action: "check" })).status).toBe(404);
      expect((await phonePost("not-a-token", { action: "check" })).status).toBe(404);

      // No device secret, no entry. The first phone to arrive owns the link.
      expect((await phonePost(token!, { action: "check" }, null)).status).toBe(400);
      expect((await phonePost(token!, { action: "check" })).status).toBe(200);
      expect((await phonePost(token!, { action: "check" })).status).toBe(200);
      expect((await phonePost(token!, { action: "check" }, DEVICE_B)).status).toBe(409);
      expect(
        (await phonePost(token!, { audio: AUDIO, clientKey: randomUUID() }, DEVICE_B))
          .status,
      ).toBe(409);
      expect((await phonePost(token!, { action: "finish" }, DEVICE_B)).status).toBe(409);
      expect(
        (await caller().scribe.visitTranscript({ appointmentId: visit!.id }))
          .phoneRecording,
      ).toMatchObject({ connected: true });

      // Malformed and oversized requests are refused before any AI call.
      expect((await phonePost(token!, "{not json")).status).toBe(400);
      expect(
        (await phonePost(token!, { audio: "aGVsbG8=", clientKey: randomUUID() })).status,
      ).toBe(400);
      expect(
        (await phonePost(token!, { audio: AUDIO, clientKey: randomUUID(), index: 1 }))
          .status,
      ).toBe(400);
      expect(
        (
          await phonePost(
            token!,
            JSON.stringify({
              audio: "A".repeat(SCRIBE_SEGMENT_MAX_BASE64_LENGTH + 8192),
              clientKey: randomUUID(),
            }),
          )
        ).status,
      ).toBe(413);
      expect(mocks.transcribeScribeSegment).toHaveBeenCalledTimes(2);

      // While the chart was recording a moment ago, the phone has to wait.
      const tooSoon = await phonePost(token!, {
        audio: AUDIO,
        clientKey: randomUUID(),
      });
      expect(tooSoon.status).toBe(409);
      await db
        .update(schema.scribeRecordings)
        .set({ updatedAt: new Date(now - 10 * 60_000) })
        .where(eq(schema.scribeRecordings.recordingKey, recordingKey));

      mocks.transcribeScribeSegment.mockResolvedValueOnce(
        "Bland diet for five days.",
      );
      const sent = await phonePost(token!, { audio: AUDIO, clientKey: randomUUID() });
      expect(sent.status).toBe(200);
      // The phone learns that a part arrived, never what was said.
      const sentBody = await sent.text();
      expect(JSON.parse(sentBody)).toEqual({ ok: true, heardSpeech: true });
      expect(sentBody).not.toContain("Bland");
      expect((await segmentsFor(visit!.id)).at(-1)).toEqual({
        text: "Bland diet for five days.",
        source: "phone",
      });
      // The link is its own recording, whatever the phone claims.
      expect(
        (await recordingRows()).find((row) => row.source === "phone"),
      ).toMatchObject({ audioSeconds: 1, meteredRuns: 1 });

      // --- A part still being transcribed when the note is finalized --------
      mocks.transcribeScribeSegment.mockImplementationOnce(async () => {
        await caller().records.createSoapNote({
          patientId: patient!.id,
          appointmentId: visit!.id,
          subjective: "Not eating for three days.",
          objective: "T 39.1",
          assessment: "Gastroenteritis",
          plan: "Maropitant.",
        });
        return "Words that arrived after the note was signed.";
      });
      const late = await phonePost(token!, { audio: AUDIO, clientKey: randomUUID() });
      expect(late.status).toBe(404);
      // Finalizing deleted the transcript, and the late part was not stored.
      expect(await segmentsFor(visit!.id)).toEqual([]);
      const after = await caller().scribe.visitTranscript({
        appointmentId: visit!.id,
      });
      expect(after).toMatchObject({ state: "finalized", phoneRecording: null });
      // The visit is still "in exam", but Scribe is done with it.
      await expect(
        caller().scribe.transcribeVisitSegment({
          ...first,
          clientKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      await expect(
        caller().scribe.startPhoneRecording({ appointmentId: visit!.id }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      await expect(
        caller().scribe.draftVisitNote({ appointmentId: visit!.id }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      expect((await phonePost(token!, { action: "check" })).status).toBe(404);

      // --- Clean-up of transcripts a visit left behind ---------------------
      const twoDaysAgo = new Date(now - 48 * 60 * 60_000);
      const part = (appointmentId: string, createdAt: Date, text: string) => ({
        practiceId: practice!.id,
        appointmentId,
        createdBy: vet!.id,
        clientKey: randomUUID(),
        source: "browser",
        text,
        createdAt,
      });
      await db.insert(schema.scribeTranscriptSegments).values([
        part(staleVisit!.id, twoDaysAgo, "left behind"),
        // A long stay: its early part is old, but it is still being recorded.
        part(longVisit!.id, twoDaysAgo, "start of a long stay"),
        part(longVisit!.id, new Date(now), "still going"),
      ]);
      const removed = await withSystem(fixture.db, (tx) =>
        store.purgeStaleScribeTranscripts(tx),
      );
      expect(removed).toBe(1);
      expect(await segmentsFor(staleVisit!.id)).toEqual([]);
      expect((await segmentsFor(longVisit!.id)).map((s) => s.text)).toEqual([
        "start of a long stay",
        "still going",
      ]);

      // --- Turning Scribe off deletes what it held --------------------------
      await caller().scribe.startPhoneRecording({ appointmentId: longVisit!.id });
      expect(await caller(admin!).scribe.setEnabled({ enabled: false })).toEqual({
        enabled: false,
      });
      expect(await segmentsFor(longVisit!.id)).toEqual([]);
      const openLinks = await db
        .select({ id: schema.captureSessions.id })
        .from(schema.captureSessions)
        .where(
          and(
            eq(schema.captureSessions.practiceId, practice!.id),
            eq(schema.captureSessions.purpose, "scribe"),
            sql`${schema.captureSessions.deletedAt} is null`,
          ),
        );
      expect(openLinks).toEqual([]);
      await expect(
        caller().scribe.visitTranscript({ appointmentId: longVisit!.id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      // Nothing said in any of this reached the audit trail.
      const trail = JSON.stringify(
        await db
          .select({ changes: schema.auditLog.changes })
          .from(schema.auditLog)
          .where(eq(schema.auditLog.practiceId, practice!.id)),
      );
      for (const spoken of ["Bella", "maropitant", "Bland", "eaten"]) {
        expect(trail).not.toContain(spoken);
      }
    } finally {
      process.env.DATABASE_URL = originalUrl;
      vi.unstubAllEnvs();
      await fixture.close();
    }
  }, 240_000);
});
