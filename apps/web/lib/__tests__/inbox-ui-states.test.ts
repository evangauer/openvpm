import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMMUNICATION_CONTENT_MAX_LENGTH,
  COMMUNICATION_SUBJECT_MAX_LENGTH,
  SMS_COMMUNICATION_CONTENT_MAX_LENGTH,
  communicationContentMaxLength,
  isCommunicationContentValid,
  isCommunicationSubjectValid,
} from "../communications/policy";
import {
  CLIENT_SEARCH_MAX_LENGTH,
  isClientSearchInputValid,
} from "../clients/policy";

describe("inbox UI states", () => {
  const source = readFileSync("app/(dashboard)/inbox/page.tsx", "utf8");
  const routerSource = readFileSync("server/routers/communications.ts", "utf8");
  const outboundEmailSecuritySource = readFileSync(
    "lib/outbound-email-security.ts",
    "utf8",
  );

  it("keeps viewer access read-only for inbox writes", () => {
    expect(source).toContain('import { useSession } from "next-auth/react"');
    expect(source).toContain("const { data: session } = useSession()");
    expect(source).toContain(
      "function canMutateInboxRole(role?: string | null): boolean",
    );
    expect(source).toContain('role === "admin"');
    expect(source).toContain('role === "veterinarian"');
    expect(source).toContain('role === "technician"');
    expect(source).toContain('role === "front_desk"');
    expect(source).toContain(
      "const canMutateInbox = canMutateInboxRole(session?.user?.role)",
    );
    expect(source).not.toContain('session?.user?.role !== "viewer"');
    expect(source).toContain("if (unreadCount > 0 && canMutateInbox)");
    expect(source).toContain(
      "if (isUnreadInboxMessage(item) && canMutateInbox)",
    );
    expect(source).toContain(
      "canMutateInbox &&\n    Boolean(selectedClientId)",
    );
    expect(source).toContain("if (!canMutateInbox) return;");
    expect(source).toContain(
      "if (!canMutateInbox || !selectedClientId) return;",
    );
    expect(source).toContain(
      "if (!canMutateInbox || !selectedUnmatched) return;",
    );
    expect(source).toContain("{canMutateInbox ? (");
    expect(source).toContain("{newMessageMode && canMutateInbox ? (");
    expect(source).toContain("No client communications to review yet.");
    expect(source).toContain("canMutateInbox\n                    ? {");
    expect(source).toContain("Viewer access cannot link inbox messages.");

    expect(routerSource).toContain("const inboxStaffProcedure =");
    expect(routerSource).toContain(
      'requireRole("admin", "veterinarian", "technician", "front_desk")',
    );
    expect(routerSource).toContain("markClientRead: inboxStaffProcedure");
    expect(routerSource).toContain("assignClient: inboxStaffProcedure");
    expect(routerSource).toContain(
      "linkCommunicationToClient: inboxStaffProcedure",
    );
    expect(routerSource).toContain("create: inboxStaffProcedure");
    expect(routerSource).toContain("updateStatus: inboxStaffProcedure");
  });

  it("renders inbox timestamps from the practice timezone contract", () => {
    expect(source).toContain(
      'import { formatDateInputForTimeZone } from "@/lib/date-input"',
    );
    expect(source).toContain(
      "function relativeTime(\n  date: Date | string | null,\n  timeZone?: string | null",
    );
    expect(source).toContain(
      "const {\n    data: inboxSettings,\n    isLoading: inboxSettingsLoading,\n    error: inboxSettingsError,\n  } = trpc.communications.settings.useQuery",
    );
    expect(source).toContain("const verifiedInboxSettings =");
    expect(source).toContain(
      "const inboxTimeZone = verifiedInboxSettings\n    ? verifiedInboxSettings.timezone\n    : null",
    );
    expect(source).toContain(
      "const inboxListLoading = inboxSettingsLoading || isLoading",
    );
    expect(source).toContain(
      "const timelineDisplayLoading = inboxSettingsLoading || timelineLoading",
    );
    expect(source).toContain("formatDateInputForTimeZone(now, timeZone)");
    expect(source).toContain("formatDateInputForTimeZone(d, timeZone)");
    expect(source).toContain(
      "relativeTime(\n                                group.latest.createdAt,\n                                inboxTimeZone",
    );
    expect(source).toContain(
      "relativeTime(\n                          selectedUnmatched.createdAt,\n                          inboxTimeZone",
    );
    expect(source).toContain("relativeTime(msg.createdAt, inboxTimeZone)");
    expect(source).not.toContain("inboxSettings?.timezone");
    expect(source).not.toContain("return d.toLocaleDateString();");
  });

  it("surfaces inbox list, timeline, and client-search query errors", () => {
    expect(CLIENT_SEARCH_MAX_LENGTH).toBe(100);
    expect(isClientSearchInputValid(" Ada ")).toBe(true);
    expect(isClientSearchInputValid("   ")).toBe(false);
    expect(isClientSearchInputValid("A".repeat(101))).toBe(false);

    expect(source).toContain(
      'import { EmptyState } from "@/components/common/empty-state"',
    );
    expect(source).toContain('from "@/lib/clients/policy"');
    expect(source).toContain(
      "const canSearchNewClients = isClientSearchInputValid(newClientSearch)",
    );
    expect(source).toContain(
      "const canSearchLinkClients = isClientSearchInputValid(linkClientSearch)",
    );
    expect(source).toContain("maxLength={CLIENT_SEARCH_MAX_LENGTH}");
    expect(source).toContain("error: inboxError");
    expect(source).toContain("error: timelineError");
    expect(source).toContain("error: searchError");
    expect(source).toContain("error: linkClientError");
    expect(source).toContain("const inboxSettingsMissing =");
    expect(source).toContain("const inboxMessagesMissing =");
    expect(source).toContain("!commsData?.items");
    expect(source).toContain("const inboxListMissing =");
    expect(source).toContain("const timelineMissing =");
    expect(source).toContain("const timelineDisplayMissing =");
    expect(source).toContain("const searchMissing =");
    expect(source).toContain("const linkClientMissing =");
    expect(source).toContain(
      "if (inboxSettingsError || inboxSettingsMissing) {\n      setSelectedUnmatched(null);",
    );
    expect(source).toContain("{inboxListError || inboxListMissing ? (");
    expect(source).toContain("{searchError || searchMissing ? (");
    expect(source).toContain("{linkClientError || linkClientMissing ? (");
    expect(source).toContain(
      "{timelineDisplayError || timelineDisplayMissing ? (",
    );
    expect(source).toContain("Unable to load inbox messages. Please retry.");
    expect(source).toContain(
      "Unable to load conversation messages. Please retry.",
    );
    expect(source).toContain("Unable to search clients. Please retry.");
    expect(source.indexOf("inboxListError || inboxListMissing")).toBeLessThan(
      source.indexOf('title="No messages yet"'),
    );
    expect(source.indexOf("searchError || searchMissing")).toBeLessThan(
      source.indexOf('title="No clients found"'),
    );
    expect(
      source.indexOf("timelineDisplayError || timelineDisplayMissing"),
    ).toBeLessThan(source.indexOf('title="No messages with this client yet"'));
  });

  it("surfaces SMS setup status failures before hiding the inbox setup prompt", () => {
    expect(source).toContain("error: messagingStatusError");
    expect(source).toContain("refetch: refetchMessagingStatus");
    expect(source).toContain("const smsStatusUnavailable =");
    expect(source).toContain(
      "Boolean(messagingStatusError) || !messagingStatus",
    );
    expect(source).toContain("const showSmsStatusError = Boolean(");
    expect(source).toContain("Unable to check texting setup");
    expect(source).toContain("SMS status unavailable");
    expect(source).toContain("onClick={() => void refetchMessagingStatus()}");
    expect(source).toContain('aria-label="Dismiss SMS status warning"');
    expect(source.indexOf("{showSmsStatusError ? (")).toBeLessThan(
      source.indexOf(") : showSmsBanner && smsSummary ? ("),
    );
    expect(source).toContain(
      "Unable to check texting setup. Retry from the inbox banner",
    );
  });

  it("uses server-derived conversation summaries for the inbox rail", () => {
    expect(routerSource).toContain("listConversations: protectedProcedure");
    expect(routerSource).toContain("row_number() over");
    expect(routerSource).toContain(
      "partition by coalesce(c.client_id::text, c.id::text)",
    );
    expect(routerSource).toContain("count(*) filter (");
    expect(routerSource).toContain("unreadCount: dbNumber(unreadCount)");

    expect(source).toContain("trpc.communications.listConversations.useQuery");
    expect(source).toContain(
      "utils.communications.listConversations.invalidate()",
    );
    expect(source).toContain(
      "item.unreadCount ?? (isUnreadInboxMessage(item) ? 1 : 0)",
    );
    expect(source).not.toContain("const map = new Map");
  });

  it("keeps assignment controls anchored to the server conversation summary", () => {
    expect(source).toContain(
      "const assignmentSource = selectedGroup?.latest ?? timeline?.[0]",
    );
    expect(source).not.toContain(
      "const assignmentSource = timeline?.[0] ?? selectedGroup?.latest",
    );
    expect(source).toContain("expectedAssignedTo: assignedTo");
    expect(routerSource).toContain("isNotNull(communications.assignedTo)");
    expect(routerSource).toContain(
      "orderBy(desc(communications.createdAt), desc(communications.id))",
    );
  });

  it("uses shared empty states for inbox empty panels", () => {
    expect(source).toContain('title="No messages yet"');
    expect(source).toContain('title="No clients found"');
    expect(source).toContain('title="Type to search for a client"');
    expect(source).toContain('title="No messages with this client yet"');
    expect(source).toContain('label: "New message"');
  });

  it("bounds compose inputs with the shared communications policy", () => {
    expect(COMMUNICATION_SUBJECT_MAX_LENGTH).toBe(255);
    expect(COMMUNICATION_CONTENT_MAX_LENGTH).toBe(5000);
    expect(SMS_COMMUNICATION_CONTENT_MAX_LENGTH).toBe(1600);
    expect(communicationContentMaxLength("email")).toBe(
      COMMUNICATION_CONTENT_MAX_LENGTH,
    );
    expect(communicationContentMaxLength("portal")).toBe(
      COMMUNICATION_CONTENT_MAX_LENGTH,
    );
    expect(communicationContentMaxLength("sms")).toBe(
      SMS_COMMUNICATION_CONTENT_MAX_LENGTH,
    );
    expect(isCommunicationSubjectValid("A".repeat(255))).toBe(true);
    expect(isCommunicationSubjectValid("A".repeat(256))).toBe(false);
    expect(isCommunicationContentValid("Hello", "email")).toBe(true);
    expect(isCommunicationContentValid("Hello", "portal")).toBe(true);
    expect(isCommunicationContentValid(" ".repeat(8), "email")).toBe(false);
    expect(isCommunicationContentValid("A".repeat(1601), "sms")).toBe(false);

    expect(routerSource).toContain('from "@/lib/communications/policy"');
    expect(routerSource).toContain(
      "subject: z.string().trim().max(COMMUNICATION_SUBJECT_MAX_LENGTH).optional()",
    );
    expect(routerSource).toContain("COMMUNICATION_CONTENT_MAX_LENGTH");
    expect(routerSource).toContain("SMS_COMMUNICATION_CONTENT_MAX_LENGTH");

    expect(source).toContain('from "@/lib/communications/policy"');
    expect(source).toContain(
      'import { communicationStatusLabel } from "@/lib/communications/status"',
    );
    expect(source).toContain(
      "const composeContentMaxLength = communicationContentMaxLength(",
    );
    expect(source).toContain('<option value="portal">Portal</option>');
    expect(source).not.toContain('<option value="email">Email</option>');
    expect(source).toContain('useState<Channel>("portal")');
    expect(source).toContain('composeChannel === "portal"');
    expect(source).toContain(
      "isCommunicationContentValid(composeContent, composeDeliveryChannel)",
    );
    expect(source).toContain("isCommunicationSubjectValid(composeSubject)");
    expect(source).toContain("maxLength={COMMUNICATION_SUBJECT_MAX_LENGTH}");
    expect(source).toContain("maxLength={composeContentMaxLength}");
    expect(source).toContain("disabled={!canSendCompose}");
    expect(source).toContain(
      'subject:\n        composeChannel === "email" ? trimmedSubject || undefined : undefined',
    );
    expect(source).toContain("content: trimmedContent");
    expect(source).toContain(
      "const statusLabel = communicationStatusLabel(msg)",
    );
    expect(source).toContain("{statusLabel ? (");
    expect(source).not.toContain("{msg.status && (");
  });

  it("keeps one client request ID across retries of the same external message", () => {
    expect(source).toContain("const externalComposeRequest = useRef<");
    expect(source).toContain("requestId: crypto.randomUUID()");
    expect(source).toContain(
      "if (externalComposeRequest.current?.fingerprint !== fingerprint)",
    );
    expect(source).toContain(
      "requestId = externalComposeRequest.current.requestId",
    );
    expect(source).toContain("...(requestId ? { requestId } : {})");
    expect(source).toContain("externalComposeRequest.current = null");
    expect(routerSource).toContain(
      "Message request ID was already used for different message data.",
    );
    expect(routerSource).toContain(
      "`${input.channel}:inbox:${ctx.practiceId}:${input.requestId!}`",
    );
  });

  it("does not expose free-form outbound email in the inbox composer", () => {
    expect(source).not.toContain('<option value="email">Email</option>');
    expect(source).not.toContain("Outbound email is logged here");
    expect(routerSource).toContain(
      'await assertOutboundEmailAllowed({',
    );
    expect(outboundEmailSecuritySource).toContain(
      'if (context.operation === "inbox")',
    );
  });

  it("collapses the two-pane layout on phones: list or thread, with a back button", () => {
    // Below md, an open conversation replaces the list instead of squeezing
    // beside it; the back button restores the list.
    expect(source).toContain(
      "selectedClientId || selectedUnmatched || newMessageMode",
    );
    expect(source).toContain('"hidden"');
    expect(source).toContain("md:w-80 md:border-r");
    expect(source).toContain("Back to conversations");
    expect(source).toContain("setSelectedUnmatched(null);");
  });
});
