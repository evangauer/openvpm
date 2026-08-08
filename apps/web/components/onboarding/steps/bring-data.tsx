"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  FileSpreadsheet,
  Loader2,
  PlugZap,
  Sparkles,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  IMPORT_CSV_MAX_BYTES,
  isImportCsvSizeValid,
} from "@/lib/import/policy";
import { getOnboardingIntentOption } from "@/lib/onboarding/intent";
import { MIGRATION_SOURCES } from "@/lib/import/sources";
import { toast } from "sonner";
import type { StepHandle, StepProps } from "../journey-types";

type Choice = "import" | "api" | "keep";
type CsvPreview = {
  total: number;
  willInsert: number;
  willReconcile?: number;
  duplicates?: number;
  unmatchedClient?: number;
  errors: string[];
};

const CLIENT_COLUMNS =
  "firstName, lastName, email or client ID, phone, address, city, state, zip";
const PET_COLUMNS =
  "clientEmail or client ID, patient ID, name, species, breed, sex, dob, color, microchipNumber";
const IMPORT_CSV_SIZE_MESSAGE = "CSV imports must be 5 MB or less.";

const textareaClass =
  "w-full resize-y rounded-md border border-input bg-background p-3 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

const fileInputClass =
  "block w-full text-xs text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-emerald-600 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white hover:file:bg-emerald-700";

// Read a chosen file to text so we can pass the CSV string to the import calls.
function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.readAsText(file);
  });
}

/**
 * Step 4: choose how real data gets in. Import from a file now, connect by API
 * later, or keep the sample data for now (the default and the skip behavior).
 */
