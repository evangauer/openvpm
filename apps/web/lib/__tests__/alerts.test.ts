import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPS_ALERT_TIMEOUT_MS,
  alertOps,
  formatOpsAlert,
  opsAlertWebhookUrl,
} from "../alerts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("formatOpsAlert", () => {
  it("includes the subject and detail in a Slack-style text payload", () => {
    const p = formatOpsAlert("Backup failed", "practice abc: timeout");
    expect(p.text).toContain("Backup failed");
    expect(p.text).toContain("practice abc: timeout");
    expect(p.text).toContain("OpenVPM");
  });
});

describe("alertOps", () => {
  it("never throws when no webhook is configured", async () => {
    vi.stubEnv("OPS_ALERT_WEBHOOK_URL", "");
    await expect(alertOps("x", "y")).resolves.toBeUndefined();
  });

  it("treats whitespace-only webhook URLs as unconfigured", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("OPS_ALERT_WEBHOOK_URL", "   ");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(opsAlertWebhookUrl()).toBeUndefined();
    await expect(alertOps("Backup failed", "practice abc")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts configured alerts with a timeout signal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("OPS_ALERT_WEBHOOK_URL", " https://ops.example/hook ");
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await alertOps("Backup failed", "practice abc: timeout");

    expect(opsAlertWebhookUrl()).toBe("https://ops.example/hook");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://ops.example/hook",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: expect.stringContaining("Backup failed"),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("aborts hung alert deliveries without throwing", async () => {
    vi.useFakeTimers();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.stubEnv("OPS_ALERT_WEBHOOK_URL", "https://ops.example/hook");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          }),
      ),
    );

    const result = alertOps("Webhook delivery failed", "slow endpoint");
    await vi.advanceTimersByTimeAsync(OPS_ALERT_TIMEOUT_MS);

    await expect(result).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      "[ops-alert] failed to deliver alert:",
      expect.any(Error),
    );
  });
});
