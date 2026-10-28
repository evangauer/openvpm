"use client";

import { useEffect, useRef, useState } from "react";
import {
  EMPTY_NOTE_DRAFT,
  hasOfflineNoteDraft,
  OfflineNoteVault,
  type NoteDraftScope,
  type OfflineNoteDraft,
} from "./offline-note-draft";

type Mode = "off" | "loading" | "locked" | "bypassed" | "ready" | "unavailable";
export function useOfflineNoteDraft(scope: NoteDraftScope | null) {
  const enabled =
    process.env.NEXT_PUBLIC_OFFLINE_CHART_DRAFTS_ENABLED === "true" &&
    Boolean(scope);
  const [draft, setDraft] = useState<OfflineNoteDraft>({ ...EMPTY_NOTE_DRAFT });
  const current = useRef(draft);
  const vault = useRef<OfflineNoteVault | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const version = useRef(0);
  const [mode, setMode] = useState<Mode>(enabled ? "loading" : "off");
  const [busy, setBusy] = useState(false);
  const [localStatus, setLocalStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [message, setMessage] = useState<string | null>(null);
  const practiceId = scope?.practiceId;
  const userId = scope?.userId;
  const patientId = scope?.patientId;

  useEffect(() => {
    mounted.current = true;
    let active = true;
    if (enabled && practiceId && userId && patientId) {
      void hasOfflineNoteDraft({ practiceId, userId, patientId })
        .then((exists) => {
          if (active) setMode(exists ? "locked" : "off");
        })
        .catch(() => {
          if (!active) return;
          setMode("unavailable");
          setMessage(
            "Device draft recovery is unavailable in this browser. Keep this tab open until your note is saved to the chart.",
          );
        });
    }
    return () => {
      active = false;
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      // Dropping the non-extractable key locks recovery after navigation/sign-out.
      vault.current = null;
    };
  }, [enabled, practiceId, userId, patientId]);

  async function persist(snapshot: OfflineNoteDraft) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const target = vault.current;
    if (!target) return;
    const writing = ++version.current;
    setLocalStatus("saving");
    try {
      await target.save(snapshot);
      if (mounted.current && writing === version.current) {
        setLocalStatus("saved");
        setMessage(null);
      }
    } catch (error) {
      if (mounted.current) {
        setLocalStatus("error");
        setMessage(
          error instanceof Error
            ? error.message
            : "Unable to keep a device copy. Keep this tab open.",
        );
      }
      throw error;
    }
  }

  function update(
    change: Partial<Pick<OfflineNoteDraft, "content" | "noteType">>,
  ) {
    if (current.current.operationId) return;
    current.current = { ...current.current, ...change };
    setDraft(current.current);
    if (!vault.current) return;
    version.current++;
    setLocalStatus("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void persist(current.current).catch(() => undefined);
    }, 350);
  }

  async function unlock(passphrase: string) {
    if (!scope || !enabled || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const opened = await OfflineNoteVault.unlock(scope, passphrase);
      if (!mounted.current) return;
      if (opened.draft && current.current.content) {
        throw new Error(
          "There is already a device draft. Keep a copy of your current text and clear the editor before unlocking it.",
        );
      }
      vault.current = opened.vault;
      if (opened.draft) {
        current.current = opened.draft;
        setDraft(opened.draft);
      }
      setMode("ready");
      await persist(current.current);
    } catch (error) {
      if (mounted.current)
        setMessage(
          error instanceof Error
            ? error.message
            : "Unable to unlock the device draft.",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function beginSave() {
    if (mode === "locked" || mode === "loading")
      throw new Error("Unlock the device draft first.");
    if (!current.current.operationId) {
      current.current = {
        ...current.current,
        content: current.current.content.trim(),
        operationId: crypto.randomUUID(),
      };
      setDraft(current.current);
    }
    // Persist the retry identity BEFORE the server request, including when a reply is lost.
    await persist(current.current);
    return { ...current.current, operationId: current.current.operationId! };
  }

  function startSeparateNote() {
    if (mode !== "locked" || busy) return;
    // Keep the locked ciphertext untouched; a forgotten passphrase must not
    // prevent ordinary chart work. Reopening offers recovery again.
    setMode("bypassed");
    setMessage(null);
  }

  async function acknowledgeSave() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    try {
      await vault.current?.clear();
      if (mounted.current) {
        setLocalStatus("idle");
        setMessage(null);
      }
    } catch {
      // The encrypted retry identity remains valid if cleanup fails. A recovered retry
      // is acknowledged by the server without appending a second note.
      if (mounted.current) {
        setLocalStatus("error");
        setMessage(
          "The note is saved in the chart, but this browser could not remove its device copy. Reopen the chart before writing another note.",
        );
      }
    }
    if (mounted.current) {
      current.current = { ...EMPTY_NOTE_DRAFT };
      setDraft(current.current);
    }
  }

  return {
    enabled,
    draft,
    update,
    mode,
    busy,
    localStatus,
    message,
    unlock,
    startSeparateNote,
    beginSave,
    acknowledgeSave,
  };
}
