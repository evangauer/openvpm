"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  AlertCircle,
  ArrowLeft,
  ClipboardList,
  Loader2,
  Save,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/common/empty-state";
import { CapturePhotos } from "@/components/records/capture-photos";
import { toast } from "sonner";
import {
  hasSoapContent,
  normalizeSoapSection,
} from "@/lib/records/soap-content";
import {
  SOAP_NOTE_TEMPLATES,
  applySoapTemplateToSections,
  getSoapTemplateById,
} from "@/lib/records/soap-templates";

const SoapNoteEditor = dynamic(
  () =>
    import("@/components/SoapNoteEditor").then((mod) => mod.SoapNoteEditor),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-32 rounded-lg border border-border bg-muted/20 p-3 text-sm text-muted-foreground">
        Loading editor...
      </div>
    ),
  }
);

function canCreateSoapNoteRole(role?: string | null): boolean {
  return role === "admin" || role === "veterinarian";
}

/** Plain-text AI draft sections -> simple HTML the tiptap editor can load. */
function draftTextToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br>")}</p>`);
  return paragraphs.join("");
}

export default function NewSoapNotePage() {
  const params = useParams<{ patientId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, status } = useSession();
  const userRole = session?.user?.role;
  const canCreateSoapNote = canCreateSoapNoteRole(userRole);
  const accessDenied = status !== "loading" && !canCreateSoapNote;
  const appointmentId = searchParams.get("appointmentId") ?? undefined;
  const returnPath = appointmentId
    ? `/encounters/${encodeURIComponent(appointmentId)}`
    : "/records";

  const [subjective, setSubjective] = useState("");
  const [objective, setObjective] = useState("");
  const [assessment, setAssessment] = useState("");
  const [plan, setPlan] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState(
    SOAP_NOTE_TEMPLATES[0]?.id ?? ""
  );
  const [replaceTemplateContent, setReplaceTemplateContent] = useState(false);
  const canSave = hasSoapContent({ subjective, objective, assessment, plan });
  const selectedTemplate = getSoapTemplateById(selectedTemplateId);

  const {
    data: patient,
    isLoading: patientLoading,
    error: patientError,
  } =
    trpc.patients.getById.useQuery(
      { id: params.patientId },
      { enabled: !!params.patientId && canCreateSoapNote && !!appointmentId }
    );

  const createNote = trpc.records.createSoapNote.useMutation({
    onSuccess: () => {
      toast.success("SOAP note created");
      router.push(returnPath);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  // AI draft availability mirrors the OpenVPM Agent (same key + model config).
  const agentStatus = trpc.agent.status.useQuery(undefined, {
    enabled: canCreateSoapNote && !!appointmentId,
  });
  const aiConfigured = agentStatus.data?.configured ?? false;
  const draftWithAi = trpc.ai.draftSoapNote.useMutation({
    onSuccess: (draft) => {
      setSubjective(draftTextToHtml(draft.subjective));
      setObjective(draftTextToHtml(draft.objective));
      setAssessment(draftTextToHtml(draft.assessment));
      setPlan(draftTextToHtml(draft.plan));
      toast.success("Draft ready. Please review and edit before you save.");
    },
    onError: (err) => toast.error(err.message),
  });

  function handleDraftWithAi() {
    if (!params.patientId || draftWithAi.isPending) return;
    if (
      canSave &&
      !window.confirm("Replace what you typed with the AI draft?")
    ) {
      return;
    }
    draftWithAi.mutate({ patientId: params.patientId });
  }

  function handleSave() {
    if (!appointmentId) {
      toast.error("Open an active visit before creating a SOAP note");
      return;
    }
    if (!params.patientId || !patient) {
      toast.error("Load the patient before saving a SOAP note");
      return;
    }
    if (!canSave) {
      toast.error("Add at least one SOAP section before saving");
      return;
    }
    createNote.mutate({
      patientId: params.patientId,
      appointmentId,
      subjective: normalizeSoapSection(subjective),
      objective: normalizeSoapSection(objective),
      assessment: normalizeSoapSection(assessment),
      plan: normalizeSoapSection(plan),
    });
  }

  function handleApplyTemplate() {
    if (!selectedTemplate) return;
    const next = applySoapTemplateToSections(
      { subjective, objective, assessment, plan },
      selectedTemplate,
      { replaceExisting: replaceTemplateContent }
    );
    setSubjective(next.subjective);
    setObjective(next.objective);
    setAssessment(next.assessment);
    setPlan(next.plan);
    toast.success(
      replaceTemplateContent || !canSave
        ? `${selectedTemplate.name} template applied`
        : `${selectedTemplate.name} template filled blank sections`
    );
  }

  if (accessDenied) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <ShieldAlert className="h-12 w-12 text-muted-foreground mb-4" />
        <h2 className="font-heading text-xl font-semibold">Access Denied</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Only veterinarians and administrators can create SOAP notes.
        </p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => router.push(returnPath)}
        >
          {appointmentId ? "Back to visit" : "Back to Records"}
        </Button>
      </div>
    );
  }

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card p-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Checking SOAP note access...
      </div>
    );
  }

  if (!appointmentId) {
    return (
      <EmptyState
        icon={ClipboardList}
        title="Open an active visit first"
        description="SOAP notes must be attached to a visit that is currently in exam. Open the appointment from the schedule, start the exam, and write the note from the encounter workspace."
        action={{
          label: "Back to Records",
          onClick: () => router.push("/records"),
          icon: ArrowLeft,
        }}
      />
    );
  }

  if (patientLoading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card p-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading patient...
      </div>
    );
  }

  if (patientError || !patient) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Unable to load patient"
        description={
          patientError?.message ??
          "Choose a patient from Records before creating a SOAP note."
        }
        action={{
          label: "Back to Records",
          onClick: () => router.push("/records"),
          icon: ArrowLeft,
        }}
      />
    );
  }

  return (
    <div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => router.push(returnPath)}
        className="mb-4"
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to visit
      </Button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-heading text-xl font-semibold">New SOAP Note</h2>
          {patient && (
            <p className="text-sm text-muted-foreground">
              Patient: {patient.name}
              {patient.species
                ? ` - ${patient.species.charAt(0).toUpperCase() + patient.species.slice(1)}`
                : ""}
              {patient.breed ? ` (${patient.breed})` : ""}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            This note will be linked to the current appointment.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <CapturePhotos patientId={params.patientId} />
            <Button
              variant="outline"
              size="sm"
              onClick={handleDraftWithAi}
              disabled={!aiConfigured || draftWithAi.isPending}
            >
              {draftWithAi.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="mr-2 h-4 w-4" />
              )}
              {draftWithAi.isPending ? "Drafting..." : "Draft with AI"}
            </Button>
          </div>
          {!aiConfigured && !agentStatus.isLoading && (
            <p className="text-xs text-muted-foreground">
              AI is not set up yet. Ask your admin to add an AI key.
            </p>
          )}
        </div>
      </div>

      <div className="mt-6 space-y-6">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
            <div className="w-full lg:max-w-sm">
              <label className="mb-1 block text-sm font-medium">
                SOAP Template
              </label>
              <select
                value={selectedTemplateId}
                onChange={(event) => setSelectedTemplateId(event.target.value)}
                className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              >
                {SOAP_NOTE_TEMPLATES.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            </div>
            {canSave && (
              <label className="flex min-h-10 items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm">
                <Checkbox
                  checked={replaceTemplateContent}
                  onChange={(event) =>
                    setReplaceTemplateContent(event.target.checked)
                  }
                />
                Replace existing content
              </label>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={handleApplyTemplate}
              disabled={!selectedTemplate}
            >
              <ClipboardList className="mr-2 h-4 w-4" />
              Apply template
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card p-6 space-y-6">
          {/* Subjective */}
          <div>
            <label className="block text-sm font-medium mb-1.5">
              Subjective
            </label>
            <p className="text-xs text-muted-foreground mb-2">
              Owner&apos;s complaint, history, and symptoms reported
            </p>
            <SoapNoteEditor
              value={subjective}
              onChange={setSubjective}
              placeholder="What the owner reports..."
            />
          </div>

          {/* Objective */}
          <div>
            <label className="block text-sm font-medium mb-1.5">
              Objective
            </label>
            <p className="text-xs text-muted-foreground mb-2">
              Physical examination findings, vitals, and test results
            </p>
            <SoapNoteEditor
              value={objective}
              onChange={setObjective}
              placeholder="Physical exam findings, vitals, lab results..."
            />
          </div>

          {/* Assessment */}
          <div>
            <label className="block text-sm font-medium mb-1.5">
              Assessment
            </label>
            <p className="text-xs text-muted-foreground mb-2">
              Diagnosis or differential diagnoses
            </p>
            <SoapNoteEditor
              value={assessment}
              onChange={setAssessment}
              placeholder="Diagnosis, differential diagnoses..."
            />
          </div>

          {/* Plan */}
          <div>
            <label className="block text-sm font-medium mb-1.5">
              Plan
            </label>
            <p className="text-xs text-muted-foreground mb-2">
              Treatment plan, medications, follow-up instructions
            </p>
            <SoapNoteEditor
              value={plan}
              onChange={setPlan}
              placeholder="Treatment plan, medications, follow-up..."
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3">
          <Button
            onClick={handleSave}
            disabled={createNote.isPending || !canSave}
          >
            <Save className="mr-2 h-4 w-4" />
            {createNote.isPending ? "Saving..." : "Save Note"}
          </Button>
          {!canSave && (
            <p className="text-sm text-muted-foreground">
              Add at least one section to save this note.
            </p>
          )}
          <Button variant="outline" onClick={() => router.push(returnPath)}>
            Cancel
          </Button>
          {createNote.isError && (
            <p className="text-sm text-destructive">
              Failed to save: {createNote.error.message}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
