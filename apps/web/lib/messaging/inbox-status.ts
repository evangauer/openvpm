export type InboxSmsRegistrationStatus =
  | "not_started"
  | "pending"
  | "active"
  | "action_required"
  | "failed"
  | "suspended";

export type InboxSmsLocation = {
  messaging: {
    provider?: string | null;
    senderE164: string | null;
    messagingProfileId: string | null;
    registrationStatus: InboxSmsRegistrationStatus;
    enabled: boolean;
    /** Fresh provider readback required before hosted staff compose is shown. */
    providerProfileReady?: boolean;
    /** Hosted deployment policy; omitted/false for self-host compatibility. */
    providerProfileReadyRequired?: boolean;
    /** Server-computed hosted rollout policy. Omitted for self-host/back-compat. */
    launchEligible?: boolean;
  } | null;
};

export type InboxSmsStatusKind =
  | "ready"
  | "not_configured"
  | "pending"
  | "action_required"
  | "disabled";

export type InboxSmsStatusSummary = {
  kind: InboxSmsStatusKind;
  smsComposeEnabled: boolean;
  showBanner: boolean;
  title: string;
  description: string;
  badge: {
    label: string;
    variant: "success" | "warning" | "destructive" | "secondary";
  };
  actionLabel: string | null;
};

export function summarizeInboxSmsStatus(
  locations: InboxSmsLocation[],
): InboxSmsStatusSummary {
  const configured = locations
    .map((location) => location.messaging)
    .filter(
      (messaging): messaging is NonNullable<InboxSmsLocation["messaging"]> =>
        Boolean(messaging),
    );
  const hasSender = (messaging: NonNullable<InboxSmsLocation["messaging"]>) =>
    Boolean(
      messaging.senderE164?.trim() || messaging.messagingProfileId?.trim(),
    );

  const ready = configured.some(
    (messaging) =>
      messaging.enabled &&
      messaging.launchEligible !== false &&
      (!messaging.providerProfileReadyRequired ||
        messaging.providerProfileReady === true) &&
      messaging.registrationStatus === "active" &&
      hasSender(messaging),
  );

  if (ready) {
    return {
      kind: "ready",
      smsComposeEnabled: true,
      showBanner: false,
      title: "Texting is ready",
      description: "SMS is available from your active clinic number.",
      badge: { label: "SMS ready", variant: "success" },
      actionLabel: null,
    };
  }

  const launchBlocked = configured.some(
    (messaging) => messaging.launchEligible === false,
  );
  if (launchBlocked) {
    return {
      kind: "disabled",
      smsComposeEnabled: false,
      showBanner: true,
      title: "Texting pilot is not active for this clinic",
      description:
        "OpenVPM has kept outbound SMS off. Contact support when this clinic is ready for the controlled texting pilot.",
      badge: { label: "Pilot off", variant: "warning" },
      actionLabel: null,
    };
  }

  if (configured.length === 0) {
    return {
      kind: "not_configured",
      smsComposeEnabled: false,
      showBanner: true,
      title: "Text your clients from the shared inbox",
      description:
        "Set up a clinic texting number before staff send SMS conversations from the inbox.",
      badge: { label: "Not set up", variant: "secondary" },
      actionLabel: "Set up texting",
    };
  }

  const needsAction = configured.some(
    (messaging) =>
      !hasSender(messaging) ||
      (messaging.providerProfileReadyRequired === true &&
        messaging.providerProfileReady !== true) ||
      messaging.registrationStatus === "action_required" ||
      messaging.registrationStatus === "failed" ||
      messaging.registrationStatus === "suspended",
  );

  if (needsAction) {
    return {
      kind: "action_required",
      smsComposeEnabled: false,
      showBanner: true,
      title: "Texting setup needs attention",
      description:
        "Review your messaging setup before SMS can be used from the shared inbox.",
      badge: { label: "Action needed", variant: "destructive" },
      actionLabel: "Review setup",
    };
  }

  const pending = configured.some(
    (messaging) =>
      messaging.registrationStatus === "pending" ||
      messaging.registrationStatus === "not_started",
  );

  if (pending) {
    return {
      kind: "pending",
      smsComposeEnabled: false,
      showBanner: true,
      title: "Texting is registering with carriers",
      description:
        "Your texting number is set up, but SMS cannot send until carrier registration is active. This usually takes 1-2 weeks.",
      badge: { label: "Pending", variant: "warning" },
      actionLabel: "Review setup",
    };
  }

  return {
    kind: "disabled",
    smsComposeEnabled: false,
    showBanner: true,
    title: "Texting is set up but sending is off",
    description:
      "Turn sending on in Messaging settings before staff can use SMS from the inbox.",
    badge: { label: "Disabled", variant: "warning" },
    actionLabel: "Turn on texting",
  };
}
