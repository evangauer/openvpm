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
