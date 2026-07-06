"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  Check,
  CheckCircle2,
  CreditCard,
  Database,
  FileUp,
  ImageIcon,
  Loader2,
  PawPrint,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/empty-state";
import { trialCalendarDaysLeft } from "@/lib/billing/trial-days";

const SETUP_STEPS = [
  {
    icon: Building2,
    title: "Confirm practice details",
    body: "Set name, country, currency, tax rate, timezone, and your default location.",
    href: "/settings?tab=practice",
    cta: "Practice settings",
  },
  {
    icon: Users,
    title: "Invite the team",
    body: "Add doctors, technicians, front desk, managers, and read-only viewers.",
    href: "/settings?tab=staff",
    cta: "Manage staff",
  },
  {
    icon: FileUp,
    title: "Bring in client and patient data",
    body: "Import CSVs from your current PIMS or keep exploring with sample data.",
    href: "/settings?tab=data",
    cta: "Import data",
  },
];

const TRUST_POINTS = [
  "One practice tenant is created before payment.",
  "Every record is scoped to your practice ID.",
  "Hosted production uses Postgres RLS as a second isolation guard.",
  "You can export data even if billing lapses.",
];

const ROLE_LABELS = {
  veterinarian: "Veterinarian",
  technician: "Technician",
  front_desk: "Front desk",
  viewer: "Viewer",
} as const;

function money(value: number | null | undefined) {
  return `$${Number(value ?? 0).toLocaleString("en-US")}`;
}

