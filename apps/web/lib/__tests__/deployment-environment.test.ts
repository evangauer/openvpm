import { describe, expect, it } from "vitest";
import {
  assertDeploymentEnvironment,
  inspectDeploymentEnvironment,
  type DeploymentEnvironmentVariables,
} from "../deployment-environment";

function managed(
  environment: "development" | "staging" | "demo" | "production",
  overrides: DeploymentEnvironmentVariables = {},
): DeploymentEnvironmentVariables {
  return {
    VERCEL: "1",
    VERCEL_ENV: environment === "production" ? "production" : "preview",
    OPENVPM_ENVIRONMENT: environment,
    HOSTED_BILLING_ENABLED: environment === "demo" ? "false" : "true",
    NEXT_PUBLIC_DEMO_MODE: environment === "demo" ? "true" : "false",
    ...overrides,
  };
}

describe("deployment environment contract", () => {
  it("keeps an omitted environment compatible with local and self-hosted OSS", () => {
    expect(inspectDeploymentEnvironment({})).toEqual({
      ok: true,
      environment: "local/self-hosted",
      businessTier: "self-hosted",
      issues: [],
    });
  });

  it("fails closed when a managed runtime omits its explicit environment", () => {
    const check = inspectDeploymentEnvironment({
      VERCEL: "1",
      VERCEL_ENV: "preview",
    });
    expect(check.ok).toBe(false);
    expect(check.issues).toContain(
      "OPENVPM_ENVIRONMENT is required for managed or hosted-billing runtimes",
    );
  });

  it("rejects unknown or case-drifted environment names", () => {
    expect(
      inspectDeploymentEnvironment({ OPENVPM_ENVIRONMENT: "Production" }).issues,
    ).toEqual(["OPENVPM_ENVIRONMENT is invalid"]);
  });

  it("requires Production to use the cloud tier without demo auth escape hatches", () => {
    const check = inspectDeploymentEnvironment(
      managed("production", {
        HOSTED_BILLING_ENABLED: "false",
        NEXT_PUBLIC_DEMO_MODE: "true",
        OPENVPM_EXPOSE_AUTH_LINKS: "true",
      }),
    );
    expect(check.issues).toEqual([
      "Production requires the cloud business tier",
      "Production cannot enable demo mode",
      "Production cannot expose authentication links",
    ]);
  });

  it("accepts explicit managed environment/business-tier pairs", () => {
    for (const environment of [
      "development",
      "staging",
      "demo",
      "production",
    ] as const) {
      expect(inspectDeploymentEnvironment(managed(environment)).ok).toBe(true);
    }
  });

  it("keeps provider mutation, rollout scope, fees, and live Stripe off outside Production", () => {
    const check = inspectDeploymentEnvironment(
      managed("staging", {
        MESSAGING_PROVISIONING_ENABLED: "true",
        MESSAGING_SENDING_PRACTICE_IDS: "00000000-0000-4000-8000-000000000001",
        FILE_REPLICA_ALL_PRACTICES: "true",
        FILE_REPLICA_REQUIRED: "on",
        STRIPE_CONNECT_APPLICATION_FEE_BPS: "250",
        STRIPE_TAX_ENABLED: "true",
        STRIPE_SECRET_KEY: "sk_live_redacted",
      }),
    );
    expect(check.issues).toEqual([
      "FILE_REPLICA_ALL_PRACTICES must remain disabled outside Production",
      "FILE_REPLICA_REQUIRED must remain disabled outside Production",
      "MESSAGING_PROVISIONING_ENABLED must remain disabled outside Production",
      "STRIPE_TAX_ENABLED must remain disabled outside Production",
      "MESSAGING_SENDING_PRACTICE_IDS must remain empty outside Production",
      "STRIPE_CONNECT_APPLICATION_FEE_BPS must be zero outside Production",
      "Nonproduction Stripe credentials must use test mode",
    ]);
    expect(JSON.stringify(check)).not.toContain("sk_live_redacted");
  });

  it("accepts an explicitly zero nonproduction application fee and test credential", () => {
    expect(
      assertDeploymentEnvironment(
        managed("development", {
          STRIPE_CONNECT_APPLICATION_FEE_BPS: "0",
          STRIPE_SECRET_KEY: "rk_test_redacted",
        }),
      ).ok,
    ).toBe(true);
  });
});
