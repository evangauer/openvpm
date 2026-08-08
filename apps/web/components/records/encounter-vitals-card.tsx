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
  visitStateReady,
  visitOpen,
  timeZone,
}: {
  patientId: string;
  appointmentId: string;
  canRecord: boolean;
  visitStateReady: boolean;
  visitOpen: boolean;
  timeZone?: string | null;
}) {
  const utils = trpc.useUtils();
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
  const vitalsReady = Boolean(vitalsQuery.data) && !vitalsQuery.error;
  const canSubmit =
    canRecord &&
    vitalsReady &&
    hasContent &&
    isVitalsOptionalTemperatureInputValid(form.temperatureC) &&
    isVitalsOptionalHeartRateInputValid(form.heartRateBpm) &&
    isVitalsOptionalRespiratoryRateInputValid(form.respiratoryRateBpm) &&
    isVitalsOptionalWeightInputValid(form.weightKg) &&
    isVitalsOptionalBodyConditionInputValid(form.bodyConditionScore) &&
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
      temperatureC: optionalNumber(form.temperatureC),
      heartRateBpm: optionalNumber(form.heartRateBpm),
      respiratoryRateBpm: optionalNumber(form.respiratoryRateBpm),
      weightKg: optionalNumber(form.weightKg),
      bodyConditionScore: optionalNumber(form.bodyConditionScore),
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
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <VitalNumberInput
                label="Temp (C)"
                name="temperatureC"
                min={VITALS_TEMPERATURE_MIN_C}
                max={VITALS_TEMPERATURE_MAX_C}
                step={VITALS_TEMPERATURE_STEP}
                value={form.temperatureC}
                valid={isVitalsOptionalTemperatureInputValid(form.temperatureC)}
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
                label="Weight (kg)"
                name="weightKg"
                min={VITALS_WEIGHT_MIN_KG}
                max={VITALS_WEIGHT_MAX_KG}
                step={VITALS_WEIGHT_STEP}
                value={form.weightKg}
                valid={isVitalsOptionalWeightInputValid(form.weightKg)}
                onChange={updateField}
              />
              <VitalNumberInput
                label="BCS (1-9)"
                name="bodyConditionScore"
                min={VITALS_BODY_CONDITION_MIN}
                max={VITALS_BODY_CONDITION_MAX}
                step={1}
                value={form.bodyConditionScore}
                valid={isVitalsOptionalBodyConditionInputValid(
                  form.bodyConditionScore,
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
                  className="rounded-md border border-border bg-muted/10 p-3"
                >
                  <p className="mb-2 text-xs font-medium text-muted-foreground">
                    {formatRecordedAt(vital.recordedAt, timeZone)}
                  </p>
                  <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-sm sm:grid-cols-6">
                    <div>
                      <dt className="text-xs text-muted-foreground">Temp</dt>
                      <dd>{displayMeasurement(vital.temperatureC, " C")}</dd>
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
                      <dd>{displayMeasurement(vital.weightKg, " kg")}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">BCS</dt>
                      <dd>{displayMeasurement(vital.bodyConditionScore)}</dd>
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
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
