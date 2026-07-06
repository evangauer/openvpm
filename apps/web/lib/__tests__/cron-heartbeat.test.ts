import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  alertOps: vi.fn(async () => undefined),
}));

vi.mock("../alerts", () => ({
  alertOps: mocks.alertOps,
}));

const {
  CRON_HEARTBEAT_JOBS,
  CRON_HEARTBEAT_TIMEOUT_MS,
  CRON_HEARTBEAT_URL_ENV,
  cronHeartbeatConfigured,
  cronHeartbeatEnvName,
  cronHeartbeatUrlFromEnv,
  cronHeartbeatUrlForJob,
  formatCronHeartbeat,
  reportCronHeartbeat,
} = await import("../cron-heartbeat");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("cron heartbeat config", () => {
  it("tracks every scheduled production cron job by default", () => {
    const config = JSON.parse(readFileSync("vercel.json", "utf8")) as {
      crons?: Array<{ path: string; schedule: string }>;
    };
    const scheduledJobs = new Set(
      config.crons
        ?.map((cron) => cron.path.match(/^\/api\/cron\/(.+)$/)?.[1])
        .filter((job): job is string => Boolean(job))
    );

    expect(new Set(CRON_HEARTBEAT_JOBS)).toEqual(scheduledJobs);
  });

  it("derives job-specific env names from cron slugs", () => {
    expect(cronHeartbeatEnvName("usage-reconcile")).toBe(
      "CRON_HEARTBEAT_USAGE_RECONCILE_URL"
    );
    expect(cronHeartbeatEnvName("billing.lifecycle")).toBe(
      "CRON_HEARTBEAT_BILLING_LIFECYCLE_URL"
    );
  });

  it("documents every job-specific heartbeat env for hosted operators", () => {
    const runbook = readFileSync("../../docs/hosted-cloud-production.md", "utf8");
    const envExample = readFileSync("../../.env.example", "utf8");

    for (const job of CRON_HEARTBEAT_JOBS) {
      const envName = cronHeartbeatEnvName(job);
      expect(runbook).toContain(envName);
      expect(envExample).toContain(`${envName}=`);
    }
  });

  it("prefers a job-specific heartbeat URL over the global URL", () => {
    vi.stubEnv(CRON_HEARTBEAT_URL_ENV, "https://heartbeat.example/{job}");
    vi.stubEnv(
      "CRON_HEARTBEAT_BACKUP_URL",
      " https://heartbeat.example/backup-only "
    );

    expect(cronHeartbeatUrlFromEnv("CRON_HEARTBEAT_BACKUP_URL")).toBe(
      "https://heartbeat.example/backup-only"
    );
    expect(cronHeartbeatUrlForJob("backup")).toBe(
      "https://heartbeat.example/backup-only"
    );
    expect(cronHeartbeatUrlForJob("reminders")).toBe(
      "https://heartbeat.example/{job}"
    );
  });

  it("ignores blank job-specific heartbeat URLs and falls back to global", () => {
    vi.stubEnv(CRON_HEARTBEAT_URL_ENV, " https://heartbeat.example/{job} ");
    vi.stubEnv("CRON_HEARTBEAT_BACKUP_URL", "   ");

    expect(cronHeartbeatUrlForJob("backup")).toBe(
      "https://heartbeat.example/{job}"
    );
  });

  it("reports advisory readiness for global or complete job-specific config", () => {
    expect(cronHeartbeatConfigured(["reminders", "backup"])).toEqual({
      ok: false,
      detail: "Missing cron heartbeat URL(s): reminders, backup",
    });

    vi.stubEnv(CRON_HEARTBEAT_URL_ENV, "   ");
    expect(cronHeartbeatConfigured(["reminders", "backup"])).toEqual({
      ok: false,
      detail: "Missing cron heartbeat URL(s): reminders, backup",
    });

    vi.stubEnv(CRON_HEARTBEAT_URL_ENV, "https://heartbeat.example/{job}");
    expect(cronHeartbeatConfigured(["reminders", "backup"])).toEqual({
      ok: true,
      detail: "Cron heartbeat URL configured",
    });

    vi.unstubAllEnvs();
    vi.stubEnv("CRON_HEARTBEAT_REMINDERS_URL", "https://h.example/reminders");
    vi.stubEnv("CRON_HEARTBEAT_BACKUP_URL", "https://h.example/backup");
    expect(cronHeartbeatConfigured(["reminders", "backup"])).toEqual({
      ok: true,
      detail: "Job-specific cron heartbeat URLs configured",
    });
  });
});

describe("formatCronHeartbeat", () => {
  it("builds a stable payload for external dead-man monitors", () => {
    expect(
      formatCronHeartbeat({
        job: "backup",
        status: "degraded",
        detail: "1 failed",
        metrics: { ok: 4, failed: 1 },
        finishedAt: new Date("2026-07-01T08:30:00Z"),
      })
    ).toEqual({
      service: "openvpm-web",
      job: "backup",
      status: "degraded",
      detail: "1 failed",
      metrics: { ok: 4, failed: 1 },
      finishedAt: "2026-07-01T08:30:00.000Z",
    });
  });
});

describe("reportCronHeartbeat", () => {
  it("no-ops when no heartbeat URL is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await reportCronHeartbeat({ job: "backup", status: "ok" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs a heartbeat payload and renders URL tokens", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv(
      CRON_HEARTBEAT_URL_ENV,
      " https://heartbeat.example/{job}/{status} "
    );

    await reportCronHeartbeat({
      job: "usage-reconcile",
      status: "ok",
      metrics: { attempted: 2, metered: 1 },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://heartbeat.example/usage-reconcile/ok",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: expect.stringContaining('"job":"usage-reconcile"'),
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("alerts ops when heartbeat delivery fails", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.stubEnv(CRON_HEARTBEAT_URL_ENV, "https://heartbeat.example/{job}");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );

    await reportCronHeartbeat({
      job: "reminders",
      status: "failed",
      detail: "route crashed",
    });

    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Cron heartbeat failed",
      expect.stringContaining("reminders (failed)")
    );
    consoleError.mockRestore();
  });

  it("alerts ops when heartbeat endpoint returns a non-2xx response", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.stubEnv(CRON_HEARTBEAT_URL_ENV, "https://heartbeat.example/{job}");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    await reportCronHeartbeat({
      job: "backup",
      status: "degraded",
      detail: "one practice failed",
    });

    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Cron heartbeat failed",
      expect.stringContaining("backup (degraded)")
    );
    consoleError.mockRestore();
  });

  it("aborts hung heartbeat deliveries and alerts ops", async () => {
    vi.useFakeTimers();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.stubEnv(CRON_HEARTBEAT_URL_ENV, "https://heartbeat.example/{job}");
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

    const result = reportCronHeartbeat({
      job: "billing-lifecycle",
      status: "failed",
      detail: "route crashed",
    });
    await vi.advanceTimersByTimeAsync(CRON_HEARTBEAT_TIMEOUT_MS);
    await result;

    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Cron heartbeat failed",
      expect.stringContaining("billing-lifecycle (failed)")
    );
    consoleError.mockRestore();
  });
});
