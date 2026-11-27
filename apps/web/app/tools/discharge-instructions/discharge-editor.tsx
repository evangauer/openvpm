"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Copy, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  handoutFields,
  handoutSections,
  handoutText,
  type DischargeHandout,
} from "@/lib/encounters/discharge-handout";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";

export function DischargeEditor({
  practice,
  phone,
}: {
  practice: string;
  phone: string;
}) {
  const blankDraft = {
    patient: "",
    contact: phone,
    instructions: "",
    warningSigns: "",
    followUp: "",
  };
  const [draft, setDraft] = useState<DischargeHandout>(blankDraft);
  const [reviewing, setReviewing] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "manual">(
    "idle",
  );
  const reviewTitle = useRef<HTMLHeadingElement>(null);
  const patientInput = useRef<HTMLInputElement>(null);
  const fallback = useRef<HTMLTextAreaElement>(null);
  const dirty = Boolean(
    draft.patient ||
    draft.instructions ||
    draft.warningSigns ||
    draft.followUp ||
    draft.contact !== phone,
  );
  useUnsavedChangesGuard(dirty, "Leaving clears this handout. Leave the page?");

  useEffect(() => {
    if (reviewing) reviewTitle.current?.focus();
  }, [reviewing]);

  useEffect(() => {
    if (copyStatus === "manual") {
      fallback.current?.focus();
      fallback.current?.select();
    }
  }, [copyStatus]);

  async function copyHandout() {
    try {
      await navigator.clipboard.writeText(handoutText(practice, draft));
      setCopyStatus("copied");
    } catch {
      setCopyStatus("manual");
    }
  }

  function changeDraft(key: keyof DischargeHandout, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function editHandout() {
    setCopyStatus("idle");
    setReviewing(false);
    requestAnimationFrame(() => patientInput.current?.focus());
  }

  return (
    <main
      id="main-content"
      className="min-h-screen bg-surface px-4 py-6 sm:py-10 print:min-h-0 print:bg-white print:p-0"
    >
      <div className="mx-auto max-w-2xl print:max-w-none">
        <Link
          href="/"
          prefetch={false}
          className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-primary print:hidden"
        >
          <ArrowLeft size={16} aria-hidden="true" /> Return to your practice
        </Link>
        {reviewing ? (
          <>
            <div className="mb-5 print:hidden">
              <h1
                ref={reviewTitle}
                tabIndex={-1}
                className="font-heading text-3xl font-semibold tracking-tight"
              >
                Review handout
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Check the patient and instructions before you print or copy.
              </p>
            </div>
            <article
              aria-label="Owner handout"
              className="space-y-6 break-words rounded-xl border bg-white p-5 sm:p-8 print:rounded-none print:border-0 print:p-0"
            >
              <header className="space-y-2 border-b pb-5">
                <h2 className="font-heading text-2xl font-semibold">
                  Discharge instructions for {draft.patient.trim()}
                </h2>
                <p className="text-sm">
                  <strong>{practice}</strong>
                  {draft.contact.trim() && (
                    <>
                      <br />
                      {draft.contact.trim()}
                    </>
                  )}
                </p>
              </header>
              {handoutSections(draft).map(({ label, text }) => (
                <section key={label}>
                  <h3 className="mb-1 font-heading font-semibold print:break-after-avoid">
                    {label}
                  </h3>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">
                    {text}
                  </p>
                </section>
              ))}
            </article>
            <div className="mt-5 space-y-3 print:hidden">
              <div className="flex flex-wrap gap-2">
                <Button onClick={copyHandout} className="gap-2">
                  <Copy size={16} aria-hidden="true" />
                  Copy instructions
                </Button>
                <Button
                  variant="outline"
                  onClick={() => window.print()}
                  className="gap-2"
                >
                  <Printer size={16} aria-hidden="true" />
                  Print handout
                </Button>
                <Button variant="ghost" onClick={editHandout}>
                  Edit instructions
                </Button>
              </div>
              <p role="status" className="text-sm text-muted-foreground">
                {copyStatus === "copied" &&
                  "Copied. Paste the instructions into the correct patient record."}
                {copyStatus === "manual" &&
                  "Clipboard access is unavailable. Copy the selected text below."}
              </p>
              {copyStatus === "manual" && (
                <Textarea
                  aria-label="Instructions to copy"
                  ref={fallback}
                  readOnly
                  rows={8}
                  value={handoutText(practice, draft)}
                />
              )}
              <Button
                variant="link"
                className="px-0"
                onClick={() => {
                  if (
                    !window.confirm(
                      "Clear this handout and start one for another patient?",
                    )
                  )
                    return;
                  setDraft(blankDraft);
                  editHandout();
                }}
              >
                Start another handout
              </Button>
            </div>
          </>
        ) : (
          <div className="print:hidden">
            <h1 className="font-heading text-3xl font-semibold tracking-tight">
              Discharge instructions
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
              Write a take-home care plan for the owner. Your draft stays in
              this tab until you copy or print it.
            </p>
            <form
              className="mt-6 space-y-5 rounded-xl border bg-white p-5 sm:p-8"
              autoComplete="off"
              onSubmit={(event) => {
                event.preventDefault();
                if (draft.patient.trim() && draft.instructions.trim())
                  setReviewing(true);
              }}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Patient name" htmlFor="patient" required>
                  <Input
                    id="patient"
                    ref={patientInput}
                    required
                    maxLength={200}
                    value={draft.patient}
                    onChange={(event) =>
                      changeDraft("patient", event.target.value)
                    }
                  />
                </FormField>
                <FormField label="Clinic contact" htmlFor="contact">
                  <Input
                    id="contact"
                    maxLength={200}
                    value={draft.contact}
                    onChange={(event) =>
                      changeDraft("contact", event.target.value)
                    }
                  />
                </FormField>
              </div>
              {handoutFields.map(({ key, label, limit }) => (
                <FormField
                  key={key}
                  label={label}
                  htmlFor={key}
                  required={key === "instructions"}
                >
                  <Textarea
                    id={key}
                    rows={key === "instructions" ? 4 : 2}
                    required={key === "instructions"}
                    maxLength={limit}
                    value={draft[key]}
                    onChange={(event) => changeDraft(key, event.target.value)}
                  />
                </FormField>
              ))}
              <Button
                type="submit"
                disabled={!draft.patient.trim() || !draft.instructions.trim()}
              >
                Review handout
              </Button>
            </form>
          </div>
        )}
      </div>
    </main>
  );
}
