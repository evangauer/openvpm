export type RegistrationLifecycleStatus =
  | "not_started"
  | "pending"
  | "active"
  | "action_required"
  | "failed"
  | "suspended";

export type TelnyxRegistrationObservation = {
  brandIdentityStatus?: string | null;
  brandStatus?: string | null;
  campaignStatus?: string | null;
  campaignSubmissionStatus?: string | null;
  assignmentStatuses?: Array<string | null | undefined>;
  detail?: string | null;
};

const FAILURE_CAMPAIGN_STATUSES = new Set([
  "TCR_FAILED",
  "TELNYX_FAILED",
  "MNO_REJECTED",
  "MNO_PROVISIONING_FAILED",
]);

/** Pure mapping from Telnyx's multi-stage state into OpenVPM's send gate. */
export function observedRegistrationStatus(
  observation: TelnyxRegistrationObservation
): RegistrationLifecycleStatus {
  const brandIdentity = observation.brandIdentityStatus?.toUpperCase();
  const brandStatus = observation.brandStatus?.toUpperCase();
  const campaignStatus = observation.campaignStatus?.toUpperCase();
  const campaignSubmission =
    observation.campaignSubmissionStatus?.toUpperCase();
  const assignments = (observation.assignmentStatuses ?? []).map((status) =>
    status?.toUpperCase()
  );

  if (
    campaignStatus === "TCR_SUSPENDED" ||
    campaignStatus === "SUSPENDED" ||
    assignments.includes("FAILED_UNASSIGNMENT")
  ) {
    return "suspended";
  }
  if (campaignStatus === "TCR_EXPIRED" || campaignStatus === "EXPIRED") {
    return "failed";
  }
  if (
    brandIdentity === "UNVERIFIED" ||
    brandStatus === "REGISTRATION_FAILED" ||
    (campaignStatus && FAILURE_CAMPAIGN_STATUSES.has(campaignStatus)) ||
    campaignSubmission === "FAILED" ||
    assignments.includes("FAILED_ASSIGNMENT")
  ) {
    return "action_required";
  }

  const brandReady =
    brandIdentity === "VERIFIED" || brandIdentity === "VETTED_VERIFIED";
  const campaignReady =
    campaignStatus === "MNO_PROVISIONED" || campaignStatus === "ACTIVE";
  const assignmentsReady =
    assignments.length > 0 &&
    assignments.every((status) => status === "ASSIGNED");

  if (brandReady && campaignReady && assignmentsReady) return "active";
  return "pending";
}

/**
 * Prevent late/stale pending observations from reopening a terminal or active
 * state. Positive activation and explicit carrier failures still take effect.
 */
export function mergeRegistrationStatus(
  current: RegistrationLifecycleStatus,
  observed: RegistrationLifecycleStatus
): RegistrationLifecycleStatus {
  if (observed === "active") return "active";
  if (observed === "suspended") return "suspended";
  if (observed === "action_required" || observed === "failed") {
    return current === "suspended" ? current : observed;
  }
  if (observed === "pending") {
    return current === "not_started" || current === "pending"
      ? "pending"
      : current;
  }
  return current;
}
