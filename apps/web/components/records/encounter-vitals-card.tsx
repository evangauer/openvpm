"use client";

import { useState } from "react";
import { Activity, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import {
  VITALS_BODY_CONDITION_MAX,
  VITALS_BODY_CONDITION_MIN,
  VITALS_CAPILLARY_REFILL_MAX_SEC,
  VITALS_CAPILLARY_REFILL_MIN_SEC,
  VITALS_CAPILLARY_REFILL_STEP,
  VITALS_HEART_RATE_MAX_BPM,
  VITALS_HEART_RATE_MIN_BPM,
  VITALS_MUCOUS_MEMBRANE_MAX_LENGTH,
  VITALS_NOTES_MAX_LENGTH,
  VITALS_PAIN_SCORE_MAX,
  VITALS_PAIN_SCORE_MIN,
  VITALS_RESPIRATORY_RATE_MAX_BPM,
  VITALS_RESPIRATORY_RATE_MIN_BPM,
  VITALS_TEMPERATURE_MAX_C,
  VITALS_TEMPERATURE_MIN_C,
  VITALS_TEMPERATURE_STEP,
  VITALS_WEIGHT_MAX_KG,
  VITALS_WEIGHT_MIN_KG,
  VITALS_WEIGHT_SCALE,
  VITALS_WEIGHT_STEP,
  isVitalsOptionalBodyConditionInputValid,
  isVitalsOptionalCapillaryRefillInputValid,
  isVitalsOptionalHeartRateInputValid,
  isVitalsOptionalPainScoreInputValid,
  isVitalsOptionalRespiratoryRateInputValid,
  isVitalsOptionalTemperatureInputValid,
  isVitalsOptionalTextInputValid,
  isVitalsOptionalWeightInputValid,
} from "@/lib/records/vitals-policy";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ClinicalCorrectionControl } from "@/components/records/clinical-correction-control";
import { cn } from "@/lib/utils";
import { useOnlineStatus } from "@/lib/use-online-status";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import {
  celsiusToFahrenheit,
  fahrenheitToCelsius,
  kilogramsToPounds,
  poundsToKilograms,
  roundClinicalMeasurement,
  type BodyConditionScale,
  type MeasurementSystem,
} from "@/lib/ambulatory-workspace";

type VitalsFormState = {
  temperatureC: string;
  heartRateBpm: string;
  respiratoryRateBpm: string;
  weightKg: string;
  bodyConditionScore: string;
  painScore: string;
  mucousMembrane: string;
  capillaryRefillSec: string;
  notes: string;
};

const EMPTY_VITALS_FORM: VitalsFormState = {
  temperatureC: "",
  heartRateBpm: "",
  respiratoryRateBpm: "",
  weightKg: "",
  bodyConditionScore: "",
  painScore: "",
  mucousMembrane: "",
  capillaryRefillSec: "",
  notes: "",
};

function optionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function canonicalMeasurementInput(
  value: string,
  converter: ((value: number) => number) | undefined,
  scale: number,
): string {
  const trimmed = value.trim();
  if (!trimmed || !converter) return trimmed;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return trimmed;
  return String(roundClinicalMeasurement(converter(parsed), scale));
}

function weightInputMinimum(measurementSystem: MeasurementSystem): number {
  if (measurementSystem === "metric") return VITALS_WEIGHT_MIN_KG;
  const minimumPounds = kilogramsToPounds(VITALS_WEIGHT_MIN_KG);
  return roundClinicalMeasurement(
    Math.ceil(minimumPounds / VITALS_WEIGHT_STEP) * VITALS_WEIGHT_STEP,
    VITALS_WEIGHT_SCALE,
  );
}

function formatRecordedAt(
  value: Date | string,
  timeZone?: string | null,
): string {
  try {
    return new Date(value).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timeZone ?? undefined,
    });
  } catch {
    return new Date(value).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
}

function displayMeasurement(
  value: number | string | null | undefined,
  unit = "",
): string {
  if (value === null || value === undefined || value === "") return "—";
  return `${value}${unit}`;
}

function displayClinicalTemperature(
  value: number | string | null | undefined,
  measurementSystem: MeasurementSystem,
): string {
  if (value === null || value === undefined || value === "") return "—";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "—";
  return measurementSystem === "us_customary"
    ? `${roundClinicalMeasurement(celsiusToFahrenheit(parsed))} F`
    : `${roundClinicalMeasurement(parsed)} C`;
}

