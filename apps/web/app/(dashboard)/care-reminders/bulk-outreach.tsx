"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Mail, MessageSquare, Send } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  CARE_REMINDER_SPECIES,
  CARE_REMINDER_SPECIES_LABELS,
  type CareReminderSpecies,
} from "@/lib/care-reminder-species";

type DueFilter = "all" | "overdue" | "range";
type LastContactedFilter = "any" | "never" | "before";
type ChannelFilter = "auto" | "email" | "sms";

function isSpecies(value: string): value is CareReminderSpecies {
  return (CARE_REMINDER_SPECIES as readonly string[]).includes(value);
}

export function CareReminderBulkOutreach() {
  const utils = trpc.useUtils();
  const [due, setDue] = useState<DueFilter>("overdue");
  const [dueFrom, setDueFrom] = useState("");
  const [dueTo, setDueTo] = useState("");
  const [title, setTitle] = useState("");
  const [species, setSpecies] = useState("");
  const [lastContacted, setLastContacted] =
    useState<LastContactedFilter>("any");
  const [lastContactedBefore, setLastContactedBefore] = useState("");
  const [channel, setChannel] = useState<ChannelFilter>("auto");
  const [previewing, setPreviewing] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectAllMatching, setSelectAllMatching] = useState(false);

  const filtersReady =
    (due !== "range" || (Boolean(dueFrom) && Boolean(dueTo) && dueFrom <= dueTo)) &&
    (lastContacted !== "before" || Boolean(lastContactedBefore));

  const filters = {
    due,
    ...(due === "range" ? { dueFrom, dueTo } : {}),
    ...(title.trim() ? { title: title.trim() } : {}),
    ...(isSpecies(species) ? { species } : {}),
    lastContacted,
    ...(lastContacted === "before" ? { lastContactedBefore } : {}),
    channel,
  };

  const preview = trpc.careReminders.previewBulkOutreach.useQuery(filters, {
    enabled: previewing && filtersReady,
  });
  const send = trpc.careReminders.sendBulkOutreach.useMutation({
    onSuccess: async (result) => {
      setSelectedIds(new Set());
      setSelectAllMatching(false);
      await utils.careReminders.previewBulkOutreach.invalidate();
      await utils.careReminders.list.invalidate();
      const summary = [
        `${result.sent} sent`,
        result.deduped ? `${result.deduped} already handled` : null,
        result.blocked ? `${result.blocked} blocked` : null,
        result.failed ? `${result.failed} failed` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      if (result.failed > 0) toast.error(summary);
      else toast.success(summary || "No reminders were sent");
    },
    onError: (error) => toast.error(error.message),
  });

  useEffect(() => {
    setSelectedIds(new Set());
    setSelectAllMatching(false);
  }, [
    due,
    dueFrom,
    dueTo,
    title,
    species,
    lastContacted,
    lastContactedBefore,
    channel,
  ]);

  const recipients = preview.data?.recipients ?? [];
  const maxBatch = preview.data?.maxBatch ?? 200;
  const eligible = useMemo(
    () => recipients.filter((recipient) => recipient.status === "eligible"),
    [recipients],
  );
  const selectedEligible = eligible.filter((recipient) =>
    selectedIds.has(recipient.reminderId),
  );
  const sendCount = selectAllMatching
    ? Math.min(preview.data?.eligible ?? 0, maxBatch)
    : selectedEligible.length;

  function toggle(reminderId: string, checked: boolean) {
    setSelectAllMatching(false);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) {
        if (next.size >= maxBatch) return current;
        next.add(reminderId);
      } else {
        next.delete(reminderId);
      }
      return next;
    });
  }

  function selectAll() {
    setSelectAllMatching(true);
    setSelectedIds(
      new Set(eligible.slice(0, maxBatch).map((recipient) => recipient.reminderId)),
    );
  }

  function confirmSend() {
    if (sendCount === 0 || send.isPending || !filtersReady) return;
    const scope = selectAllMatching
      ? `the first ${sendCount} eligible reminder${sendCount === 1 ? "" : "s"} matching these filters`
      : `${sendCount} selected reminder${sendCount === 1 ? "" : "s"}`;
    if (
      !window.confirm(
        `Send care reminders for ${scope} now? Blocked clients are skipped. Consent, suppression, quiet hours, and the clinic recovery hold are checked again before anything is delivered.`,
      )
    ) {
      return;
    }
    if (selectAllMatching) {
      send.mutate({ filters, selectAllMatching: true });
      return;
    }
    send.mutate({
      filters,
      reminderIds: selectedEligible.map((recipient) => recipient.reminderId),
    });
  }

  return (
    <Card data-testid="bulk-outreach">
      <CardHeader className="gap-2">
        <CardTitle>Bulk outreach</CardTitle>
        <p className="text-sm text-muted-foreground">
          Review who would be contacted before anything sends. Texts go out
          only when the client currently agrees to SMS. An imported reminder
          never counts as that agreement. One send includes at most {maxBatch}{" "}
          reminders, and each clinic can start a few of these sends per hour.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <label className="space-y-1 text-sm font-medium">
            Due
            <select
              aria-label="Due"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={due}
              onChange={(event) => setDue(event.target.value as DueFilter)}
            >
              <option value="overdue">Overdue</option>
              <option value="all">All open</option>
              <option value="range">Date range</option>
            </select>
          </label>
          {due === "range" ? (
            <>
              <label className="space-y-1 text-sm font-medium">
                Due from
                <Input
                  type="date"
                  aria-label="Due from"
                  value={dueFrom}
                  onChange={(event) => setDueFrom(event.target.value)}
                />
              </label>
              <label className="space-y-1 text-sm font-medium">
                Due to
                <Input
                  type="date"
                  aria-label="Due to"
                  value={dueTo}
                  onChange={(event) => setDueTo(event.target.value)}
                />
              </label>
            </>
          ) : null}
          <label className="space-y-1 text-sm font-medium">
            Reminder title
            <Input
              aria-label="Reminder title"
              value={title}
              placeholder="For example, dental or heartworm"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="space-y-1 text-sm font-medium">
            Species
            <select
              aria-label="Species"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={species}
              onChange={(event) => setSpecies(event.target.value)}
            >
              <option value="">Any species</option>
              {CARE_REMINDER_SPECIES.map((value) => (
                <option key={value} value={value}>
                  {CARE_REMINDER_SPECIES_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm font-medium">
            Last contacted
            <select
              aria-label="Last contacted"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={lastContacted}
              onChange={(event) =>
                setLastContacted(event.target.value as LastContactedFilter)
              }
            >
              <option value="any">Any time</option>
              <option value="never">Never contacted</option>
              <option value="before">Not contacted since</option>
            </select>
          </label>
          {lastContacted === "before" ? (
            <label className="space-y-1 text-sm font-medium">
              Not contacted since
              <Input
                type="date"
                aria-label="Not contacted since"
                value={lastContactedBefore}
                onChange={(event) => setLastContactedBefore(event.target.value)}
              />
            </label>
          ) : null}
          <label className="space-y-1 text-sm font-medium">
            Channel
            <select
              aria-label="Channel"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={channel}
              onChange={(event) =>
                setChannel(event.target.value as ChannelFilter)
              }
            >
              <option value="auto">Best available</option>
              <option value="email">Email only</option>
              <option value="sms">Text only</option>
            </select>
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!filtersReady || preview.isFetching}
            onClick={() => {
              setPreviewing(true);
              if (previewing) void preview.refetch();
            }}
          >
            {preview.isFetching ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            Preview matching
          </Button>
          <Button
            type="button"
            variant="outline"
            data-testid="bulk-select-all"
            disabled={eligible.length === 0 || send.isPending}
            onClick={selectAll}
          >
            Select all matching
          </Button>
          <Button
            type="button"
            data-testid="bulk-send"
            className="gap-2"
            disabled={sendCount === 0 || send.isPending}
            onClick={confirmSend}
          >
            {send.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {selectAllMatching
              ? `Send all matching (${sendCount})`
              : `Send selected (${sendCount})`}
          </Button>
        </div>

        {preview.error ? (
          <p className="text-sm text-destructive">{preview.error.message}</p>
        ) : null}

        {preview.data ? (
          <div className="space-y-3" data-testid="bulk-preview">
            <p className="text-sm text-muted-foreground">
              {preview.data.eligible} ready · {preview.data.blocked} blocked ·{" "}
              {preview.data.alreadySent} already sent
              {preview.data.truncated
                ? " · This preview is the first 1,000 matches. Narrow the filters before sending."
                : ""}
              {selectAllMatching
                ? ` · Sending uses the first ${sendCount} eligible matches the server still accepts.`
                : ""}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="w-10 py-3 pr-3 font-medium">
                      <input
                        type="checkbox"
                        aria-label="Select eligible reminders in this preview"
                        checked={
                          eligible.length > 0 &&
                          eligible
                            .slice(0, maxBatch)
                            .every((recipient) =>
                              selectedIds.has(recipient.reminderId),
                            )
                        }
                        disabled={eligible.length === 0}
                        onChange={(event) => {
                          setSelectAllMatching(false);
                          setSelectedIds(
                            event.target.checked
                              ? new Set(
                                  eligible
                                    .slice(0, maxBatch)
                                    .map((recipient) => recipient.reminderId),
                                )
                              : new Set(),
                          );
                        }}
                        className="h-4 w-4 rounded border-border"
                      />
                    </th>
                    <th className="py-3 pr-4 font-medium">Patient</th>
                    <th className="py-3 pr-4 font-medium">Reminder</th>
                    <th className="py-3 pr-4 font-medium">Channel</th>
                    <th className="py-3 font-medium">Eligibility</th>
                  </tr>
                </thead>
                <tbody>
                  {recipients.map((recipient) => {
                    const eligibleRow = recipient.status === "eligible";
                    return (
                      <tr
                        key={recipient.reminderId}
                        className="border-b border-border last:border-0"
                      >
                        <td className="py-3 pr-3">
                          <input
                            type="checkbox"
                            aria-label={`Select ${recipient.title} for ${recipient.patientName}`}
                            checked={selectedIds.has(recipient.reminderId)}
                            disabled={
                              !eligibleRow ||
                              send.isPending ||
                              (!selectedIds.has(recipient.reminderId) &&
                                selectedIds.size >= maxBatch)
                            }
                            onChange={(event) =>
                              toggle(recipient.reminderId, event.target.checked)
                            }
                            className="h-4 w-4 rounded border-border"
                          />
                        </td>
                        <td className="py-3 pr-4">
                          <p className="font-medium">{recipient.patientName}</p>
                          <p className="text-xs text-muted-foreground">
                            {recipient.clientName}
                          </p>
                        </td>
                        <td className="py-3 pr-4">
                          <p className="font-medium">{recipient.title}</p>
                          <p className="text-xs text-muted-foreground">
                            {recipient.imported ? "Imported · " : ""}
                            {recipient.species}
                          </p>
                        </td>
                        <td className="py-3 pr-4">
                          {recipient.channel === "sms" ? (
                            <span className="inline-flex items-center gap-1">
                              <MessageSquare className="h-3.5 w-3.5" /> Text
                            </span>
                          ) : recipient.channel === "email" ? (
                            <span className="inline-flex items-center gap-1">
                              <Mail className="h-3.5 w-3.5" /> Email
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-3">
                          {recipient.status === "eligible" ? (
                            <span className="text-sm">
                              Ready
                              {recipient.blockMessage
                                ? ` · ${recipient.blockMessage}`
                                : ""}
                            </span>
                          ) : (
                            <span
                              className="text-sm text-destructive"
                              data-testid="bulk-block-reason"
                            >
                              {recipient.blockMessage ??
                                (recipient.status === "already_sent"
                                  ? "Already sent"
                                  : "Blocked")}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
