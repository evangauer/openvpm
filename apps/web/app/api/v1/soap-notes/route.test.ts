import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const selectBuilders: Array<{
    from: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
    for: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
  }> = [];
  const insertRow = {
    id: "00000000-0000-0000-0000-0000000000a1",
    practiceId: "00000000-0000-0000-0000-000000000001",
    patientId: "00000000-0000-0000-0000-000000000003",
    appointmentId: "00000000-0000-0000-0000-000000000004",
    authorId: "00000000-0000-0000-0000-000000000005",
    subjective: "Eating less than usual.",
    objective: null,
    assessment: "Mild GI upset.",
    plan: "Bland diet and recheck if not improving.",
    createdAt: new Date("2026-07-01T14:00:00.000Z"),
    updatedAt: new Date("2026-07-01T14:00:00.000Z"),
    deletedAt: null,
  };
  const insertReturning = vi.fn(async () => [insertRow]);
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const tenantRollback = vi.fn();
  const db = {
    execute: vi.fn(async () => []),
    select: vi.fn(() => {
      const result = selectResults.shift() ?? [];
      const builder = {
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        for: vi.fn(async () => result),
        limit: vi.fn(() => builder),
        then: (
          resolve: (rows: unknown[]) => unknown,
          reject?: (error: unknown) => unknown,
        ) => Promise.resolve(result).then(resolve, reject),
      };
      selectBuilders.push(builder);
      return builder;
    }),
    insert: vi.fn(() => ({ values: insertValues })),
  };

  return {
    authenticateApiKey: vi.fn(async () => ({
      ok: true,
      ctx: {
        practiceId: "00000000-0000-0000-0000-000000000001",
        apiKeyId: "key-1",
        scopes: ["records:write"],
      },
    })),
    withTenant: vi.fn(
      async (
        _db: unknown,
        _practiceId: string,
        fn: (tx: unknown) => Promise<unknown>,
      ) => {
        try {
          return await fn(db);
        } catch (error) {
          tenantRollback(error);
          throw error;
        }
      },
    ),
    dispatchWebhookEvent: vi.fn(async () => undefined),
    db,
    insertRow,
    insertValues,
    selectBuilders,
    selectResults,
    tenantRollback,
  };
});

vi.mock("@/lib/api-auth", () => ({
  authenticateApiKey: mocks.authenticateApiKey,
}));

vi.mock("@openpims/db/client", () => ({
  db: mocks.db,
}));

vi.mock("@/lib/tenant-db", () => ({
  withTenant: mocks.withTenant,
}));

vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchWebhookEvent: mocks.dispatchWebhookEvent,
}));

const { POST } = await import("./route");
const { appointments, patients, practices, users } =
  await import("@openpims/db");
const { SOAP_SECTION_MAX_LENGTH } = await import("@/lib/records/soap-content");
const { SOAP_NOTE_TEMPLATES } = await import("@/lib/records/soap-templates");
const { JSON_REQUEST_BODY_MAX_BYTES } = await import("@/lib/request-json");

const PRACTICE_ID = "00000000-0000-0000-0000-000000000001";
const PATIENT_ID = "00000000-0000-0000-0000-000000000003";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000004";
const AUTHOR_ID = "00000000-0000-0000-0000-000000000005";
const ACTIVE_PRACTICE = [{ id: PRACTICE_ID }];

function soapBody(overrides: Record<string, unknown> = {}) {
  return {
    patient_id: PATIENT_ID,
    appointment_id: APPOINTMENT_ID,
    subjective: "  Eating less than usual.  ",
    plan: "Bland diet and recheck if not improving.",
    source: "scribenote",
    ...overrides,
  };
}

