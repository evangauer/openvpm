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
  const insertValues = vi.fn(async () => undefined);
  const insert = vi.fn(() => ({ values: insertValues }));
  const activeAccount = (overrides: Record<string, unknown> = {}) => ({
    userId,
    tier: "free",
    billingStatus: "trialing",
    trialEndsAt: new Date("2026-07-15T00:00:00Z"),
    ...overrides,
  });
  const selectResults: unknown[][] = [];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [activeAccount()];
    const builder = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(async () => result),
    };
    return builder;
  });
  const tx = { insert, select };

  return {
    getServerSession: vi.fn(async () => ({
      user: { id: userId, practiceId },
    })),
    uploadFile: vi.fn(async () => undefined),
    deleteFile: vi.fn(async () => undefined),
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx)
    ),
    withTenant: vi.fn(
      async (
        _db: unknown,
        _practiceId: string,
        fn: (tx: unknown) => unknown
      ) => fn(tx)
    ),
    billingEnforced: vi.fn(() => false),
    hasHostedFullAccess: vi.fn(() => true),
    insertValues,
    activeAccount,
    selectResults,
    practiceId,
    userId,
  };
});

vi.mock("next-auth", () => ({
  getServerSession: mocks.getServerSession,
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/s3", () => ({
  deleteFile: mocks.deleteFile,
  uploadFile: mocks.uploadFile,
}));

vi.mock("@openpims/db/client", () => ({
  db: {},
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
  withTenant: mocks.withTenant,
}));

vi.mock("@/lib/billing/plans", () => ({
  billingEnforced: mocks.billingEnforced,
  hasHostedFullAccess: mocks.hasHostedFullAccess,
}));

const { POST } = await import("./route");
const { UPLOAD_REQUEST_MAX_BYTES } = await import("@/lib/upload-limits");

function uploadRequest(file: File, category = "branding") {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("category", category);

  return new Request("https://openvpm.test/api/upload", {
    method: "POST",
    body: formData,
  }) as never;
}

function oversizedUploadRequest() {
  const formData = new FormData();
  formData.append(
    "file",
    new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "lab.pdf", {
      type: "application/pdf",
    })
  );
  formData.append("category", "documents");

  return new Request("https://openvpm.test/api/upload", {
    method: "POST",
    headers: {
      "content-length": String(UPLOAD_REQUEST_MAX_BYTES + 1),
    },
    body: formData,
  }) as never;
}

function streamedOversizedUploadRequest() {
  return new Request("https://openvpm.test/api/upload", {
    method: "POST",
    headers: {
      "content-type": "multipart/form-data; boundary=openvpm",
    },
    body: "x".repeat(UPLOAD_REQUEST_MAX_BYTES + 1),
  }) as never;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.selectResults.length = 0;
  mocks.billingEnforced.mockReturnValue(false);
  mocks.hasHostedFullAccess.mockReturnValue(true);
  mocks.getServerSession.mockResolvedValue({
    user: { id: mocks.userId, practiceId: mocks.practiceId },
  });
});

