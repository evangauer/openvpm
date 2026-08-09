import { afterEach, describe, expect, it, vi } from "vitest";
import { telnyxProvider } from "../telnyx";
import { TELNYX_API_TIMEOUT_MS } from "../telnyx-http";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("telnyxProvider", () => {
  it("treats a blank API key as unconfigured", async () => {
    vi.stubEnv("TELNYX_API_KEY", "   ");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(telnyxProvider.isConfigured()).toBe(false);
    await expect(
      telnyxProvider.send({
        to: "+15555550199",
        body: "Reminder",
        sender: { messagingServiceId: "mp-1" },
      })
    ).resolves.toEqual({
      status: "definite_failure",
      error: "Telnyx is not configured (TELNYX_API_KEY missing).",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts sends with a timeout signal", async () => {
    vi.stubEnv("TELNYX_API_KEY", " KEY123 ");
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { id: "msg-1" } }), {
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      telnyxProvider.send({
        to: "+15555550199",
        body: "Reminder",
        sender: { messagingServiceId: " mp-1 " },
      })
    ).resolves.toEqual({ status: "accepted", id: "msg-1" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telnyx.com/v2/messages",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer KEY123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: "+15555550199",
          text: "Reminder",
          messaging_profile_id: "mp-1",
        }),
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("aborts hung sends and reports the provider error", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          })
      )
    );

    const result = telnyxProvider.send({
      to: "+15555550199",
      body: "Reminder",
      sender: { from: "+15555550100" },
    });
    await vi.advanceTimersByTimeAsync(TELNYX_API_TIMEOUT_MS);

    await expect(result).resolves.toEqual({
      status: "outcome_unknown",
      error: "aborted",
    });
  });

  it.each([408, 429, 500, 503])(
    "treats HTTP %s as outcome unknown",
    async (status) => {
      vi.stubEnv("TELNYX_API_KEY", "KEY123");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("transient", { status })),
      );

      await expect(
        telnyxProvider.send({
          to: "+15555550199",
          body: "Reminder",
          sender: { from: "+15555550100" },
        }),
      ).resolves.toMatchObject({ status: "outcome_unknown" });
    },
  );

  it("treats a non-transient 4xx rejection as definite failure", async () => {
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid destination", { status: 400 })),
    );

    await expect(
      telnyxProvider.send({
        to: "+15555550199",
        body: "Reminder",
        sender: { from: "+15555550100" },
      }),
    ).resolves.toMatchObject({ status: "definite_failure" });
  });

  it("treats 2xx without a provider id as outcome unknown", async () => {
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: {} }), {
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    await expect(
      telnyxProvider.send({
        to: "+15555550199",
        body: "Reminder",
        sender: { from: "+15555550100" },
      }),
    ).resolves.toMatchObject({ status: "outcome_unknown" });
  });
});