export function BringDataStep({ register, state, setState }: StepProps) {
  const importClientsCsv = trpc.data.importClientsCsv.useMutation();
  const importPatientsCsv = trpc.data.importPatientsCsv.useMutation();

  // Default to keeping the sample data; the skip behavior matches this too.
  const [choice, setChoice] = useState<Choice>("keep");
  const [migrationSource, setMigrationSource] =
    useState<(typeof MIGRATION_SOURCES)[number]["id"]>("other");
  const [clientsCsv, setClientsCsv] = useState("");
  const [petsCsv, setPetsCsv] = useState("");
  const [clientsFileName, setClientsFileName] = useState("");
  const [petsFileName, setPetsFileName] = useState("");
  const [clientsPreview, setClientsPreview] = useState<CsvPreview | null>(null);
  const [petsPreview, setPetsPreview] = useState<CsvPreview | null>(null);
  const importReviewVersionRef = useRef(0);
  const fileReadVersionRef = useRef({ clients: 0, pets: 0 });
  const [result, setResult] = useState<{
    clients: number;
    pets: number;
    reconciled: number;
    errors: string[];
  } | null>(null);

  function clearImportReview() {
    importReviewVersionRef.current += 1;
    setClientsPreview(null);
    setPetsPreview(null);
    setResult(null);
  }

  function updateClientsCsv(value: string) {
    fileReadVersionRef.current.clients += 1;
    setClientsCsv(value);
    clearImportReview();
  }

  function updatePetsCsv(value: string) {
    fileReadVersionRef.current.pets += 1;
    setPetsCsv(value);
    clearImportReview();
  }

  function invalidatePendingFileReads() {
    fileReadVersionRef.current.clients += 1;
    fileReadVersionRef.current.pets += 1;
  }

  async function onPickFile(
    e: React.ChangeEvent<HTMLInputElement>,
    setCsv: (v: string) => void,
    which: "clients" | "pets",
  ) {
    const file = e.target.files?.[0];
    if (!file) return;
    const readVersion = ++fileReadVersionRef.current[which];
    function clearPickedFile() {
      setCsv("");
      if (which === "clients") setClientsFileName("");
      else setPetsFileName("");
      e.target.value = "";
    }
    if (file.size > IMPORT_CSV_MAX_BYTES) {
      clearPickedFile();
      toast.error(IMPORT_CSV_SIZE_MESSAGE);
      return;
    }
    try {
      const text = await readFileText(file);
      if (fileReadVersionRef.current[which] !== readVersion) return;
      if (!isImportCsvSizeValid(text)) {
        clearPickedFile();
        toast.error(IMPORT_CSV_SIZE_MESSAGE);
        return;
      }
      setCsv(text);
      if (which === "clients") setClientsFileName(file.name);
      else setPetsFileName(file.name);
    } catch {
      if (fileReadVersionRef.current[which] !== readVersion) return;
      toast.error("Could not read that file. Try again.");
    }
  }

  const clientsCsvTooLarge = !isImportCsvSizeValid(clientsCsv);
  const petsCsvTooLarge = !isImportCsvSizeValid(petsCsv);
  const importCsvSizeError = [
    clientsCsvTooLarge ? "Client CSV must be 5 MB or less." : null,
    petsCsvTooLarge ? "Pet CSV must be 5 MB or less." : null,
  ]
    .filter(Boolean)
    .join(" ");
  const hasImportCsvSizeError = importCsvSizeError.length > 0;
  const hasClientsCsv = clientsCsv.trim().length > 0;
  const hasPetsCsv = petsCsv.trim().length > 0;
  const hasImportCsv = choice === "import" && (hasClientsCsv || hasPetsCsv);
  const needsDryRun =
    (hasClientsCsv && !clientsPreview) || (hasPetsCsv && !petsPreview);
  const previewReady = hasImportCsv && !needsDryRun;
  const previewWillInsert =
    (clientsPreview?.willInsert ?? 0) + (petsPreview?.willInsert ?? 0);
  const previewWillReconcile =
    (clientsPreview?.willReconcile ?? 0) + (petsPreview?.willReconcile ?? 0);

  // Finish only clears sample data after real rows have imported. Checking a
  // CSV or connecting later leaves the demo clinic intact.
  const hasImportedRows =
    choice === "import" && Boolean(result && result.clients + result.pets > 0);
  useEffect(() => {
    setState({ keepSampleData: !hasImportedRows });
  }, [hasImportedRows, setState]);

  useEffect(() => {
    register({
      async onContinue() {
        // Only the file path does extra work on Continue; the others just move on.
        if (choice !== "import") return true;
        if (!hasClientsCsv && !hasPetsCsv) return true;
        if (result) return true;
        if (hasImportCsvSizeError) {
          toast.error(importCsvSizeError || IMPORT_CSV_SIZE_MESSAGE);
          return false;
        }

        if (needsDryRun) {
          const reviewVersion = importReviewVersionRef.current;
          if (hasClientsCsv) {
            const r = await importClientsCsv.mutateAsync({
              csv: clientsCsv.trim(),
              dryRun: true,
              source: migrationSource,
            });
            if (importReviewVersionRef.current !== reviewVersion) return false;
            if ("dryRun" in r && r.dryRun) {
              setClientsPreview({
                total: r.total,
                willInsert: r.willInsert,
                willReconcile: r.willReconcile,
                duplicates: r.duplicates,
                errors: r.errors,
              });
            }
          }
          if (hasPetsCsv) {
            const r = await importPatientsCsv.mutateAsync({
              csv: petsCsv.trim(),
              dryRun: true,
              source: migrationSource,
              clientCsv: hasClientsCsv ? clientsCsv.trim() : undefined,
            });
            if (importReviewVersionRef.current !== reviewVersion) return false;
            if ("dryRun" in r && r.dryRun) {
              setPetsPreview({
                total: r.total,
                willInsert: r.willInsert,
                willReconcile: r.willReconcile,
                unmatchedClient: r.unmatchedClient,
                errors: r.errors,
              });
            }
          }
          toast.success("CSV checked. Review the plan before importing.");
          return false;
        }

        if (previewWillInsert + previewWillReconcile === 0) {
          setResult({
            clients: 0,
            pets: 0,
            reconciled: 0,
            errors: [
              "No new rows were found to import. You can adjust the CSV or continue with sample data.",
            ],
          });
          return false;
        }

        const errors: string[] = [];
        let clientsImported = 0;
        let petsImported = 0;
        let reconciled = 0;

        if (hasClientsCsv) {
          const r = await importClientsCsv.mutateAsync({
            csv: clientsCsv.trim(),
            dryRun: false,
            source: migrationSource,
          });
          clientsImported = r.imported ?? 0;
          reconciled += r.reconciled ?? 0;
          if (r.errors?.length) errors.push(...r.errors);
        }
        if (hasPetsCsv) {
          const r = await importPatientsCsv.mutateAsync({
            csv: petsCsv.trim(),
            dryRun: false,
            source: migrationSource,
          });
          petsImported = r.imported ?? 0;
          reconciled += r.reconciled ?? 0;
          if (r.errors?.length) errors.push(...r.errors);
        }
        setResult({
          clients: clientsImported,
          pets: petsImported,
          reconciled,
          errors,
        });
        toast.success(
          `Added ${clientsImported} clients and ${petsImported} pets${reconciled > 0 ? `; connected ${reconciled} IDs` : ""}`,
        );
        // Stay on the step so they can see the result before moving on.
        return false;
      },
    });
  }, [
    register,
    choice,
    clientsCsv,
    petsCsv,
    hasClientsCsv,
    hasPetsCsv,
    hasImportCsvSizeError,
    importCsvSizeError,
    needsDryRun,
    previewWillInsert,
    previewWillReconcile,
    migrationSource,
    result,
    importClientsCsv,
    importPatientsCsv,
  ]);

  const importing = importClientsCsv.isPending || importPatientsCsv.isPending;
  const pathway = getOnboardingIntentOption(state.onboardingIntent);
  const pathwayIntro =
    pathway.value === "alongside"
      ? "Start small: bring in a few real clients and pets while your current PIMS stays in place."
      : pathway.value === "replace"
        ? "Make the move in stages: check a client and pet export before any live workflow changes."
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
          subtitle="Paste your clients and pets from a spreadsheet."
          onClick={() => {
            invalidatePendingFileReads();
            setChoice("import");
            clearImportReview();
          }}
        />
        {choice === "import" ? (
          <div className="space-y-4 rounded-lg border border-slate-200 bg-slate-50/70 p-4">
            <p className="text-xs text-slate-500">
              Pick a CSV file for each one, or paste the rows below. Continue
              checks the files first; nothing imports until you review the plan.
            </p>
            <p className="text-xs text-slate-500">
              Existing owners connect by one exact email. Existing pets need a
              matching microchip or date of birth before an ID is connected.
            </p>
            <label className="block space-y-1.5 text-sm font-medium text-slate-700">
              <span>Which system are you moving from?</span>
              <select
                value={migrationSource}
                onChange={(event) => {
                  invalidatePendingFileReads();
                  setMigrationSource(
                    event.target
                      .value as (typeof MIGRATION_SOURCES)[number]["id"],
                  );
                  clearImportReview();
                }}
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm font-normal"
              >
                {MIGRATION_SOURCES.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">
                Clients
              </span>
              <p className="text-xs text-slate-500">
                Columns: {CLIENT_COLUMNS}
              </p>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => onPickFile(e, updateClientsCsv, "clients")}
                className={fileInputClass}
                aria-label="Choose a clients CSV file"
              />
              {clientsFileName ? (
                <p className="text-xs text-emerald-700">
                  Loaded {clientsFileName}
                </p>
              ) : null}
              <textarea
                rows={4}
                className={textareaClass}
                value={clientsCsv}
                maxLength={IMPORT_CSV_MAX_BYTES}
                aria-invalid={clientsCsvTooLarge || undefined}
                aria-describedby={
                  clientsCsvTooLarge ? "clients-csv-size-error" : undefined
                }
                onChange={(e) => updateClientsCsv(e.target.value)}
                placeholder={`firstName,lastName,email,phone,address,city,state,zip`}
              />
              {clientsCsvTooLarge ? (
                <p id="clients-csv-size-error" className="text-xs text-red-700">
                  Client CSV must be 5 MB or less.
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Pets</span>
              <p className="text-xs text-slate-500">Columns: {PET_COLUMNS}</p>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => onPickFile(e, updatePetsCsv, "pets")}
                className={fileInputClass}
                aria-label="Choose a pets CSV file"
              />
              {petsFileName ? (
                <p className="text-xs text-emerald-700">
                  Loaded {petsFileName}
                </p>
              ) : null}
              <textarea
                rows={4}
                className={textareaClass}
                value={petsCsv}
                maxLength={IMPORT_CSV_MAX_BYTES}
                aria-invalid={petsCsvTooLarge || undefined}
                aria-describedby={
                  petsCsvTooLarge ? "pets-csv-size-error" : undefined
                }
                onChange={(e) => updatePetsCsv(e.target.value)}
                placeholder={`clientEmail,name,species,breed,sex,dob,color,microchipNumber`}
              />
              {petsCsvTooLarge ? (
                <p id="pets-csv-size-error" className="text-xs text-red-700">
                  Pet CSV must be 5 MB or less.
                </p>
              ) : null}
            </div>
            {clientsPreview || petsPreview ? (
              <div className="space-y-3">
                <div>
                  <p className="text-sm font-medium text-slate-800">
                    Dry-run preview
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    No data has been imported yet. Review the counts, then press
                    Continue again to import.
                  </p>
                </div>
                {clientsPreview ? (
                  <CsvPreviewCard
                    title="Clients"
                    preview={clientsPreview}
                    duplicateLabel="Duplicates"
                    duplicateValue={clientsPreview.duplicates ?? 0}
                  />
                ) : null}
                {petsPreview ? (
                  <CsvPreviewCard
                    title="Pets"
                    preview={petsPreview}
                    duplicateLabel="Missing owners"
                    duplicateValue={petsPreview.unmatchedClient ?? 0}
                  />
                ) : null}
              </div>
            ) : null}
            {importing ? (
              <p className="flex items-center gap-2 text-xs text-slate-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {previewReady ? "Importing your data" : "Checking your data"}
              </p>
            ) : null}
            {result ? (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
                <p className="font-medium">
                  Added {result.clients} clients and {result.pets} pets.
                  {result.reconciled > 0
                    ? ` Connected ${result.reconciled} existing record IDs.`
                    : ""}
                </p>
                {result.errors.length > 0 ? (
                  <>
                    <ul className="mt-2 list-disc space-y-0.5 pl-4 text-amber-800">
                      {result.errors.slice(0, 5).map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                      {result.errors.length > 5 ? (
                        <li>and {result.errors.length - 5} more</li>
                      ) : null}
                    </ul>
                    <p className="mt-2">Press Continue when you are ready.</p>
                  </>
                ) : (
                  <p className="mt-1">Press Continue when you are ready.</p>
                )}
              </div>
            ) : null}
            {importClientsCsv.error || importPatientsCsv.error ? (
              <p className="text-xs text-red-700">
                {importClientsCsv.error?.message ??
                  importPatientsCsv.error?.message}
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
            invalidatePendingFileReads();
            setChoice("api");
            clearImportReview();
          }}
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
          subtitle="Explore with the example pets we set up for you."
          onClick={() => {
            invalidatePendingFileReads();
            setChoice("keep");
            clearImportReview();
          }}
        />
      </div>
    </div>
  );
}

function CsvPreviewCard({
  title,
  preview,
  duplicateLabel,
  duplicateValue,
}: {
  title: string;
  preview: CsvPreview;
  duplicateLabel: string;
  duplicateValue: number;
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-slate-800">{title}</p>
        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
          {preview.willInsert + (preview.willReconcile ?? 0) > 0
            ? "Ready"
            : "Review"}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <ImportStat label="Rows" value={preview.total} />
        <ImportStat label="Will import" value={preview.willInsert} />
        {(preview.willReconcile ?? 0) > 0 ? (
          <ImportStat
            label="IDs to connect"
            value={preview.willReconcile ?? 0}
          />
        ) : null}
        <ImportStat label={duplicateLabel} value={duplicateValue} />
        <ImportStat label="Issues" value={preview.errors.length} />
      </div>
      {preview.errors.length > 0 ? (
        <ul className="mt-3 max-h-24 space-y-0.5 overflow-y-auto text-xs text-amber-800">
          {preview.errors.slice(0, 5).map((error, index) => (
            <li key={index}>{error}</li>
          ))}
          {preview.errors.length > 5 ? (
            <li>and {preview.errors.length - 5} more</li>
          ) : null}
        </ul>
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
}: {
  active: boolean;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-start gap-3 rounded-lg border bg-white p-4 text-left transition-colors",
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