describe("upload route file validation", () => {
  it("rejects oversized requests before billing, multipart parsing, or upload", async () => {
    mocks.billingEnforced.mockReturnValue(true);

    const response = await POST(oversizedUploadRequest());

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Upload exceeds maximum request size",
    });
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("rejects streamed oversized requests without a content-length header before multipart parsing", async () => {
    const response = await POST(streamedOversizedUploadRequest());

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Upload exceeds maximum request size",
    });
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("rejects uploads without session lookup when NEXTAUTH_SECRET is blank", async () => {
    vi.stubEnv("NEXTAUTH_SECRET", "   ");
    const file = new File([new TextEncoder().encode("%PDF-1.7\n")], "lab.pdf", {
      type: "application/pdf",
    });

    const response = await POST(uploadRequest(file, "documents"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(mocks.getServerSession).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it("rejects stale sessions before billing or upload work", async () => {
    mocks.selectResults.push([]);
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const file = new File([pngBytes], "logo.png", { type: "image/png" });

    const response = await POST(uploadRequest(file));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(mocks.billingEnforced).not.toHaveBeenCalled();
    expect(mocks.hasHostedFullAccess).not.toHaveBeenCalled();
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("blocks hosted read-only uploads using the active practice row", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    mocks.hasHostedFullAccess.mockReturnValue(false);
    mocks.selectResults.push([
      mocks.activeAccount({
        tier: "basic",
        billingStatus: "past_due",
        trialEndsAt: null,
      }),
    ]);
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const file = new File([pngBytes], "logo.png", { type: "image/png" });

    const response = await POST(uploadRequest(file));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error:
        "OpenVPM Cloud is read-only until your trial or subscription is active.",
    });
    expect(mocks.hasHostedFullAccess).toHaveBeenCalledWith(
      "basic",
      "past_due",
      null
    );
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it("rejects overlong filenames before upload", async () => {
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const file = new File([pngBytes], `${"a".repeat(252)}.png`, {
      type: "image/png",
    });

    const response = await POST(uploadRequest(file));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "File name must be between 1 and 255 characters",
    });

    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it("rejects non-image uploads in the public branding category", async () => {
    const file = new File([new TextEncoder().encode("%PDF-1.7\n")], "logo.pdf", {
      type: "application/pdf",
    });

    const response = await POST(uploadRequest(file, "branding"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Branding uploads must be image files",
    });
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it("rejects uploads whose bytes do not match the declared MIME type", async () => {
    const file = new File([new TextEncoder().encode("<html></html>")], "fake.png", {
      type: "image/png",
    });

    const response = await POST(uploadRequest(file));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "File contents do not match the declared file type",
    });
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it("still allows PDFs in private document categories", async () => {
    const file = new File([new TextEncoder().encode("%PDF-1.7\n")], "lab.pdf", {
      type: "application/pdf",
    });

    const response = await POST(uploadRequest(file, "documents"));

    expect(response.status).toBe(201);
    const json = await response.json();
    expect(json.url).toMatch(
      new RegExp(`^/api/files/${mocks.practiceId}/documents/.+-lab\\.pdf$`)
    );
    expect(mocks.uploadFile).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`^${mocks.practiceId}/documents/.+-lab\\.pdf$`)
      ),
      expect.any(Buffer),
      "application/pdf"
    );
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: mocks.practiceId,
        uploadedBy: mocks.userId,
        fileName: "lab.pdf",
        mimeType: "application/pdf",
        category: "documents",
      })
    );
  });

  it("stores files only after the declared type matches the file signature", async () => {
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const file = new File([pngBytes], "logo.png", { type: "image/png" });

    const response = await POST(uploadRequest(file));

    expect(response.status).toBe(201);
    const json = await response.json();
    expect(json.url).toMatch(
      new RegExp(`^/api/files/${mocks.practiceId}/branding/.+-logo\\.png$`)
    );
    expect(mocks.uploadFile).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`^${mocks.practiceId}/branding/.+-logo\\.png$`)
      ),
      expect.any(Buffer),
      "image/png"
    );
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: mocks.practiceId,
        uploadedBy: mocks.userId,
        fileName: "logo.png",
        mimeType: "image/png",
        category: "branding",
      })
    );
  });

  it("cleans up the uploaded object when metadata persistence fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.insertValues.mockRejectedValueOnce(new Error("db unavailable"));
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const file = new File([pngBytes], "logo.png", { type: "image/png" });

    try {
      const response = await POST(uploadRequest(file));

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "Upload failed" });
      expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
      expect(mocks.deleteFile).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`^${mocks.practiceId}/branding/.+-logo\\.png$`)
        )
      );
      expect(consoleError).toHaveBeenCalledWith(
        "Upload failed:",
        expect.any(Error)
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("revalidates uploads against active user and practice rows", () => {
    expect(ROUTE_SOURCE).toContain("innerJoin(");
    expect(ROUTE_SOURCE).toContain("isNull(practices.deletedAt)");
    expect(ROUTE_SOURCE).toContain("eq(users.id, session.user.id)");
    expect(ROUTE_SOURCE).toContain(
      "eq(users.practiceId, session.user.practiceId)"
    );
    expect(ROUTE_SOURCE).toContain("isNull(users.deletedAt)");
  });

  it("uses the capped request byte reader before multipart parsing", () => {
    expect(ROUTE_SOURCE).toContain("readRequestBytesWithLimit(");
    expect(ROUTE_SOURCE).toContain("UPLOAD_REQUEST_MAX_BYTES");
    expect(ROUTE_SOURCE).not.toContain("req.formData()");
  });
});
