import { alertOps } from "@/lib/alerts";
import { sendEmail } from "@/lib/email";
import { defaultEmailFrom } from "@/lib/email-env";

/** Optional inbox for the post-signup clinic alert. Blank disables it. */
export const NEW_CLINIC_ALERT_EMAIL_ENV = "NEW_CLINIC_ALERT_EMAIL";

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function recipient(): string | undefined {
  const value = process.env[NEW_CLINIC_ALERT_EMAIL_ENV]?.trim();
  return value ? value : undefined;
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Tell operators a practice was created. Caller must invoke this only after
 * the registration transaction has committed. Never throws, and does nothing
 * when NEW_CLINIC_ALERT_EMAIL is unset.
 */
export async function notifyNewClinic(clinic: {
  practiceId: string;
  practiceName: string;
}): Promise<void> {
  const to = recipient();
  if (!to) return;

  const subject = `New OpenVPM clinic: ${singleLine(clinic.practiceName)} [${singleLine(clinic.practiceId)}]`;
  if (!looksLikeEmail(to)) {
    console.error("[register] new clinic alert recipient is invalid");
    await alertOps(
      "New clinic alert failed",
      `${subject}: recipient is not a valid email address`,
    ).catch(() => undefined);
    return;
  }

  try {
    const result = await sendEmail({
      to,
      subject,
      html: `<p>${escapeHtml(subject)}</p>`,
      from: defaultEmailFrom(),
      idempotencyKey: `new-clinic:${clinic.practiceId}`,
    });
    if (!result.success) {
      throw new Error(
        result.error ?? "Email provider did not accept the new clinic alert",
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[register] new clinic alert failed");
    await alertOps("New clinic alert failed", `${subject}: ${message}`).catch(
      () => undefined,
    );
  }
}
