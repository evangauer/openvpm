import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROUTE_SOURCE = readFileSync(
  fileURLToPath(new URL("./route.ts", import.meta.url)),
  "utf8"
);

const mocks = vi.hoisted(() => {
  const practiceId = "00000000-0000-0000-0000-000000000001";
  const userId = "00000000-0000-0000-0000-000000000002";
  const selectResults: unknown[][] = [];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [
      { id: "file_123", mimeType: "image/png" },
    ];
    const builder = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(async () => result),
    };
    return builder;
  });
  const tx = { select };

  return {
    practiceId,
    userId,
    selectResults,
    getServerSession: vi.fn(async () => ({
      user: { id: userId, practiceId },
    })),
    getObject: vi.fn(),
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx)
    ),
  };
});

vi.mock("next-auth", () => ({
  getServerSession: mocks.getServerSession,
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@openpims/db/client", () => ({
  db: {},
}));

vi.mock("@/lib/s3", () => ({
  getObject: mocks.getObject,
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
}));

const { GET } = await import("./route");
const { UPLOAD_FILE_MAX_BYTES } = await import("@/lib/upload-limits");

function fileRequest(path: string) {
  return new Request(`https://openvpm.test/api/files/${path}`) as never;
}

function routeContext(path: string[]) {
  return { params: Promise.resolve({ path }) };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.selectResults.length = 0;
  mocks.getServerSession.mockResolvedValue({
    user: { id: mocks.userId, practiceId: mocks.practiceId },
  });
});

