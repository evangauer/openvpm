import { alertOps } from "@/lib/alerts";

export const CRON_HEARTBEAT_URL_ENV = "CRON_HEARTBEAT_URL";
export const CRON_HEARTBEAT_TIMEOUT_MS = 5_000;

export const CRON_HEARTBEAT_JOBS = [
  "reminders",
  "backup",
  "usage-reconcile",
  "billing-lifecycle",
  "wellness-billing",
  "rate-limit-cleanup",
  "auth-cleanup",
  "prescription-expiry",
  "activation-digest",
  "conversion-reconcile",
] as const;

export type CronHeartbeatJob = (typeof CRON_HEARTBEAT_JOBS)[number];
export type CronHeartbeatStatus = "ok" | "degraded" | "failed";

export interface CronHeartbeatPayload {
  service: "openvpm-web";
  job: string;
  status: CronHeartbeatStatus;
  detail?: string;
  metrics?: Record<string, number | string | boolean | null>;
  finishedAt: string;
}

export function cronHeartbeatEnvName(job: string): string {
  return `CRON_HEARTBEAT_${job.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_URL`;
}

function nonBlank(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function cronHeartbeatUrlFromEnv(name: string): string | undefined {
  return nonBlank(process.env[name]);
}

export function cronHeartbeatUrlForJob(job: string): string | undefined {
  return (
    cronHeartbeatUrlFromEnv(cronHeartbeatEnvName(job)) ??
    cronHeartbeatUrlFromEnv(CRON_HEARTBEAT_URL_ENV)
  );
}

export function cronHeartbeatConfigured(
  jobs: readonly string[] = CRON_HEARTBEAT_JOBS
): { ok: boolean; detail: string } {
  if (cronHeartbeatUrlFromEnv(CRON_HEARTBEAT_URL_ENV)) {
    return { ok: true, detail: "Cron heartbeat URL configured" };
  }

  const missing = jobs.filter(
    (job) => !cronHeartbeatUrlFromEnv(cronHeartbeatEnvName(job))
  );
  return missing.length === 0
    ? { ok: true, detail: "Job-specific cron heartbeat URLs configured" }
    : {
        ok: false,
        detail: `Missing cron heartbeat URL(s): ${missing.join(", ")}`,
      };
}

export function formatCronHeartbeat(opts: {
  job: string;
  status: CronHeartbeatStatus;
  detail?: string;
  metrics?: Record<string, number | string | boolean | null>;
  finishedAt?: Date;
}): CronHeartbeatPayload {
  return {
    service: "openvpm-web",
    job: opts.job,
    status: opts.status,
    ...(opts.detail ? { detail: opts.detail } : {}),
    ...(opts.metrics ? { metrics: opts.metrics } : {}),
    finishedAt: (opts.finishedAt ?? new Date()).toISOString(),
  };
}

export async function reportCronHeartbeat(opts: {
  job: string;
  status: CronHeartbeatStatus;
  detail?: string;
  metrics?: Record<string, number | string | boolean | null>;
}): Promise<void> {
  const urlTemplate = cronHeartbeatUrlForJob(opts.job);
  if (!urlTemplate) return;

  const payload = formatCronHeartbeat(opts);
  const url = renderCronHeartbeatUrl(urlTemplate, payload);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    CRON_HEARTBEAT_TIMEOUT_MS,
  );

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[cron-heartbeat] ${opts.job} ${opts.status}:`, error);
    await alertOps(
      "Cron heartbeat failed",
      `${opts.job} (${opts.status}) could not reach heartbeat URL: ${message}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function renderCronHeartbeatUrl(
  template: string,
  payload: CronHeartbeatPayload
): string {
  return template
    .replaceAll("{job}", encodeURIComponent(payload.job))
    .replaceAll("{status}", encodeURIComponent(payload.status));
}