function OnboardingLoadError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="mx-auto max-w-2xl rounded-lg border border-destructive/30 bg-destructive/5 p-6">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
          <AlertTriangle className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="font-heading text-lg font-semibold">
            Onboarding details could not load
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{message}</p>
          <Button variant="outline" size="sm" onClick={onRetry} className="mt-4">
            Retry
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function OnboardingPage() {
  const router = useRouter();
  const { data: session, status: sessionStatus } = useSession();

  if (sessionStatus === "loading") {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (session?.user?.role !== "admin") {
    return (
      <div className="mx-auto max-w-3xl">
        <EmptyState
          icon={ShieldCheck}
          title="Onboarding is admin-only"
          description="Only admins can change setup, billing, team, and demo data."
          action={{
            label: "Back to Dashboard",
            onClick: () => router.push("/"),
          }}
        />
      </div>
    );
  }

  return <AdminOnboardingPage />;
}

function AdminOnboardingPage() {
  const router = useRouter();
  const utils = trpc.useUtils();
  const status = trpc.settings.onboardingStatus.useQuery(undefined, {
    retry: false,
  });
  const subscription = trpc.subscription.get.useQuery(undefined, {
    retry: false,
  });

  const clearDemo = trpc.settings.clearDemoData.useMutation({
    onSuccess: () => {
      utils.settings.onboardingStatus.invalidate();
      toast.success("Demo data cleared");
    },
    onError: (e) => toast.error(e.message),
  });
  const complete = trpc.settings.completeOnboarding.useMutation({
    onSuccess: () => {
      toast.success("Workspace setup saved");
      router.push("/");
      router.refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  const loadError = status.error ?? subscription.error;
  if (loadError) {
    return (
      <OnboardingLoadError
        message={loadError.message}
        onRetry={() => {
          void Promise.all([status.refetch(), subscription.refetch()]);
        }}
      />
    );
  }

  if (status.isLoading || subscription.isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!status.data || !subscription.data) {
    return (
      <OnboardingLoadError
        message="Onboarding details were unavailable. Retry before reviewing trial, billing, or demo-data setup."
        onRetry={() => {
          void Promise.all([status.refetch(), subscription.refetch()]);
        }}
      />
    );
  }

  const onboardingStatus = status.data;
  const subscriptionDetails = subscription.data;
  const daysLeft = trialCalendarDaysLeft(
    subscriptionDetails.trialEndsAt,
    subscriptionDetails.timezone
  );
  const draft = onboardingStatus.onboardingDraft;
  const draftTeam = draft?.teamMembers ?? [];
  const hasSignupDraft = !!draft?.logoName || !!draft?.brandColor || draftTeam.length > 0;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="grid min-h-[320px] lg:grid-cols-[0.9fr_1.1fr]">
            <div className="relative overflow-hidden bg-slate-950 p-7 text-white">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(45,212,191,0.25),transparent_34%),radial-gradient(circle_at_80%_0%,rgba(125,211,252,0.16),transparent_30%)]" />
              <div className="relative flex h-full flex-col justify-between">
                <div>
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-teal-300 text-slate-950">
                    <PawPrint className="h-6 w-6" />
                  </div>
                  <h1 className="mt-8 font-heading text-3xl font-bold tracking-tight">
                    Your OpenVPM workspace is ready.
                  </h1>
                  <p className="mt-3 text-sm leading-6 text-white/70">
                    Before the first charge, walk through the product with a working
                    schedule, real setup paths, and a clean route to replace demo data
                    with your clinic data.
                  </p>
                </div>

                <div className="mt-8 grid grid-cols-3 gap-3">
                  <div className="rounded-md bg-white/10 p-3">
                    <p className="text-xs text-white/55">Locations</p>
                    <p className="mt-1 text-lg font-semibold">
                      {subscriptionDetails.locationCount}
                    </p>
                  </div>
                  <div className="rounded-md bg-white/10 p-3">
                    <p className="text-xs text-white/55">Staff</p>
                    <p className="mt-1 text-lg font-semibold">
                      {subscriptionDetails.billableSeatCount}
                    </p>
                  </div>
                  <div className="rounded-md bg-white/10 p-3">
                    <p className="text-xs text-white/55">Trial</p>
                    <p className="mt-1 text-lg font-semibold">
                      {daysLeft === null ? "Open" : `${daysLeft}d`}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="p-7">
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
                <Sparkles className="h-3.5 w-3.5" />
                Setup before first charge
              </div>
              <h2 className="mt-5 font-heading text-2xl font-bold text-foreground">
                Start with the workflow, not a charge.
              </h2>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                Your trial is fully featured. Confirm the basics, invite staff,
                inspect the demo records, and adjust billing from Settings before
                the trial converts.
              </p>

              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                {TRUST_POINTS.map((point) => (
                  <div key={point} className="flex gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <span>{point}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <aside className="rounded-lg border border-border bg-card p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
              <CreditCard className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-semibold">Cloud estimate</h2>
              <p className="text-xs text-muted-foreground">
                Billing secured by Stripe
              </p>
            </div>
          </div>

          <div className="mt-6 space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">
                {subscriptionDetails.locationCount} active location
              </span>
              <span className="font-medium">
                {money(subscriptionDetails.locationUnitPriceMonthlyUsd)}/mo each
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">
                {subscriptionDetails.billableSeatCount} staff
              </span>
              <span className="font-medium">unlimited, included</span>
            </div>
            <div className="border-t border-border pt-3">
              <div className="flex items-end justify-between">
                <span className="text-muted-foreground">Estimated base</span>
                <span className="font-heading text-2xl font-bold">
                  {money(subscriptionDetails.estimatedMonthlyBase)}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                SMS and AI include monthly allowances, then meter overages.
              </p>
            </div>
          </div>

          <Link href="/settings?tab=billing">
            <Button variant="outline" className="mt-6 w-full">
              Review billing
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
        </aside>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="space-y-3">
          {SETUP_STEPS.map((s, index) => {
            const Icon = s.icon;
            return (
              <div
                key={s.title}
                className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 sm:flex-row sm:items-center"
              >
                <div className="flex items-center gap-4">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Step {index + 1}
                    </p>
                    <h3 className="font-medium">{s.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{s.body}</p>
                  </div>
                </div>
                <Link href={s.href} className="sm:ml-auto">
                  <Button variant="outline" size="sm" className="w-full sm:w-auto">
                    {s.cta}
                  </Button>
                </Link>
              </div>
            );
          })}
        </section>

        <aside className="space-y-4">
          {hasSignupDraft ? (
            <div className="rounded-lg border border-border bg-card p-6">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <ImageIcon className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="font-semibold">Signup setup</h2>
                  <p className="text-xs text-muted-foreground">
                    Staged before verification
                  </p>
                </div>
              </div>

              {draft?.logoName || draft?.brandColor ? (
                <div className="mt-4 rounded-md border border-border bg-muted/30 p-3">
                  <div className="flex items-center gap-3">
                    {draft?.brandColor ? (
                      <span
                        className="h-8 w-8 rounded-md border border-border"
                        style={{ backgroundColor: draft.brandColor }}
                      />
                    ) : null}
                    <div className="min-w-0">
                      <p className="text-sm font-medium">Brand draft</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {draft?.logoName ?? "Accent selected"}
                      </p>
                    </div>
                  </div>
                </div>
              ) : null}

              {draftTeam.length ? (
                <div className="mt-4 space-y-2">
                  {draftTeam.slice(0, 3).map((member) => (
                    <div
                      key={member.email}
                      className="rounded-md border border-border bg-muted/30 p-3"
                    >
                      <p className="truncate text-sm font-medium">{member.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {member.email}
                      </p>
                      <p className="mt-1 text-xs text-primary">
                        {ROLE_LABELS[member.role]}
                      </p>
                    </div>
                  ))}
                  {draftTeam.length > 3 ? (
                    <p className="text-xs text-muted-foreground">
                      +{draftTeam.length - 3} more staged invite
                    </p>
                  ) : null}
                </div>
              ) : null}

              <Link href="/settings?tab=staff">
                <Button variant="outline" size="sm" className="mt-5 w-full">
                  Finish setup
                </Button>
              </Link>
            </div>
          ) : null}

          <div className="rounded-lg border border-border bg-card p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Database className="h-5 w-5" />
              </div>
              <div>
                <h2 className="font-semibold">Sample data</h2>
                <p className="text-xs text-muted-foreground">
                  Explore before importing
                </p>
              </div>
            </div>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              Hosted trials start with sample clients, patients, and appointments
              so the app feels alive. Clear it once your team is ready for real data.
            </p>
            {onboardingStatus.hasDemoData ? (
              <Button
                variant="outline"
                size="sm"
                className="mt-5 w-full"
                disabled={clearDemo.isPending}
                onClick={() => clearDemo.mutate()}
              >
                {clearDemo.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Clear demo data
              </Button>
            ) : (
              <div className="mt-5 rounded-md border border-primary/20 bg-primary/5 p-3 text-sm text-primary">
                Demo data has been cleared.
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border bg-card p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div>
                <h2 className="font-semibold">Isolation model</h2>
                <p className="text-xs text-muted-foreground">
                  Shared database, scoped tenants
                </p>
              </div>
            </div>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              Clinics do not create separate databases. OpenVPM creates a practice
              tenant and stores every record with that practice ID. Hosted RLS uses
              the tenant context as a second guard.
            </p>
          </div>
        </aside>
      </div>

      <div className="mt-8 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Link href="/">
          <Button variant="ghost" className="w-full sm:w-auto">
            Skip for now
          </Button>
        </Link>
        <Button
          className="w-full sm:w-auto"
          disabled={complete.isPending}
          onClick={() => complete.mutate()}
        >
          {complete.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Check className="mr-2 h-4 w-4" />
          )}
          Enter dashboard
        </Button>
      </div>
    </div>
  );
}
