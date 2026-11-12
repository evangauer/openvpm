"use client";

import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  WEIGHT_UNITS,
  TEMPERATURE_UNITS,
  type ClinicalUnits,
} from "@/lib/clinical-units";

export function ClinicalUnitsSettings() {
  const utils = trpc.useUtils();
  const query = trpc.settings.getClinicalUnits.useQuery();
  const [draft, setDraft] = useState<ClinicalUnits | null>(null);
  const save = trpc.settings.updateClinicalUnits.useMutation({
    onSuccess: async (units) => {
      utils.settings.getClinicalUnits.setData(undefined, units);
      setDraft(null);
      await Promise.all([
        utils.records.settings.invalidate(),
        utils.settings.getPractice.invalidate(),
      ]);
      toast.success("Clinical units saved");
    },
    onError: (error) => toast.error(error.message),
  });
  const current = draft ?? query.data;
  return (
    <section
      className="space-y-4 rounded-lg border border-border p-4"
      aria-labelledby="clinical-units-heading"
    >
      <div>
        <h3 id="clinical-units-heading" className="font-medium">
          Clinical units
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose the clinic’s default units. Staff can select a different unit
          when recording a measurement.
        </p>
      </div>
      {query.error ? (
        <p role="alert" className="text-sm text-destructive">
          Unable to load clinical units.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void query.refetch()}
          >
            Retry
          </button>
        </p>
      ) : !current ? (
        <p role="status">Loading clinical units...</p>
      ) : (
        <fieldset disabled={save.isPending} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="block">Default weight unit</span>
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3"
                value={current.weightEntryUnit}
                onChange={(event) =>
                  setDraft({
                    ...current,
                    weightEntryUnit: event.target
                      .value as ClinicalUnits["weightEntryUnit"],
                  })
                }
              >
                {WEIGHT_UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {unit}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="block">Default temperature unit</span>
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3"
                value={current.temperatureUnit}
                onChange={(event) =>
                  setDraft({
                    ...current,
                    temperatureUnit: event.target
                      .value as ClinicalUnits["temperatureUnit"],
                  })
                }
              >
                {TEMPERATURE_UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    °{unit}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={current.dualDisplay}
              onChange={(event) =>
                setDraft({ ...current, dualDisplay: event.target.checked })
              }
            />
            Show both units on charts and summaries
          </label>
          <Button
            type="button"
            disabled={!draft || save.isPending}
            onClick={() => save.mutate(current)}
          >
            {save.isPending ? "Saving..." : "Save clinical units"}
          </Button>
        </fieldset>
      )}
    </section>
  );
}
