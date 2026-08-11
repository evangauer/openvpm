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
  campaignStatuses?: Array<string | null | undefined>;
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
  observation: TelnyxRegistrationObservation,
): RegistrationLifecycleStatus {
  const brandIdentity = observation.brandIdentityStatus?.toUpperCase();
  const brandStatus = observation.brandStatus?.toUpperCase();
  const campaignStatuses = [
    observation.campaignStatus,
    ...(observation.campaignStatuses ?? []),
  ]
    .map((status) => status?.toUpperCase())
    .filter((status): status is string => Boolean(status));
  const campaignSubmission =
    observation.campaignSubmissionStatus?.toUpperCase();
  const assignments = (observation.assignmentStatuses ?? []).map((status) =>
    status?.toUpperCase(),
  );

  if (
    campaignStatuses.some(
      (status) => status === "TCR_SUSPENDED" || status === "SUSPENDED",
    ) ||
    assignments.includes("FAILED_UNASSIGNMENT")
  ) {
    return "suspended";
  }
  if (
    campaignStatuses.some(
      (status) => status === "TCR_EXPIRED" || status === "EXPIRED",
    )
  ) {
    return "failed";
  }
  if (
    brandIdentity === "UNVERIFIED" ||
    brandStatus === "REGISTRATION_FAILED" ||
    campaignStatuses.some((status) => FAILURE_CAMPAIGN_STATUSES.has(status)) ||
    campaignSubmission === "FAILED" ||
    assignments.includes("FAILED_ASSIGNMENT")
  ) {
    return "action_required";
  }

  const brandReady =
    brandIdentity === "VERIFIED" || brandIdentity === "VETTED_VERIFIED";
  const campaignReady =
    campaignStatuses.includes("MNO_PROVISIONED") ||
    campaignStatuses.includes("ACTIVE");
  const assignmentsReady =
    assignments.length > 0 &&
    assignments.every((status) => status === "ASSIGNED");

  if (brandReady && campaignReady && assignmentsReady) return "active";
  return "pending";
}

export function telnyxCampaignIsActive(input: {
  status?: string | null;
  campaignStatus?: string | null;
  submissionStatus?: string | null;
}): boolean {
  return (
    observedRegistrationStatus({
      brandIdentityStatus: "VERIFIED",
      campaignStatuses: [
        input.status,
        input.campaignStatus,
        input.submissionStatus,
      ],
      assignmentStatuses: ["ASSIGNED"],
    }) === "active"
  );
}

/**
 * Prevent late/stale pending observations from reopening a terminal or active
 * state. Positive activation and explicit carrier failures still take effect.
 */
export function mergeRegistrationStatus(
  current: RegistrationLifecycleStatus,
  observed: RegistrationLifecycleStatus,
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
