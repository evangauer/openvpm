import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("self-hosting operations docs", () => {
  it("exposes root RLS verification and documents the bootstrap sequence", () => {
    const rootPackage = JSON.parse(
      readFileSync("../../package.json", "utf8")
    ) as { scripts: Record<string, string> };
    const compose = readFileSync("../../docker/docker-compose.yml", "utf8");
    const readme = readFileSync("../../README.md", "utf8");
    const envExample = readFileSync("../../.env.example", "utf8");
    const hostedRunbook = readFileSync(
      "../../docs/hosted-cloud-production.md",
      "utf8"
    );
    const rlsSecurityDoc = readFileSync(
      "../../docs/security/row-level-security.md",
      "utf8"
    );
    const applyRls = readFileSync("../../packages/db/apply-rls.ts", "utf8");
    const testRls = readFileSync("../../packages/db/test-rls.ts", "utf8");

    expect(rootPackage.scripts["db:rls"]).toBe(
      "pnpm --filter @openpims/db db:rls"
    );
    expect(rootPackage.scripts["db:rls:test"]).toBe(
      "pnpm --filter @openpims/db db:rls:test"
    );

    expect(compose).toContain("minio-bootstrap:");
    expect(compose).toContain("mc mb --ignore-existing local/openpims");
    expect(compose).toMatch(
      /minio-bootstrap:\s*\n\s*condition: service_completed_successfully/
    );

    expect(readme).toContain("pnpm db:rls");
    expect(readme).toContain("pnpm db:rls:test");
    expect(readme).toContain("automatic MinIO bucket bootstrap");
    expect(readme).toContain("least-privilege `openpims_app` database role");
    expect(readme).toContain("OPENPIMS_APP_DB_PASSWORD='<strong>' pnpm db:rls");
    expect(readme).toContain(
      "OPENPIMS_APP_DB_PASSWORD='<same>' pnpm db:rls:test"
    );
    expect(hostedRunbook).toContain(
      "OPENPIMS_APP_DB_PASSWORD='<strong-password>' pnpm db:rls"
    );
    expect(hostedRunbook).toContain(
      "OPENPIMS_APP_DB_PASSWORD='<same-password>' pnpm db:rls:test"
    );
    expect(rlsSecurityDoc).toContain(
      "Both scripts trim `OPENPIMS_APP_DB_PASSWORD`"
    );
    expect(envExample).toContain("OPENPIMS_APP_DB_PASSWORD=");
    expect(applyRls).toContain('nonBlankEnv("OPENPIMS_APP_DB_PASSWORD")');
    expect(testRls).toContain('nonBlankEnv("OPENPIMS_APP_DB_PASSWORD")');
    expect(testRls).toContain('url.password =');
    expect(testRls).not.toContain("//openpims_app:openpims_app@");
  });

  it("documents Telnyx as the hosted SMS default with Twilio as fallback", () => {
    const readme = readFileSync("../../README.md", "utf8");
    const hostedRunbook = readFileSync(
      "../../docs/hosted-cloud-production.md",
      "utf8"
    );
    const envExample = readFileSync("../../.env.example", "utf8");
    const hostedEnvHeading = hostedRunbook.indexOf("## Required Hosted Env");
    const hostedEnvBlockStart = hostedRunbook.indexOf(
      "```env",
      hostedEnvHeading
    );
    const requiredHostedEnvBlock = hostedRunbook.slice(
      hostedEnvBlockStart,
      hostedRunbook.indexOf(
        "```",
        hostedEnvBlockStart + "```env".length
      )
    );

    expect(readme).toContain(
      "| **Email/SMS** | Resend + Telnyx SMS (Twilio fallback) |"
    );
    expect(readme).not.toContain("| **Email/SMS** | Resend + Twilio |");

    expect(requiredHostedEnvBlock).toContain("MESSAGING_PROVIDER=telnyx");
    expect(requiredHostedEnvBlock).toContain("TELNYX_API_KEY=...");
    expect(requiredHostedEnvBlock).toContain("TELNYX_PUBLIC_KEY=...");
    expect(requiredHostedEnvBlock).toContain("RESEND_WEBHOOK_SECRET=...");
    expect(requiredHostedEnvBlock).toContain("EMAIL_SUPPORT_ADDRESS=");
    expect(requiredHostedEnvBlock).toContain("EMAIL_COMPANY_ADDRESS=...");
    expect(requiredHostedEnvBlock).toContain("STRIPE_TAX_ENABLED=true");
    expect(requiredHostedEnvBlock).toContain(
      "MESSAGING_SENDING_ENABLED=false"
    );
    expect(requiredHostedEnvBlock).toContain(
      "MESSAGING_SENDING_PRACTICE_IDS="
    );
    expect(requiredHostedEnvBlock).toContain(
      "MESSAGING_SENDING_LOCATION_IDS="
    );
    expect(requiredHostedEnvBlock).not.toContain("TWILIO_");
    expect(requiredHostedEnvBlock).not.toContain("STRIPE_PRICE_CLOUD_USER");

    expect(hostedRunbook).toContain("Telnyx is the hosted SMS default");
    expect(hostedRunbook).toContain("Twilio fallback deployment");
    expect(hostedRunbook).toContain(
      "`STRIPE_PRICE_CLOUD_USER` and `STRIPE_PRICE_CLOUD` are legacy-only"
    );
    expect(envExample).toContain("TELNYX_PUBLIC_KEY=");
    expect(envExample).toContain("TELNYX_MESSAGING_PROFILE_ID=");
    expect(envExample).toContain("TELNYX_FROM_NUMBER=");
    expect(envExample).toContain("MESSAGING_SENDING_ENABLED=false");
    expect(envExample).toContain("MESSAGING_SENDING_PRACTICE_IDS=");
    expect(envExample).toContain("MESSAGING_SENDING_LOCATION_IDS=");
    expect(envExample).toContain("RESEND_WEBHOOK_SECRET=");
    expect(envExample).toContain("EMAIL_SUPPORT_ADDRESS=");
    expect(envExample).toContain("EMAIL_COMPANY_ADDRESS=");
  });

  it("documents hosted AI provider key alternatives", () => {
    const hostedRunbook = readFileSync(
      "../../docs/hosted-cloud-production.md",
      "utf8"
    );
    const envExample = readFileSync("../../.env.example", "utf8");
    const healthRoute = readFileSync("app/api/health/route.ts", "utf8");
    const hostedEnvHeading = hostedRunbook.indexOf("## Required Hosted Env");
    const hostedEnvBlockStart = hostedRunbook.indexOf(
      "```env",
      hostedEnvHeading
    );
    const requiredHostedEnvBlock = hostedRunbook.slice(
      hostedEnvBlockStart,
      hostedRunbook.indexOf(
        "```",
        hostedEnvBlockStart + "```env".length
      )
    );

    expect(requiredHostedEnvBlock).toContain("AI_MODEL=claude-sonnet-4-6");
    expect(requiredHostedEnvBlock).toContain("ANTHROPIC_API_KEY=...");
    expect(hostedRunbook).toContain("Hosted AI defaults to Claude");
    expect(hostedRunbook).toContain(
      "set either `GOOGLE_API_KEY` or the legacy\n`GOOGLE_GENERATIVE_AI_API_KEY`"
    );
    expect(envExample).toContain("GOOGLE_GENERATIVE_AI_API_KEY=");
    expect(healthRoute).toContain("HOSTED_GOOGLE_AI_ENV_NAMES");
    expect(healthRoute).toContain("some((name) => configured(name))");
  });

  it("documents Stripe Tax as a hosted production readiness gate", () => {
    const hostedRunbook = readFileSync(
      "../../docs/hosted-cloud-production.md",
      "utf8"
    );
    const envExample = readFileSync("../../.env.example", "utf8");
    const healthRoute = readFileSync("app/api/health/route.ts", "utf8");
    const stripeSource = readFileSync("lib/stripe.ts", "utf8");
    const invoiceCheckoutBuilder = stripeSource.slice(
      stripeSource.indexOf("export function buildInvoiceCheckoutSessionParams"),
      stripeSource.indexOf("export async function constructWebhookEvent")
    );

    expect(hostedRunbook).toContain("STRIPE_TAX_ENABLED=true");
    expect(hostedRunbook).toContain("Stripe Tax gates hosted readiness");
    expect(hostedRunbook).toContain(
      "Client invoice payments stay on OpenVPM's already-totaled invoice amounts"
    );
    expect(envExample).toContain(
      "Required for hosted production readiness after"
    );
    expect(healthRoute).toContain("checks.hostedSubscriptionTax");
    expect(healthRoute).toContain(
      "envFlagEnabled(HOSTED_SUBSCRIPTION_TAX_ENV_NAME)"
    );
    expect(stripeSource).toContain("automatic_tax: { enabled: true }");
    expect(invoiceCheckoutBuilder).not.toContain("automatic_tax");
  });

  it("documents the Resend webhook required for hosted email suppressions", () => {
    const hostedRunbook = readFileSync(
      "../../docs/hosted-cloud-production.md",
      "utf8"
    );
    const envExample = readFileSync("../../.env.example", "utf8");
    const resendWebhookRoute = readFileSync(
      "app/api/webhooks/resend/route.ts",
      "utf8"
    );
    const emailSection = hostedRunbook.slice(
      hostedRunbook.indexOf("## Email Setup"),
      hostedRunbook.indexOf("## Stripe Setup")
    );
    const resendEvents = [
      "email.delivered",
      "email.bounced",
      "email.complained",
      "email.failed",
      "email.suppressed",
    ];

    expect(emailSection).toContain(
      "https://app.openvpm.com/api/webhooks/resend"
    );
    expect(emailSection).toContain("RESEND_WEBHOOK_SECRET");
    expect(emailSection).toContain("EMAIL_SUPPORT_ADDRESS");
    expect(emailSection).toContain("EMAIL_COMPANY_ADDRESS");
    expect(emailSection).toContain("production emails do not fall back");
    expect(envExample).toContain("RESEND_WEBHOOK_SECRET=");
    expect(envExample).toContain("EMAIL_SUPPORT_ADDRESS=");
    expect(envExample).toContain("EMAIL_COMPANY_ADDRESS=");

    for (const event of resendEvents) {
      expect(resendWebhookRoute).toContain(event);
      expect(emailSection).toContain(`- \`${event}\``);
    }
  });

  it("documents the Stripe webhook events required by hosted handlers", () => {
    const hostedRunbook = readFileSync(
      "../../docs/hosted-cloud-production.md",
      "utf8"
    );
    const subscriptionWebhookRoute = readFileSync(
      "app/api/webhooks/stripe-subscription/route.ts",
      "utf8"
    );
    const clientInvoiceSection = hostedRunbook.slice(
      hostedRunbook.indexOf("Client invoice payment webhook endpoint:"),
      hostedRunbook.indexOf("Hosted subscription webhook endpoint:")
    );
    const subscriptionSection = hostedRunbook.slice(
      hostedRunbook.indexOf("Hosted subscription webhook endpoint:"),
      hostedRunbook.indexOf(
        "Store this endpoint secret as `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET`."
      )
    );
    const subscriptionEvents = [
      "checkout.session.completed",
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "invoice.payment_succeeded",
      "invoice.payment_failed",
    ];

    expect(clientInvoiceSection).toContain(
      "https://app.openvpm.com/api/webhooks/stripe"
    );
    expect(clientInvoiceSection).toContain("- `checkout.session.completed`");
    expect(clientInvoiceSection).not.toContain("invoice.payment_succeeded");
    expect(subscriptionSection).toContain(
      "https://app.openvpm.com/api/webhooks/stripe-subscription"
    );

    for (const event of subscriptionEvents) {
      expect(subscriptionWebhookRoute).toContain(`case "${event}"`);
      expect(subscriptionSection).toContain(`- \`${event}\``);
    }
  });
});