function request(body: Record<string, unknown>) {
  return new Request("https://openvpm.test/api/v1/soap-notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function oversizedRequest() {
  return new Request("https://openvpm.test/api/v1/soap-notes", {
    method: "POST",
    headers: {
      "content-length": String(JSON_REQUEST_BODY_MAX_BYTES + 1),
      "content-type": "application/json",
    },
    body: "{}",
  });
}

function sqlIncludesColumn(
  value: unknown,
  column: unknown,
  seen = new WeakSet<object>()
): boolean {
  if (Object.is(value, column)) {
    return true;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => sqlIncludesColumn(item, column, seen));
  }
  const candidate = value as { queryChunks?: unknown[] };
  if (Array.isArray(candidate.queryChunks)) {
    return candidate.queryChunks.some((item) =>
      sqlIncludesColumn(item, column, seen)
    );
  }
  return Object.values(value as Record<string, unknown>).some((item) =>
    sqlIncludesColumn(item, column, seen)
  );
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.selectResults.length = 0;
  mocks.selectBuilders.length = 0;
});

describe("POST /api/v1/soap-notes", () => {
  it("requires the records:write API key scope", async () => {
    const response = await POST(oversizedRequest());

    expect(response.status).toBe(413);
    expect(mocks.authenticateApiKey).toHaveBeenCalledWith(
      expect.any(Request),
      "records:write"
    );
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it("rejects empty SOAP content before tenant work", async () => {
    const response = await POST(
      request(
        soapBody({
          subjective: "<p><br></p>",
          plan: "&nbsp;",
          author_id: AUTHOR_ID,
        })
      )
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { message: "SOAP note must include at least one section." },
    });
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.db.insert).not.toHaveBeenCalled();
  });

  it("rejects oversized SOAP sections before tenant work", async () => {
    const response = await POST(
      request(
        soapBody({
          author_id: AUTHOR_ID,
          subjective: "x".repeat(SOAP_SECTION_MAX_LENGTH + 1),
        })
      )
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.message).toBe("Validation failed");
    expect(json.error.fields.subjective).toEqual([expect.any(String)]);
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.db.insert).not.toHaveBeenCalled();
  });

  it("rejects unresolved template prompts before tenant work", async () => {
    const response = await POST(
      request(
        soapBody({
          author_id: AUTHOR_ID,
          subjective: SOAP_NOTE_TEMPLATES[0]!.sections.subjective,
        })
      )
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "Replace or delete every SOAP template prompt before saving.",
      },
    });
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.db.insert).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("requires an appointment before tenant work", async () => {
    const response = await POST(
      request(soapBody({ appointment_id: undefined, author_id: undefined }))
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error.message).toBe("Validation failed");
    expect(json.error.fields.appointment_id).toEqual([expect.any(String)]);
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it("requires an explicit clinician when the appointment has no assigned doctor", async () => {
    mocks.selectResults.push(
      ACTIVE_PRACTICE,
      [{ id: PATIENT_ID }],
      [{ id: APPOINTMENT_ID, doctorId: null, status: "in_exam" }],
      []
    );

    const response = await POST(request(soapBody({ author_id: undefined })));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "author_id is required when the appointment has no assigned doctor.",
      },
    });
    expect(mocks.db.insert).not.toHaveBeenCalled();
  });

  it("rejects unowned or deleted patients before inserting", async () => {
    mocks.selectResults.push(ACTIVE_PRACTICE, []);

    const response = await POST(request(soapBody({ author_id: AUTHOR_ID })));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Patient not found" },
    });
    expect(mocks.db.insert).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();

    const patientCondition = mocks.selectBuilders[1]?.where.mock.calls[0]?.[0];
    expect(sqlIncludesColumn(patientCondition, patients.practiceId)).toBe(true);
    expect(sqlIncludesColumn(patientCondition, patients.deletedAt)).toBe(true);
  });

  it("rejects SOAP note creation when the authenticated practice is inactive", async () => {
    mocks.selectResults.push([]);

    const response = await POST(request(soapBody({ author_id: AUTHOR_ID })));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Practice not found" },
    });
    expect(mocks.db.insert).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();

    const activeCondition = mocks.selectBuilders[0]?.where.mock.calls[0]?.[0];
    expect(sqlIncludesColumn(activeCondition, practices.id)).toBe(true);
    expect(sqlIncludesColumn(activeCondition, practices.deletedAt)).toBe(true);
  });

  it("rejects appointments that do not belong to the patient and practice", async () => {
    mocks.selectResults.push(ACTIVE_PRACTICE, [{ id: PATIENT_ID }], []);

    const response = await POST(request(soapBody()));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Appointment not found" },
    });
    expect(mocks.db.insert).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();

    const appointmentCondition =
      mocks.selectBuilders[2]?.where.mock.calls[0]?.[0];
    expect(sqlIncludesColumn(appointmentCondition, appointments.patientId)).toBe(
      true
    );
    expect(sqlIncludesColumn(appointmentCondition, appointments.practiceId)).toBe(
      true
    );
    expect(sqlIncludesColumn(appointmentCondition, appointments.deletedAt)).toBe(
      true
    );
  });

  it("rejects unowned, deleted, or non-clinician authors before inserting", async () => {
    mocks.selectResults.push(
      ACTIVE_PRACTICE,
      [{ id: PATIENT_ID }],
      [{ id: APPOINTMENT_ID, doctorId: AUTHOR_ID, status: "in_exam" }],
      [],
      []
    );

    const response = await POST(request(soapBody()));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Author not found" },
    });
    expect(mocks.db.insert).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();

    const authorCondition = mocks.selectBuilders[4]?.where.mock.calls[0]?.[0];
    expect(sqlIncludesColumn(authorCondition, users.practiceId)).toBe(true);
    expect(sqlIncludesColumn(authorCondition, users.deletedAt)).toBe(true);
  });

  it("creates a scoped SOAP note and dispatches a webhook", async () => {
    mocks.selectResults.push(
      ACTIVE_PRACTICE,
      [{ id: PATIENT_ID }],
      [{ id: APPOINTMENT_ID, doctorId: AUTHOR_ID, status: "in_exam" }],
      [],
      [{ id: AUTHOR_ID, name: "Dr. Rivera" }],
      [{ id: APPOINTMENT_ID, doctorId: AUTHOR_ID, status: "in_exam" }],
      [],
      [],
      [],
    );

    const response = await POST(request(soapBody()));
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(json.data).toMatchObject({
      id: mocks.insertRow.id,
      patient_id: PATIENT_ID,
      appointment_id: APPOINTMENT_ID,
      author_id: AUTHOR_ID,
      subjective: "Eating less than usual.",
      source: "scribenote",
    });
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        authorId: AUTHOR_ID,
        subjective: "Eating less than usual.",
      })
    );
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "soap_note.created",
      expect.objectContaining({
        id: mocks.insertRow.id,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        authorId: AUTHOR_ID,
        source: "scribenote",
      })
    );
  });

  it("rolls back a deferred SOAP invariant failure before returning 409", async () => {
    mocks.selectResults.push(
      ACTIVE_PRACTICE,
      [{ id: PATIENT_ID }],
      [{ id: APPOINTMENT_ID, doctorId: AUTHOR_ID, status: "in_exam" }],
      [],
      [{ id: AUTHOR_ID, name: "Dr. Rivera" }],
      [{ id: APPOINTMENT_ID, doctorId: AUTHOR_ID, status: "in_exam" }],
      [],
      [],
      [],
    );
    mocks.db.execute.mockRejectedValueOnce({
      code: "23514",
      constraint_name: "soap_notes_appointment_invariant",
    });

    const response = await POST(request(soapBody()));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        message:
          "Clinical documentation changed in another session. Refresh and retry.",
      },
    });
    expect(mocks.tenantRollback).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "23514",
        constraint_name: "soap_notes_appointment_invariant",
      }),
    );
    expect(mocks.db.insert).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });
});
