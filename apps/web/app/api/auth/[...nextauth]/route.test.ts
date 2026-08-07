import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const nextAuthHandler = vi.fn(async () => new Response("ok"));

  return {
    nextAuth: vi.fn(() => nextAuthHandler),
    nextAuthHandler,
  };
});

vi.mock("next-auth", () => ({
  default: mocks.nextAuth,
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

const { GET, POST } = await import("./route");

const context = { params: Promise.resolve({ nextauth: ["session"] }) };

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("NextAuth route secret configuration", () => {
  it("does not invoke NextAuth when NEXTAUTH_SECRET is blank", async () => {
    vi.stubEnv("NEXTAUTH_SECRET", "   ");

    const response = await GET(
      new Request("https://openvpm.test/api/auth/session") as never,
      context
    );

    await expect(response.json()).resolves.toEqual({
      error: "Authentication secret is not configured",
    });
    expect(response.status).toBe(503);
    expect(mocks.nextAuthHandler).not.toHaveBeenCalled();
  });

  it("passes through to NextAuth when NEXTAUTH_SECRET is configured", async () => {
    vi.stubEnv("NEXTAUTH_SECRET", " auth-secret ");

    const request = new Request(
      "https://openvpm.test/api/auth/session"
    ) as never;
    const response = await POST(request, context);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
    expect(mocks.nextAuthHandler).toHaveBeenCalledWith(request, context);
  });
});
