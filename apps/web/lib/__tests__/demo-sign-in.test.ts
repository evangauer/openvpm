import { describe, expect, it, vi } from "vitest";
import { signInToDemo } from "../demo-sign-in";
import { DEMO_ROLE_OPTIONS } from "../demo-role-switcher";

describe("role-first demo sign-in", () => {
  it.each(DEMO_ROLE_OPTIONS)(
    "authenticates $value only after the email gate",
    async ({ value: role }) => {
      const calls: string[] = [];
      const fetch = vi.fn(async () => {
        calls.push("gate");
        return Response.json({ ok: true });
      });
      const signIn = vi.fn(async () => {
        calls.push("signIn");
        return { ok: true };
      });
      await signInToDemo(
        { email: "  Visitor@Example.test ", role, anonymousId: "anonymous" },
        { fetch, signIn },
      );
      expect(calls).toEqual(["gate", "signIn"]);
      expect(fetch).toHaveBeenCalledWith(
        "/api/demo-access",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            email: "visitor@example.test",
            anonymousId: "anonymous",
          }),
        }),
      );
      expect(signIn).toHaveBeenCalledWith("demo", { role, redirect: false });
    },
  );

  it.each([400, 429, 503])(
    "stops before sign-in when the gate returns %s",
    async (status) => {
      const fetch = vi.fn(async () => Response.json({ ok: false }, { status }));
      const signIn = vi.fn();
      await expect(
        signInToDemo(
          { email: "visitor@example.test", role: "front_desk" },
          { fetch, signIn },
        ),
      ).rejects.toThrow(
        status === 429 ? "Please wait" : "temporarily unavailable",
      );
      expect(signIn).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, { ok: false }, { ok: true, error: "CredentialsSignin" }])(
    "does not navigate after a failed auth result: %j",
    async (result) => {
      const fetch = vi.fn(async () => Response.json({ ok: true }));
      const signIn = vi.fn(async () => result);
      await expect(
        signInToDemo(
          { email: "visitor@example.test", role: "admin" },
          { fetch, signIn },
        ),
      ).rejects.toThrow("temporarily unavailable");
    },
  );

  it("rejects malformed email before sending any request", async () => {
    const fetch = vi.fn();
    await expect(
      signInToDemo(
        { email: "invalid", role: "admin" },
        { fetch, signIn: vi.fn() },
      ),
    ).rejects.toThrow("valid email");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("handles transport and invalid JSON failures without attempting authentication", async () => {
    const signIn = vi.fn();
    for (const fetch of [
      vi.fn().mockRejectedValue(new Error("offline")),
      vi.fn().mockResolvedValue(new Response("bad json")),
    ]) {
      await expect(
        signInToDemo(
          { email: "visitor@example.test", role: "admin" },
          { fetch, signIn },
        ),
      ).rejects.toThrow("temporarily unavailable");
    }
    expect(signIn).not.toHaveBeenCalled();
  });
});
