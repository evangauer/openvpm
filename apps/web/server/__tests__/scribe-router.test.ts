import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  bytesToBase64,
  encodeWav,
  SCRIBE_SAMPLE_RATE,
} from "@/lib/scribe/audio";
import { SCRIBE_ENABLED_ENV } from "@/lib/scribe/availability";

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn(async () => undefined),
  draftScribeNote: vi.fn(),
  transcribeScribeSegment: vi.fn(),
  isScribeAudioConfigured: vi.fn(() => true),
  rateLimit: vi.fn(async () => ({ success: true })),
  recordUsage: vi.fn(async () => undefined),
  readHostedAiAccess: vi.fn(async () => ({
    allowed: true,
    reason: "allowed",
    message: null as string | null,
  })),
  lockPractice: vi.fn(async () => true),
  findRecording: vi.fn(async (): Promise<unknown> => null),
  addRecordingAudio: vi.fn(async () => ({ runsDue: 1, first: true })),
  purgePracticeScribeData: vi.fn(async () => undefined),
  loadScribeVocabulary: vi.fn(async () => ["Otomax"]),
}));

vi.mock("@/lib/scribe/vocabulary", () => ({
  loadScribeVocabulary: mocks.loadScribeVocabulary,
}));

vi.mock("@/lib/audit", () => ({ recordAuditLog: mocks.recordAuditLog }));
vi.mock("@/lib/scribe/draft", () => ({
  draftScribeNote: mocks.draftScribeNote,
}));
vi.mock("@/lib/scribe/transcribe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/scribe/transcribe")>()),
  transcribeScribeSegment: mocks.transcribeScribeSegment,
  isScribeAudioConfigured: mocks.isScribeAudioConfigured,
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: mocks.rateLimit,
}));
vi.mock("@/lib/billing/usage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/usage")>()),
  recordUsage: mocks.recordUsage,
}));
vi.mock("@/lib/billing/ai-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/ai-access")>()),
  readHostedAiAccess: mocks.readHostedAiAccess,
}));
vi.mock("@/lib/recovery-hold", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/recovery-hold")>()),
  lockPracticeForExternalSideEffects: mocks.lockPractice,
}));

vi.mock("@/lib/scribe/recordings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/scribe/recordings")>()),
  findRecording: mocks.findRecording,
  addRecordingAudio: mocks.addRecordingAudio,
}));
vi.mock("@/lib/scribe/visit-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/scribe/visit-store")>()),
  purgePracticeScribeData: mocks.purgePracticeScribeData,
}));

const { scribeRouter } = await import("../routers/scribe");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const TRANSCRIPT = "Owner says Biscuit has been limping for two days.";
const DRAFT = {
  subjective: "Limping for two days.",
  objective: "",
  assessment: "",
  plan: "",
};
const AUDIO = bytesToBase64(
  encodeWav(new Int16Array(SCRIBE_SAMPLE_RATE).fill(900)),
);
const RECORDING_KEY = "11111111-1111-4111-8111-111111111111";
const OPTED_IN = [{ settings: { scribe: { enabled: true } } }];
const NOT_OPTED_IN = [{ settings: {} }];

function createDb(selectResults: unknown[][] = [], updatedRows: unknown[] = []) {
  const results = [...selectResults];
  const select = vi.fn(() => {
    const result = results.shift() ?? [];
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(async () => result),
    };
    return builder;
  });
  const insertValues = vi.fn(async (_values: unknown) => undefined);
  const insert = vi.fn(() => ({ values: insertValues }));
  const updateSet = vi.fn(() => ({
    where: vi.fn(() => ({ returning: vi.fn(async () => updatedRows) })),
  }));
  const update = vi.fn(() => ({ set: updateSet }));
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
    insert,
    update,
  };
  return { db, select, insertValues, update, updateSet };
}

function caller(db: Record<string, unknown>, role = "veterinarian") {
  const session = {
    user: {
      id: USER_ID,
      email: "doctor@example.com",
      name: "Doctor",
      role,
      practiceId: PRACTICE_ID,
    },
  };
  return scribeRouter.createCaller({ db, session } as never);
}

