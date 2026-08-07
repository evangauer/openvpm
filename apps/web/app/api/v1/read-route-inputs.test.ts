import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateApiKey: vi.fn(async () => ({
    ok: true,
    ctx: {
      practiceId: "00000000-0000-0000-0000-000000000001",
      apiKeyId: "key_123",
      scopes: ["clients:read", "patients:read"],
    },
  })),
  db: {
    select: vi.fn(),
  },
  withTenant: vi.fn(
    async (
      _db: unknown,
      _practiceId: string,
      fn: (tx: unknown) => Promise<unknown>
    ) => fn(mocks.db)
  ),
}));

vi.mock("@/lib/api-auth", () => ({
  authenticateApiKey: mocks.authenticateApiKey,
}));

vi.mock("@openpims/db/client", () => ({
  db: mocks.db,
}));

vi.mock("@/lib/tenant-db", () => ({
  withTenant: mocks.withTenant,
}));

const { GET: getClient } = await import("./clients/[id]/route");
const { GET: listClients } = await import("./clients/route");
const { GET: getPatient } = await import("./patients/[id]/route");
const { GET: listPatients } = await import("./patients/route");
const { GET: getAppointment } = await import("./appointments/[id]/route");
const { MAX_OFFSET } = await import("@/lib/compat/shared/pagination");

const PRACTICE_ID = "00000000-0000-0000-0000-000000000001";
const VALID_ID = "00000000-0000-0000-0000-000000000002";
const ACTIVE_PRACTICE = [{ id: PRACTICE_ID }];

function request(path: string) {
  return new Request(`https://openvpm.test${path}`, {
    headers: { authorization: "Bearer ovpm_valid0000000000000000000000000" },
  });
}

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function mockActivePracticeQuery(result: unknown[] = ACTIVE_PRACTICE) {
  const builder = {
    from: vi.fn(() => builder),
    where: vi.fn(() => builder),
    limit: vi.fn(async () => result),
  };
  mocks.db.select.mockReturnValueOnce(builder);
  return builder;
}

function mockListQuery() {
  mockActivePracticeQuery();
  const offset = vi.fn(async () => []);
  const listBuilder = {
    from: vi.fn(() => listBuilder),
    where: vi.fn(() => listBuilder),
    orderBy: vi.fn(() => listBuilder),
    limit: vi.fn(() => ({ offset })),
  };
  const countBuilder = {
    from: vi.fn(() => countBuilder),
    where: vi.fn(async () => [{ count: 0 }]),
  };
  mocks.db.select
    .mockReturnValueOnce(listBuilder)
    .mockReturnValueOnce(countBuilder);
  return { offset };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("REST read route input validation", () => {
  it("uses a shared active-practice preflight for v1 read routes", () => {
    const source = readFileSync("lib/compat/shared/active-practice.ts", "utf8");

    expect(source).toContain("function activePracticeWhere");
    expect(source).toContain("eq(practices.id, practiceId)");
    expect(source).toContain("isNull(practices.deletedAt)");
    expect(source).toContain('apiError("Practice not found", 404)');
  });

  it("rejects malformed client path ids before tenant DB work", async () => {
    const response = await getClient(
      request("/api/v1/clients/not-a-uuid"),
      routeContext("not-a-uuid")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Client id must be a valid UUID" },
    });
    expect(mocks.authenticateApiKey).toHaveBeenCalledWith(
      expect.any(Request),
      "clients:read"
    );
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.db.select).not.toHaveBeenCalled();
  });

  it("rejects malformed patient path ids before tenant DB work", async () => {
    const response = await getPatient(
      request("/api/v1/patients/not-a-uuid"),
      routeContext("not-a-uuid")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Patient id must be a valid UUID" },
    });
    expect(mocks.authenticateApiKey).toHaveBeenCalledWith(
      expect.any(Request),
      "patients:read"
    );
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.db.select).not.toHaveBeenCalled();
  });

  it("rejects malformed appointment path ids before tenant DB work", async () => {
    const response = await getAppointment(
      request("/api/v1/appointments/not-a-uuid"),
      routeContext("not-a-uuid")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Appointment id must be a valid UUID" },
    });
    expect(mocks.authenticateApiKey).toHaveBeenCalledWith(
      expect.any(Request),
      "appointments:read"
    );
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.db.select).not.toHaveBeenCalled();
  });

  it("rejects malformed patient client_id filters before tenant DB work", async () => {
    const response = await listPatients(
      request("/api/v1/patients?client_id=not-a-uuid")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { message: "client_id must be a valid UUID" },
    });
    expect(mocks.authenticateApiKey).toHaveBeenCalledWith(
      expect.any(Request),
      "patients:read"
    );
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.db.select).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "client list",
      call: () => listClients(request("/api/v1/clients")),
    },
    {
      label: "client detail",
      call: () =>
        getClient(
          request(`/api/v1/clients/${VALID_ID}`),
          routeContext(VALID_ID)
        ),
    },
    {
      label: "patient list",
      call: () => listPatients(request("/api/v1/patients")),
    },
    {
      label: "patient detail",
      call: () =>
        getPatient(
          request(`/api/v1/patients/${VALID_ID}`),
          routeContext(VALID_ID)
        ),
    },
    {
      label: "appointment detail",
      call: () =>
        getAppointment(
          request(`/api/v1/appointments/${VALID_ID}`),
          routeContext(VALID_ID)
        ),
    },
  ])("rejects $label when the authenticated practice is inactive", async ({ call }) => {
    mockActivePracticeQuery([]);

    const response = await call();

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Practice not found" },
    });
    expect(mocks.db.select).toHaveBeenCalledTimes(1);
  });

  it("caps oversized client list offsets before querying", async () => {
    const { offset } = mockListQuery();

    const response = await listClients(
      request(`/api/v1/clients?limit=1000&offset=${MAX_OFFSET + 1}`)
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(offset).toHaveBeenCalledWith(MAX_OFFSET);
    expect(json.pagination).toEqual({
      limit: 100,
      offset: MAX_OFFSET,
      total: 0,
    });
  });

  it("caps oversized patient list offsets before querying", async () => {
    const { offset } = mockListQuery();

    const response = await listPatients(
      request(`/api/v1/patients?limit=1000&offset=${MAX_OFFSET + 1}`)
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(offset).toHaveBeenCalledWith(MAX_OFFSET);
    expect(json.pagination).toEqual({
      limit: 100,
      offset: MAX_OFFSET,
      total: 0,
    });
  });
});
