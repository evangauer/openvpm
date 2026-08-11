"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  ChevronDown,
  FileSpreadsheet,
  Loader2,
  PlugZap,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  isOnboardingImportModeLocked,
  isOnboardingMigrationSourceLocked,
  lastCommittedImportIndex,
  nextOnboardingImportMode,
  onboardingImportChangeCount,
  summarizeOnboardingImports,
  type OnboardingImportCommit,
  type OnboardingImportCommits,
  type OnboardingImportSelections,
  type OnboardingImportSummary,
} from "@/lib/import/onboarding-workflow";
import {
  IMPORT_CSV_MAX_BYTES,
  isImportCsvSizeValid,
} from "@/lib/import/policy";
import {
  isValidMigrationSource,
  MIGRATION_SOURCES,
  MIGRATION_STEPS,
  migrationSourceExportHint,
  migrationSourceName,
  type MigrationImportMode,
} from "@/lib/import/sources";
import { getOnboardingIntentOption } from "@/lib/onboarding/intent";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import type { StepProps } from "../journey-types";
import { MigrationHelpRequest } from "../migration-help-request";

type Choice = "import" | "api" | "keep";
type CsvPreview = {
  previewToken: string;
  total: number;
  willInsert: number;
  willReconcile?: number;
  duplicates?: number;
  unmatchedClient?: number;
  unmatchedPatient?: number;
  errors: string[];
};
type CsvPreviews = Partial<Record<MigrationImportMode, CsvPreview>>;
type CsvMeta = { hasContent: boolean; sizeValid: boolean };
type ImportResponse = {
  dryRun?: boolean;
  previewToken?: string;
  total?: number;
  willInsert?: number;
  willReconcile?: number;
  duplicates?: number;
  unmatchedClient?: number;
  unmatchedPatient?: number;
  imported?: number;
  reconciled?: number;
  alreadyCommitted?: boolean;
  errors: string[];
};

const IMPORT_CSV_SIZE_MESSAGE = "CSV imports must be 5 MB or less.";

const textareaClass =
  "w-full resize-y rounded-md border border-input bg-background p-3 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

const fileInputClass =
  "block w-full text-xs text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-emerald-600 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white hover:file:bg-emerald-700";

function importMap<T>(create: () => T): Record<MigrationImportMode, T> {
  return Object.fromEntries(
    MIGRATION_STEPS.map(({ mode }) => [mode, create()]),
  ) as Record<MigrationImportMode, T>;
}

function migrationModeLabels(modes: readonly MigrationImportMode[]): string {
  return modes
    .map(
      (mode) =>
        MIGRATION_STEPS.find((step) => step.mode === mode)?.label ?? mode,
    )
    .join(", ");
}

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.readAsText(file);
  });
}

function isPreviewConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const data = "data" in error ? error.data : null;
  return Boolean(
    data &&
    typeof data === "object" &&
    "code" in data &&
    data.code === "CONFLICT",
  );
}

