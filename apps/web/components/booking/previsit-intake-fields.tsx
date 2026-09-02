"use client";

import React, { useId, type Dispatch, type SetStateAction } from "react";
import {
  PREVISIT_INTAKE_FIELD_DEFINITIONS,
  PREVISIT_INTAKE_FIELD_MAX_LENGTH,
  type PrevisitIntake,
  type PrevisitIntakeFieldKey,
} from "@/lib/booking/previsit-intake";
import { cn } from "@/lib/utils";

export interface PrevisitIntakeFieldsProps {
  enabledFieldKeys: readonly PrevisitIntakeFieldKey[];
  value: PrevisitIntake;
  onChange: Dispatch<SetStateAction<PrevisitIntake>>;
  disabled?: boolean;
  className?: string;
}

/** Controlled, client-facing pre-visit context fields. */
export function PrevisitIntakeFields({
  enabledFieldKeys,
  value,
  onChange,
  disabled = false,
  className,
}: PrevisitIntakeFieldsProps) {
  const idPrefix = useId();
  const enabledFields = new Set(enabledFieldKeys);
  const fields = PREVISIT_INTAKE_FIELD_DEFINITIONS.filter(({ key }) =>
    enabledFields.has(key),
  );

  if (fields.length === 0) return null;

  const descriptionId = `${idPrefix}-description`;

  return (
    <details
      className={cn(
        "rounded-xl border border-gray-200 bg-gray-50 p-4",
        className,
      )}
    >
      <summary className="cursor-pointer text-sm font-semibold text-gray-900">
        Visit location and health details
        <span className="ml-1 font-normal text-gray-500">(optional)</span>
      </summary>
      <p id={descriptionId} className="mt-2 text-xs leading-5 text-gray-500">
        Share where the visit should happen and anything that would help the
        clinic prepare. These are owner-reported details and remain unverified
        until the care team reviews and confirms them.
      </p>
      <div className="mt-4 space-y-4">
        {fields.map((field) => {
          const fieldId = `${idPrefix}-intake-${field.key}`;

          return (
            <div key={field.key}>
              <label
                htmlFor={fieldId}
                className="mb-1.5 block text-sm font-medium text-gray-700"
              >
                {field.label}
              </label>
              <textarea
                id={fieldId}
                aria-describedby={descriptionId}
                value={value[field.key] ?? ""}
                onChange={(event) => {
                  const nextValue = event.currentTarget.value;
                  onChange((current) => ({
                    ...current,
                    [field.key]: nextValue || undefined,
                  }));
                }}
                disabled={disabled}
                rows={2}
                maxLength={PREVISIT_INTAKE_FIELD_MAX_LENGTH}
                placeholder={field.placeholder}
                className="w-full resize-y rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
          );
        })}
      </div>
    </details>
  );
}