describe("file proxy response headers", () => {
  it("serves public branding images inline without requiring a session", async () => {
    mocks.getObject.mockResolvedValue({
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      contentType: "image/png",
    });

    const response = await GET(
      fileRequest(`${mocks.practiceId}/branding/logo.png`),
      routeContext([mocks.practiceId, "branding", "logo.png"])
    );

    expect(mocks.getServerSession).not.toHaveBeenCalled();
    expect(mocks.withSystem).toHaveBeenCalledTimes(1);
    expect(mocks.getObject).toHaveBeenCalledWith(
      `${mocks.practiceId}/branding/logo.png`,
      { maxBytes: UPLOAD_FILE_MAX_BYTES }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Disposition")).toBe(
      'inline; filename="logo.png"'
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");
  });

  it("does not serve non-image objects from the public branding category", async () => {
    mocks.getObject.mockResolvedValue({
      body: new TextEncoder().encode("%PDF-1.7\n"),
      contentType: "application/pdf",
    });

    const response = await GET(
      fileRequest(`${mocks.practiceId}/branding/logo.pdf`),
      routeContext([mocks.practiceId, "branding", "logo.pdf"])
    );

    expect(mocks.getServerSession).not.toHaveBeenCalled();
    expect(mocks.withSystem).toHaveBeenCalledTimes(1);
    expect(mocks.getObject).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("does not fetch public branding objects without active file metadata", async () => {
    mocks.selectResults.push([]);

    const response = await GET(
      fileRequest(`${mocks.practiceId}/branding/logo.png`),
      routeContext([mocks.practiceId, "branding", "logo.png"])
    );

    expect(mocks.getServerSession).not.toHaveBeenCalled();
    expect(mocks.withSystem).toHaveBeenCalledTimes(1);
    expect(mocks.getObject).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("does not fetch public branding objects with non-image file metadata", async () => {
    mocks.selectResults.push([{ id: "file_123", mimeType: "application/pdf" }]);

    const response = await GET(
      fileRequest(`${mocks.practiceId}/branding/logo.png`),
      routeContext([mocks.practiceId, "branding", "logo.png"])
    );

    expect(mocks.getServerSession).not.toHaveBeenCalled();
    expect(mocks.withSystem).toHaveBeenCalledTimes(1);
    expect(mocks.getObject).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("rejects malformed encoded paths before auth or storage lookup", async () => {
    const response = await GET(
      fileRequest(`${mocks.practiceId}/branding/%`),
      routeContext([mocks.practiceId, "branding", "%"])
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(mocks.getServerSession).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.getObject).not.toHaveBeenCalled();
  });

  it("rejects encoded path separators before auth or storage lookup", async () => {
    const response = await GET(
      fileRequest(`${mocks.practiceId}/branding/logo%2Fsecret.png`),
      routeContext([mocks.practiceId, "branding", "logo%2Fsecret.png"])
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(mocks.getServerSession).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.getObject).not.toHaveBeenCalled();
  });

  it("rejects unsupported categories before auth or storage lookup", async () => {
    const response = await GET(
      fileRequest(`${mocks.practiceId}/exports/backup.json`),
      routeContext([mocks.practiceId, "exports", "backup.json"])
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(mocks.getServerSession).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.getObject).not.toHaveBeenCalled();
  });

  it("rejects deeper object paths before auth or storage lookup", async () => {
    const response = await GET(
      fileRequest(`${mocks.practiceId}/documents/nested/lab.pdf`),
      routeContext([mocks.practiceId, "documents", "nested", "lab.pdf"])
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(mocks.getServerSession).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.getObject).not.toHaveBeenCalled();
  });

  it("rejects private objects without session lookup when NEXTAUTH_SECRET is blank", async () => {
    vi.stubEnv("NEXTAUTH_SECRET", "   ");

    const response = await GET(
      fileRequest(`${mocks.practiceId}/documents/lab.pdf`),
      routeContext([mocks.practiceId, "documents", "lab.pdf"])
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    expect(mocks.getServerSession).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.getObject).not.toHaveBeenCalled();
  });

  it("serves private document files as attachments with nosniff", async () => {
    mocks.getObject.mockResolvedValue({
      body: new TextEncoder().encode("%PDF-1.7\n"),
      contentType: "application/pdf",
    });

    const response = await GET(
      fileRequest(`${mocks.practiceId}/documents/lab.pdf`),
      routeContext([mocks.practiceId, "documents", "lab.pdf"])
    );

    expect(mocks.getServerSession).toHaveBeenCalledTimes(1);
    expect(mocks.withSystem).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="lab.pdf"'
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=3600");
  });

  it("treats oversized storage objects as missing", async () => {
    mocks.getObject.mockResolvedValue(null);

    const response = await GET(
      fileRequest(`${mocks.practiceId}/documents/lab.pdf`),
      routeContext([mocks.practiceId, "documents", "lab.pdf"])
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(mocks.getObject).toHaveBeenCalledWith(
      `${mocks.practiceId}/documents/lab.pdf`,
      { maxBytes: UPLOAD_FILE_MAX_BYTES }
    );
  });

  it("does not fetch private objects without active file metadata", async () => {
    mocks.selectResults.push([{ id: mocks.userId }], []);

    const response = await GET(
      fileRequest(`${mocks.practiceId}/documents/lab.pdf`),
      routeContext([mocks.practiceId, "documents", "lab.pdf"])
    );

    expect(mocks.getServerSession).toHaveBeenCalledTimes(1);
    expect(mocks.withSystem).toHaveBeenCalledTimes(2);
    expect(mocks.getObject).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("does not fetch private objects for stale sessions", async () => {
    mocks.selectResults.push([]);

    const response = await GET(
      fileRequest(`${mocks.practiceId}/documents/lab.pdf`),
      routeContext([mocks.practiceId, "documents", "lab.pdf"])
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    expect(mocks.withSystem).toHaveBeenCalledTimes(1);
    expect(mocks.getObject).not.toHaveBeenCalled();
  });

  it("does not fetch private objects for another practice", async () => {
    mocks.getServerSession.mockResolvedValue({
      user: {
        id: mocks.userId,
        practiceId: "00000000-0000-0000-0000-000000000099",
      },
    });

    const response = await GET(
      fileRequest(`${mocks.practiceId}/documents/lab.pdf`),
      routeContext([mocks.practiceId, "documents", "lab.pdf"])
    );

    expect(response.status).toBe(403);
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.getObject).not.toHaveBeenCalled();
  });

  it("revalidates private file sessions against active user and practice rows", () => {
    expect(ROUTE_SOURCE).toContain("innerJoin(");
    expect(ROUTE_SOURCE).toContain("getActiveFileMetadata");
    expect(ROUTE_SOURCE).toContain("eq(files.fileKey, key)");
    expect(ROUTE_SOURCE).toContain("eq(files.practiceId, practiceId)");
    expect(ROUTE_SOURCE).toContain("eq(files.category, category)");
    expect(ROUTE_SOURCE).toContain("isNull(files.deletedAt)");
    expect(ROUTE_SOURCE).toContain("isNull(practices.deletedAt)");
    expect(ROUTE_SOURCE).toContain("eq(users.id, session.user.id)");
    expect(ROUTE_SOURCE).toContain("eq(users.practiceId, practiceId)");
    expect(ROUTE_SOURCE).toContain("isNull(users.deletedAt)");
  });
});