function downloadIssueReport(errors: string[], fileName: string) {
  const blob = new Blob([`${errors.join("\n")}\n`], {
    type: "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Step 4: choose how real data gets in. Every supplied file is processed in
 * dependency order and gets its own server preview before an explicit commit.
 */
export function BringDataStep({ register, state, setState }: StepProps) {
  const pathway = getOnboardingIntentOption(state.onboardingIntent);
  const utils = trpc.useUtils();
  const importClientsCsv = trpc.data.importClientsCsv.useMutation();
  const importPatientsCsv = trpc.data.importPatientsCsv.useMutation();
  const importVaccinationsCsv = trpc.data.importVaccinationsCsv.useMutation();
  const importSoapNotesCsv = trpc.data.importSoapNotesCsv.useMutation();

  const [choice, setChoice] = useState<Choice>(
    state.hasImportedData || (state.migrationCompletedModes?.length ?? 0) > 0
      ? "import"
      : "keep",
  );
  const [historyExpanded, setHistoryExpanded] = useState(
    pathway.value === "replace",
  );
  const [migrationSource, setMigrationSource] = useState<string>(() =>
    isValidMigrationSource(state.migrationSource)
      ? state.migrationSource
      : "other",
  );
  const [knownCompletedModes, setKnownCompletedModes] = useState<
    MigrationImportMode[]
  >(() =>
    MIGRATION_STEPS.flatMap(({ mode }) =>
      state.migrationCompletedModes?.includes(mode) ? [mode] : [],
    ),
  );
  const [csvByMode, setCsvByMode] = useState(() => importMap(() => ""));
  const [csvMetaByMode, setCsvMetaByMode] = useState(() =>
    importMap<CsvMeta>(() => ({ hasContent: false, sizeValid: true })),
  );
  const [fileNameByMode, setFileNameByMode] = useState(() =>
    importMap(() => ""),
  );
  const [previewByMode, setPreviewByMode] = useState<CsvPreviews>({});
  const [committedByMode, setCommittedByMode] =
    useState<OnboardingImportCommits>({});
  const [fileReadPending, setFileReadPending] = useState(() =>
    importMap(() => false),
  );
  const [importRecoveryMessage, setImportRecoveryMessage] = useState("");
  const [result, setResult] = useState<OnboardingImportSummary | null>(null);
  const importReviewVersionRef = useRef(0);
  const fileReadVersionRef = useRef(importMap(() => 0));

  const importing =
    importClientsCsv.isPending ||
    importPatientsCsv.isPending ||
    importVaccinationsCsv.isPending ||
    importSoapNotesCsv.isPending;
  const readingFiles = Object.values(fileReadPending).some(Boolean);
  const importInputsBusy = importing || readingFiles;
  const lastCommittedIndex = lastCommittedImportIndex(committedByMode);
  const migrationSourceLocked = isOnboardingMigrationSourceLocked(
    state.migrationSourceHasCommittedChanges === true,
    committedByMode,
  );

  function clearAllImportReview() {
    importReviewVersionRef.current += 1;
    setPreviewByMode({});
    setCommittedByMode({});
    setImportRecoveryMessage("");
    setResult(null);
  }

  function clearReviewFrom(mode: MigrationImportMode) {
    importReviewVersionRef.current += 1;
    const start = MIGRATION_STEPS.findIndex((step) => step.mode === mode);
    setPreviewByMode(
      (current) =>
        Object.fromEntries(
          Object.entries(current).filter(([key]) => {
            const index = MIGRATION_STEPS.findIndex(
              (step) => step.mode === key,
            );
            return index < start;
          }),
        ) as CsvPreviews,
    );
    setCommittedByMode(
      (current) =>
        Object.fromEntries(
          Object.entries(current).filter(([key]) => {
            const index = MIGRATION_STEPS.findIndex(
              (step) => step.mode === key,
            );
            return index < start;
          }),
        ) as OnboardingImportCommits,
    );
    setImportRecoveryMessage("");
    setResult(null);
  }

  function updateCsv(mode: MigrationImportMode, value: string) {
    fileReadVersionRef.current[mode] += 1;
    setFileReadPending((current) => ({ ...current, [mode]: false }));
    setCsvByMode((current) => ({ ...current, [mode]: value }));
    setCsvMetaByMode((current) => ({
      ...current,
      [mode]: {
        hasContent: value.trim().length > 0,
        sizeValid: isImportCsvSizeValid(value),
      },
    }));
    setFileNameByMode((current) => ({ ...current, [mode]: "" }));
    clearReviewFrom(mode);
  }

  function invalidatePendingFileReads() {
    for (const { mode } of MIGRATION_STEPS) {
      fileReadVersionRef.current[mode] += 1;
    }
    setFileReadPending(importMap(() => false));
  }

  async function onPickFile(
    event: React.ChangeEvent<HTMLInputElement>,
    mode: MigrationImportMode,
  ) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    // Let a clinic select the same path again after fixing the file externally.
    input.value = "";
    clearReviewFrom(mode);
    setFileReadPending((current) => ({ ...current, [mode]: true }));
    const readVersion = ++fileReadVersionRef.current[mode];

    function finishFileRead() {
      setFileReadPending((current) => ({ ...current, [mode]: false }));
    }

    function clearPickedFile() {
      setCsvByMode((current) => ({ ...current, [mode]: "" }));
      setCsvMetaByMode((current) => ({
        ...current,
        [mode]: { hasContent: false, sizeValid: true },
      }));
      setFileNameByMode((current) => ({ ...current, [mode]: "" }));
      finishFileRead();
    }

    if (file.size > IMPORT_CSV_MAX_BYTES) {
      clearPickedFile();
      toast.error(IMPORT_CSV_SIZE_MESSAGE);
      return;
    }

    try {
      const text = await readFileText(file);
      if (fileReadVersionRef.current[mode] !== readVersion) return;
      if (!text.trim()) {
        clearPickedFile();
        toast.error("CSV file is empty.");
        return;
      }
      if (!isImportCsvSizeValid(text)) {
        clearPickedFile();
        toast.error(IMPORT_CSV_SIZE_MESSAGE);
        return;
      }
      setCsvByMode((current) => ({ ...current, [mode]: text }));
      setCsvMetaByMode((current) => ({
        ...current,
        [mode]: { hasContent: text.trim().length > 0, sizeValid: true },
      }));
      setFileNameByMode((current) => ({ ...current, [mode]: file.name }));
      finishFileRead();
    } catch {
      if (fileReadVersionRef.current[mode] !== readVersion) return;
      finishFileRead();
      toast.error("Could not read that file. Try again.");
    }
  }

  async function runImport(
    mode: MigrationImportMode,
    input: {
      csv: string;
      dryRun: boolean;
      source: typeof migrationSource;
      previewToken?: string;
      migrationProtocol: "reviewed-v1";
    },
  ): Promise<ImportResponse> {
    if (mode === "clients") return importClientsCsv.mutateAsync(input);
    if (mode === "patients") return importPatientsCsv.mutateAsync(input);
    if (mode === "vaccinations")
      return importVaccinationsCsv.mutateAsync(input);
    return importSoapNotesCsv.mutateAsync(input);
  }

  async function finishStage(
    mode: MigrationImportMode,
    committed: OnboardingImportCommit,
  ) {
    const completedChanges = committed.imported + committed.reconciled;
    const committedAt = new Date().toISOString();
    const nextKnownCompletedModes = MIGRATION_STEPS.flatMap(
      ({ mode: currentMode }) =>
        knownCompletedModes.includes(currentMode) || currentMode === mode
          ? [currentMode]
          : [],
    );
    setKnownCompletedModes(nextKnownCompletedModes);
    utils.settings.getOnboardingState.setData(undefined, (previous) =>
      previous
        ? {
            ...previous,
            migrationSource,
            migrationCompletedModes: nextKnownCompletedModes,
            ...(completedChanges > 0
              ? {
                  migrationHasCommittedChanges: true,
                  migrationSourceHasCommittedChanges: true,
                  migrationLastCommittedAt: committedAt,
                }
              : {}),
          }
        : previous,
    );
    void utils.settings.getOnboardingState.invalidate();
    setState({
      migrationSource,
      migrationCompletedModes: nextKnownCompletedModes,
      ...(completedChanges > 0
        ? {
            keepSampleData: false,
            hasImportedData: true,
            migrationSourceHasCommittedChanges: true,
          }
        : {}),
    });
    const nextCommitted = { ...committedByMode, [mode]: committed };
    setCommittedByMode(nextCommitted);
    setPreviewByMode((current) => ({ ...current, [mode]: undefined }));
    const selectedByMode = Object.fromEntries(
      MIGRATION_STEPS.map(({ mode }) => [mode, csvMetaByMode[mode].hasContent]),
    ) as OnboardingImportSelections;
    const nextMode = nextOnboardingImportMode(selectedByMode, nextCommitted);
    if (nextMode) {
      const currentLabel = MIGRATION_STEPS.find(
        (step) => step.mode === mode,
      )!.label;
      const nextLabel = MIGRATION_STEPS.find(
        (step) => step.mode === nextMode,
      )!.shortLabel;
      setImportRecoveryMessage(
        `${currentLabel} complete (${completedChanges} changes). Check the ${nextLabel} file next.`,
      );
      return;
    }

    const summary = summarizeOnboardingImports(nextCommitted);
    setImportRecoveryMessage("");
    setResult(summary);
    const changeCount = onboardingImportChangeCount(summary);
    toast.success(
      changeCount > 0
        ? `${changeCount.toLocaleString()} clinic record changes completed`
        : "Import review complete",
    );
  }

  const csvSizeErrors = MIGRATION_STEPS.flatMap(({ mode, label }) =>
    csvMetaByMode[mode].sizeValid ? [] : [`${label} CSV must be 5 MB or less.`],
  );
  const hasImportCsvSizeError = csvSizeErrors.length > 0;
  const selectedByMode = Object.fromEntries(
    MIGRATION_STEPS.map(({ mode }) => [mode, csvMetaByMode[mode].hasContent]),
  ) as OnboardingImportSelections;
  const hasImportCsv = Object.values(selectedByMode).some(Boolean);
  const activeMode = nextOnboardingImportMode(selectedByMode, committedByMode);
  const activeStep = activeMode
    ? MIGRATION_STEPS.find((step) => step.mode === activeMode)!
    : null;
  const activePreview = activeMode ? previewByMode[activeMode] : undefined;
  const previewChangeCount = activePreview
    ? activePreview.willInsert + (activePreview.willReconcile ?? 0)
    : 0;
  const previewReady = Object.values(previewByMode).some(Boolean);
  const continueLabel =
    choice !== "import" || !hasImportCsv || result
      ? "Continue"
      : !activeStep
        ? "Finish import review"
        : !activePreview
          ? `Check ${activeStep.shortLabel} file`
          : previewChangeCount > 0
            ? `Import ${previewChangeCount.toLocaleString()} ${activeStep.shortLabel} ${previewChangeCount === 1 ? "change" : "changes"}`
            : activePreview.total === 0
              ? `Skip ${activeStep.shortLabel} file`
              : `Confirm no ${activeStep.shortLabel} changes`;

  const currentSummary = summarizeOnboardingImports(committedByMode);
  const hasImportedRows =
    choice === "import" && onboardingImportChangeCount(currentSummary) > 0;
  const hasCommittedStages = Object.keys(committedByMode).length > 0;
  useEffect(() => {
    setState({
      keepSampleData: state.keepSampleData && !hasImportedRows,
      hasPartialImport: hasCommittedStages && !result,
    });
  }, [
    hasCommittedStages,
    hasImportedRows,
    result,
    setState,
    state.keepSampleData,
  ]);

  useEffect(() => {
    register({
      continueLabel,
      continueDisabled: readingFiles,
      async onContinue() {
        if (choice !== "import") return true;
        if (!hasImportCsv) return true;
        if (result) return true;
        if (hasImportCsvSizeError) {
          toast.error(csvSizeErrors.join(" ") || IMPORT_CSV_SIZE_MESSAGE);
          return false;
        }
        if (!activeMode || !activeStep) return true;

        const csv = csvByMode[activeMode].trim();
        const reviewVersion = importReviewVersionRef.current;
        setImportRecoveryMessage("");

        if (!activePreview) {
          try {
            const response = await runImport(activeMode, {
              csv,
              dryRun: true,
              source: migrationSource,
              migrationProtocol: "reviewed-v1",
            });
            if (importReviewVersionRef.current !== reviewVersion) return false;
            if (
              response.dryRun !== true ||
              !response.previewToken ||
              typeof response.total !== "number" ||
              typeof response.willInsert !== "number"
            ) {
              throw new Error("The import preview response was incomplete.");
            }
            setPreviewByMode((current) => ({
              ...current,
              [activeMode]: {
                previewToken: response.previewToken!,
                total: response.total!,
                willInsert: response.willInsert!,
                willReconcile: response.willReconcile,
                duplicates: response.duplicates,
                unmatchedClient: response.unmatchedClient,
                unmatchedPatient: response.unmatchedPatient,
                errors: response.errors,
              },
            }));
            toast.success(
              `${activeStep.label} checked. Review the plan before importing.`,
            );
          } catch (error) {
            if (importReviewVersionRef.current !== reviewVersion) return false;
            setPreviewByMode((current) => ({
              ...current,
              [activeMode]: undefined,
            }));
            setImportRecoveryMessage(
              error instanceof Error && error.message.trim()
                ? error.message
                : `The ${activeStep.shortLabel} file was not checked. Check your connection and try again.`,
            );
          }
          return false;
        }

        try {
          const response = await runImport(activeMode, {
            csv,
            dryRun: false,
            source: migrationSource,
            previewToken: activePreview.previewToken,
            migrationProtocol: "reviewed-v1",
          });
          if (importReviewVersionRef.current !== reviewVersion) return false;
          if (response.dryRun === true) {
            throw new Error("The import commit response was incomplete.");
          }
          await finishStage(activeMode, {
            imported: response.imported ?? 0,
            reconciled: response.reconciled ?? 0,
            errors:
              response.alreadyCommitted && response.errors.length === 0
                ? activePreview.errors
                : response.errors,
          });
        } catch (error) {
          if (importReviewVersionRef.current !== reviewVersion) return false;
          if (isPreviewConflict(error)) {
            setPreviewByMode((current) => ({
              ...current,
              [activeMode]: undefined,
            }));
            setImportRecoveryMessage(
              `Nothing was imported from the ${activeStep.shortLabel} file because its preview expired or clinic records changed. Check the same file again. Earlier completed stages are safe.`,
            );
          } else {
            setImportRecoveryMessage(
              `We could not confirm the ${activeStep.shortLabel} import response. Retry the same import. It is safe and will not add the rows twice. Earlier completed stages are safe.`,
            );
          }
        }
        return false;
      },
    });
  }, [
    register,
    choice,
    hasImportCsv,
    result,
    hasImportCsvSizeError,
    csvSizeErrors,
    activeMode,
    activeStep,
    activePreview,
    previewChangeCount,
    csvByMode,
    csvMetaByMode,
    migrationSource,
    continueLabel,
    readingFiles,
    committedByMode,
    importClientsCsv,
    importPatientsCsv,
    importVaccinationsCsv,
    importSoapNotesCsv,
    setState,
    utils,
  ]);

  const selectedMigrationSourceName = migrationSourceName(migrationSource);
  const selectedMigrationSourceHint =
    migrationSourceExportHint(migrationSource);
  const isCustomMigrationSource = !MIGRATION_SOURCES.some(
    (source) => source.id === migrationSource,
  );
  const pathwayIntro =
    pathway.value === "alongside"
      ? "Start small: bring a few real records over while your current PIMS stays in place."
      : pathway.value === "replace"
        ? "Move in stages: check owners, pets, vaccines, and visit notes before your team changes live workflows."
        : pathway.value === "self_host"
          ? "The same import and export tools work in hosted and self-hosted OpenVPM."
          : "Keep the sample clinic as long as you need, or try an import when you are ready.";

  return (
    <div className="space-y-4">
      <p className="text-sm leading-6 text-slate-600">
        {pathwayIntro} You own your data and can export it any time.
      </p>

      <div className="grid gap-3">
        <ChoiceCard
          active={choice === "import"}
          icon={<FileSpreadsheet className="h-5 w-5" />}
          title="Import from a file"
          subtitle="Bring clients, pets, vaccine history, and visit notes."
          onClick={() => {
            if (
              importInputsBusy ||
              choice === "import" ||
              lastCommittedIndex >= 0 ||
              result
            )
              return;
            invalidatePendingFileReads();
            setChoice("import");
          }}
          disabled={
            importInputsBusy || lastCommittedIndex >= 0 || Boolean(result)
          }
        />
        {choice === "import" ? (
          <div className="space-y-4 rounded-lg border border-slate-200 bg-slate-50/70 p-4">
            <div className="space-y-1 text-xs text-slate-500">
              {knownCompletedModes.length > 0 ? (
                <p className="rounded-md border border-emerald-200 bg-emerald-50 p-3 font-medium text-emerald-900">
                  Already reviewed: {migrationModeLabels(knownCompletedModes)}.
                  Reselect only the files you still need to finish.{" "}
                  {migrationSourceLocked
                    ? `This migration will keep using ${selectedMigrationSourceName} so saved owner and patient IDs stay linked.`
                    : "No clinic records changed, so you can still choose a different source."}
                </p>
              ) : state.hasImportedData ? (
                <p className="rounded-md border border-emerald-200 bg-emerald-50 p-3 font-medium text-emerald-900">
                  Earlier import changes are already saved. If you are unsure
                  which file finished, reselecting it is safe because duplicate
                  rows are skipped.
                </p>
              ) : null}
              <p>
                Add any files you have. OpenVPM checks each one in order. No
                records import until you review that file's plan.
              </p>
              <p>
                Keep the same source for all four files so owner and patient IDs
                stay linked. Rows with issues are shown before you confirm.
              </p>
              <p>
                Completed stages stay saved. Unfinished files stay only in this
                setup, so reselect them if you leave and return.
              </p>
            </div>
            <label className="block space-y-1.5 text-sm font-medium text-slate-700">
              <span>Which system are you moving from?</span>
              <select
                value={migrationSource}
                disabled={importInputsBusy || migrationSourceLocked}
                onChange={(event) => {
                  const nextSource = event.target.value;
                  if (!isValidMigrationSource(nextSource)) return;
                  invalidatePendingFileReads();
                  setMigrationSource(nextSource);
                  setKnownCompletedModes([]);
                  clearAllImportReview();
                  setState({
                    migrationSource: nextSource,
                    migrationSourceHasCommittedChanges: false,
                    migrationCompletedModes: [],
                    hasPartialImport: false,
                  });
                }}
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm font-normal"
              >
                {isCustomMigrationSource ? (
                  <option value={migrationSource}>
                    {selectedMigrationSourceName}
                  </option>
                ) : null}
                {MIGRATION_SOURCES.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
              <p>{selectedMigrationSourceHint}</p>
            </div>
            <MigrationHelpRequest source={migrationSource} />

            <div className="space-y-4">
              {MIGRATION_STEPS.slice(0, 2).map((step, index) => (
                <ImportFileFields
                  key={step.mode}
                  stepNumber={index + 1}
                  step={step}
                  csv={csvByMode[step.mode]}
                  tooLarge={!csvMetaByMode[step.mode].sizeValid}
                  fileName={fileNameByMode[step.mode]}
                  locked={
                    importInputsBusy ||
                    isOnboardingImportModeLocked(
                      step.mode,
                      committedByMode,
                      Boolean(result),
                    )
                  }
                  onPickFile={(event) => onPickFile(event, step.mode)}
                  onChangeCsv={(value) => updateCsv(step.mode, value)}
                />
              ))}
            </div>

            <details
              className="group rounded-lg border border-slate-200 bg-white"
              open={historyExpanded}
              onToggle={(event) => setHistoryExpanded(event.currentTarget.open)}
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-3 text-sm font-medium text-slate-800">
                <span>
                  Also bring vaccine and visit history
                  <span className="ml-1 font-normal text-slate-500">
                    (optional)
                  </span>
                </span>
                <ChevronDown className="h-4 w-4 text-slate-500 transition-transform group-open:rotate-180" />
              </summary>
              <div className="space-y-4 border-t border-slate-200 p-3">
                <p className="text-xs text-slate-500">
                  History attaches only to a safely matched real patient. Use
                  the same patient ID from the pet file whenever possible.
                  Existing OpenVPM pets can also match by owner email or client
                  ID plus patient name.
                </p>
                {MIGRATION_STEPS.slice(2).map((step, index) => (
                  <ImportFileFields
                    key={step.mode}
                    stepNumber={index + 3}
                    step={step}
                    csv={csvByMode[step.mode]}
                    tooLarge={!csvMetaByMode[step.mode].sizeValid}
                    fileName={fileNameByMode[step.mode]}
                    locked={
                      importInputsBusy ||
                      isOnboardingImportModeLocked(
                        step.mode,
                        committedByMode,
                        Boolean(result),
                      )
                    }
                    onPickFile={(event) => onPickFile(event, step.mode)}
                    onChangeCsv={(value) => updateCsv(step.mode, value)}
                  />
                ))}
              </div>
            </details>

            {activeMode && activePreview ? (
              <div className="space-y-3" aria-live="polite">
                <div>
                  <p className="text-sm font-medium text-slate-800">
                    Dry-run preview
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    No data in this preview has been imported yet. Review the
                    planned changes and every issue before you confirm.
                  </p>
                  <p className="mt-1 text-xs font-medium text-amber-800">
                    Start with a small representative sample. A confirmed import
                    has no one-click rollback.
                  </p>
                </div>
                <CsvPreviewCard mode={activeMode} preview={activePreview} />
                {previewChangeCount > 0 && activePreview.errors.length > 0 ? (
                  <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                    {previewChangeCount.toLocaleString()} valid changes can
                    import. Review{" "}
                    {activePreview.errors.length.toLocaleString()}{" "}
                    {activePreview.errors.length === 1 ? "issue" : "issues"}.
                    Some affected rows may be skipped or imported without an
                    optional field. Edit the file above to fix them, or import
                    the valid changes now.
                  </p>
                ) : null}
                {previewChangeCount === 0 && activePreview.total === 0 ? (
                  <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                    Nothing in this file can be imported yet. Edit the file to
                    fix the listed issues, or use Skip file to continue without
                    it.
                  </p>
                ) : null}
                {previewChangeCount === 0 && activePreview.total > 0 ? (
                  <p className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                    These rows are already present or cannot be matched. Confirm
                    the reviewed no-change plan to continue, or edit the file
                    above.
                  </p>
                ) : null}
              </div>
            ) : null}

            {readingFiles ? (
              <p
                className="flex items-center gap-2 text-xs text-slate-500"
                role="status"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Reading the selected file
              </p>
            ) : importing ? (
              <p
                className="flex items-center gap-2 text-xs text-slate-500"
                role="status"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {previewReady ? "Importing your data" : "Checking your data"}
              </p>
            ) : null}

            {importRecoveryMessage ? (
              <div
                className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
                role="status"
                aria-live="polite"
              >
                {importRecoveryMessage}
              </div>
            ) : null}

            {result ? <ImportResultCard result={result} /> : null}

            {!importRecoveryMessage &&
            (importClientsCsv.error ||
              importPatientsCsv.error ||
              importVaccinationsCsv.error ||
              importSoapNotesCsv.error) ? (
              <p className="text-xs text-red-700" role="alert">
                {importClientsCsv.error?.message ??
                  importPatientsCsv.error?.message ??
                  importVaccinationsCsv.error?.message ??
                  importSoapNotesCsv.error?.message}
              </p>
            ) : null}
          </div>
        ) : null}

        <ChoiceCard
          active={choice === "api"}
          icon={<PlugZap className="h-5 w-5" />}
          title="Connect later by API"
          subtitle="Move data in from another system whenever you want."
          onClick={() => {
            if (importInputsBusy || lastCommittedIndex >= 0 || result) return;
            invalidatePendingFileReads();
            setChoice("api");
            clearAllImportReview();
          }}
          disabled={
            importInputsBusy || lastCommittedIndex >= 0 || Boolean(result)
          }
        />
        {choice === "api" ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-4 text-sm text-slate-600">
            <p>
              Your data stays yours, and you can connect by API on your own
              schedule. Find your keys and import tools in settings.
            </p>
            <Link
              href="/settings?tab=data"
              className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-emerald-700 hover:underline"
            >
              Open settings
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        ) : null}

        <ChoiceCard
          active={choice === "keep"}
          icon={<Sparkles className="h-5 w-5" />}
          title="Keep the sample data for now"
          subtitle={
            state.hasImportedData
              ? "Real data is saved, so sample records will be removed when setup finishes."
              : "Explore with the example pets we set up for you."
          }
          onClick={() => {
            if (
              state.hasImportedData ||
              importInputsBusy ||
              lastCommittedIndex >= 0 ||
              result
            )
              return;
            invalidatePendingFileReads();
            setChoice("keep");
            clearAllImportReview();
            setState({ keepSampleData: true, hasPartialImport: false });
          }}
          disabled={
            state.hasImportedData ||
            importInputsBusy ||
            lastCommittedIndex >= 0 ||
            Boolean(result)
          }
        />
      </div>
    </div>
  );
}

function ImportFileFields({
  stepNumber,
  step,
  csv,
  tooLarge,
  fileName,
  locked,
  onPickFile,
  onChangeCsv,
}: {
  stepNumber: number;
  step: (typeof MIGRATION_STEPS)[number];
  csv: string;
  tooLarge: boolean;
  fileName: string;
  locked: boolean;
  onPickFile: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onChangeCsv: (value: string) => void;
}) {
  const [showPasteEditor, setShowPasteEditor] = useState(false);
  useEffect(() => {
    if (fileName) setShowPasteEditor(false);
  }, [fileName]);
  const textareaId = `${step.mode}-csv-text`;
  const errorId = `${step.mode}-csv-size-error`;
  return (
    <div className="space-y-1.5 rounded-md border border-slate-200 bg-white p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-slate-700">
          {stepNumber}. {step.label}
        </span>
        <span className="text-[11px] text-slate-400">CSV</span>
      </div>
      <p className="text-xs text-slate-500">Columns: {step.columnHint}</p>
      <input
        type="file"
        disabled={locked}
        accept=".csv,text/csv"
        onChange={onPickFile}
        className={fileInputClass}
        aria-label={`Choose a ${step.label.toLowerCase()} CSV file`}
      />
      {fileName ? (
        <p className="text-xs text-emerald-700">Loaded {fileName}</p>
      ) : null}
      {!locked ? (
        <button
          type="button"
          className="text-xs font-medium text-emerald-700 underline underline-offset-2"
          onClick={() => setShowPasteEditor((current) => !current)}
          aria-expanded={showPasteEditor}
        >
          {showPasteEditor
            ? "Hide CSV text"
            : fileName
              ? "Review or edit file text"
              : "Paste CSV text instead"}
        </button>
      ) : null}
      {showPasteEditor ? (
        <textarea
          id={textareaId}
          rows={3}
          className={textareaClass}
          value={csv}
          disabled={locked}
          maxLength={IMPORT_CSV_MAX_BYTES}
          aria-label={`Paste ${step.label.toLowerCase()} CSV text`}
          aria-invalid={tooLarge || undefined}
          aria-describedby={tooLarge ? errorId : undefined}
          onChange={(event) => onChangeCsv(event.target.value)}
          placeholder={step.placeholder}
        />
      ) : null}
      {tooLarge ? (
        <p id={errorId} className="text-xs text-red-700">
          {step.label} CSV must be 5 MB or less.
        </p>
      ) : null}
    </div>
  );
}

function CsvPreviewCard({
  mode,
  preview,
}: {
  mode: MigrationImportMode;
  preview: CsvPreview;
}) {
  const step = MIGRATION_STEPS.find((candidate) => candidate.mode === mode)!;
  const unmatched =
    mode === "patients"
      ? preview.unmatchedClient
      : mode === "vaccinations" || mode === "soapNotes"
        ? preview.unmatchedPatient
        : undefined;
  const needsAttention =
    preview.errors.length > 0 ||
    (preview.duplicates ?? 0) > 0 ||
    (unmatched ?? 0) > 0;

  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-slate-800">{step.label}</p>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-xs font-medium",
            needsAttention
              ? "bg-amber-50 text-amber-700"
              : "bg-emerald-50 text-emerald-700",
          )}
        >
          {needsAttention
            ? "Ready with issues to review"
            : preview.willInsert + (preview.willReconcile ?? 0) > 0
              ? "Ready"
              : "No changes needed"}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <ImportStat label="Valid rows parsed" value={preview.total} />
        <ImportStat label="Will import" value={preview.willInsert} />
        {(preview.willReconcile ?? 0) > 0 ? (
          <ImportStat
            label="IDs to connect"
            value={preview.willReconcile ?? 0}
          />
        ) : null}
        {typeof preview.duplicates === "number" ? (
          <ImportStat label="Duplicates" value={preview.duplicates} />
        ) : null}
        {typeof unmatched === "number" ? (
          <ImportStat
            label={step.unmatchedLabel ?? "Unmatched"}
            value={unmatched}
          />
        ) : null}
        <ImportStat label="Issues" value={preview.errors.length} />
      </div>
      {preview.errors.length > 0 ? (
        <ImportIssues
          errors={preview.errors}
          fileName={`openvpm-${mode}-preview-issues.txt`}
        />
      ) : null}
    </div>
  );
}

