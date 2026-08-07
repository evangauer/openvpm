import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("admin UI", () => {
  const source = readFileSync("app/(dashboard)/admin/page.tsx", "utf8");

  it("separates admin forbidden, load error, loading, and missing-data states", () => {
    expect(source).toContain(
      'import { EmptyState } from "@/components/common/empty-state"'
    );
    expect(source).toContain(
      'import { PageLoading } from "@/components/common/loading"'
    );
    expect(source).toContain("error, refetch");
    expect(source).toContain('error?.data?.code === "FORBIDDEN"');
    expect(source).toContain("Access Denied");
    expect(source).toContain('title="Unable to load platform admin"');
    expect(source).toContain("action={{ label: \"Retry\", onClick: () => refetch() }}");
    expect(source).toContain("if (isLoading) return <PageLoading");
    expect(source).toContain("if (!data)");
    expect(source).not.toContain("if (isLoading || !data)");
  });

  it("shows the trial funnel tile with counts, rates, and the plain hint", () => {
    expect(source).toContain(
      "trpc.admin.activationFunnel.useQuery({ days: 30 }, { retry: false })"
    );
    expect(source).toContain("Trial funnel (30 days)");
    expect(source).toContain("{funnel.totals.signups}");
    expect(source).toContain("{funnel.totals.setupStarted}");
    expect(source).toContain("{funnel.totals.setupCompleted}");
    expect(source).toContain("{funnel.totals.activated}");
    expect(source).toContain("{funnel.totals.billingStarted}");
    expect(source).toContain("{funnel.totals.subscribed}");
    expect(source).toContain("formatPct(funnel.totals.activationRate)");
    expect(source).toContain("formatPct(funnel.totals.billingStartRate)");
    expect(source).toContain("formatPct(funnel.totals.setupStartRate)");
    expect(source).toContain("formatPct(funnel.totals.setupCompletionRate)");
    expect(source).toContain("formatPct(funnel.totals.conversionRate)");
    expect(source).toContain(
      "Activated = added a"
    );
    expect(source).toContain("Billing started = Stripe");
    expect(source).toContain("Could not load the funnel.");
  });

  it("shows production journey cohorts and abandonment counts", () => {
    expect(source).toContain(
      "trpc.admin.journeyFunnel.useQuery({ days: 30 }, { retry: false })"
    );
    expect(source).toContain("Production journey cohorts (30 days)");
    expect(source).toContain("journey.totals.leftBeforeTrying");
    expect(source).toContain("journey.totals.demoAbandoned");
    expect(source).toContain("journey.totals.registrationAbandoned");
    expect(source).toContain("journey.totals.activationAbandoned");
    expect(source).toContain("journey.totals.cardAbandoned");
    expect(source).toContain("journey.totals.clientErrors");
    expect(source).toContain("journey.weeks.map");
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
    expect(source).toContain('href={`mailto:${p.adminEmail}`}');
    expect(source).toContain('!p.adminEmailVerifiedAt ? " · unverified" : ""');
  });

  it("renders practice dates in each practice timezone", () => {
    expect(source).toContain(
      "function formatDate(d: Date | string | null, timeZone?: string | null)"
    );
    expect(source).toContain("if (Number.isNaN(date.getTime())) return");
    expect(source).toContain('timeZone: timeZone?.trim() || "UTC"');
    expect(source).toContain("formatDate(p.trialEndsAt, p.timezone)");
    expect(source).toContain("formatDate(p.createdAt, p.timezone)");
    expect(source).not.toContain("formatDate(p.trialEndsAt)}</td>");
    expect(source).not.toContain("formatDate(p.createdAt)}</td>");
  });
});
