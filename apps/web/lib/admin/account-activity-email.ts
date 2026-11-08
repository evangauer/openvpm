import { engagementFor, type PracticeTracking } from "./practice-tracking-types";

function escape(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function timestamp(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium", timeStyle: "short", timeZone: "UTC",
  }).format(new Date(value)) + " UTC";
}

export interface AccountActivityEmail {
  snapshotAt: string;
  practices: PracticeTracking[];
  hasMore: boolean;
}

/** Shared, bounded operator-email fragment. Deliberately does not serialize
 * whole records: audit inputs, patient/client identities and clinical text
 * cannot enter the HTML through an added field on a tracking object.
 */
export function accountActivityEmail(
  activity: AccountActivityEmail | null,
  dashboardUrl: string,
): string {
  const url = new URL(dashboardUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Invalid operator dashboard URL");
  const link = `<a href="${escape(url.toString())}" style="color:#0d9488;">View account activity in OpenVPM</a>`;
  const heading = '<h2 style="margin:24px 0 8px;font-size:18px;color:#111827;">Trial and customer activity</h2>';
  if (!activity) return heading + '<p>Account activity could not be loaded. Usage and engagement are unknown for this report.</p>' + link;
  const accounts = activity.practices.slice(0, 10).map(p => {
    const usage = [
      ["Clients", p.usage.clients], ["Patients", p.usage.patients],
      ["Appointments", p.usage.appointments], ["Clinical notes", p.usage.soapNotes],
      ["Invoices", p.usage.invoices], ["Uploaded files", p.usage.files],
      ["Capture sessions started", p.usage.captureSessions],
      ["Metered AI runs", p.usage.aiRuns], ["Metered SMS", p.usage.sms],
    ] as const;
    const actions = p.actions.length
      ? '<ul style="margin:8px 0;padding-left:20px;">' + p.actions.map(a =>
        `<li>${escape(a.label)} × ${a.count} — latest ${timestamp(a.lastAt)}</li>`).join("") + "</ul>"
      : "<p>No supported product actions recorded.</p>";
    const source = (value: string | null) => value ? escape(value) : "Unknown — not captured";
    return `<div style="margin:16px 0;padding:16px;border:1px solid #e5e7eb;border-radius:8px;color:#374151;font-size:14px;line-height:1.5;overflow-wrap:anywhere;">
<h3 style="margin:0 0 4px;font-size:16px;color:#111827;">${escape(p.businessName)}</h3>
<p style="margin:4px 0;color:#6b7280;font-size:12px;">Account-provided business name; business identity is unverified.</p>
<p style="margin:8px 0;"><strong>Owner:</strong> ${escape(p.ownerName || "Name not recorded")} · ${escape(p.ownerEmail || "Email not recorded")}<br>
<strong>Email verification:</strong> ${p.emailVerifiedAt ? "Verified " + timestamp(p.emailVerifiedAt) : "Verification not recorded"}<br>
<strong>Registered:</strong> ${timestamp(p.registeredAt)}<br>
<strong>Billing status:</strong> ${escape(p.billingStatus)}<br>
<strong>Trial ends:</strong> ${timestamp(p.trialEndsAt)}</p>
<p style="margin:8px 0;"><strong>Product-use assessment:</strong> ${escape(engagementFor(p, new Date(activity.snapshotAt)))}<br>
<strong>Last recorded product action:</strong> ${timestamp(p.lastActionAt)}<br>
<strong>Days with recorded actions:</strong> ${p.activeDays7} in the last 7 UTC calendar days; ${p.activeDays30} in the last 30.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:13px;">${usage.map(([label, count]) =>
  `<tr><td style="padding:2px 8px 2px 0;">${label}</td><td style="padding:2px 0;text-align:right;">${count}</td></tr>`).join("")}</table>
<p style="margin:8px 0;font-size:12px;color:#6b7280;">Record counts exclude seeded samples. New appointments can still use sample patients. Capture sessions do not establish a completed upload.</p>
<strong>Recorded actions</strong>${actions}
<p style="margin:8px 0;"><strong>Captured signup source / placement:</strong> ${source(p.acquisition.signupSource)}<br>
<strong>Medium:</strong> ${source(p.acquisition.medium)}<br>
<strong>Campaign:</strong> ${source(p.acquisition.campaign)}</p>
<p style="margin:4px 0;font-size:12px;color:#6b7280;">A homepage button identifies signup placement; an external referral channel cannot be inferred from it. Billing status is separate from product use and paid revenue.</p>
</div>`;
  }).join("");
  return heading + `<p style="color:#6b7280;font-size:13px;">Account snapshot: ${timestamp(activity.snapshotAt)}. Includes signups before checkout. Successful supported actions indicate product activity, not time online or current presence.</p>`
    + (accounts || "<p>No registered accounts to report.</p>")
    + ((activity.hasMore || activity.practices.length > 10) ? "<p>Showing the 10 newest registered accounts. More accounts are available in the dashboard.</p>" : "")
    + link;
}