function ImportResultCard({ result }: { result: OnboardingImportSummary }) {
  const changeCount = onboardingImportChangeCount(result);
  const hasIssues = result.errors.length > 0;
  return (
    <div
      className={cn(
        "rounded-md border p-3 text-xs",
        hasIssues
          ? "border-amber-200 bg-amber-50 text-amber-900"
          : "border-emerald-200 bg-emerald-50 text-emerald-900",
      )}
      aria-live="polite"
    >
      <p className="font-medium">
        {hasIssues ? "Review completed with issues. " : ""}
        {changeCount > 0
          ? `Added ${result.imported.clients} clients, ${result.imported.patients} pets, ${result.imported.vaccinations} vaccine records, and ${result.imported.soapNotes} visit notes.`
          : "Review complete. No new records were needed."}
        {result.reconciled > 0
          ? ` Connected ${result.reconciled} existing record IDs.`
          : ""}
      </p>
      {result.errors.length > 0 ? (
        <>
          <ImportIssues
            errors={result.errors}
            fileName="openvpm-import-issues.txt"
          />
          <Link
            href="/settings?tab=data"
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1 font-medium text-amber-950 underline underline-offset-2"
          >
            Fix skipped records in Settings, then Data
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </>
      ) : null}
      <p className="mt-2">Press Continue when you are ready.</p>
    </div>
  );
}

