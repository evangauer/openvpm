import { createHash, randomBytes } from "node:crypto";

export const TREATMENT_PLAN_CLIENT_DECISIONS_ENABLED_ENV =
  "TREATMENT_PLAN_CLIENT_DECISIONS_ENABLED";
export const TREATMENT_PLAN_PRESENTATION_TOKEN_TTL_MS = 60 * 60 * 1000;
export const TREATMENT_PLAN_PRESENTATION_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function treatmentPlanClientDecisionsEnabled(): boolean {
  return (
    process.env[
      TREATMENT_PLAN_CLIENT_DECISIONS_ENABLED_ENV
    ]?.trim().toLowerCase() === "true"
  );
}

export function generateTreatmentPlanPresentationToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashTreatmentPlanPresentationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isTreatmentPlanPresentationTokenShape(token: string): boolean {
  return TREATMENT_PLAN_PRESENTATION_TOKEN_PATTERN.test(token);
}
