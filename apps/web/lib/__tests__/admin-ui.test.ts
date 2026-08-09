import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("admin UI", () => {
  const source = readFileSync("app/(dashboard)/admin/page.tsx", "utf8");
  const compactSource = source.replace(/\s+/g, " ");
  const carrierHistory = source.slice(
    source.indexOf("{/* Messaging carrier history */}"),
    source.indexOf("{/* Trial funnel */}"),
  );

  it("separates admin forbidden, load error, loading, and missing-data states", () => {
    expect(source).toContain(
      'import { EmptyState } from "@/components/common/empty-state"',
    );
    expect(source).toContain(
      'import { PageLoading } from "@/components/common/loading"',
    );
    expect(source).toContain("error, refetch");
    expect(source).toContain('error?.data?.code === "FORBIDDEN"');
    expect(source).toContain("Access Denied");
    expect(source).toContain('title="Unable to load platform admin"');
    expect(source).toContain(
      'action={{ label: "Retry", onClick: () => refetch() }}',
    );
    expect(source).toContain("if (isLoading) return <PageLoading");
    expect(source).toContain("if (!data)");
    expect(source).not.toContain("if (isLoading || !data)");
  });

  it("shows the trial funnel tile with counts, rates, and the plain hint", () => {
    expect(source).toContain(
      "trpc.admin.activationFunnel.useQuery({ days: 30 }, { retry: false })",
    );
    expect(source).toContain("Trial funnel (30 days)");
    expect(source).toContain("{funnel.totals.signups}");
    expect(source).toContain("{funnel.totals.setupStarted}");
    expect(source).toContain("{funnel.totals.setupCompleted}");
    expect(source).toContain("{funnel.totals.activated}");
    expect(source).toContain("First visit done");
    expect(source).toContain("{funnel.totals.firstVisitCompleted}");
    expect(source).toContain("{funnel.totals.paymentMethodCollected}");
    expect(source).toContain("{funnel.totals.firstPositivePayment}");
    expect(source).toContain("{funnel.totals.currentlyActive}");
    expect(source).toContain("formatPct(funnel.totals.activationRate)");
    expect(source).toContain(
      "formatPct(funnel.totals.firstVisitCompletionRate)",
    );
    expect(source).toContain("formatPct(funnel.totals.paymentMethodRate)");
    expect(source).toContain("formatPct(funnel.totals.setupStartRate)");
    expect(source).toContain("formatPct(funnel.totals.setupCompletionRate)");
    expect(source).toContain("formatPct(funnel.totals.positivePaymentRate)");
    expect(compactSource).toContain("Activated = added a");
    expect(compactSource).toContain("completed clinical and billing closeout");
    expect(compactSource).toContain("rate is measured from");
    expect(compactSource).toContain("signed subscription Checkout");
    expect(compactSource).toContain("Legacy business-stage rows are excluded");
    expect(source).toContain("Could not load the funnel.");
  });

  it("shows a ranked activation recovery queue with verified contacts", () => {
    expect(source).toContain("trpc.admin.activationRecovery.useQuery");
    expect(source).toContain("Clinic activation recovery");
    expect(source).toContain("clinic.queueRank");
    expect(source).toMatch(
      /clinic\.verifiedAdminEmail\s*&&\s*clinic\.verifiedAdminEmailAt/,
    );
    expect(source).toContain("href={`mailto:${clinic.verifiedAdminEmail}`}");
    expect(source).toContain("No verified admin contact");
    expect(source).toContain("clinic.setupStage");
    expect(source).toContain("clinic.setupHelpRequestedAt");
    expect(source).toContain("clinic.realClientCount");
    expect(source).toContain("clinic.realAppointmentCount");
    expect(source).toContain("clinic.lastMeaningfulActivityAt");
    expect(source).toContain("clinic.stallAgeDays");
    expect(source).toContain("clinic.authoritativeStage");
    expect(source).toContain("clinic.nextAction");
    expect(source).toContain("clinic.nextActionPriority");
  });

  it("labels the overview KPI as active trials", () => {
    expect(source).toContain('label: "Active trials"');
    expect(source).toContain("data.totals.activeTrials");
    expect(source).not.toContain('label: "On trial"');
  });

  it("shows production journey cohorts and abandonment counts", () => {
    expect(source).toContain(
      "trpc.admin.journeyFunnel.useQuery({ days: 30 }, { retry: false })",
    );
    expect(source).toContain("Production journey cohorts (30 days)");
    expect(source).toContain("journey.totals.leftBeforeTrying");
    expect(source).toContain("journey.totals.demoAbandoned");
    expect(source).toContain("journey.totals.registrationAbandoned");
    expect(source).toContain("journey.totals.activationAbandoned");
    expect(source).toContain("journey.totals.paymentAbandoned");
    expect(source).toContain("journey.totals.clientErrors");
    expect(source).toContain(
      "journey.totals.historicalUnattributedRegistrations",
    );
    expect(source).toContain("journey.totals.repairableAttributionGaps");
    expect(source).toContain("journey.weeks.map");
    expect(compactSource).toContain("Stalls require seven full days");
    expect(compactSource).toContain("active trial with a collected");
  });

  it("shows trial source and setup stage for diagnosing individual drop-off", () => {
    expect(source).toContain("{p.acquisitionSource}");
    expect(source).toContain("{p.onboardingIntent}");
    expect(source).toContain("{p.setupStage}");
    expect(source).toContain("{p.setupHelpRequestedAt ? (");
    expect(source).toContain(">Source</th>");
    expect(source).toContain(">Intent</th>");
    expect(source).toContain(">Setup</th>");
    expect(source).toContain(">Metrics</th>");
    expect(source).toContain("setAnalyticsExcluded.mutate({");
    expect(source).toContain('{p.analyticsExcluded ? "Excluded" : "Exclude"}');
    expect(source).toContain("href={`mailto:${p.adminEmail}`}");
    expect(source).toContain('!p.adminEmailVerifiedAt ? " · unverified" : ""');
  });

  it("gives operators an explicit provider-profile inspection and switch", () => {
    expect(source).toContain("trpc.admin.inspectMessagingProfile.useMutation");
    expect(source).toContain(
      "trpc.admin.setMessagingProfileEnabled.useMutation",
    );
    expect(source).toContain("provider not verified");
    expect(source).toContain("Inspect profile");
    expect(source).toContain("Enable provider profile");
    expect(source).toContain("Disable provider profile");
    expect(source).toContain("Clinic sending will remain off");
    expect(source).toContain("US-only destination list");
    expect(source).toContain("$10 daily cap");
    expect(source).toContain('result.blockers.join("; ")');
    expect(source).toContain("sender.registrationDetail");
    expect(source).toContain("sender.senderLast4");
    expect(source).toContain("Number ••••${sender.senderLast4}");
    expect(source).not.toContain("sender.senderE164");
  });

  it("shows bounded read-only redacted carrier lifecycle history", () => {
    expect(source).toContain(
      "trpc.admin.messagingRegistrationHistory.useQuery",
    );
    expect(source).toContain("const MESSAGING_HISTORY_LIMIT = 50");
    expect(source).toContain("setMessagingHistorySelection({");
    expect(source).toMatch(/>\s*History\s*<\/button>/);
    expect(carrierHistory).toContain("messagingHistory.events.map");
    expect(carrierHistory).toContain("messagingHistory.truncated");
    expect(carrierHistory).toContain("redacted operational events");
    expect(carrierHistory).toContain("Operational evidence");
    expect(carrierHistory).toContain("event.actorLabel");
    expect(carrierHistory).not.toContain("useMutation");
    expect(carrierHistory).not.toContain("sender");
    expect(carrierHistory).not.toContain("legalName");
    expect(carrierHistory).not.toContain("taxId");
    expect(carrierHistory).not.toContain("contact");
    expect(carrierHistory).not.toContain("detail");
    expect(carrierHistory).not.toContain("lastError");
    expect(carrierHistory).not.toContain("actorIdentity");
    expect(carrierHistory).not.toContain("actorName");
  });

  it("shows a bounded read-only SMS operations queue with operator actions", () => {
    expect(source).toContain("trpc.admin.smsOperationsHealth.useQuery");
    expect(source).toContain("SMS operations health");
    expect(source).toContain("This monitor never enables sending");
    expect(source).toContain("smsOperations.counts.critical");
    expect(source).toContain("smsOperations.counts.attention");
    expect(source).toContain("smsOperations.counts.sendAttempts");
    expect(source).toContain("smsOperations.counts.deliveryEvents");
    expect(source).toContain("smsOperations.counts.staleWithoutFinal");
    expect(source).toContain("smsOperations.counts.providerAuditFailures");
    expect(source).toContain("item.practiceName");
    expect(source).toContain('item.locationName ?? "Practice-wide"');
    expect(source).toContain("formatAgeMinutes(item.ageMinutes)");
    expect(source).toContain("item.reason");
    expect(source).toContain("item.nextAction");
    expect(source).toContain("No SMS operational exceptions need attention.");
    expect(source).toContain("Results are bounded.");
    expect(source).not.toContain("item.senderE164");
    expect(source).not.toContain("item.providerMessageId");
    expect(source).not.toContain("item.recipient");
    expect(source).not.toContain("item.body");
  });

  it("renders practice dates in each practice timezone", () => {
    expect(source).toContain(
      "function formatDate(d: Date | string | null, timeZone?: string | null)",
    );
    expect(source).toContain("if (Number.isNaN(date.getTime())) return");
    expect(source).toContain('timeZone: timeZone?.trim() || "UTC"');
    expect(source).toContain("formatDate(p.trialEndsAt, p.timezone)");
    expect(source).toContain("formatDate(p.createdAt, p.timezone)");
    expect(source).not.toContain("formatDate(p.trialEndsAt)}</td>");
    expect(source).not.toContain("formatDate(p.createdAt)}</td>");
  });
});
