import { describe, expect, it } from "vitest";
import {
  EXPECTED_CONNECT_APPLICATION_FEE_BPS,
  EXPECTED_OPENVPM_PRODUCTION_CONFIG,
  verifyVercelStripeEnvPolicy,
} from "./verify-vercel-stripe-env";

const sensitive = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_CONNECT_WEBHOOK_SECRET",
  "STRIPE_CONNECT_V2_WEBHOOK_SECRET",
  "STRIPE_SUBSCRIPTION_WEBHOOK_SECRET",
];
function validInput() {
  return {
    envs: [
      ...sensitive.map((key) => ({
        key,
        type: "sensitive",
        target: ["production"],
      })),
      ...Object.entries(EXPECTED_OPENVPM_PRODUCTION_CONFIG).map(
        ([key, value]) => ({
          key,
          value,
          type: "plain",
          target: ["production"],
        }),
      ),
      {
        key: "STRIPE_CONNECT_APPLICATION_FEE_BPS",
        value: EXPECTED_CONNECT_APPLICATION_FEE_BPS,
        type: "plain",
        target: ["production"],
      },
    ],
  };
}

describe("Vercel Stripe environment policy", () => {
  it("accepts a complete production configuration with protected credentials", () => {
    expect(verifyVercelStripeEnvPolicy(validInput())).toEqual({
      ok: true,
      issues: [],
    });
  });

  it("accepts current Vercel encrypted config rows whose exact values are checked at runtime", () => {
    const input = validInput();
    for (const env of input.envs) {
      if (env.type !== "plain") continue;
      env.type = "encrypted";
      if ("value" in env) {
        (env as { value: string }).value =
          "authenticated-vercel-ciphertext";
      }
    }

    expect(verifyVercelStripeEnvPolicy(input)).toEqual({
      ok: true,
      issues: [],
    });
  });

  it("rejects a Stripe credential stored as non-sensitive", () => {
    const input = validInput();
    input.envs.find((env) => env.key === "STRIPE_SECRET_KEY")!.type =
      "encrypted";

    expect(verifyVercelStripeEnvPolicy(input)).toMatchObject({
      ok: false,
      issues: ["Production credential must be Sensitive: STRIPE_SECRET_KEY"],
    });
  });

  it("rejects missing pinned account configuration", () => {
    const input = validInput();
    input.envs = input.envs.filter(
      (env) => env.key !== "STRIPE_EXPECTED_ACCOUNT_ID",
    );

    expect(verifyVercelStripeEnvPolicy(input).issues).toContain(
      "Missing production environment variable: STRIPE_EXPECTED_ACCOUNT_ID",
    );
  });

  it("rejects opaque or incorrect production configuration", () => {
    const opaque = validInput();
    const account = opaque.envs.find(
      (env) => env.key === "STRIPE_EXPECTED_ACCOUNT_ID",
    ) as { key: string; type: string; target: string[]; value?: string };
    account.type = "sensitive";
    delete account.value;
    expect(verifyVercelStripeEnvPolicy(opaque).issues).toContain(
      "Production config must be non-sensitive and verifiable: STRIPE_EXPECTED_ACCOUNT_ID",
    );

    const wrong = validInput();
    const tax = wrong.envs.find((env) => env.key === "STRIPE_TAX_ENABLED") as {
      key: string;
      type: string;
      target: string[];
      value?: string;
    };
    tax.value = "false";
    expect(verifyVercelStripeEnvPolicy(wrong).issues).toContain(
      "Production config does not match OpenVPM cutover: STRIPE_TAX_ENABLED",
    );
  });

  it("rejects legacy Cloud price configuration after cutover", () => {
    const input = validInput();
    input.envs.push({
      key: "STRIPE_PRICE_CLOUD_USER",
      type: "encrypted",
      target: ["production"],
    });

    expect(verifyVercelStripeEnvPolicy(input).issues).toContain(
      "Retired production environment variable is still present: STRIPE_PRICE_CLOUD_USER",
    );
  });

  it("rejects a missing or malformed Connect application fee", () => {
    const missing = validInput();
    missing.envs = missing.envs.filter(
      (env) => env.key !== "STRIPE_CONNECT_APPLICATION_FEE_BPS",
    );
    expect(verifyVercelStripeEnvPolicy(missing).issues).toContain(
      "Missing production environment variable: STRIPE_CONNECT_APPLICATION_FEE_BPS",
    );

    const malformed = validInput();
    const fee = malformed.envs.find(
      (env) => env.key === "STRIPE_CONNECT_APPLICATION_FEE_BPS",
    ) as { key: string; value?: string };
    fee.value = "1.5";
    expect(verifyVercelStripeEnvPolicy(malformed).issues).toContain(
      "Production Connect application fee must be 25 basis points (0.25%)",
    );
  });

  it("rejects a positive but unapproved Connect application fee", () => {
    const input = validInput();
    const fee = input.envs.find(
      (env) => env.key === "STRIPE_CONNECT_APPLICATION_FEE_BPS",
    ) as { key: string; value?: string };
    fee.value = "100";

    expect(verifyVercelStripeEnvPolicy(input).issues).toContain(
      "Production Connect application fee must be 25 basis points (0.25%)",
    );
  });
});