function displayClinicalWeight(
  value: number | string | null | undefined,
  measurementSystem: MeasurementSystem,
): string {
  if (value === null || value === undefined || value === "") return "—";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "—";
  return measurementSystem === "us_customary"
    ? `${roundClinicalMeasurement(kilogramsToPounds(parsed))} lb`
    : `${roundClinicalMeasurement(parsed, 3)} kg`;
}

function VitalNumberInput({
  label,
  name,
  value,
  min,
  max,
  step,
  valid,
  onChange,
}: {
  label: string;
  name: keyof VitalsFormState;
  value: string;
  min: number;
  max: number;
  step: number;
  valid: boolean;
  onChange: React.ChangeEventHandler<HTMLInputElement>;
}) {
  return (
    <label className="space-y-1 text-xs font-medium text-muted-foreground">
      {label}
      <Input
        name={name}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-invalid={!valid}
        onChange={onChange}
      />
    </label>
  );
}

export function EncounterVitalsCard({
  patientId,
  appointmentId,
  canRecord,
  canCorrect,
  visitStateReady,
  visitOpen,
  timeZone,
  measurementSystem = "metric",
  bodyConditionScale = 9,
}: {
  patientId: string;
  appointmentId: string;
  canRecord: boolean;
  canCorrect: boolean;
  visitStateReady: boolean;
  visitOpen: boolean;
  timeZone?: string | null;
  measurementSystem?: MeasurementSystem;
  bodyConditionScale?: BodyConditionScale;
}) {
  const utils = trpc.useUtils();
  const isOnline = useOnlineStatus();
  const [form, setForm] = useState<VitalsFormState>(() => ({
    ...EMPTY_VITALS_FORM,
  }));
  const vitalsQuery = trpc.vitals.listByAppointment.useQuery({
    appointmentId,
  });
  const recordVitals = trpc.vitals.record.useMutation({
    onSuccess: async () => {
      setForm({ ...EMPTY_VITALS_FORM });
      toast.success("Visit vitals recorded");
      await Promise.all([
        utils.vitals.listByAppointment.invalidate({ appointmentId }),
        utils.vitals.listByPatient.invalidate({ patientId }),
      ]);
    },
    onError: (error) => toast.error(error.message),
  });
  const correctVital = trpc.vitals.markEnteredInError.useMutation({
    onSuccess: async () => {
      toast.success("Vital signs retained and marked entered in error");
      await Promise.all([
        utils.vitals.listByAppointment.invalidate({ appointmentId }),
        utils.vitals.listByPatient.invalidate({ patientId }),
      ]);
    },
    onError: (error) => toast.error(error.message),
  });

  function updateField(
    event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) {
    const field = event.currentTarget.name as keyof VitalsFormState;
    const value = event.currentTarget.value;
    setForm((current) => ({ ...current, [field]: value }));
  }

  const hasContent = Object.values(form).some(
    (value) => value.trim().length > 0,
  );
  useUnsavedChangesGuard(
    hasContent,
    "Vitals have not been recorded on the server. Leave and lose these values?",
  );
  const vitalsReady = Boolean(vitalsQuery.data) && !vitalsQuery.error;
  const canonicalTemperature = canonicalMeasurementInput(
    form.temperatureC,
    measurementSystem === "us_customary" ? fahrenheitToCelsius : undefined,
    1,
  );
  const canonicalWeight = canonicalMeasurementInput(
    form.weightKg,
    measurementSystem === "us_customary" ? poundsToKilograms : undefined,
    3,
  );
  const canSubmit =
    canRecord &&
    isOnline &&
    vitalsReady &&
    hasContent &&
    isVitalsOptionalTemperatureInputValid(canonicalTemperature) &&
    isVitalsOptionalHeartRateInputValid(form.heartRateBpm) &&
    isVitalsOptionalRespiratoryRateInputValid(form.respiratoryRateBpm) &&
    isVitalsOptionalWeightInputValid(canonicalWeight) &&
    isVitalsOptionalBodyConditionInputValid(
      form.bodyConditionScore,
      bodyConditionScale,
    ) &&
    isVitalsOptionalPainScoreInputValid(form.painScore) &&
    isVitalsOptionalCapillaryRefillInputValid(form.capillaryRefillSec) &&
    isVitalsOptionalTextInputValid(
      form.mucousMembrane,
      VITALS_MUCOUS_MEMBRANE_MAX_LENGTH,
    ) &&
    isVitalsOptionalTextInputValid(form.notes, VITALS_NOTES_MAX_LENGTH) &&
    !recordVitals.isPending;

  function submitVitals(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    recordVitals.mutate({
      patientId,
      appointmentId,
      temperatureC: optionalNumber(canonicalTemperature),
      heartRateBpm: optionalNumber(form.heartRateBpm),
      respiratoryRateBpm: optionalNumber(form.respiratoryRateBpm),
      weightKg: optionalNumber(canonicalWeight),
      bodyConditionScore: optionalNumber(form.bodyConditionScore),
      bodyConditionScale,
      painScore: optionalNumber(form.painScore),
      mucousMembrane: form.mucousMembrane.trim() || undefined,
      capillaryRefillSec: optionalNumber(form.capillaryRefillSec),
      notes: form.notes.trim() || undefined,
    });
  }

  const vitals = vitalsQuery.data ?? [];
  const vitalsMissing =
    !vitalsQuery.isLoading && !vitalsQuery.error && !vitalsQuery.data;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <Activity className="mt-0.5 h-5 w-5 text-primary" />
          <div>
            <CardTitle>Visit vitals</CardTitle>
            <CardDescription>
              Measurements recorded here stay attached to this appointment.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {canRecord ? (
          <form onSubmit={submitVitals} className="space-y-3">
            {!isOnline ? (
              <div
                className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-950 dark:text-amber-100"
                role="status"
              >
                Offline — keep this page open. Vitals stay only in this form
                until you reconnect and record them.
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <VitalNumberInput
                label={`Temp (${measurementSystem === "us_customary" ? "F" : "C"})`}
                name="temperatureC"
                min={
                  measurementSystem === "us_customary"
                    ? roundClinicalMeasurement(
                        celsiusToFahrenheit(VITALS_TEMPERATURE_MIN_C),
                      )
                    : VITALS_TEMPERATURE_MIN_C
                }
                max={
                  measurementSystem === "us_customary"
                    ? roundClinicalMeasurement(
                        celsiusToFahrenheit(VITALS_TEMPERATURE_MAX_C),
                      )
                    : VITALS_TEMPERATURE_MAX_C
                }
                step={VITALS_TEMPERATURE_STEP}
                value={form.temperatureC}
                valid={isVitalsOptionalTemperatureInputValid(
                  canonicalTemperature,
                )}
                onChange={updateField}
              />
              <VitalNumberInput
                label="HR (bpm)"
                name="heartRateBpm"
                min={VITALS_HEART_RATE_MIN_BPM}
                max={VITALS_HEART_RATE_MAX_BPM}
                step={1}
                value={form.heartRateBpm}
                valid={isVitalsOptionalHeartRateInputValid(form.heartRateBpm)}
                onChange={updateField}
              />
              <VitalNumberInput
                label="RR (bpm)"
                name="respiratoryRateBpm"
                min={VITALS_RESPIRATORY_RATE_MIN_BPM}
                max={VITALS_RESPIRATORY_RATE_MAX_BPM}
                step={1}
                value={form.respiratoryRateBpm}
                valid={isVitalsOptionalRespiratoryRateInputValid(
                  form.respiratoryRateBpm,
                )}
                onChange={updateField}
              />
              <VitalNumberInput
                label={`Weight (${measurementSystem === "us_customary" ? "lb" : "kg"})`}
                name="weightKg"
                min={weightInputMinimum(measurementSystem)}
                max={
                  measurementSystem === "us_customary"
                    ? Math.floor(kilogramsToPounds(VITALS_WEIGHT_MAX_KG))
                    : VITALS_WEIGHT_MAX_KG
                }
                step={VITALS_WEIGHT_STEP}
                value={form.weightKg}
                valid={isVitalsOptionalWeightInputValid(canonicalWeight)}
                onChange={updateField}
              />
              <VitalNumberInput
                label={`BCS (1-${bodyConditionScale})`}
                name="bodyConditionScore"
                min={VITALS_BODY_CONDITION_MIN}
                max={bodyConditionScale}
                step={1}
                value={form.bodyConditionScore}
                valid={isVitalsOptionalBodyConditionInputValid(
                  form.bodyConditionScore,
                  bodyConditionScale,
                )}
                onChange={updateField}
              />
              <VitalNumberInput
                label="Pain (0-10)"
                name="painScore"
                min={VITALS_PAIN_SCORE_MIN}
                max={VITALS_PAIN_SCORE_MAX}
                step={1}
                value={form.painScore}
                valid={isVitalsOptionalPainScoreInputValid(form.painScore)}
                onChange={updateField}
              />
              <VitalNumberInput
                label="CRT (sec)"
                name="capillaryRefillSec"
                min={VITALS_CAPILLARY_REFILL_MIN_SEC}
                max={VITALS_CAPILLARY_REFILL_MAX_SEC}
                step={VITALS_CAPILLARY_REFILL_STEP}
                value={form.capillaryRefillSec}
                valid={isVitalsOptionalCapillaryRefillInputValid(
                  form.capillaryRefillSec,
                )}
                onChange={updateField}
              />
              <label className="col-span-2 space-y-1 text-xs font-medium text-muted-foreground">
                Mucous membrane
                <Input
                  name="mucousMembrane"
                  value={form.mucousMembrane}
                  maxLength={VITALS_MUCOUS_MEMBRANE_MAX_LENGTH}
                  placeholder="e.g. Pink and moist"
                  onChange={updateField}
                />
              </label>
            </div>
            <label className="block space-y-1 text-xs font-medium text-muted-foreground">
              Notes
              <Textarea
                name="notes"
                value={form.notes}
                maxLength={VITALS_NOTES_MAX_LENGTH}
                rows={2}
                placeholder="Optional visit-vitals context"
                onChange={updateField}
              />
            </label>
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={!canSubmit}>
                {recordVitals.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                {recordVitals.isPending
                  ? "Recording..."
                  : "Record visit vitals"}
              </Button>
            </div>
          </form>
        ) : (
          <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
            {!visitStateReady
              ? "Checking whether this visit accepts new vitals..."
              : visitOpen
                ? "Only an administrator, veterinarian, or technician can record visit vitals."
                : "This visit is closed to new vitals. Recorded values remain read-only."}
          </div>
        )}

        <div className="border-t border-border pt-4">
          {vitalsQuery.error || vitalsMissing ? (
            <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
              Unable to load visit vitals. Refresh before relying on this chart.
            </div>
          ) : vitalsQuery.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading visit vitals...
            </div>
          ) : vitals.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No vitals recorded for this visit.
            </p>
          ) : (
            <div className="space-y-3">
              {vitals.map((vital) => (
                <div
                  key={vital.id}
                  className={cn(
                    "rounded-md border border-border bg-muted/10 p-3",
                    vital.correctionId &&
                      "border-destructive/40 bg-destructive/5",
                  )}
                >
                  <p className="mb-2 text-xs font-medium text-muted-foreground">
                    {formatRecordedAt(vital.recordedAt, timeZone)}
                  </p>
                  <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-sm sm:grid-cols-6">
                    <div>
                      <dt className="text-xs text-muted-foreground">Temp</dt>
                      <dd>
                        {displayClinicalTemperature(
                          vital.temperatureC,
                          measurementSystem,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">HR</dt>
                      <dd>{displayMeasurement(vital.heartRateBpm, " bpm")}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">RR</dt>
                      <dd>
                        {displayMeasurement(vital.respiratoryRateBpm, " bpm")}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Weight</dt>
                      <dd>
                        {displayClinicalWeight(
                          vital.weightKg,
                          measurementSystem,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">BCS</dt>
                      <dd>
                        {displayMeasurement(vital.bodyConditionScore)}
                        {vital.bodyConditionScore
                          ? ` / ${vital.bodyConditionScale}`
                          : ""}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Pain</dt>
                      <dd>{displayMeasurement(vital.painScore)}</dd>
                    </div>
                  </dl>
                  {vital.mucousMembrane || vital.capillaryRefillSec ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      MM {vital.mucousMembrane ?? "—"} · CRT{" "}
                      {displayMeasurement(vital.capillaryRefillSec, " sec")}
                    </p>
                  ) : null}
                  {vital.notes ? (
                    <p className="mt-2 whitespace-pre-wrap text-sm">
                      {vital.notes}
                    </p>
                  ) : null}
                  <ClinicalCorrectionControl
                    correction={
                      vital.correctionId &&
                      vital.correctionReason &&
                      vital.correctedAt
                        ? {
                            id: vital.correctionId,
                            reason: vital.correctionReason,
                            correctedAt: vital.correctedAt,
                            correctedByName: vital.correctedByName,
                          }
                        : null
                    }
                    canCorrect={canCorrect}
                    isPending={
                      correctVital.isPending &&
                      correctVital.variables?.recordId === vital.id
                    }
                    onCorrect={(reason) =>
                      correctVital.mutateAsync({
                        patientId,
                        recordId: vital.id,
                        reason,
                      })
                    }
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
