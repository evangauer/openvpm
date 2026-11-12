export const LEAD_ALERT_TIMEOUT_MS = 5_000;

export function leadAlertWebhookUrl(): string | undefined {
  const trimmed = process.env.LEAD_ALERT_WEBHOOK_URL?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Tell the team a lead raised their hand so someone replies the same day.
 * Posts Slack-style JSON to LEAD_ALERT_WEBHOOK_URL when configured. Kept apart
 * from ops alerts so sales signals never page on-call. Never throws.
 */
export async function notifyLeadHandRaise(alert: {
  practiceId: string;
  practiceName: string;
  summary: string;
  note?: string | null;
}): Promise<boolean> {
  const lines = [
    `🙋 Lead hand-raise — ${alert.practiceName}`,
    alert.summary,
    ...(alert.note ? [`> ${alert.note.replace(/\s+/g, " ").trim()}`] : []),
    `practice=${alert.practiceId}`,
  ];
  console.info(`[lead-alert] ${alert.practiceId}: ${alert.summary}`);
  const url = leadAlertWebhookUrl();
  if (!url) return true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LEAD_ALERT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: lines.join("\n") }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error("[lead-alert] delivery failed:", response.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      "[lead-alert] delivery failed:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
