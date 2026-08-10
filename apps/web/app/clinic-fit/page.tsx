import type { Metadata } from "next";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleX,
  Laptop,
  PawPrint,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PawMark } from "@/components/brand/paw-mark";
import { buildCloudSignupUrl } from "@/lib/funnel-analytics";

export const metadata: Metadata = {
  title: "Clinic fit and pilot readiness | OpenVPM",
  description:
    "See which OpenVPM clinic workflows are ready today, which need a supported pilot, and which are not yet available.",
};

const READY_NOW = [
  "Clients, patients, scheduling, whiteboard, records, SOAP notes, vitals, vaccines, manual labs, inventory, invoices, and manual payments",
  "Client portal and clinic-reviewed appointment requests",
  "Reviewed CSV imports for clients, patients, vaccine history, and visit notes, plus data export and backups",
  "Connected browser use on computers, phones, and iPads",
];

const PILOT_OR_SETUP = [
  "Client card payments after the clinic completes Stripe Connect setup",
  "Hosted texting after carrier registration, consent review, and explicit clinic approval",
  "Larger, unusual, appointment, invoice, attachment, or vendor-specific migrations",
];

const NOT_YET = [
  "Offline charting or no-signal field use",
  "Herd, group-treatment, or production-animal workflows",
  "Production multi-location rollout; validate one location only during the current pilot",
  "General IDEXX, Antech, Zoetis, Vetcove, Rhapsody, e-prescribing, or accounting integrations",
  "Automated state or federal regulatory reporting",
];

const CLINIC_FIT_SIGNUP_URL = buildCloudSignupUrl({
  source: "clinic_fit",
  medium: "product",
  campaign: "clinic_fit",
});

export default function ClinicFitPage() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <Link
            href="/register"
            className="inline-flex items-center gap-2 font-semibold"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <PawMark className="h-4 w-4" />
            </span>
            OpenVPM
          </Link>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" asChild>
              <Link href="https://demo.openvpm.com/login">Open demo</Link>
            </Button>
            <Button size="sm" asChild>
              <Link href={CLINIC_FIT_SIGNUP_URL}>
                Start free
                <ArrowRight className="ml-1.5 h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main id="main-content">
        <section className="border-b border-slate-200 bg-white">
          <div className="mx-auto max-w-4xl px-6 py-16 text-center sm:py-20">
            <span className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800">
              <ShieldCheck className="h-3.5 w-3.5" />
              Honest clinic-readiness check
            </span>
            <h1 className="mt-5 font-heading text-4xl font-bold tracking-tight sm:text-5xl">
              Know what is ready before you move clinic work.
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">
              OpenVPM is strongest today for companion-animal and house-call
              clinics that can work in a connected browser and start alongside
              their current PIMS. You can try it without a card and decide with
              real workflow evidence.
            </p>
            <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
              <Button size="lg" asChild>
                <Link href={CLINIC_FIT_SIGNUP_URL}>
                  Start a 14-day trial
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link href="https://demo.openvpm.com/login">
                  Open the live demo
                </Link>
              </Button>
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Immediate access. No credit card required. Keep your current PIMS
              in place while you validate a real visit.
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 py-14">
          <div className="grid gap-5 lg:grid-cols-3">
            <CapabilityCard
              icon={<CheckCircle2 className="h-5 w-5" />}
              eyebrow="Ready now"
              title="Connected clinic-day work"
              items={READY_NOW}
              tone="ready"
            />
            <CapabilityCard
              icon={<AlertTriangle className="h-5 w-5" />}
              eyebrow="Setup or supported pilot"
              title="Validate before depending on it"
              items={PILOT_OR_SETUP}
              tone="pilot"
            />
            <CapabilityCard
              icon={<CircleX className="h-5 w-5" />}
              eyebrow="Not available yet"
              title="Keep another workflow in place"
              items={NOT_YET}
              tone="later"
            />
          </div>
        </section>

        <section className="border-y border-slate-200 bg-white">
          <div className="mx-auto grid max-w-6xl gap-10 px-6 py-14 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
            <div>
              <Laptop className="h-8 w-8 text-emerald-700" />
              <h2 className="mt-4 font-heading text-3xl font-bold">
                Prove one workflow first.
              </h2>
              <p className="mt-3 text-sm leading-6 text-slate-600">
                A safe pilot earns the switch. It does not ask your team to
                trust a feature list.
              </p>
            </div>
            <ol className="grid gap-3 sm:grid-cols-2">
              {[
                [
                  "1",
                  "Confirm fit",
                  "Name the workflow, location, devices, staff roles, and blockers.",
                ],
                [
                  "2",
                  "Bring a small sample",
                  "Dry-run a few real clients and patients before a larger import.",
                ],
                [
                  "3",
                  "Complete a real visit",
                  "Book, chart, close out, invoice or record no charge, and verify handoff.",
                ],
                [
                  "4",
                  "Run a pilot week",
                  "Validate exports, roles, payments, communications, recovery, and support.",
                ],
              ].map(([number, title, description]) => (
                <li
                  key={number}
                  className="rounded-xl border border-slate-200 bg-slate-50 p-4"
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-900 text-xs font-bold text-white">
                    {number}
                  </span>
                  <p className="mt-3 text-sm font-semibold">{title}</p>
                  <p className="mt-1 text-xs leading-5 text-slate-600">
                    {description}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="mx-auto max-w-3xl px-6 py-16 text-center">
          <PawPrint className="mx-auto h-8 w-8 text-emerald-700" />
          <h2 className="mt-4 font-heading text-3xl font-bold">
            Unsure about one must-have workflow?
          </h2>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            Ask before you move data or change clinic operations. We will tell
            you plainly whether it is ready, pilot-only, or not supported.
          </p>
          <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
            <Button asChild>
              <a href="mailto:support@openvpm.com?subject=OpenVPM%20clinic%20fit%20review">
                Plan a clinic pilot
              </a>
            </Button>
            <Button variant="outline" asChild>
              <Link href={CLINIC_FIT_SIGNUP_URL}>Start with sample data</Link>
            </Button>
          </div>
          <p className="mt-4 text-xs text-slate-500">
            Do not attach clinic exports or patient/client data to ordinary
            email. We will arrange a secure transfer method if a migration
            review needs real data.
          </p>
        </section>
      </main>
    </div>
  );
}

function CapabilityCard({
  icon,
  eyebrow,
  title,
  items,
  tone,
}: {
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  items: string[];
  tone: "ready" | "pilot" | "later";
}) {
  const styles = {
    ready: "border-emerald-200 bg-emerald-50/70 text-emerald-800",
    pilot: "border-amber-200 bg-amber-50/70 text-amber-800",
    later: "border-slate-200 bg-slate-100 text-slate-700",
  }[tone];

  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <span
        className={`inline-flex h-10 w-10 items-center justify-center rounded-xl border ${styles}`}
      >
        {icon}
      </span>
      <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {eyebrow}
      </p>
      <h2 className="mt-1 font-heading text-xl font-bold">{title}</h2>
      <ul className="mt-4 space-y-3 text-sm leading-6 text-slate-600">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-50" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}
