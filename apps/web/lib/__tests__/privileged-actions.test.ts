import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PRIVILEGED_ACTION_LABELS,
  PRIVILEGED_ACTIONS,
} from "../privileged-actions";

const ROUTER_FILE: Record<string, string> = {
  admin: "admin.ts",
  apiKeys: "api-keys.ts",
  billing: "billing.ts",
  data: "data.ts",
  passkeys: "passkeys.ts",
  settings: "settings.ts",
  subscription: "subscription.ts",
  webhooks: "webhooks.ts",
};

const REQUIRED_BOUNDARIES = [
  "billing.refundPayment",
  "billing.applyInvoiceAdjustment",
  "billing.voidInvoice",
  "subscription.scheduleAnnualAtRenewal",
  "settings.createUser",
  "settings.inviteStaff",
  "settings.updateUser",
  "settings.deactivateUser",
  "settings.restoreUser",
  "data.exportFullBackup",
  "data.exportClients",
  "data.exportPatients",
  "data.exportAppointments",
  "data.exportInvoices",
  "data.restoreBackup",
  "apiKeys.create",
  "apiKeys.revoke",
  "webhooks.create",
  "webhooks.toggle",
  "webhooks.delete",
  "passkeys.beginRegistration",
  "passkeys.remove",
  "admin.setMessagingProfileEnabled",
  "admin.submitMessagingBrand",
  "admin.submitMessagingCampaign",
  "admin.assignMessagingNumbers",
  "admin.attachMessagingProviderIds",
  "admin.clearStaleMessagingSubmissionLock",
] as const;

describe("hosted privileged action inventory", () => {
  it("keeps every money, access, export, credential, API-key, and operator boundary listed", () => {
    expect(new Set(PRIVILEGED_ACTIONS).size).toBe(PRIVILEGED_ACTIONS.length);
    expect(PRIVILEGED_ACTIONS).toEqual(
      expect.arrayContaining([...REQUIRED_BOUNDARIES]),
    );
    expect(Object.keys(PRIVILEGED_ACTION_LABELS).sort()).toEqual(
      [...PRIVILEGED_ACTIONS].sort(),
    );
  });

  it("maps every declared action to a procedure in its real router", () => {
    const sources = new Map<string, string>();
    for (const action of PRIVILEGED_ACTIONS) {
      const [router, procedure] = action.split(".");
      if (!router || !procedure) throw new Error(`Invalid action: ${action}`);
      const file = ROUTER_FILE[router];
      expect(file, `router file for ${action}`).toBeTruthy();
      const source =
        sources.get(file!) ??
        readFileSync(
          new URL(`../../server/routers/${file}`, import.meta.url),
          "utf8",
        );
      sources.set(file!, source);
      expect(source, `procedure for ${action}`).toMatch(
        new RegExp(`\\b${procedure}:\\s`),
      );
    }
  });
});
