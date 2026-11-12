/**
 * Render every lifecycle template to ./.preview/*.html with sample props so the
 * design can be eyeballed in a browser. Run: `pnpm --filter @openpims/email preview`.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { openvpmBrand } from "./src/brand";
import {
  renderWelcomeEmail,
  renderSetupRecoveryEmail,
  renderTrialEndingEmail,
  renderPaymentReceiptEmail,
  renderPaymentFailedEmail,
  renderCheckoutRecoveryEmail,
  renderDemoFollowupEmail,
  renderTeamInviteEmail,
  renderTrialWinbackEmail,
  renderAdoptionEmail,
  renderNpsSurveyEmail,
  renderBuildFollowupEmail,
  type RenderedEmail,
} from "./src/render";

const brand = openvpmBrand();
const practiceName = "Cedar Animal Hospital";
const billingUrl = `${brand.appUrl}/settings?tab=billing`;
const outDir = "./.preview";

async function main() {
  mkdirSync(outDir, { recursive: true });
  const emails = {
    welcome: await renderWelcomeEmail({ brand, practiceName, trialDays: 14 }),
    "welcome-preview": await renderWelcomeEmail({
      brand,
      practiceName,
      trialDays: 14,
      billingRequired: true,
      previewDays: 3,
    }),
    "setup-recovery": await renderSetupRecoveryEmail({
      brand,
      practiceName,
      stepTitle: "bring in your clinic records",
      nextAction:
        "Import one small file at a time, keep sample data for now, or request a private migration review.",
      resumeUrl: `${brand.appUrl}/?setup=resume`,
      attemptNumber: 1,
    }),
    "trial-ending": await renderTrialEndingEmail({
      brand,
      practiceName,
      daysLeft: 3,
      trialEndDate: "July 10, 2026",
      monthlyPrice: "$79",
      billingUrl,
      billingConnected: false,
      usage: { clients: 14, appointments: 22, invoices: 9, staffCount: 3 },
      unsubscribeUrl: `${brand.appUrl}/email-preferences?token=preview`,
    }),
    "team-invite": await renderTeamInviteEmail({
      brand,
      practiceName,
      greetingName: "Sam",
      senderName: "Alex",
      appointments: 6,
      inviteUrl: `${brand.appUrl}/settings?tab=staff`,
      unsubscribeUrl: `${brand.appUrl}/email-preferences?token=preview`,
    }),
    ...Object.fromEntries<RenderedEmail>(
      await Promise.all(
        ([1, 2, 3] as const).map(async (step): Promise<[string, RenderedEmail]> => [
          `trial-winback-${step}`,
          await renderTrialWinbackEmail({
            brand,
            step,
            practiceName,
            greetingName: "Sam",
            senderName: "Alex",
            usageSummary: "14 clients and 22 appointments",
            reactivateUrl: billingUrl,
            reasonLinks: [
              "The price doesn't fit",
              "It's missing something we need",
            ].map((label, index) => ({
              label,
              url: `${brand.appUrl}/feedback/stop-reason?token=preview&reason=${index}`,
            })),
            unsubscribeUrl: `${brand.appUrl}/email-preferences?token=preview`,
          }),
        ]),
      ),
    ),
    adoption: await renderAdoptionEmail({
      brand,
      practiceName,
      greetingName: "Sam",
      senderName: "Alex",
      tips: [
        {
          title: "Appointment reminders",
          body: "Clients get an email or text before each visit, which cuts no-shows without anyone picking up the phone.",
          linkLabel: "Turn on reminders",
          url: `${brand.appUrl}/settings?tab=messaging`,
        },
        {
          title: "The client portal",
          body: "Every client has a private link to see their pets, visits, and invoices, so fewer calls come to the front desk.",
          linkLabel: "Share a portal link",
          url: `${brand.appUrl}/clients`,
        },
      ],
      unsubscribeUrl: `${brand.appUrl}/email-preferences?token=preview`,
    }),
    ...Object.fromEntries<RenderedEmail>(
      await Promise.all(
        ([1, 2] as const).map(async (step): Promise<[string, RenderedEmail]> => [
          `build-followup-${step}`,
          await renderBuildFollowupEmail({
            brand,
            step,
            clinicName: "Farmstead Equine",
            brandColor: "#16a34a",
            currentSystem: "DaySmart",
            senderName: "Alex",
            resumeUrl: `${brand.appUrl}/start?resume=preview`,
            bookingUrl: null,
            unsubscribeUrl: `${brand.appUrl}/email-preferences?token=preview`,
          }),
        ]),
      ),
    ),
    nps: await renderNpsSurveyEmail({
      brand,
      practiceName,
      greetingName: "Sam",
      senderName: "Alex",
      scoreUrls: Array.from(
        { length: 11 },
        (_, score) => `${brand.appUrl}/feedback/nps?token=preview&score=${score}`,
      ),
      unsubscribeUrl: `${brand.appUrl}/email-preferences?token=preview`,
    }),
    receipt: await renderPaymentReceiptEmail({
      brand,
      practiceName,
      amount: "$79.00",
      periodLabel: "Jun 10 – Jul 10, 2026",
      invoiceUrl: "https://example.com/invoice",
    }),
    "payment-failed": await renderPaymentFailedEmail({
      brand,
      practiceName,
      amount: "$79.00",
      nextRetryDate: "July 3, 2026",
      billingUrl,
    }),
    ...Object.fromEntries<RenderedEmail>(
      await Promise.all(
        ([1, 2, 3, 4] as const).map(async (step): Promise<[string, RenderedEmail]> => [
          `checkout-recovery-${step}`,
          await renderCheckoutRecoveryEmail({
            brand,
            step,
            practiceName,
            greetingName: "Sam",
            senderName: "Alex",
            trialDays: 14,
            resumeUrl: `${brand.appUrl}/settings?tab=billing`,
            reasonLinks: [
              "I didn't want to enter a card yet",
              "The price doesn't fit",
              "It's not the right time",
            ].map((label, index) => ({
              label,
              url: `${brand.appUrl}/feedback/stop-reason?token=preview&reason=${index}`,
            })),
            feedbackUrl: `${brand.appUrl}/feedback/stop-reason?token=preview`,
            bookingUrl: null,
            unsubscribeUrl: `${brand.appUrl}/email-preferences?token=preview`,
          }),
        ]),
      ),
    ),
    "checkout-recovery-1-preview": await renderCheckoutRecoveryEmail({
      brand,
      step: 1,
      practiceName,
      greetingName: "Sam",
      senderName: "Alex",
      trialDays: 14,
      resumeUrl: brand.appUrl,
      reasonLinks: [],
      feedbackUrl: `${brand.appUrl}/feedback/stop-reason?token=preview`,
      bookingUrl: null,
      previewActive: true,
      unsubscribeUrl: `${brand.appUrl}/email-preferences?token=preview`,
    }),
    ...Object.fromEntries<RenderedEmail>(
      await Promise.all(
        ([1, 2, 3, 4] as const).map(async (step): Promise<[string, RenderedEmail]> => [
          `demo-followup-${step}`,
          await renderDemoFollowupEmail({
            brand,
            step,
            senderName: "Alex",
            tool: {
              name: "the day board",
              pitch:
                "Your whole day on one screen: who's checked in, who's waiting, and which room each patient is in.",
            },
            trialDays: 14,
            signupUrl: `${brand.appUrl}/register?intent=cloud`,
            bookingUrl: null,
            unsubscribeUrl: `${brand.appUrl}/email-preferences?token=preview`,
          }),
        ]),
      ),
    ),
  };

  for (const [name, r] of Object.entries(emails)) {
    writeFileSync(`${outDir}/${name}.html`, r.html);
    console.log(`wrote ${outDir}/${name}.html  —  ${r.subject}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
