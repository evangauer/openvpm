import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Download, FileText, MapPin, Receipt } from "lucide-react";
import { PawMark } from "@/components/brand/paw-mark";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Three sample workflows to try | OpenVPM",
  description:
    "Walk through patient documents, visit charges, and an optional connected field visit with fictional data before choosing an OpenVPM pilot.",
  alternates: {
    canonical: "https://app.openvpm.com/clinic-fit/workflows",
  },
};

const GUIDE_BASE = "https://github.com/evangauer/openvpm/blob/main/docs/help";

export default function WorkflowGuide() {
  return (
    <div className="min-h-screen bg-white text-slate-950">
      <header className="border-b border-slate-200">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
          <a
            href="https://openvpm.com"
            className="inline-flex items-center gap-2 font-semibold"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <PawMark className="h-4 w-4" />
            </span>
            OpenVPM
          </a>
          <nav aria-label="Page navigation" className="flex items-center gap-2">
            <Button variant="ghost" size="sm" asChild>
              <Link href="/clinic-fit">Clinic fit</Link>
            </Button>
            <Button size="sm" asChild>
              <a href={`${GUIDE_BASE}/getting-started.md`}>Read the guides</a>
            </Button>
          </nav>
        </div>
      </header>

      <main id="main-content">
        <section className="mx-auto max-w-5xl px-6 py-14 sm:py-20">
          <h1 className="max-w-3xl font-heading text-4xl font-bold tracking-tight sm:text-5xl">
            Walk through one useful visit.
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">
            Bring a familiar task to a test clinic. Find an outside record,
            follow work into an invoice, or review a connected house call. Use
            fictional data while you check what fits your practice.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button size="lg" asChild>
              <a href="/clinic-fit/workflows/synthetic-external-record.pdf" download>
                <Download className="mr-2 h-4 w-4" />
                Get the sample record
              </a>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <a href="#patient-documents">Start with a patient document</a>
            </Button>
          </div>
          <p className="mt-4 text-sm leading-6 text-slate-500">
            Use an up-to-date OpenVPM test clinic with fictional data. A
            connected browser is required.
          </p>
          <nav
            aria-label="Workflow sections"
            className="mt-10 flex flex-wrap gap-x-7 gap-y-3 border-t border-slate-200 pt-5 text-sm font-medium text-emerald-800"
          >
            <a className="underline-offset-4 hover:underline" href="#patient-documents">
              01 Patient documents
            </a>
            <a className="underline-offset-4 hover:underline" href="#visit-to-invoice">
              02 Visit to invoice
            </a>
            <a className="underline-offset-4 hover:underline" href="#field-visit">
              03 Connected field visit
            </a>
          </nav>
          <p className="mt-6 max-w-3xl border-l-2 border-emerald-600 pl-4 text-sm leading-6 text-slate-600">
            The shared demo may run an earlier release and may not show these
            newer workflows. Use the current version for this walkthrough. If
            Documents or Start field visit is absent, check the installation
            version and feature availability before trying those steps.
          </p>
        </section>

        <section id="patient-documents" className="scroll-mt-6 border-y border-slate-200 bg-slate-50">
          <div className="mx-auto grid max-w-5xl gap-8 px-6 py-12 md:grid-cols-[0.75fr_1.25fr] md:gap-14">
            <div>
              <FileText aria-hidden="true" className="h-7 w-7 text-emerald-700" />
              <h2 className="mt-4 font-heading text-2xl font-bold sm:text-3xl">
                Keep the original report with the patient.
              </h2>
              <p className="mt-4 text-sm leading-6 text-slate-600">
                Outside records, referrals, scans, and external lab reports can
                live in Documents. The original file remains a source record;
                uploading it does not create structured lab values.
              </p>
              <a
                href={`${GUIDE_BASE}/upload-patient-documents.md`}
                className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-emerald-800 underline underline-offset-4"
              >
                Read the document guide
                <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </a>
            </div>
            <div>
              <h3 className="text-base font-semibold">Try it with a synthetic record</h3>
              <ol className="mt-4 list-decimal space-y-3 pl-5 text-sm leading-6 text-slate-700 marker:font-semibold marker:text-emerald-800">
                <li>Open Patients and choose a fictional patient in your test clinic.</li>
                <li>Open Documents. Under Add a patient document, choose External record.</li>
                <li>Choose the sample PDF below, then select Upload document.</li>
                <li>Find the filename in Documents. View or download it and compare it with the original.</li>
              </ol>
              <Button className="mt-6" variant="outline" asChild>
                <a href="/clinic-fit/workflows/synthetic-external-record.pdf" download>
                  <Download className="mr-2 h-4 w-4" />
                  Download sample PDF
                </a>
              </Button>
              <p className="mt-2 text-xs leading-5 text-slate-500">
                One page of invented demonstration text. No real clinic,
                patient, contact information, lab values, or treatment advice.
              </p>
              <details className="mt-6 border-t border-slate-200 pt-4 text-sm">
                <summary className="cursor-pointer font-semibold text-slate-900">
                  What should you check?
                </summary>
                <ul className="mt-3 list-disc space-y-2 pl-5 leading-6 text-slate-600">
                  <li>The document belongs to the patient you selected.</li>
                  <li>Its original filename is visible and the downloaded file matches.</li>
                  <li>Lab report files can be found using the Lab reports filter.</li>
                  <li>Staff with write access can upload; viewer accounts can read and download.</li>
                </ul>
                <p className="mt-3 leading-6 text-slate-600">
                  Files can be PDF, JPG, PNG, or WebP, up to 4 MB each. If an
                  upload cannot be confirmed, keep the page open and use Retry
                  upload to check and finish the same upload.
                </p>
              </details>
            </div>
          </div>
        </section>

        <section id="visit-to-invoice" className="scroll-mt-6">
          <div className="mx-auto grid max-w-5xl gap-8 px-6 py-12 md:grid-cols-[0.75fr_1.25fr] md:gap-14">
            <div>
              <Receipt aria-hidden="true" className="h-7 w-7 text-emerald-700" />
              <h2 className="mt-4 font-heading text-2xl font-bold sm:text-3xl">
                Follow the work into the invoice.
              </h2>
              <p className="mt-4 text-sm leading-6 text-slate-600">
                A visit workspace brings notes, performed work, reconciliation,
                charges, and closeout together. Use the clinic owner/admin role
                when evaluating both clinical and billing tasks.
              </p>
              <a
                href={`${GUIDE_BASE}/solo-vet-workflow.md`}
                className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-emerald-800 underline underline-offset-4"
              >
                Read the visit guide
                <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </a>
            </div>
            <div>
              <h3 className="text-base font-semibold">Use a familiar sample visit</h3>
              <ol className="mt-4 list-decimal space-y-3 pl-5 text-sm leading-6 text-slate-700 marker:font-semibold marker:text-emerald-800">
                <li>Open a scheduled visit for a fictional patient and review its chart.</li>
                <li>Document the sample visit and review the work performed.</li>
                <li>Reconcile the proposed service and product charges. Check the descriptions, quantities, and totals.</li>
                <li>Review the invoice and payment state, then return to the same visit to finish closeout.</li>
              </ol>
              <details className="mt-6 border-t border-slate-200 pt-4 text-sm">
                <summary className="cursor-pointer font-semibold text-slate-900">
                  What should you check?
                </summary>
                <ul className="mt-3 list-disc space-y-2 pl-5 leading-6 text-slate-600">
                  <li>The recorded work and invoice agree before you present the bill.</li>
                  <li>Review an existing sample prescription, its dispensing quantity, and its linked charges if your test case includes one.</li>
                  <li>Payment status and the invoice&apos;s remaining balance agree.</li>
                  <li>Clinical documentation is complete or still clearly marked unfinished.</li>
                </ul>
                <p className="mt-3 leading-6 text-slate-600">
                  Keep this a sample billing review; do not enter real card
                  details or take a real payment in a test clinic. A follow-up
                  due date is not a booked appointment: book the actual visit
                  before linking it in closeout.
                </p>
              </details>
            </div>
          </div>
        </section>

        <section id="field-visit" className="scroll-mt-6 border-y border-slate-200 bg-slate-50">
          <div className="mx-auto grid max-w-5xl gap-8 px-6 py-12 md:grid-cols-[0.75fr_1.25fr] md:gap-14">
            <div>
              <MapPin aria-hidden="true" className="h-7 w-7 text-emerald-700" />
              <h2 className="mt-4 font-heading text-2xl font-bold sm:text-3xl">
                Start a connected field visit from the chart.
              </h2>
              <p className="mt-4 text-sm leading-6 text-slate-600">
                The optional ambulatory workspace supports an individual-patient
                field visit without a separately booked appointment. Availability
                depends on the installation and clinic settings.
              </p>
              <Link
                href="/clinic-fit"
                className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-emerald-800 underline underline-offset-4"
              >
                Check current clinic fit
                <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </Link>
            </div>
            <div>
              <h3 className="text-base font-semibold">When the workspace is enabled</h3>
              <ol className="mt-4 list-decimal space-y-3 pl-5 text-sm leading-6 text-slate-700 marker:font-semibold marker:text-emerald-800">
                <li>Open an active fictional patient and choose Start field visit.</li>
                <li>Review the patient, location, and visit before entering sample work.</li>
                <li>Use Charges and payment to review billing in the same visit.</li>
                <li>If notes are unfinished, return through the dashboard&apos;s Unfinished field visits list.</li>
              </ol>
              <details className="mt-6 border-t border-slate-200 pt-4 text-sm">
                <summary className="cursor-pointer font-semibold text-slate-900">
                  What should you check?
                </summary>
                <p className="mt-3 leading-6 text-slate-600">
                  Start field visit appears only when the installation operator
                  makes the feature available and the clinic admin enables
                  Ambulatory workspace in Settings. If it is absent, use a
                  scheduled sample visit or ask the operator about availability.
                </p>
                <p className="mt-3 leading-6 text-slate-600">
                  Bill now, finish notes later keeps billing and unfinished
                  documentation distinct. Returning to the visit should show
                  what still needs attention. Internet access is required;
                  offline charting and herd/group treatment are not supported.
                </p>
              </details>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-6 py-12">
          <h2 className="font-heading text-2xl font-bold">Leave with a concrete next step.</h2>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-600">
            Write down what worked, where you stopped, and the one change that
            would make this workflow useful. Share the steps and device you used
            without real patient or client information. That gives a pilot or
            community contribution a clear starting point.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button asChild>
              <a href={`${GUIDE_BASE}/getting-started.md`}>Read the getting-started guide</a>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/clinic-fit">Review pilot fit</Link>
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
}
