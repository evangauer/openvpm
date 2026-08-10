import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const selectBuilders: Array<{
    from: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
  }> = [];
  const insertRow = {
    id: "00000000-0000-0000-0000-0000000000a1",
    practiceId: "00000000-0000-0000-0000-000000000001",
    startTime: new Date("2026-07-01T15:00:00.000Z"),
    endTime: new Date("2026-07-01T15:30:00.000Z"),
    status: "scheduled",
    clientId: "00000000-0000-0000-0000-000000000002",
    patientId: "00000000-0000-0000-0000-000000000003",
    doctorId: "00000000-0000-0000-0000-000000000004",
    typeId: "00000000-0000-0000-0000-000000000005",
    roomId: "00000000-0000-0000-0000-000000000006",
    locationId: "00000000-0000-0000-0000-000000000007",
    notes: "Annual wellness",
    recurringSeriesId: null,
    createdAt: new Date("2026-07-01T14:00:00.000Z"),
    updatedAt: new Date("2026-07-01T14:00:00.000Z"),
    deletedAt: null,
  };
  const insertReturning = vi.fn(async () => [insertRow]);
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const db = {
    select: vi.fn((fields?: Record<string, unknown>) => {
      const fieldNames = Object.keys(fields ?? {})
        .sort()
        .join(",");
      const result =
        fieldNames === "address,id,isPrimary,name,phone"
          ? [
              {
                id: "00000000-0000-0000-0000-000000000007",
                name: "Main Clinic",
                address: "1 Main St",
                phone: null,
                isPrimary: true,
              },
            ]
          : fieldNames === "id,locationId"
            ? [
                {
                  id: "00000000-0000-0000-0000-000000000006",
                  locationId: "00000000-0000-0000-0000-000000000007",
                },
              ]
            : fieldNames === "locationId"
              ? [
                  {
                    locationId: "00000000-0000-0000-0000-000000000007",
                  },
                ]
              : (selectResults.shift() ?? []);
      const afterLimit = {
        offset: vi.fn(async () => result),
        then: (
          resolve: (value: unknown[]) => unknown,
          reject?: (error: unknown) => unknown
        ) => Promise.resolve(result).then(resolve, reject),
      };
      const builder = {
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        orderBy: vi.fn(() => builder),
        limit: vi.fn(() => afterLimit),
        then: (
          resolve: (value: unknown[]) => unknown,
          reject?: (error: unknown) => unknown
        ) => Promise.resolve(result).then(resolve, reject),
      };
      selectBuilders.push(builder);
      return builder;
    }),
    insert: vi.fn(() => ({ values: insertValues })),
    execute: vi.fn(async () => undefined),
  };

  return {
    authenticateApiKey: vi.fn(async () => ({
      ok: true,
      ctx: {
        practiceId: "00000000-0000-0000-0000-000000000001",
        apiKeyId: "key-1",
        scopes: ["appointments:read", "appointments:write"],
      },
    })),
    withTenant: vi.fn(
      async (
        _db: unknown,
        _practiceId: string,
        fn: (tx: unknown) => Promise<unknown>
      ) => fn(db)
    ),
    dispatchWebhookEvent: vi.fn(async () => undefined),
    recordActivationAfterAppointmentCreated: vi.fn(async () => true),
    db,
    insertRow,
    insertReturning,
    insertValues,
    selectBuilders,
    selectResults,
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

vi.mock("@/lib/funnel-events-server", () => ({
  recordActivationAfterAppointmentCreated:
    mocks.recordActivationAfterAppointmentCreated,
}));

const { GET, POST } = await import("./route");
const { appointments, clients, practices } = await import("@openpims/db");
const { APPOINTMENT_NOTES_MAX_LENGTH } = await import("@/lib/compat/openvpm");
const { JSON_REQUEST_BODY_MAX_BYTES } = await import("@/lib/request-json");
const { MAX_OFFSET } = await import("@/lib/compat/shared/pagination");

const PRACTICE_ID = "00000000-0000-0000-0000-000000000001";
const CLIENT_ID = "00000000-0000-0000-0000-000000000002";
const PATIENT_ID = "00000000-0000-0000-0000-000000000003";
const DOCTOR_ID = "00000000-0000-0000-0000-000000000004";
const TYPE_ID = "00000000-0000-0000-0000-000000000005";
const ROOM_ID = "00000000-0000-0000-0000-000000000006";
const LOCATION_ID = "00000000-0000-0000-0000-000000000007";
const OTHER_CLIENT_ID = "00000000-0000-0000-0000-000000000099";
const ACTIVE_PRACTICE = [{ id: PRACTICE_ID }];

function appointmentBody(overrides: Record<string, unknown> = {}) {
  return {
    start_time: "2026-07-01T15:00:00.000Z",
    end_time: "2026-07-01T15:30:00.000Z",
    client_id: CLIENT_ID,
    patient_id: PATIENT_ID,
    doctor_id: DOCTOR_ID,
    type_id: TYPE_ID,
    room_id: ROOM_ID,
    notes: "Annual wellness",
    ...overrides,
  };
}

function request(body: Record<string, unknown>) {
  return new Request("https://openvpm.test/api/v1/appointments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function oversizedRequest() {
  return new Request("https://openvpm.test/api/v1/appointments", {
    method: "POST",
    headers: {
      "content-length": String(JSON_REQUEST_BODY_MAX_BYTES + 1),
      "content-type": "application/json",
    },
    body: "{}",
  });
}

function getRequest(path = "/api/v1/appointments") {
  return new Request(`https://openvpm.test${path}`, {
    headers: { authorization: "Bearer ovpm_valid0000000000000000000000000" },
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

function sqlDateValues(value: unknown, seen = new WeakSet<object>()): string[] {
  if (value instanceof Date) {
    return [value.toISOString()];
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  if (seen.has(value)) {
    return [];
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((item) => sqlDateValues(item, seen));
  }
  const candidate = value as { queryChunks?: unknown[] };
  if (Array.isArray(candidate.queryChunks)) {
    return candidate.queryChunks.flatMap((item) => sqlDateValues(item, seen));
  }
  return Object.values(value as Record<string, unknown>).flatMap((item) =>
    sqlDateValues(item, seen)
  );
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.selectResults.length = 0;
  mocks.selectBuilders.length = 0;
});

describe("/api/v1/appointments", () => {
  it("lists appointments through the appointments:read scope", async () => {
    mocks.selectResults.push(ACTIVE_PRACTICE, [mocks.insertRow], [{ count: 1 }]);

    const response = await GET(
      getRequest(
        `/api/v1/appointments?client_id=${CLIENT_ID}&patient_id=${PATIENT_ID}&from=2026-07-01T00:00:00.000Z&to=2026-07-02T00:00:00.000Z&limit=1000&offset=${
          MAX_OFFSET + 1
        }&status=scheduled`
      )
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.authenticateApiKey).toHaveBeenCalledWith(
      expect.any(Request),
      "appointments:read"
    );
    expect(json).toMatchObject({
      data: [
        {
          id: mocks.insertRow.id,
          status: "scheduled",
          client_id: CLIENT_ID,
          patient_id: PATIENT_ID,
          doctor_id: DOCTOR_ID,
          type_id: TYPE_ID,
          room_id: ROOM_ID,
        },
      ],
      pagination: {
        limit: 100,
        offset: MAX_OFFSET,
        total: 1,
      },
    });
    const listCondition = mocks.selectBuilders[1]?.where.mock.calls[0]?.[0];
    expect(sqlIncludesColumn(listCondition, appointments.status)).toBe(true);
  });

  it("accepts strict date-only appointment list filters", async () => {
    mocks.selectResults.push(ACTIVE_PRACTICE, [mocks.insertRow], [{ count: 1 }]);

    const response = await GET(
      getRequest("/api/v1/appointments?from=2026-07-01&to=2026-07-02")
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toHaveLength(1);
    const listCondition = mocks.selectBuilders[1]?.where.mock.calls[0]?.[0];
    expect(sqlIncludesColumn(listCondition, appointments.startTime)).toBe(true);
    expect(sqlDateValues(listCondition)).toEqual(
      expect.arrayContaining([
        "2026-07-01T00:00:00.000Z",
        "2026-07-02T23:59:59.999Z",
      ])
    );
  });

  it("rejects appointment lists when the authenticated practice is inactive", async () => {
    mocks.selectResults.push([]);

    const response = await GET(getRequest("/api/v1/appointments"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Practice not found" },
    });
    expect(mocks.db.select).toHaveBeenCalledTimes(1);

    const activeCondition = mocks.selectBuilders[0]?.where.mock.calls[0]?.[0];
    expect(sqlIncludesColumn(activeCondition, practices.id)).toBe(true);
    expect(sqlIncludesColumn(activeCondition, practices.deletedAt)).toBe(true);
  });

  it("rejects malformed appointment list filters before tenant work", async () => {
    const badClient = await GET(
      getRequest("/api/v1/appointments?client_id=not-a-uuid")
    );
    expect(badClient.status).toBe(400);
    await expect(badClient.json()).resolves.toEqual({
      error: { message: "client_id must be a valid UUID" },
    });

    const badPatient = await GET(
      getRequest("/api/v1/appointments?patient_id=not-a-uuid")
    );
    expect(badPatient.status).toBe(400);
    await expect(badPatient.json()).resolves.toEqual({
      error: { message: "patient_id must be a valid UUID" },
    });

    const badDate = await GET(getRequest("/api/v1/appointments?from=nope"));
    expect(badDate.status).toBe(400);
    await expect(badDate.json()).resolves.toEqual({
      error: {
        message: "from must be a valid ISO date or timezone-qualified timestamp",
      },
    });

    const impossibleDate = await GET(
      getRequest("/api/v1/appointments?from=2026-02-31")
    );
    expect(impossibleDate.status).toBe(400);
    await expect(impossibleDate.json()).resolves.toEqual({
      error: {
        message: "from must be a valid ISO date or timezone-qualified timestamp",
      },
    });

    const localTimestamp = await GET(
      getRequest("/api/v1/appointments?to=2026-07-01T12:00:00")
    );
    expect(localTimestamp.status).toBe(400);
    await expect(localTimestamp.json()).resolves.toEqual({
      error: {
        message: "to must be a valid ISO date or timezone-qualified timestamp",
      },
    });

    const badRange = await GET(
      getRequest(
        "/api/v1/appointments?from=2026-07-02T00:00:00.000Z&to=2026-07-01T00:00:00.000Z"
      )
    );
    expect(badRange.status).toBe(400);
    await expect(badRange.json()).resolves.toEqual({
      error: { message: "from must be before or equal to to" },
    });

    const badStatus = await GET(
      getRequest("/api/v1/appointments?status=boarding")
    );
    expect(badStatus.status).toBe(400);
    await expect(badStatus.json()).resolves.toEqual({
      error: {
        message:
          "status must be one of: scheduled, confirmed, checked_in, in_exam, checked_out, no_show, cancelled",
      },
    });

    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.db.select).not.toHaveBeenCalled();
  });

  it("rejects oversized JSON bodies before tenant work", async () => {
    const response = await POST(oversizedRequest());

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Request body too large" },
    });
    expect(mocks.authenticateApiKey).toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.db.insert).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects oversized notes before tenant work", async () => {
    const response = await POST(
      request(
        appointmentBody({
          notes: "x".repeat(APPOINTMENT_NOTES_MAX_LENGTH + 1),
        })
      )
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.message).toBe("Validation failed");
    expect(json.error.fields.notes).toEqual([expect.any(String)]);
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.db.insert).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects appointment creation timestamps without timezone offsets before tenant work", async () => {
    const response = await POST(
      request(
        appointmentBody({
          start_time: "2026-07-01T15:00:00",
          end_time: "2026-07-01T15:30:00",
        })
      )
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.message).toBe("Validation failed");
    expect(json.error.fields).toMatchObject({
      start_time: ["must be a timezone-qualified ISO timestamp"],
      end_time: ["must be a timezone-qualified ISO timestamp"],
    });
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.db.insert).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects unowned or deleted clients before inserting", async () => {
    mocks.selectResults.push(ACTIVE_PRACTICE, []);

    const response = await POST(
      request(
        appointmentBody({
          patient_id: undefined,
          doctor_id: undefined,
          type_id: undefined,
          room_id: undefined,
        })
      )
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Client not found" },
    });
    expect(mocks.db.insert).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();

    const clientCondition = mocks.selectBuilders[1]?.where.mock.calls[0]?.[0];
    expect(sqlIncludesColumn(clientCondition, clients.practiceId)).toBe(true);
    expect(sqlIncludesColumn(clientCondition, clients.deletedAt)).toBe(true);
  });

  it("rejects appointment creation when the authenticated practice is inactive", async () => {
    mocks.selectResults.push([]);

    const response = await POST(request(appointmentBody()));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Practice not found" },
    });
    expect(mocks.db.insert).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects patient and client mismatches before inserting", async () => {
    mocks.selectResults.push(ACTIVE_PRACTICE, [
      { id: PATIENT_ID, clientId: OTHER_CLIENT_ID },
    ]);

    const response = await POST(request(appointmentBody()));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Patient not found" },
    });
    expect(mocks.db.select).toHaveBeenCalledTimes(2);
    expect(mocks.db.insert).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects overlapping doctor or room bookings before inserting", async () => {
    mocks.selectResults.push(
      ACTIVE_PRACTICE,
      [{ id: PATIENT_ID, clientId: CLIENT_ID }],
      [{ id: CLIENT_ID }],
      [{ id: TYPE_ID }],
      [{ id: DOCTOR_ID }],
      [{ id: ROOM_ID }],
      [
        {
          id: "00000000-0000-0000-0000-0000000000b1",
          startTime: new Date("2026-07-01T14:45:00.000Z"),
          endTime: new Date("2026-07-01T15:15:00.000Z"),
          doctorId: DOCTOR_ID,
          roomId: null,
          status: "scheduled",
        },
      ]
    );

    const response = await POST(request(appointmentBody()));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "This time conflicts with another appointment for this doctor.",
      },
    });
    expect(mocks.db.insert).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("infers the appointment client from a validated patient", async () => {
    mocks.selectResults.push(
      ACTIVE_PRACTICE,
      [{ id: PATIENT_ID, clientId: CLIENT_ID }],
      [{ id: CLIENT_ID }]
    );

    const response = await POST(
      request(
        appointmentBody({
          client_id: undefined,
          doctor_id: undefined,
          type_id: undefined,
          room_id: undefined,
        })
      )
    );
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(json.data).toMatchObject({
      client_id: CLIENT_ID,
      patient_id: PATIENT_ID,
    });
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
      })
    );
  });

  it("creates a scoped appointment and dispatches a webhook after validation", async () => {
    mocks.selectResults.push(
      ACTIVE_PRACTICE,
      [{ id: PATIENT_ID, clientId: CLIENT_ID }],
      [{ id: CLIENT_ID }],
      [{ id: TYPE_ID }],
      [{ id: DOCTOR_ID }],
      [{ id: ROOM_ID }],
      []
    );

    const response = await POST(request(appointmentBody()));
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(json.data).toMatchObject({
      id: mocks.insertRow.id,
      client_id: CLIENT_ID,
      patient_id: PATIENT_ID,
      doctor_id: DOCTOR_ID,
      type_id: TYPE_ID,
      room_id: ROOM_ID,
      location_id: LOCATION_ID,
      notes: "Annual wellness",
    });
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        doctorId: DOCTOR_ID,
        typeId: TYPE_ID,
        roomId: ROOM_ID,
        locationId: LOCATION_ID,
      })
    );
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "appointment.created",
      expect.objectContaining({
        id: mocks.insertRow.id,
        startTime: mocks.insertRow.startTime,
        endTime: mocks.insertRow.endTime,
        status: "scheduled",
        patientId: PATIENT_ID,
        clientId: CLIENT_ID,
        doctorId: DOCTOR_ID,
        typeId: TYPE_ID,
        roomId: ROOM_ID,
        locationId: LOCATION_ID,
        source: "api",
      })
    );
    expect(mocks.recordActivationAfterAppointmentCreated).toHaveBeenCalledWith(
      mocks.db,
      PRACTICE_ID,
      "api.v1.appointments.POST"
    );
    const webhookCall = mocks.dispatchWebhookEvent.mock.calls[0] as
      | unknown[]
      | undefined;
    const webhookPayload = webhookCall?.[2];
    expect(webhookPayload).not.toHaveProperty("start_time");
    expect(webhookPayload).not.toHaveProperty("client_id");
  });
});
