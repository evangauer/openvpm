"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import { formatClinicalDateTime } from "@/lib/records/clinical-dates";
import { useOnlineStatus } from "@/lib/use-online-status";
import { useOfflineNoteDraft } from "@/lib/records/use-offline-note-draft";
import type { NoteDraftScope } from "@/lib/records/offline-note-draft";
import { OfflineNoteDraftControls } from "./offline-note-draft-controls";
import {
  PATIENT_NOTE_LABELS,
  PATIENT_NOTE_MAX_LENGTH,
  PATIENT_NOTE_TYPES,
} from "@/lib/records/patient-note-policy";

export function PatientNotes({
  patientId,
  timeZone,
  canWrite,
  draftScope = null,
}: {
  patientId: string;
  timeZone: string | null;
  canWrite: boolean;
  draftScope?: NoteDraftScope | null;
}) {
  const recovery = useOfflineNoteDraft(canWrite ? draftScope : null);
  const { content, noteType, operationId } = recovery.draft;
  const isOnline = useOnlineStatus();
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const utils = trpc.useUtils();
  const notes = trpc.patientNotes.list.useInfiniteQuery(
    { patientId },
    { getNextPageParam: (page) => page.nextCursor },
  );
  // Do not leave a paused mutation holding the editor or replay it silently.
  // Browser connectivity is only a hint; server failures still preserve the draft.
  const create = trpc.patientNotes.create.useMutation({
    networkMode: "always",
    retry: false,
  });
  useUnsavedChangesGuard(
    Boolean(content) || saving,
    "This note has not been saved to the chart. Leave this page?",
  );
  const tooLong = content.trim().length > PATIENT_NOTE_MAX_LENGTH;
  const editorLocked =
    saving ||
    Boolean(operationId) ||
    recovery.busy ||
    recovery.mode === "locked" ||
    recovery.mode === "loading";

  async function save() {
    const text = content.trim();
    if (
      !text ||
      tooLong ||
      savingRef.current ||
      !isOnline ||
      !canWrite ||
      recovery.mode === "locked" ||
      recovery.mode === "loading"
    )
      return;
    savingRef.current = true;
    setSaving(true);
    try {
      const pending = await recovery.beginSave();
      await create.mutateAsync({
        patientId,
        ...pending,
      });
      await recovery.acknowledgeSave();
      toast.success("Chart note saved");
      await Promise.all([
        notes.refetch(),
        utils.records.searchPatientHistory.invalidate({ patientId }),
      ]);
    } catch {
      /* Mutation error is shown next to the preserved draft. */
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <section
      id="patient-notes"
      className="mt-6 space-y-4 rounded-lg border border-border bg-card p-4"
      aria-labelledby="patient-notes-heading"
    >
      <div>
        <h3 id="patient-notes-heading" className="font-heading font-semibold">
          Chart notes
        </h3>
        <p className="text-sm text-muted-foreground">
          General updates, phone calls and follow-ups. No appointment needed.
        </p>
      </div>
      {canWrite ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          className="space-y-3"
        >
          <OfflineNoteDraftControls
            recovery={recovery}
            disabled={saving || Boolean(operationId)}
          />
          {!isOnline ? (
            <p role="status" className="text-sm text-muted-foreground">
              You are offline. Keep writing here, then save to the chart when
              your connection returns.
            </p>
          ) : null}
          <label className="block text-sm font-medium">
            Note type
            <select
              value={noteType}
              onChange={(event) =>
                recovery.update({
                  noteType: event.target.value as typeof noteType,
                })
              }
              disabled={editorLocked}
              className="mt-1 block h-10 rounded-md border border-input bg-background px-3"
            >
              {PATIENT_NOTE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {PATIENT_NOTE_LABELS[type]}
                </option>
              ))}
            </select>
          </label>
          <label
            className="block text-sm font-medium"
            htmlFor="patient-note-content"
          >
            Chart note
          </label>
          <textarea
            id="patient-note-content"
            value={content}
            onChange={(event) =>
              recovery.update({ content: event.target.value })
            }
            readOnly={editorLocked}
            rows={6}
            placeholder="Type or paste the note here..."
            className="block w-full rounded-md border border-input bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-describedby="patient-note-help"
          />
          <p id="patient-note-help" className="text-xs text-muted-foreground">
            Saved with your name and the current date. Saved notes stay in the
            chart; use a new note for a correction. Visit SOAP notes remain in
            Medical Records.
          </p>
          {tooLong ? (
            <p role="alert" className="text-sm text-destructive">
              The note exceeds {PATIENT_NOTE_MAX_LENGTH.toLocaleString()}{" "}
              characters. Shorten it before saving; your text has been kept.
            </p>
          ) : null}
          {create.error ? (
            <p role="alert" className="text-sm text-destructive">
              {create.error.message} Your note has been kept. You can retry
              saving.
            </p>
          ) : null}
          {operationId && !saving ? (
            <p role="status" className="text-sm text-muted-foreground">
              Save not yet confirmed. Retry this same note before making
              changes; a previous attempt may already have reached the chart.
            </p>
          ) : null}
          <Button
            type="submit"
            disabled={
              !content.trim() ||
              tooLong ||
              saving ||
              !isOnline ||
              recovery.busy ||
              recovery.mode === "locked" ||
              recovery.mode === "loading"
            }
          >
            {saving
              ? "Saving note..."
              : operationId
                ? "Retry chart note save"
                : "Save chart note"}
          </Button>
        </form>
      ) : null}
      {notes.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading chart notes...</p>
      ) : notes.error ? (
        <div role="alert">
          <p className="text-sm text-destructive">
            Unable to load chart notes. {notes.error.message}
          </p>
          <Button variant="outline" onClick={() => void notes.refetch()}>
            Retry loading notes
          </Button>
        </div>
      ) : !notes.data?.pages[0]?.items.length ? (
        <p className="text-sm text-muted-foreground">No chart notes yet.</p>
      ) : (
        notes.data.pages
          .flatMap((page) => page.items)
          .map((note) => (
            <article
              key={note.id}
              className="space-y-2 border-t border-border pt-4"
            >
              <div className="flex flex-wrap justify-between gap-2 text-sm">
                <strong>{PATIENT_NOTE_LABELS[note.noteType]}</strong>
                <span className="text-muted-foreground">
                  {note.authorName ?? "Unknown author"} ·{" "}
                  {formatClinicalDateTime(note.createdAt, timeZone)}
                </span>
              </div>
              <p className="whitespace-pre-wrap break-words text-sm">
                {note.content}
              </p>
            </article>
          ))
      )}
      {notes.hasNextPage ? (
        <Button
          variant="outline"
          disabled={notes.isFetchingNextPage}
          onClick={() => void notes.fetchNextPage()}
        >
          {notes.isFetchingNextPage ? "Loading..." : "Load older notes"}
        </Button>
      ) : null}
    </section>
  );
}
