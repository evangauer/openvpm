import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validCredentialsRequireMfa: vi.fn(async () => false),
}));

vi.mock("@/lib/auth", () => ({
  validCredentialsRequireMfa: mocks.validCredentialsRequireMfa,
}));

const { POST } = await import("./route");

function request(
  body: string,
  origin = "https://preview.example.test",
  extraHeaders: HeadersInit = {},
) {
  return new Request("https://preview.example.test/api/auth/mfa-required", {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      ...extraHeaders,
    },
    body,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("MFA challenge probe", () => {
  it("rejects cross-origin and oversized requests without credential work", async () => {
    const crossOrigin = await POST(
      request(
        '{"email":"admin@example.com","password":"secret"}',
        "https://attacker.example",
      ),
    );
    expect(crossOrigin.status).toBe(403);

    const oversized = await POST(
      request("{}", "https://preview.example.test", {
        "content-length": "2049",
      }),
    );
    expect(oversized.status).toBe(400);
    expect(mocks.validCredentialsRequireMfa).not.toHaveBeenCalled();
  });

  it("returns only the bounded challenge decision", async () => {
    mocks.validCredentialsRequireMfa.mockResolvedValueOnce(true);
    const response = await POST(
      request('{"email":" Admin@Example.com ","password":"secret"}'),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ mfaRequired: true });
    expect(mocks.validCredentialsRequireMfa).toHaveBeenCalledWith({
      email: "Admin@Example.com",
      password: "secret",
      ip: "unknown",
    });
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
  });
});
