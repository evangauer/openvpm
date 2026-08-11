/**
 * Ops alerting for background jobs (cron, webhook dispatch). These run with no
 * user watching, so a silent failure means a clinic never knows a reminder
 * didn't send or a backup didn't run. Posts to OPS_ALERT_WEBHOOK_URL (Slack-
 * style) if configured; always logs. Never throws into the caller.
 */

export function formatOpsAlert(
  subject: string,
  detail: string,
): { text: string } {
  return { text: `🚨 OpenVPM ops alert — ${subject}\n${detail}` };
}

export const OPS_ALERT_TIMEOUT_MS = 5_000;

export function opsAlertWebhookUrl(): string | undefined {
  const trimmed = process.env.OPS_ALERT_WEBHOOK_URL?.trim();
  return trimmed ? trimmed : undefined;
}

export async function deliverOpsAlert(
  subject: string,
  detail: string,
): Promise<boolean> {
  console.error(`[ops-alert] ${subject}: ${detail}`);
  const url = opsAlertWebhookUrl();
  if (!url) return true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPS_ALERT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formatOpsAlert(subject, detail)),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(
        "[ops-alert] failed to deliver alert:",
        new Error(`alert endpoint returned HTTP ${response.status}`),
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error("[ops-alert] failed to deliver alert:", err);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function alertOps(subject: string, detail: string): Promise<void> {
  await deliverOpsAlert(subject, detail);
}
