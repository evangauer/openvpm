import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validCredentialsSecondFactor: vi.fn(
    async (): Promise<{
      factor: string;
      challengeId?: string;
      options?: Record<string, unknown>;
    }> => ({ factor: "none" }),
  ),
}));

vi.mock("@/lib/auth", () => ({
  validCredentialsSecondFactor: mocks.validCredentialsSecondFactor,
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
    expect(mocks.validCredentialsSecondFactor).not.toHaveBeenCalled();
  });

  it("returns only the bounded challenge decision", async () => {
    mocks.validCredentialsSecondFactor.mockResolvedValueOnce({
      factor: "totp",
    });
    const response = await POST(
      request('{"email":" Admin@Example.com ","password":"secret"}'),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mfaRequired: true,
      factor: "totp",
    });
    expect(mocks.validCredentialsSecondFactor).toHaveBeenCalledWith({
      email: "Admin@Example.com",
      password: "secret",
      ip: "unknown",
    });
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("returns a bounded passkey ceremony only after the password probe", async () => {
    mocks.validCredentialsSecondFactor.mockResolvedValueOnce({
      factor: "passkey",
      challengeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      options: { challenge: "challenge", rpId: "preview.example.test" },
    });
    const response = await POST(
      request('{"email":"admin@example.com","password":"secret"}'),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mfaRequired: true,
      factor: "passkey",
      challengeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      options: { challenge: "challenge", rpId: "preview.example.test" },
    });
  });

  it("fails closed when required enrollment or verifier config is missing", async () => {
    mocks.validCredentialsSecondFactor.mockResolvedValueOnce({
      factor: "enrollment_required",
    });
    const enrollment = await POST(
      request('{"email":"admin@example.com","password":"secret"}'),
    );
    expect(enrollment.status).toBe(409);

    mocks.validCredentialsSecondFactor.mockResolvedValueOnce({
      factor: "unavailable",
    });
    const unavailable = await POST(
      request('{"email":"admin@example.com","password":"secret"}'),
    );
    expect(unavailable.status).toBe(503);
  });
});
