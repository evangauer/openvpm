"use client";

import { useMemo, useState } from "react";
import { Clock3, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";

type ProviderWindow = {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
};

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function weekdayPreset(): ProviderWindow[] {
  return [1, 2, 3, 4, 5].map((dayOfWeek) => ({
    dayOfWeek,
    startTime: "08:00",
    endTime: "18:00",
  }));
}

function scheduleError(windows: ProviderWindow[]): string | null {
  for (let dayOfWeek = 0; dayOfWeek < DAYS.length; dayOfWeek += 1) {
    const day = windows
      .filter((window) => window.dayOfWeek === dayOfWeek)
      .sort((left, right) => left.startTime.localeCompare(right.startTime));
    if (day.length > 3) return "Use at most three working windows per day.";
    for (let index = 0; index < day.length; index += 1) {
      const window = day[index]!;
      if (window.startTime >= window.endTime) {
        return `${DAYS[dayOfWeek]} hours must end after they start.`;
      }
      if (index > 0 && window.startTime < day[index - 1]!.endTime) {
        return `${DAYS[dayOfWeek]} working windows cannot overlap.`;
      }
    }
  }
  return null;
}

function oneHourAfter(time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  const totalMinutes = Math.min((hours ?? 0) * 60 + (minutes ?? 0) + 60, 1439);
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}`;
}

export function ProviderHours() {
  const utils = trpc.useUtils();
  const setup = trpc.settings.providerScheduleSetup.useQuery();
  const [editingProviderId, setEditingProviderId] = useState<string | null>(
    null,
  );
  const [editingRevision, setEditingRevision] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProviderWindow[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState("");
  const validationError = useMemo(() => scheduleError(draft), [draft]);
  const save = trpc.settings.replaceProviderSchedule.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.settings.providerScheduleSetup.invalidate(),
        utils.settings.listUsers.invalidate(),
      ]);
      setEditingProviderId(null);
      setEditingRevision(null);
      toast.success("Provider hours saved");
    },
    onError: (error) => toast.error(error.message),
  });

  if (setup.isLoading) {
    return (
      <div className="rounded-lg border border-border p-6">
        <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (setup.error || !setup.data) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
        <p className="font-medium">Provider hours could not be loaded.</p>
        <p className="mt-1 text-muted-foreground">
          {setup.error?.message ?? "Refresh and try again."}
        </p>
        <Button
          className="mt-3"
          size="sm"
          variant="outline"
          onClick={() => void setup.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  }

  const { locations, primaryLocation, providers, timezone } = setup.data;
  const selectedLocation =
    locations.find((location) => location.id === selectedLocationId) ??
    primaryLocation ??
    locations[0];

  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
        <div>
          <div className="flex items-center gap-2">
            <Clock3 className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Provider working hours</h3>
          </div>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Set each veterinarian&apos;s weekly coverage at every clinic. Times
            use {timezone}. Doctor-required client requests only show configured
            provider coverage once your clinic saves its first hours.
          </p>
        </div>
        {locations.length > 0 ? (
          <label className="text-xs font-medium text-muted-foreground">
            Clinic location
            <select
              aria-label="Provider hours clinic location"
              className="mt-1 block h-9 min-w-48 rounded-md border border-input bg-background px-3 text-sm text-foreground"
              value={selectedLocation?.id ?? ""}
              onChange={(event) => {
                setSelectedLocationId(event.target.value);
                setEditingProviderId(null);
                setEditingRevision(null);
                setDraft([]);
              }}
            >
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                  {location.isPrimary ? " (primary)" : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {!selectedLocation ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          Add an active clinic location before setting provider hours.
        </div>
      ) : providers.length === 0 ? (
        <div className="rounded-md bg-muted/50 p-4 text-sm text-muted-foreground">
          Mark at least one active staff member as a veterinarian provider to
          configure appointment coverage.
        </div>
      ) : (
        <div className="space-y-3">
          {providers.map((provider) => {
            const editing = editingProviderId === provider.id;
            const windows =
              provider.locationSchedules.find(
                (schedule) => schedule.locationId === selectedLocation.id,
              )?.windows ?? [];
            const homeLocation = locations.find(
              (location) => location.id === provider.locationId,
            );
            const dayCount = new Set(windows.map((window) => window.dayOfWeek))
              .size;
            return (
              <div
                key={provider.id}
                className="rounded-md border border-border p-3"
              >
                <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
                  <div>
                    <p className="text-sm font-medium">{provider.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {windows.length === 0
                        ? `No hours set at ${selectedLocation.name}`
                        : `${dayCount} day${dayCount === 1 ? "" : "s"} · ${windows.length} working window${windows.length === 1 ? "" : "s"}`}
                    </p>
                    {homeLocation ? (
                      <p className="text-xs text-muted-foreground">
                        Home base: {homeLocation.name}
                      </p>
                    ) : null}
                    {provider.unspecifiedWindowCount > 0 ? (
                      <p className="text-xs text-amber-700">
                        {provider.unspecifiedWindowCount} legacy practice-wide
                        working{" "}
                        {provider.unspecifiedWindowCount === 1
                          ? "window"
                          : "windows"}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    size="sm"
                    variant={editing ? "secondary" : "outline"}
                    disabled={save.isPending}
                    onClick={() => {
                      if (editing) {
                        setEditingProviderId(null);
                        setEditingRevision(null);
                        return;
                      }
                      setEditingProviderId(provider.id);
                      setEditingRevision(provider.revision);
                      setDraft(windows.map((window) => ({ ...window })));
                    }}
                  >
                    {editing ? "Close editor" : "Set hours"}
                  </Button>
                </div>

                {editing ? (
                  <div className="mt-4 space-y-3 border-t border-border pt-4">
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setDraft(weekdayPreset())}
                      >
                        Use Mon–Fri, 8–6
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDraft([])}
                      >
                        Mark all closed
                      </Button>
                    </div>

                    <div className="space-y-2">
                      {DAYS.map((dayName, dayOfWeek) => {
                        const windows = draft
                          .map((window, index) => ({ window, index }))
                          .filter(
                            ({ window }) => window.dayOfWeek === dayOfWeek,
                          )
                          .sort(({ window: left }, { window: right }) =>
                            left.startTime.localeCompare(right.startTime),
                          );
                        return (
                          <div
                            key={dayName}
                            className="grid gap-2 rounded-md bg-muted/30 p-2 sm:grid-cols-[7rem_1fr]"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-medium">
                                {dayName}
                              </span>
                              {windows.length === 0 ? (
                                <span className="text-xs text-muted-foreground">
                                  Closed
                                </span>
                              ) : null}
                            </div>
                            <div className="space-y-2">
                              {windows.map(({ window, index }) => (
                                <div
                                  key={index}
                                  className="flex items-center gap-2"
                                >
                                  <Input
                                    aria-label={`${dayName} start time`}
                                    className="h-8 w-32"
                                    type="time"
                                    value={window.startTime}
                                    onChange={(event) =>
                                      setDraft((current) =>
                                        current.map(
                                          (candidate, candidateIndex) =>
                                            candidateIndex === index
                                              ? {
                                                  ...candidate,
                                                  startTime: event.target.value,
                                                }
                                              : candidate,
                                        ),
                                      )
                                    }
                                  />
                                  <span className="text-xs text-muted-foreground">
                                    to
                                  </span>
                                  <Input
                                    aria-label={`${dayName} end time`}
                                    className="h-8 w-32"
                                    type="time"
                                    value={window.endTime}
                                    onChange={(event) =>
                                      setDraft((current) =>
                                        current.map(
                                          (candidate, candidateIndex) =>
                                            candidateIndex === index
                                              ? {
                                                  ...candidate,
                                                  endTime: event.target.value,
                                                }
                                              : candidate,
                                        ),
                                      )
                                    }
                                  />
                                  <Button
                                    aria-label={`Remove ${dayName} working window`}
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                      setDraft((current) =>
                                        current.filter(
                                          (_, candidateIndex) =>
                                            candidateIndex !== index,
                                        ),
                                      )
                                    }
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </div>
                              ))}
                              {windows.length < 3 ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() =>
                                    setDraft((current) => [
                                      ...current,
                                      {
                                        dayOfWeek,
                                        startTime:
                                          windows.at(-1)?.window.endTime ??
                                          "08:00",
                                        endTime: windows.length
                                          ? oneHourAfter(
                                              windows.at(-1)!.window.endTime,
                                            )
                                          : "18:00",
                                      },
                                    ])
                                  }
                                >
                                  <Plus className="mr-1 h-3.5 w-3.5" />
                                  Add window
                                </Button>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {validationError ? (
                      <p className="text-xs text-destructive">
                        {validationError}
                      </p>
                    ) : null}
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={
                          Boolean(validationError) ||
                          save.isPending ||
                          editingRevision === null
                        }
                        onClick={() =>
                          save.mutate({
                            userId: provider.id,
                            locationId: selectedLocation.id,
                            windows: draft,
                            expectedRevision: editingRevision!,
                          })
                        }
                      >
                        {save.isPending ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : null}
                        Save provider hours
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={save.isPending}
                        onClick={() => {
                          setEditingProviderId(null);
                          setEditingRevision(null);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