beforeEach(() => {
  vi.stubEnv(SCRIBE_ENABLED_ENV, "true");
  mocks.draftScribeNote.mockResolvedValue(DRAFT);
  mocks.transcribeScribeSegment.mockResolvedValue("He has been limping.");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("scribe availability", () => {
  it("reports unavailable without reading the clinic while the deployment is dark", async () => {
    vi.stubEnv(SCRIBE_ENABLED_ENV, "false");
    const { db, select } = createDb([OPTED_IN]);
    await expect(caller(db, "admin").availability()).resolves.toEqual({
      available: false,
      enabled: false,
      canManage: false,
      configured: false,
      canRecord: false,
    });
    expect(select).not.toHaveBeenCalled();
  });

  it.each(["technician", "front_desk", "viewer"])(
    "reports unavailable to the %s role",
    async (role) => {
      const { db, select } = createDb([OPTED_IN]);
      await expect(caller(db, role).availability()).resolves.toMatchObject({
        available: false,
        enabled: false,
      });
      expect(select).not.toHaveBeenCalled();
    },
  );

  it("separates the clinic opt-in from who may change it", async () => {
    await expect(
      caller(createDb([NOT_OPTED_IN]).db, "admin").availability(),
    ).resolves.toMatchObject({ available: true, enabled: false, canManage: true });
    await expect(
      caller(createDb([OPTED_IN]).db).availability(),
    ).resolves.toMatchObject({ available: true, enabled: true, canManage: false });
  });
});

describe("scribe clinic opt-in", () => {
  it("lets only an administrator change it", async () => {
    const { db, update } = createDb([], OPTED_IN);
    await expect(
      caller(db).setEnabled({ enabled: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(update).not.toHaveBeenCalled();

    await expect(
      caller(db, "admin").setEnabled({ enabled: true }),
    ).resolves.toEqual({ enabled: true });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("deletes what Scribe was holding when a clinic turns it off", async () => {
    const off = createDb([], NOT_OPTED_IN);
    await expect(
      caller(off.db, "admin").setEnabled({ enabled: false }),
    ).resolves.toEqual({ enabled: false });
    expect(mocks.purgePracticeScribeData).toHaveBeenCalledWith(off.db, PRACTICE_ID);

    mocks.purgePracticeScribeData.mockClear();
    const on = createDb([], OPTED_IN);
    await caller(on.db, "admin").setEnabled({ enabled: true });
    expect(mocks.purgePracticeScribeData).not.toHaveBeenCalled();
  });

  it("cannot be changed while the deployment is dark", async () => {
    vi.stubEnv(SCRIBE_ENABLED_ENV, "false");
    const { db, update } = createDb([], OPTED_IN);
    await expect(
      caller(db, "admin").setEnabled({ enabled: true }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("hosted rollout list", () => {
  beforeEach(() => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
  });

  it("hides Scribe from a hosted clinic that is not on the list", async () => {
    vi.stubEnv("SCRIBE_PRACTICE_IDS", "00000000-0000-0000-0000-0000000000bb");
    const { db, select, update } = createDb([OPTED_IN], OPTED_IN);
    await expect(caller(db, "admin").availability()).resolves.toMatchObject({
      available: false,
    });
    expect(select).not.toHaveBeenCalled();
    await expect(
      caller(db, "admin").setEnabled({ enabled: true }),
    ).rejects.toBeInstanceOf(Error);
    expect(update).not.toHaveBeenCalled();
  });

  it("treats an empty list as no clinic", async () => {
    vi.stubEnv("SCRIBE_PRACTICE_IDS", "");
    await expect(
      caller(createDb([OPTED_IN]).db, "admin").availability(),
    ).resolves.toMatchObject({ available: false });
  });

  it("opens Scribe to a listed clinic, or to every clinic with *", async () => {
    for (const list of [`other, ${PRACTICE_ID}`, "*"]) {
      vi.stubEnv("SCRIBE_PRACTICE_IDS", list);
      await expect(
        caller(createDb([OPTED_IN]).db, "admin").availability(),
      ).resolves.toMatchObject({ available: true, enabled: true });
    }
  });

  it("is ignored on self-hosted installations", async () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "false");
    vi.stubEnv("SCRIBE_PRACTICE_IDS", "");
    await expect(
      caller(createDb([OPTED_IN]).db, "admin").availability(),
    ).resolves.toMatchObject({ available: true });
  });
});

describe("scribe drafting", () => {
  it("drafts for an opted-in clinic, meters the run and records sizes only", async () => {
    const { db, insertValues } = createDb([OPTED_IN]);
    await expect(
      caller(db).draftFromTranscript({
        transcript: TRANSCRIPT,
        patientName: "Biscuit",
      }),
    ).resolves.toEqual(DRAFT);

    expect(mocks.draftScribeNote).toHaveBeenCalledWith({
      transcript: TRANSCRIPT,
      patientName: "Biscuit",
    });
    expect(mocks.recordUsage).toHaveBeenCalledWith({
      practiceId: PRACTICE_ID,
      kind: "ai_run",
    });
    expect(insertValues).toHaveBeenCalledTimes(1);
    const entry = insertValues.mock.calls[0]?.[0];
    expect(entry).toEqual({
      practiceId: PRACTICE_ID,
      userId: USER_ID,
      action: "drafted",
      entityType: "scribe_note",
      entityId: null,
      changes: { transcriptCharacters: TRANSCRIPT.length },
    });
    expect(JSON.stringify(entry)).not.toContain("Biscuit");
    expect(mocks.recordAuditLog).not.toHaveBeenCalled();
  });

  it("keeps the transcript out of the generic mutation audit", () => {
    const trpc = readFileSync(new URL("../trpc.ts", import.meta.url), "utf8");
    const skipList = trpc.slice(
      trpc.indexOf("Audit other successful mutations"),
      trpc.indexOf("const rawInput = await getRawInput()"),
    );
    for (const path of [
      "scribe.draftFromTranscript",
      "scribe.transcribeSegment",
      "scribe.transcribeVisitSegment",
      "scribe.draftVisitNote",
    ]) {
      expect(skipList).toContain(`"${path}"`);
    }
  });

  it("still returns the draft when the audit entry cannot be written", async () => {
    const { db, insertValues } = createDb([OPTED_IN]);
    insertValues.mockRejectedValueOnce(new Error("audit unavailable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      caller(db).draftFromTranscript({ transcript: TRANSCRIPT }),
    ).resolves.toEqual(DRAFT);
    expect(JSON.stringify(error.mock.calls)).not.toContain("Biscuit");
    error.mockRestore();
  });

  it("refuses while the deployment is dark, before reading or calling the provider", async () => {
    vi.stubEnv(SCRIBE_ENABLED_ENV, "false");
    const { db, select } = createDb([OPTED_IN]);
    await expect(
      caller(db).draftFromTranscript({ transcript: TRANSCRIPT }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(select).not.toHaveBeenCalled();
    expect(mocks.draftScribeNote).not.toHaveBeenCalled();
  });

  it("refuses a clinic that has not opted in", async () => {
    const { db } = createDb([NOT_OPTED_IN]);
    await expect(
      caller(db, "admin").draftFromTranscript({ transcript: TRANSCRIPT }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.draftScribeNote).not.toHaveBeenCalled();
  });

  it.each(["technician", "front_desk", "viewer"])(
    "refuses the %s role",
    async (role) => {
      const { db } = createDb([OPTED_IN]);
      await expect(
        caller(db, role).draftFromTranscript({ transcript: TRANSCRIPT }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(mocks.draftScribeNote).not.toHaveBeenCalled();
    },
  );

  it("rejects an empty or oversized transcript and unknown fields", async () => {
    const { db } = createDb([OPTED_IN, OPTED_IN, OPTED_IN]);
    for (const input of [
      { transcript: "   " },
      { transcript: "x".repeat(60_001) },
      { transcript: TRANSCRIPT, patientId: USER_ID },
    ]) {
      await expect(
        caller(db).draftFromTranscript(input as never),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(mocks.draftScribeNote).not.toHaveBeenCalled();
  });

  it("stops at the rate limit, a recovery hold, or missing AI access", async () => {
    mocks.rateLimit.mockResolvedValueOnce({ success: false });
    await expect(
      caller(createDb([OPTED_IN]).db).draftFromTranscript({
        transcript: TRANSCRIPT,
      }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    mocks.lockPractice.mockResolvedValueOnce(false);
    await expect(
      caller(createDb([OPTED_IN]).db).draftFromTranscript({
        transcript: TRANSCRIPT,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    mocks.readHostedAiAccess.mockResolvedValueOnce({
      allowed: false,
      reason: "subscription_inactive",
      message: "Subscription inactive.",
    });
    await expect(
      caller(createDb([OPTED_IN]).db).draftFromTranscript({
        transcript: TRANSCRIPT,
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Subscription inactive.",
    });

    expect(mocks.draftScribeNote).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("does not meter or audit a draft the provider failed to produce", async () => {
    mocks.draftScribeNote.mockRejectedValueOnce(new Error("provider down"));
    const { db, insertValues } = createDb([OPTED_IN]);
    await expect(
      caller(db).draftFromTranscript({ transcript: TRANSCRIPT }),
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Could not draft the note. Try again.",
    });
    expect(mocks.recordUsage).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });
});

describe("scribe recording", () => {
  it("transcribes a segment and hands the decoded audio to the provider", async () => {
    const { db } = createDb([OPTED_IN]);
    await expect(
      caller(db).transcribeSegment({
        audio: AUDIO,
        recordingKey: RECORDING_KEY,
        previousTail: "and he is off his food",
        species: "Dog",
      }),
    ).resolves.toEqual({ text: "He has been limping." });

    const input = mocks.transcribeScribeSegment.mock.calls[0]![0];
    expect(input.wav).toBeInstanceOf(Uint8Array);
    expect(input.wav.length).toBe(44 + SCRIBE_SAMPLE_RATE * 2);
    expect(input).toMatchObject({
      vocabulary: ["Otomax"],
      previousTail: "and he is off his food",
      species: "Dog",
    });
    expect(mocks.recordAuditLog).not.toHaveBeenCalled();
  });

  it("meters by the audio the server measured, not by what the page says", async () => {
    const first = createDb([OPTED_IN]);
    await caller(first.db).transcribeSegment({
      audio: AUDIO,
      recordingKey: RECORDING_KEY,
    });
    // AUDIO is exactly one second long.
    expect(mocks.addRecordingAudio).toHaveBeenCalledWith(
      first.db,
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        userId: USER_ID,
        appointmentId: null,
        recordingKey: RECORDING_KEY,
        source: "browser",
        seconds: 1,
      }),
    );
    expect(mocks.recordUsage).toHaveBeenCalledWith({
      practiceId: PRACTICE_ID,
      kind: "ai_run",
      quantity: 1,
    });
    expect(first.insertValues).toHaveBeenCalledWith({
      practiceId: PRACTICE_ID,
      userId: USER_ID,
      action: "recorded",
      entityType: "scribe_note",
      entityId: null,
      changes: { fromPhone: 0 },
    });

    // Later audio inside the same metered stretch costs nothing more.
    mocks.addRecordingAudio.mockResolvedValueOnce({ runsDue: 0, first: false });
    const later = createDb([OPTED_IN]);
    await caller(later.db).transcribeSegment({
      audio: AUDIO,
      recordingKey: RECORDING_KEY,
    });
    expect(mocks.recordUsage).toHaveBeenCalledTimes(1);
    expect(later.insertValues).not.toHaveBeenCalled();
  });

  it("has no input a page could use to skip metering", async () => {
    const { db } = createDb([OPTED_IN]);
    await expect(
      caller(db).transcribeSegment({
        audio: AUDIO,
        recordingKey: RECORDING_KEY,
        index: 1,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.transcribeScribeSegment).not.toHaveBeenCalled();
  });

  it("refuses a recording key that names someone else's recording", async () => {
    mocks.findRecording.mockResolvedValueOnce({
      createdBy: "00000000-0000-0000-0000-000000000099",
      appointmentId: null,
      source: "browser",
      audioSeconds: 30,
      deviceKeyHash: null,
    });
    const { db } = createDb([OPTED_IN]);
    await expect(
      caller(db).transcribeSegment({ audio: AUDIO, recordingKey: RECORDING_KEY }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.transcribeScribeSegment).not.toHaveBeenCalled();
  });

  it("stops a recording that has reached the longest length", async () => {
    mocks.findRecording.mockResolvedValueOnce({
      createdBy: USER_ID,
      appointmentId: null,
      source: "browser",
      audioSeconds: 50 * 60,
      deviceKeyHash: null,
    });
    const { db } = createDb([OPTED_IN]);
    await expect(
      caller(db).transcribeSegment({ audio: AUDIO, recordingKey: RECORDING_KEY }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.transcribeScribeSegment).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("refuses audio that is not a Scribe recording before reading anything", async () => {
    const { db, select } = createDb([OPTED_IN, OPTED_IN, OPTED_IN]);
    const wrongRate = bytesToBase64(encodeWav(new Int16Array(100), 44_100));
    for (const audio of ["not base64!", "aGVsbG8gd29ybGQ=", wrongRate]) {
      await expect(
        caller(db).transcribeSegment({ audio, recordingKey: RECORDING_KEY }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(select).not.toHaveBeenCalled();
    expect(mocks.transcribeScribeSegment).not.toHaveBeenCalled();
  });

  it("applies the same gates as drafting", async () => {
    vi.stubEnv(SCRIBE_ENABLED_ENV, "false");
    await expect(
      caller(createDb([OPTED_IN]).db).transcribeSegment({ audio: AUDIO, recordingKey: RECORDING_KEY }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    vi.stubEnv(SCRIBE_ENABLED_ENV, "true");

    await expect(
      caller(createDb([NOT_OPTED_IN]).db).transcribeSegment({
        audio: AUDIO,
        recordingKey: RECORDING_KEY,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    for (const role of ["technician", "front_desk", "viewer"]) {
      await expect(
        caller(createDb([OPTED_IN]).db, role).transcribeSegment({
          audio: AUDIO,
          recordingKey: RECORDING_KEY,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }

    mocks.rateLimit.mockResolvedValueOnce({ success: false });
    await expect(
      caller(createDb([OPTED_IN]).db).transcribeSegment({ audio: AUDIO, recordingKey: RECORDING_KEY }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    mocks.readHostedAiAccess.mockResolvedValueOnce({
      allowed: false,
      reason: "subscription_inactive",
      message: "Subscription inactive.",
    });
    await expect(
      caller(createDb([OPTED_IN]).db).transcribeSegment({ audio: AUDIO, recordingKey: RECORDING_KEY }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(mocks.transcribeScribeSegment).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("does not meter a part the provider failed to transcribe", async () => {
    mocks.transcribeScribeSegment.mockRejectedValueOnce(new Error("provider down"));
    const { db, insertValues } = createDb([OPTED_IN]);
    await expect(
      caller(db).transcribeSegment({ audio: AUDIO, recordingKey: RECORDING_KEY }),
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Could not transcribe that part of the recording.",
    });
    expect(mocks.recordUsage).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("reports whether recording is possible", async () => {
    await expect(
      caller(createDb([OPTED_IN]).db).availability(),
    ).resolves.toMatchObject({ canRecord: false, configured: false });
  });
});

describe("microphone permission", () => {
  afterEach(() => {
    vi.resetModules();
  });

  async function permissionsPolicy() {
    vi.resetModules();
    const headers = (await import("@/lib/security-headers.js")) as unknown as {
      securityHeaders: Array<{ key: string; value: string }>;
    };
    return headers.securityHeaders.find(
      (header) => header.key === "Permissions-Policy",
    )?.value;
  }

  it("stays off for the whole app unless Scribe is switched on", async () => {
    vi.stubEnv(SCRIBE_ENABLED_ENV, "false");
    expect(await permissionsPolicy()).toBe(
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    );
    vi.stubEnv(SCRIBE_ENABLED_ENV, "true");
    expect(await permissionsPolicy()).toBe(
      "camera=(), microphone=(self), geolocation=(), payment=(), usb=(), interest-cohort=()",
    );
  });
});
