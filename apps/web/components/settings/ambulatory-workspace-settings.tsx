"use client";

import { Loader2, Save, Stethoscope } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { trpc } from "@/lib/trpc";
import {
  ambulatoryWorkspaceSettings,
  type AmbulatoryWorkspaceSettings,
} from "@/lib/ambulatory-workspace";

export function AmbulatoryWorkspaceSettingsCard({
  settings,
  rolloutEnabled,
}: {
  settings: unknown;
  rolloutEnabled: boolean;
}) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState<AmbulatoryWorkspaceSettings | null>(null);
  const persisted = ambulatoryWorkspaceSettings(settings);
  const current = draft ?? persisted;
  const update = trpc.settings.updateAmbulatoryWorkspace.useMutation({
    onSuccess: async (saved) => {
      setDraft(saved);
      await utils.settings.getPractice.invalidate();
      toast.success("Ambulatory workspace settings saved");
    },
    onError: (error) => toast.error(error.message),
  });

  if (!rolloutEnabled) return null;

  return (
    <section className="space-y-5 rounded-lg border border-border bg-card p-6 xl:col-span-2">
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-primary/10 p-2 text-primary">
          <Stethoscope className="h-5 w-5" />
        </div>
        <div>
          <h3 className="text-sm font-semibold">Ambulatory workspace</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            A field-first patient workflow with direct visit start, one-page
            clinical entry, large-animal measurements, and compact closeout.
            Existing clinic workflows stay unchanged until this is enabled.
          </p>
        </div>
      </div>

      <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3">
        <Checkbox
          checked={current.enabled}
          disabled={update.isPending}
          onChange={(event) =>
            setDraft({ ...current, enabled: event.currentTarget.checked })
          }
        />
        <span>
          <span className="block text-sm font-medium">
            Enable ambulatory workspace
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">
            Adds “Start field visit” to active patient charts. Scheduled clinic
            workflows remain unchanged.
          </span>
        </span>
      </label>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="space-y-1.5">
          <span className="text-sm font-medium">Measurements</span>
          <select
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={current.measurementSystem}
            disabled={update.isPending}
            onChange={(event) =>
              setDraft({
                ...current,
                measurementSystem: event.target.value as
                  | "metric"
                  | "us_customary",
              })
            }
          >
            <option value="metric">Kilograms / Celsius</option>
            <option value="us_customary">Pounds / Fahrenheit</option>
          </select>
        </label>

        <label className="space-y-1.5">
          <span className="text-sm font-medium">Body condition scale</span>
          <select
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={current.bodyConditionScale}
            disabled={update.isPending}
            onChange={(event) =>
              setDraft({
                ...current,
                bodyConditionScale: event.target.value === "5" ? 5 : 9,
              })
            }
          >
            <option value="5">1–5</option>
            <option value="9">1–9</option>
          </select>
        </label>

        <label className="flex cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2">
          <Checkbox
            checked={current.compactCloseout}
            disabled={update.isPending}
            onChange={(event) =>
              setDraft({
                ...current,
                compactCloseout: event.currentTarget.checked,
              })
            }
          />
          <span className="text-sm font-medium">Compact closeout</span>
        </label>
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          disabled={update.isPending}
          onClick={() => update.mutate(current)}
        >
          {update.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          Save ambulatory settings
        </Button>
      </div>
    </section>
  );
}
