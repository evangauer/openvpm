"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import {
  PRACTICE_NAME_MAX_LENGTH,
  STAFF_LICENSE_NUMBER_MAX_LENGTH,
} from "@/lib/settings-policy";
import type { StepHandle } from "../journey-types";

// Same regions the settings page offers. Choosing a country auto-fills
// currency and tax for you on the server, so you do not have to.
const COUNTRIES: { code: string; label: string }[] = [
  { code: "US", label: "United States" },
  { code: "GB", label: "United Kingdom" },
  { code: "IE", label: "Ireland" },
  { code: "CA", label: "Canada" },
  { code: "AU", label: "Australia" },
];

// Mirrors the TIMEZONES list on the settings page.
const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Toronto",
  "Europe/London",
  "Europe/Dublin",
  "Australia/Sydney",
];

const selectClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

/**
 * Step 1: capture the clinic name, country, and timezone. Continue saves them
 * with updatePractice (which also fills in currency and tax from the country).
 */
export function PracticeBasicsStep({
  register,
}: {
  register: (h: StepHandle) => void;
}) {
  const {
    data: practice,
    isLoading,
    error,
    refetch,
  } = trpc.settings.getPractice.useQuery();
  const {
    data: clinicalProfile,
    isLoading: isClinicalProfileLoading,
    error: clinicalProfileError,
    refetch: refetchClinicalProfile,
  } = trpc.settings.getMyClinicalProfile.useQuery();
  const updatePractice = trpc.settings.updatePractice.useMutation();
  const updateClinicalProfile =
    trpc.settings.updateMyClinicalProfile.useMutation();

  const [name, setName] = useState("");
  const [country, setCountry] = useState("US");
  const [timezone, setTimezone] = useState("America/New_York");
  const [ownerRole, setOwnerRole] = useState<
    "veterinarian" | "non_clinical" | ""
  >("");
  const [licenseNumber, setLicenseNumber] = useState("");
  const [ownerRoleMissing, setOwnerRoleMissing] = useState(false);
  const [filled, setFilled] = useState(false);
  const trimmedName = name.trim();
  const practiceNameInvalid =
    trimmedName.length > 0 && trimmedName.length > PRACTICE_NAME_MAX_LENGTH;

  // Prefill once from the saved practice without stomping later edits.
  useEffect(() => {
    if (filled || !practice || !clinicalProfile) return;
    setName(practice.name ?? "");
    setCountry(practice.country ?? "US");
    setTimezone(practice.timezone ?? "America/New_York");
    setOwnerRole(clinicalProfile.isVeterinarian ? "veterinarian" : "");
    setLicenseNumber(clinicalProfile.licenseNumber ?? "");
    setFilled(true);
  }, [practice, clinicalProfile, filled]);

  useEffect(() => {
    register({
      async onContinue() {
        if (
          error ||
          clinicalProfileError ||
          isLoading ||
          isClinicalProfileLoading
        )
          return false;
        if (practiceNameInvalid) return false;
        if (!ownerRole) {
          setOwnerRoleMissing(true);
          return false;
        }
        setOwnerRoleMissing(false);
        if (trimmedName) {
          await updatePractice.mutateAsync({
            name: trimmedName,
            country,
            timezone,
          });
        }
        await updateClinicalProfile.mutateAsync({
          isVeterinarian: ownerRole === "veterinarian",
          licenseNumber:
            ownerRole === "veterinarian" && licenseNumber.trim()
              ? licenseNumber.trim()
              : undefined,
        });
        return true;
      },
    });
  }, [
    register,
    error,
    clinicalProfileError,
    isLoading,
    isClinicalProfileLoading,
    trimmedName,
    practiceNameInvalid,
    country,
    timezone,
    ownerRole,
    licenseNumber,
    updatePractice,
    updateClinicalProfile,
  ]);

  if (error || clinicalProfileError) {
    return (
      <OnboardingStepError
        title="Practice details could not load"
        message={(error ?? clinicalProfileError)!.message}
        onRetry={() => {
          void refetch();
          void refetchClinicalProfile();
        }}
      />
    );
  }

  if (isLoading || isClinicalProfileLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <p className="text-sm leading-6 text-slate-600">
        This is your clinic, and your data. Add a few basics so OpenVPM feels
        right. You can change all of this later in settings.
      </p>

      <FormField label="Practice name" htmlFor="ob-practice-name">
        <Input
          id="ob-practice-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={PRACTICE_NAME_MAX_LENGTH}
          aria-invalid={practiceNameInvalid || undefined}
          aria-describedby={
            practiceNameInvalid ? "ob-practice-name-error" : undefined
          }
          placeholder="Neighborhood Veterinary"
          autoFocus
        />
        {practiceNameInvalid ? (
          <p id="ob-practice-name-error" className="text-xs text-destructive">
            Practice name must be at most {PRACTICE_NAME_MAX_LENGTH} characters.
          </p>
        ) : null}
      </FormField>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Country" htmlFor="ob-country">
          <select
            id="ob-country"
            className={selectClass}
            value={country}
            onChange={(e) => setCountry(e.target.value)}
          >
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="Time zone" htmlFor="ob-timezone">
          <select
            id="ob-timezone"
            className={selectClass}
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          >
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </FormField>
      </div>

      <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/70 p-4">
        <FormField
          label="Your clinic role"
          htmlFor="ob-owner-role"
          description="Administrative access and veterinarian sign-off are separate. A clinic owner can use this same login for both."
        >
          <select
            id="ob-owner-role"
            className={selectClass}
            value={ownerRole}
            aria-invalid={ownerRoleMissing || undefined}
            aria-describedby={
              ownerRoleMissing ? "ob-owner-role-error" : undefined
            }
            onChange={(event) => {
              setOwnerRole(
                event.target.value as "veterinarian" | "non_clinical" | "",
              );
              setOwnerRoleMissing(false);
            }}
          >
            <option value="">Choose your role</option>
            <option value="veterinarian">I am a veterinarian</option>
            <option value="non_clinical">I manage or support the clinic</option>
          </select>
        </FormField>
        {ownerRoleMissing ? (
          <p id="ob-owner-role-error" className="text-xs text-destructive">
            Choose your clinic role so visits are assigned safely.
          </p>
        ) : null}
        {ownerRole === "veterinarian" ? (
          <FormField
            label="Veterinary license number (optional)"
            htmlFor="ob-license-number"
          >
            <Input
              id="ob-license-number"
              value={licenseNumber}
              onChange={(event) => setLicenseNumber(event.target.value)}
              maxLength={STAFF_LICENSE_NUMBER_MAX_LENGTH}
              placeholder="State license number"
            />
          </FormField>
        ) : null}
      </div>
    </div>
  );
}

function OnboardingStepError({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div>
          <p className="font-medium text-destructive">{title}</p>
          <p className="mt-1 text-slate-600">{message}</p>
          <Button variant="outline" size="sm" onClick={onRetry} className="mt-3">
            Retry
          </Button>
        </div>
      </div>
    </div>
  );
}
