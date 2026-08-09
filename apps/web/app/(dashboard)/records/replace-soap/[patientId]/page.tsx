"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  AlertCircle,
  ArrowLeft,
  FilePenLine,
  Loader2,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  CLINICAL_CORRECTION_REASON_MAX_LENGTH,
  isClinicalCorrectionReasonValid,
} from "@/lib/records/clinical-correction-policy";
import {
  hasSoapContent,
  SOAP_SECTION_MAX_LENGTH,
} from "@/lib/records/soap-content";
import { hasUnresolvedSoapTemplatePrompts } from "@/lib/records/soap-templates";
import { trpc } from "@/lib/trpc";

const SoapNoteEditor = dynamic(
  () =>
    import("@/components/SoapNoteEditor").then((mod) => mod.SoapNoteEditor),
  { ssr: false },
);

type Sections = {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
};

function canReplaceSoap(role?: string | null): boolean {
  return role === "admin" || role === "veterinarian";
}

function fingerprint(reason: string, sections: Sections): string {
  return JSON.stringify({ reason, ...sections });
}

export default function ReplaceSoapNotePage() {
  const params = useParams<{ patientId: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { data: session, status } = useSession();
  const allowed = canReplaceSoap(session?.user?.role);
  const sourceNoteId = searchParams.get("sourceNoteId") ?? "";
  const returnTarget = searchParams.get("return");
  const returnPath =
    returnTarget === "records"
      ? `/records?patientId=${encodeURIComponent(params.patientId)}&tab=soap`
      : `/patients/${encodeURIComponent(params.patientId)}`;

  const patient = trpc.patients.getById.useQuery(
    { id: params.patientId },
    { enabled: allowed && Boolean(params.patientId) },
  );
  const notes = trpc.records.listSoapNotes.useQuery(
    { patientId: params.patientId },
    { enabled: allowed && Boolean(params.patientId) && Boolean(sourceNoteId) },
  );
  const source = notes.data?.find((note) => note.id === sourceNoteId) ?? null;

  const [sections, setSections] = useState<Sections>({
    subjective: "",
    objective: "",
    assessment: "",
    plan: "",
  });
  const [reason, setReason] = useState("");
  const [initialized, setInitialized] = useState(false);
  const initialFingerprint = useRef("");
  const operationId = useRef<string | null>(null);

  useEffect(() => {
    if (!source || initialized) return;
    const nextSections = {
      subjective: source.subjective ?? "",
      objective: source.objective ?? "",
      assessment: source.assessment ?? "",
      plan: source.plan ?? "",
    };
    const nextReason = source.correctionReason ?? "";
    setSections(nextSections);
    setReason(nextReason);
    initialFingerprint.current = fingerprint(nextReason, nextSections);
    setInitialized(true);
  }, [initialized, source]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (
        !initialized ||
        fingerprint(reason, sections) === initialFingerprint.current
      ) {
        return;
      }
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [initialized, reason, sections]);

  useEffect(() => {
    const guardLinkNavigation = (event: MouseEvent) => {
      if (
        !initialized ||
        fingerprint(reason, sections) === initialFingerprint.current ||
        !(event.target instanceof Element) ||
        !event.target.closest("a[href]")
      ) {
        return;
      }
      if (!window.confirm("Discard the replacement SOAP changes on this page?")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("click", guardLinkNavigation, true);
    return () => document.removeEventListener("click", guardLinkNavigation, true);
  }, [initialized, reason, sections]);

  const replace = trpc.records.replaceSoapNote.useMutation({
    onSuccess: async (replacement) => {
      initialFingerprint.current = fingerprint(reason, sections);
      toast.success("Replacement SOAP finalized; original retained in history", {
        description:
          "Review the signed discharge separately if owner-facing instructions changed.",
      });
      router.push(`${returnPath}#soap-note-${replacement.id}`);
    },
    onError: (error) => toast.error(error.message),
  });

  const hasContent = hasSoapContent(sections);
  const unresolvedPrompts = hasUnresolvedSoapTemplatePrompts(sections);
  const valid =
    hasContent &&
    !unresolvedPrompts &&
    isClinicalCorrectionReasonValid(reason) &&
    Object.values(sections).every(
      (value) => value.length <= SOAP_SECTION_MAX_LENGTH,
    );
  const leaveEditor = () => {
    if (
      initialized &&
      fingerprint(reason, sections) !== initialFingerprint.current &&
      !window.confirm("Discard the replacement SOAP changes on this page?")
    ) {
      return;
    }
    router.push(returnPath);
  };

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Checking access...
      </div>
    );
  }
  if (!allowed) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="Access denied"
        description="Only veterinarians and administrators can replace finalized SOAP documentation."
        action={{ label: "Back to chart", onClick: () => router.push(returnPath) }}
      />
    );
  }
  if (!sourceNoteId) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Choose a SOAP note"
        description="Open the finalized note from the patient chart and choose Replace finalized SOAP."
        action={{ label: "Back to chart", onClick: () => router.push(returnPath) }}
      />
    );
  }
  if (patient.isLoading || notes.isLoading || !initialized) {
    if (patient.error || notes.error || (!notes.isLoading && !source)) {
      return (
        <EmptyState
          icon={AlertCircle}
          title="Unable to load the source SOAP"
          description={patient.error?.message ?? notes.error?.message ?? "The finalized source note is unavailable in this patient chart."}
          action={{ label: "Back to chart", onClick: () => router.push(returnPath) }}
        />
      );
    }
    return (
      <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading signed SOAP...
      </div>
    );
  }
  if (!source || source.status !== "finalized") {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Finalized source required"
        description="Only finalized SOAP notes can be replaced."
        action={{ label: "Back to chart", onClick: () => router.push(returnPath) }}
      />
    );
  }
  if (source.replacementSoapNoteId) {
    return (
      <EmptyState
        icon={FilePenLine}
        title="Replacement already finalized"
        description="This source already has a signed replacement. Open the current note from the chart."
        action={{ label: "View chart", onClick: () => router.push(returnPath) }}
      />
    );
  }

  const updateSection = (key: keyof Sections, value: string) =>
    setSections((current) => ({ ...current, [key]: value }));

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <Button variant="ghost" size="sm" onClick={leaveEditor}>
        <ArrowLeft className="mr-2 h-4 w-4" /> Back to chart
      </Button>

      <div>
        <h1 className="font-heading text-2xl font-semibold">
          Replace finalized SOAP
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Patient: {patient.data?.name ?? "Unknown patient"}
        </p>
      </div>

      <div role="alert" className="rounded-lg border border-amber-400/60 bg-amber-50 p-4 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
        <p className="font-semibold">This creates a new signed clinical record.</p>
        <p className="mt-1">
          The original remains permanently visible as entered in error. The
          replacement becomes the current SOAP immediately. A completed visit,
          invoice, payment, discharge, and signed handoffs are not reopened or
          rewritten.
        </p>
        <p className="mt-2 font-medium">
          This page is not an autosaved draft. Finish or copy your work before leaving.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card p-5">
        <label htmlFor="soap-correction-reason" className="text-sm font-semibold">
          Permanent correction reason
        </label>
        <Textarea
          id="soap-correction-reason"
          className="mt-2 bg-background"
          rows={4}
          maxLength={CLINICAL_CORRECTION_REASON_MAX_LENGTH}
          value={reason}
          disabled={Boolean(source.correctionId)}
          placeholder="Required. Explain why the original signed note is incorrect."
          onChange={(event) => setReason(event.currentTarget.value)}
        />
        {source.correctionId ? (
          <p className="mt-2 text-xs text-muted-foreground">
            This reason is already permanent chart history and cannot be changed.
          </p>
        ) : null}
      </div>

      {(
        [
          ["Subjective", "subjective"],
          ["Objective", "objective"],
          ["Assessment", "assessment"],
          ["Plan", "plan"],
        ] as const
      ).map(([label, key]) => (
        <section key={key}>
          <h2 className="mb-2 text-sm font-semibold">{label}</h2>
          <SoapNoteEditor
            value={sections[key]}
            onChange={(value) => updateSection(key, value)}
            placeholder={`Enter corrected ${label.toLowerCase()} documentation...`}
          />
        </section>
      ))}

      {unresolvedPrompts ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          Replace or delete every bracketed template prompt before finalizing.
        </p>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-5">
        <Button variant="outline" disabled={replace.isPending} onClick={leaveEditor}>
          Cancel
        </Button>
        <Button
          disabled={!valid || replace.isPending}
          onClick={() => {
            if (
              !window.confirm(
                "Finalize this replacement SOAP now? It cannot be edited after signing; later clarification requires an attributed addendum.",
              )
            ) {
              return;
            }
            operationId.current ??= crypto.randomUUID();
            replace.mutate({
              patientId: params.patientId,
              sourceNoteId: source.id,
              operationId: operationId.current,
              reason: reason.trim(),
              ...sections,
            });
          }}
        >
          {replace.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <FilePenLine className="mr-2 h-4 w-4" />
          )}
          {replace.isPending ? "Finalizing..." : "Finalize replacement"}
        </Button>
      </div>
    </div>
  );
}
