"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, FileText, FlaskConical, Receipt } from "lucide-react";
import { PawMark } from "@/components/brand/paw-mark";
import { FUNNEL_EVENTS } from "@/lib/funnel-analytics";
import { trackFunnelEvent } from "@/lib/track-funnel-event";

const workflows = [
  {
    id: "patients",
    icon: FileText,
    title: "Get to know a patient",
    description: "See the chart, visit notes, and care history in one place.",
    href: "/patients",
    action: "Open patient charts",
    steps: [
      "Choose a sample patient from the list.",
      "Open their chart and explore notes, visits, and documents.",
      "See how the patient's history stays together as care continues.",
    ],
    note: "This is a shared demo. Use made-up information if you try adding anything.",
  },
  {
    id: "lab_results",
    icon: FlaskConical,
    title: "Follow a lab result",
    description: "Go from results to review and a clear follow-up owner.",
    href: "/lab-results",
    action: "Open the Lab Inbox",
    steps: [
      "Choose All to see the sample results.",
      "Open a result's evidence history to see its review trail.",
      "Explore the follow-up queue and see who owns the next step.",
    ],
    note: "These are manually recorded results. Direct connections to external labs are not available yet.",
  },
  {
    id: "billing",
    icon: Receipt,
    title: "Explore a clinic's billing",
    description: "Follow charges, invoices, and recorded payments.",
    href: "/billing",
    action: "Open billing",
    steps: [
      "Choose a sample invoice from the list.",
      "Look through its line items, balance, and payment history.",
      "See how the invoice connects back to the client and patient.",
    ],
    note: "Use sample information only. Do not enter a real card or make a real payment in the demo.",
  },
] as const;

export function DemoWelcome() {
  const [selected, setSelected] = useState<(typeof workflows)[number] | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const viewed = useRef(false);

  useEffect(() => {
    if (viewed.current) return;
    viewed.current = true;
    trackFunnelEvent(FUNNEL_EVENTS.demoWelcomeViewed, { path: "/demo-start" });
  }, []);

  useEffect(() => {
    heading.current?.focus();
  }, [selected]);

  return (
    <main id="main-content" className="flex min-h-screen items-center justify-center bg-surface px-4 py-8 sm:py-16">
      <div className="w-full max-w-3xl">
        <div className="mb-8 flex items-center justify-between gap-4">
          <Link href="/" aria-label="OpenVPM demo dashboard" className="flex items-center gap-2 font-heading text-lg font-semibold">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <PawMark className="h-5 w-5" />
            </span>
            OpenVPM
          </Link>
          <span className="text-sm text-muted-foreground">Shared demo · Sample data</span>
        </div>

        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-8">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-primary">
            {selected ? "Your quick walkthrough" : "Welcome to the demo"}
          </p>
          <h1 ref={heading} tabIndex={-1} className="font-heading text-2xl font-semibold tracking-tight outline-none sm:text-3xl">
            {selected ? selected.title : "What would you like to try?"}
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
            {selected ? "Here are a few things to look for. You can explore at your own pace." : "Start with one everyday task. The sample clinic is ready, so there's nothing to set up."}
          </p>

          {selected ? (
            <>
              <ol className="my-7 space-y-5">
                {selected.steps.map((step, index) => (
                  <li key={step} className="flex items-start gap-3 text-sm leading-6">
                    <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 font-medium text-primary">{index + 1}</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
              <p className="rounded-lg bg-muted p-3 text-xs leading-5 text-muted-foreground">{selected.note}</p>
              <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
                <button type="button" onClick={() => setSelected(null)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-3 text-sm text-muted-foreground hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
                  <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Choose another workflow
                </button>
                <Link href={selected.href} onClick={() => trackFunnelEvent(FUNNEL_EVENTS.demoWorkflowStarted, { tool: selected.id, path: "/demo-start" })} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
                  {selected.action} <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </div>
            </>
          ) : (
            <div className="mt-7 grid gap-3 sm:grid-cols-3">
              {workflows.map((workflow) => (
                <button key={workflow.id} type="button" onClick={() => {
                  setSelected(workflow);
                  trackFunnelEvent(FUNNEL_EVENTS.demoWorkflowSelected, { tool: workflow.id, path: "/demo-start" });
                }} className="group flex flex-col rounded-xl border border-border p-5 text-left transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
                  <workflow.icon className="mb-4 h-6 w-6 text-primary" aria-hidden="true" />
                  <span className="block text-sm font-semibold">{workflow.title}</span>
                  <span className="mt-2 block flex-1 text-sm leading-6 text-muted-foreground">{workflow.description}</span>
                  <ArrowRight className="mt-4 h-4 w-4 text-primary" aria-hidden="true" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="mt-5 text-center">
          <Link href="/" onClick={() => trackFunnelEvent(FUNNEL_EVENTS.demoWelcomeSkipped, { path: "/demo-start" })} className="inline-flex min-h-11 items-center px-3 text-sm text-muted-foreground underline-offset-4 hover:underline">
            I'll explore on my own
          </Link>
          <p className="mt-1 text-xs text-muted-foreground">You can choose a workflow again from the demo bar.</p>
        </div>
      </div>
    </main>
  );
}
