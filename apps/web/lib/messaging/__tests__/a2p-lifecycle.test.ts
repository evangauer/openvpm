import { describe, expect, it } from "vitest";
import {
  mergeRegistrationStatus,
  observedRegistrationStatus,
} from "../a2p-lifecycle";

describe("A2P lifecycle", () => {
  it("opens the registration gate only after brand, campaign, and all numbers are ready", () => {
    expect(
      observedRegistrationStatus({
        brandIdentityStatus: "VERIFIED",
        campaignStatus: "MNO_PROVISIONED",
        assignmentStatuses: ["ASSIGNED", "ASSIGNED"],
      })
    ).toBe("active");
    expect(
      observedRegistrationStatus({
        brandIdentityStatus: "VERIFIED",
        campaignStatus: "MNO_PROVISIONED",
        assignmentStatuses: [],
      })
    ).toBe("pending");
  });

  it("maps explicit provider failures and suspensions closed", () => {
    expect(
      observedRegistrationStatus({ brandIdentityStatus: "UNVERIFIED" })
    ).toBe("action_required");
    expect(observedRegistrationStatus({ campaignStatus: "MNO_REJECTED" })).toBe(
      "action_required"
    );
    expect(
      observedRegistrationStatus({ campaignStatus: "TCR_SUSPENDED" })
    ).toBe("suspended");
    expect(observedRegistrationStatus({ campaignStatus: "TCR_EXPIRED" })).toBe(
      "failed"
    );
  });

  it("does not let stale pending observations reopen closed or active states", () => {
    expect(mergeRegistrationStatus("active", "pending")).toBe("active");
    expect(mergeRegistrationStatus("suspended", "pending")).toBe("suspended");
    expect(mergeRegistrationStatus("action_required", "pending")).toBe(
      "action_required"
    );
    expect(mergeRegistrationStatus("pending", "active")).toBe("active");
    expect(mergeRegistrationStatus("active", "suspended")).toBe("suspended");
  });
});
