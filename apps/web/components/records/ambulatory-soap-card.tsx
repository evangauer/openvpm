"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import {
  SOAP_SECTION_MAX_LENGTH,
  soapSectionText,
} from "@/lib/records/soap-content";
import { useOnlineStatus } from "@/lib/use-online-status";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";

type SoapSections = {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
};

const EMPTY_SECTIONS: SoapSections = {
  subjective: "",
  objective: "",
  assessment: "",
  plan: "",
};

const SECTION_FIELDS: ReadonlyArray<{
  name: keyof SoapSections;
  label: string;
  placeholder: string;
}> = [
  {
    name: "subjective",
    label: "Subjective",
    placeholder: "History, presenting concern, owner observations",
  },
  {
    name: "objective",
    label: "Objective",
    placeholder: "Exam findings and field observations",
  },
  {
    name: "assessment",
    label: "Assessment",
    placeholder: "Problems, differentials, diagnosis",
  },
  {
    name: "plan",
    label: "Plan",
    placeholder: "Treatment, prescriptions, monitoring, follow-up",
  },
];

export function AmbulatorySoapCard({
  patientId,
  appointmentId,
  canWrite,
  visitOpen,
  linkedSoapCount,
  onPlanChange,
}: {
  patientId: string;
  appointmentId: string;
  canWrite: boolean;
  visitOpen: boolean;
  linkedSoapCount: number;
  onPlanChange?: (plan: string) => void;
}) {
  const utils = trpc.useUtils();
  const isOnline = useOnlineStatus();
  const [sections, setSections] = useState<SoapSections>({ ...EMPTY_SECTIONS });
  const [dirty, setDirty] = useState(false);
  const initializedDraftRef = useRef<string | null>(null);
  const draftQuery = trpc.records.getSoapDraft.useQuery(
    { patientId, appointmentId },
    { enabled: canWrite && linkedSoapCount === 0 },
  );
  const finalizedNotesQuery = trpc.records.listSoapNotes.useQuery(
    { patientId },
    { enabled: linkedSoapCount > 0 },
  );
  const draft = draftQuery.data;
  const finalizedVisitNote = finalizedNotesQuery.data?.find(
    (note) =>
      note.appointmentId === appointmentId &&
      note.status === "finalized" &&
      !note.correctionAction,
  );
  const finalizedVisitPlan = finalizedVisitNote
    ? soapSectionText(finalizedVisitNote.plan)
    : null;

  useEffect(() => {
    const draftKey = draft ? `${draft.id}:${draft.revision}` : "empty";
    if (dirty || initializedDraftRef.current === draftKey) return;
    setSections(
      draft
        ? {
            subjective: soapSectionText(draft.subjective),
            objective: soapSectionText(draft.objective),
            assessment: soapSectionText(draft.assessment),
            plan: soapSectionText(draft.plan),
          }
        : { ...EMPTY_SECTIONS },
    );
    initializedDraftRef.current = draftKey;
  }, [dirty, draft]);

  useEffect(() => {
    if (linkedSoapCount > 0) {
      if (finalizedVisitPlan !== null) {
        onPlanChange?.(finalizedVisitPlan);
      }
      return;
    }
    onPlanChange?.(sections.plan);
  }, [finalizedVisitPlan, linkedSoapCount, onPlanChange, sections.plan]);

  useUnsavedChangesGuard(
    dirty,
    "SOAP changes have not been saved on the server. Leave and lose these values?",
  );

  const saveDraft = trpc.records.saveSoapDraft.useMutation({
    onSuccess: async (saved) => {
      if (saved.outcome === "saved") {
        initializedDraftRef.current = `${saved.draft.id}:${saved.draft.revision}`;
        utils.records.getSoapDraft.setData(
          { patientId, appointmentId },
          saved.draft,
        );
        setDirty(false);
        toast.success("SOAP draft saved");
      } else if (saved.outcome === "conflict") {
        toast.error(
          "SOAP changed in another session. Refresh before saving again.",
        );
      } else {
        setDirty(false);
        toast.info("SOAP was already finalized in another session.");
      }
      await Promise.all([
        utils.records.getSoapDraft.invalidate({ patientId, appointmentId }),
        utils.encounters.getCloseout.invalidate({ appointmentId }),
      ]);
    },
    onError: (error) => toast.error(error.message),
  });
  const finalize = trpc.records.finalizeSoapNote.useMutation({
    onSuccess: async () => {
      setDirty(false);
      await Promise.all([
        utils.records.getSoapDraft.invalidate({ patientId, appointmentId }),
        utils.records.listSoapNotes.invalidate({ patientId }),
        utils.encounters.getCloseout.invalidate({ appointmentId }),
      ]);
      toast.success("SOAP note finalized");
    },
    onError: (error) => toast.error(error.message),
  });

  const hasContent = Object.values(sections).some(
    (value) => value.trim().length > 0,
  );
  const stateReady = !draftQuery.isLoading && !draftQuery.error;
  const canSave =
    canWrite &&
    visitOpen &&
    isOnline &&
    stateReady &&
    dirty &&
    hasContent &&
    !saveDraft.isPending &&
    !finalize.isPending;

  async function persistDraft() {
    if (!canSave) return draft ?? null;
    try {
      const result = await saveDraft.mutateAsync({
        patientId,
        appointmentId,
        noteId: draft?.id,
        expectedRevision: draft?.revision ?? 0,
        ...sections,
      });
      return result.outcome === "saved" ? result.draft : null;
    } catch {
      return null;
    }
  }

  async function finalizeNote() {
    if (!isOnline || !visitOpen || !hasContent || finalize.isPending) return;
    try {
      const saved = dirty ? await persistDraft() : draft;
      if (!saved) return;
      await finalize.mutateAsync({
        patientId,
        appointmentId,
        noteId: saved.id,
        expectedRevision: saved.revision,
      });
    } catch {
      // Mutation handlers surface the server error while preserving local text.
    }
  }

  return (
    <Card id="ambulatory-soap" className="scroll-mt-4">
      <CardHeader>
        <div className="flex items-start gap-3">
          <FileText className="mt-0.5 h-5 w-5 text-primary" />
          <div>
            <CardTitle>SOAP note</CardTitle>
            <CardDescription>
              Document the visit here without leaving the field workspace.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {linkedSoapCount > 0 ? (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm">
            Finalized SOAP documentation is linked to this visit.
          </div>
        ) : !canWrite ? (
          <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
            Only an administrator or veterinarian can author the SOAP note.
          </div>
        ) : draftQuery.error ? (
          <div className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive">
            SOAP draft state could not be verified. Entry is locked to avoid
            overwriting another clinician’s work.
          </div>
        ) : draftQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading SOAP draft...
          </div>
        ) : (
          <>
            {!isOnline ? (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
                Offline — keep this page open. These values are not saved until
                the server confirms them.
              </div>
            ) : null}
            <div className="grid gap-4 lg:grid-cols-2">
              {SECTION_FIELDS.map((field) => (
                <label key={field.name} className="space-y-1.5">
                  <span className="text-sm font-medium">{field.label}</span>
                  <Textarea
                    value={sections[field.name]}
                    maxLength={SOAP_SECTION_MAX_LENGTH}
                    rows={6}
                    disabled={
                      !visitOpen || saveDraft.isPending || finalize.isPending
                    }
                    placeholder={field.placeholder}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setSections((current) => ({
                        ...current,
                        [field.name]: value,
                      }));
                      setDirty(true);
                    }}
                  />
                </label>
              ))}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={!canSave}
                onClick={() => void persistDraft()}
              >
                {saveDraft.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                Save draft
              </Button>
              <Button
                type="button"
                disabled={
                  !visitOpen ||
                  !isOnline ||
                  !stateReady ||
                  !hasContent ||
                  saveDraft.isPending ||
                  finalize.isPending
                }
                onClick={() => void finalizeNote()}
              >
                {finalize.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Finalize SOAP note
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
