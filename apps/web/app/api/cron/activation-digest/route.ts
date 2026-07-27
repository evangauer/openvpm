import { NextResponse } from "next/server";
import { db } from "@openpims/db/client";
import { cronAuthError } from "@/lib/cron-auth";
import { sendEmail } from "@/lib/email";
import { alertOps } from "@/lib/alerts";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";
import { platformAdminEmails } from "@/lib/platform-admin";
import {
  computeActivationFunnel,
  type ActivationFunnel,
} from "@/lib/admin/activation-funnel";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Weekly trial-funnel digest for the founder/operators: signups -> setup ->
// activated -> billing started -> paid active for the past 7 and 30 days.
// Reporting only — it must never 500-loop, so failures alert ops and still
// return a non-throwing response.
export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  try {
    const recipients = platformAdminEmails();
    if (recipients.length === 0) {
      await reportCronHeartbeat({
        job: "activation-digest",
        status: "ok",
        detail: "No platform admin emails configured; digest skipped",
        metrics: { recipients: 0, sent: 0, failed: 0 },
      });
      return NextResponse.json({ recipients: 0, sent: 0, failed: 0 });
    }

    const [week, month] = await Promise.all([
      computeActivationFunnel(db, 7),
      computeActivationFunnel(db, 30),
    ]);

    const subject = `OpenVPM trial funnel: ${week.totals.signups} signups, ${week.totals.activated} activated this week`;
    const html = digestHtml(week, month);

    let sent = 0;
    let failed = 0;
    for (const to of recipients) {
      const result = await sendEmail({ to, subject, html });
      if (result.success) {
        sent++;
      } else {
        failed++;
      }
    }

    if (failed > 0) {
      void alertOps(
        "Activation digest had send failures",
        `${failed} of ${recipients.length} digest emails failed to send.`
      );
    }

    await reportCronHeartbeat({
      job: "activation-digest",
      status: failed > 0 ? "degraded" : "ok",
      detail: `${sent} sent, ${failed} failed`,
      metrics: { recipients: recipients.length, sent, failed },
    });

    return NextResponse.json({ recipients: recipients.length, sent, failed });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void alertOps("Activation digest cron failed", message);
    await reportCronHeartbeat({
      job: "activation-digest",
      status: "failed",
      detail: message,
    });
    // Deliberately not a 5xx: a broken digest should alert ops, not retry-loop.
    return NextResponse.json({ ok: false, error: "Activation digest failed" });
  }
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function funnelSection(title: string, funnel: ActivationFunnel): string {
  const {
    signups,
    setupStarted,
    setupCompleted,
    activated,
    billingStarted,
    subscribed,
    setupStartRate,
    setupCompletionRate,
    activationRate,
    billingStartRate,
    conversionRate,
  } = funnel.totals;
  return `<h2 style="margin:24px 0 8px;font-size:16px;color:#111827;">${title}</h2>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
  <tr style="text-align:left;color:#6b7280;font-size:13px;">
    <th style="padding:4px 12px 4px 0;font-weight:500;">Signups</th>
    <th style="padding:4px 12px 4px 0;font-weight:500;">Setup started</th>
    <th style="padding:4px 12px 4px 0;font-weight:500;">Setup complete</th>
    <th style="padding:4px 12px 4px 0;font-weight:500;">Activated</th>
    <th style="padding:4px 12px 4px 0;font-weight:500;">Billing started</th>
    <th style="padding:4px 0;font-weight:500;">Paid active</th>
  </tr>
  <tr style="font-size:20px;color:#111827;font-weight:600;">
    <td style="padding:2px 12px 2px 0;">${signups}</td>
    <td style="padding:2px 12px 2px 0;">${setupStarted} <span style="font-size:13px;color:#6b7280;font-weight:400;">${pct(setupStartRate)}</span></td>
    <td style="padding:2px 12px 2px 0;">${setupCompleted} <span style="font-size:13px;color:#6b7280;font-weight:400;">${pct(setupCompletionRate)}</span></td>
    <td style="padding:2px 12px 2px 0;">${activated} <span style="font-size:13px;color:#6b7280;font-weight:400;">${pct(activationRate)}</span></td>
    <td style="padding:2px 12px 2px 0;">${billingStarted} <span style="font-size:13px;color:#6b7280;font-weight:400;">${pct(billingStartRate)}</span></td>
    <td style="padding:2px 0;">${subscribed} <span style="font-size:13px;color:#6b7280;font-weight:400;">${pct(conversionRate)}</span></td>
  </tr>
</table>`;
}

function digestHtml(week: ActivationFunnel, month: ActivationFunnel): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenVPM trial funnel</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
          <tr>
            <td style="background-color:#0d9488;padding:24px 32px;">
              <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:600;letter-spacing:-0.01em;">OpenVPM trial funnel</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              ${funnelSection("Past 7 days", week)}
              ${funnelSection("Past 30 days", month)}
              <p style="margin:24px 0 0;color:#6b7280;font-size:13px;line-height:1.5;">Activated = added a real client and booked a real visit. Billing started = a Stripe subscription exists. Paid active = billing status is active. These are signup-cohort rates; demo data never counts.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px;background-color:#f9fafb;border-top:1px solid #e5e7eb;">
              <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.5;">Weekly digest from the OpenVPM activation cron. Full detail is on the platform admin page.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