function ImportIssues({
  errors,
  fileName,
}: {
  errors: string[];
  fileName: string;
}) {
  const visibleErrors = errors.slice(0, 5);
  return (
    <div className="mt-3 text-xs text-amber-800">
      <ul className="max-h-24 list-disc space-y-0.5 overflow-y-auto pl-4">
        {visibleErrors.map((error, index) => (
          <li key={index}>{error}</li>
        ))}
      </ul>
      {errors.length > 0 ? (
        <button
          type="button"
          className="mt-2 font-medium text-amber-900 underline underline-offset-2"
          onClick={() => downloadIssueReport(errors, fileName)}
        >
          Download{" "}
          {errors.length === 1 ? "issue report" : `all ${errors.length} issues`}
        </button>
      ) : null}
    </div>
  );
}

function ImportStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded bg-slate-100 px-2 py-1.5">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className="text-sm font-semibold text-slate-900">
        {value.toLocaleString()}
      </p>
    </div>
  );
}

function ChoiceCard({
  active,
  icon,
  title,
  subtitle,
  onClick,
  disabled = false,
}: {
  active: boolean;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "flex items-start gap-3 rounded-lg border bg-white p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        active
          ? "border-emerald-300 ring-1 ring-emerald-300"
          : "border-slate-200 hover:border-slate-300",
      )}
    >
      <span
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
          active
            ? "bg-emerald-100 text-emerald-700"
            : "bg-slate-100 text-slate-500",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-slate-900">
          {title}
        </span>
        <span className="mt-0.5 block text-xs text-slate-500">{subtitle}</span>
      </span>
      {active ? <Check className="h-5 w-5 shrink-0 text-emerald-600" /> : null}
    </button>
  );
}
