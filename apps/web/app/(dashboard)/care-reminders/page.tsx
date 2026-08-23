"use client";

import { useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  AlertTriangle,
  BellRing,
  CheckCircle2,
  Clock3,
  Loader2,
  Plus,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/common/empty-state";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type ReminderStatusFilter = "open" | "completed";
type ReminderDueFilter = "all" | "overdue" | "upcoming";

function canManage(role?: string | null): boolean {
  return ["admin", "veterinarian", "technician", "front_desk"].includes(
    role ?? "",
  );
}

function displayDate(value: string): string {
  return new Date(`${value}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default function CareRemindersPage() {
  const { data: session } = useSession();
  const utils = trpc.useUtils();
  const [status, setStatus] = useState<ReminderStatusFilter>("open");
  const [due, setDue] = useState<ReminderDueFilter>("all");
  const [showCreate, setShowCreate] = useState(false);
  const [patientQuery, setPatientQuery] = useState("");
  const [selectedPatient, setSelectedPatient] = useState<{
    id: string;
    name: string;
    clientName: string;
  } | null>(null);
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const query = trpc.careReminders.list.useQuery({ status, due, limit: 1000 });
  const patientSearch = trpc.patients.search.useQuery(
    { query: patientQuery, status: "active" },
    {
      enabled:
        showCreate && !selectedPatient && patientQuery.trim().length >= 2,
    },
  );
  const update = trpc.careReminders.setCompleted.useMutation({
    onSuccess: async (_, variables) => {
      await utils.careReminders.list.invalidate();
      toast.success(
        variables.completed ? "Reminder completed" : "Reminder reopened",
      );
    },
    onError: (error) => toast.error(error.message),
  });
  const manageable = canManage(session?.user?.role);
  const create = trpc.careReminders.create.useMutation({
    onSuccess: async () => {
      setShowCreate(false);
      setPatientQuery("");
      setSelectedPatient(null);
      setTitle("");
      setDueDate("");
      setNotes("");
      setStatus("open");
      setDue("all");
      await utils.careReminders.list.invalidate();
      toast.success("Care reminder added");
    },
    onError: (error) => toast.error(error.message),
  });

  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-5 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading care reminders...
      </div>
    );
  }

  if (query.error || !query.data) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Could not load care reminders"
        description={
          query.error?.message ?? "The reminder queue returned no data."
        }
        action={{ label: "Retry", onClick: () => query.refetch() }}
      />
    );
  }

  const { counts, items, today } = query.data;
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-heading text-xl font-semibold">Care reminders</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Internal follow-up work for each patient. This queue never sends an
            email or text automatically; client outreach remains a separate,
            deliberate action with its own consent checks.
          </p>
        </div>
        {manageable ? (
          <Button className="gap-2" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" /> Add reminder
          </Button>
        ) : null}
      </div>

      {showCreate ? (
        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle>Add an internal reminder</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Choose an active patient. Saving adds clinic work only and does
                not contact the client.
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close reminder form"
              onClick={() => setShowCreate(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4 md:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!selectedPatient || !title.trim() || !dueDate) return;
                create.mutate({
                  patientId: selectedPatient.id,
                  title,
                  dueDate,
                  notes: notes || undefined,
                });
              }}
            >
              <div className="space-y-2 md:col-span-2">
                <label
                  className="text-sm font-medium"
                  htmlFor="care-reminder-patient"
                >
                  Patient
                </label>
                {selectedPatient ? (
                  <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                    <div>
                      <p className="text-sm font-medium">
                        {selectedPatient.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {selectedPatient.clientName}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setSelectedPatient(null);
                        setPatientQuery("");
                      }}
                    >
                      Change
                    </Button>
                  </div>
                ) : (
                  <>
                    <Input
                      id="care-reminder-patient"
                      value={patientQuery}
                      onChange={(event) => setPatientQuery(event.target.value)}
                      placeholder="Search active patients or owners"
                      autoComplete="off"
                    />
                    {patientSearch.isFetching ? (
                      <p className="text-xs text-muted-foreground">
                        Searching...
                      </p>
                    ) : null}
                    {patientSearch.data?.length ? (
                      <div className="max-h-44 overflow-y-auto rounded-md border border-border">
                        {patientSearch.data.map((patient) => (
                          <button
                            key={patient.id}
                            type="button"
                            className="block w-full border-b border-border px-3 py-2 text-left last:border-0 hover:bg-accent"
                            onClick={() =>
                              setSelectedPatient({
                                id: patient.id,
                                name: patient.name,
                                clientName:
                                  [
                                    patient.clientFirstName,
                                    patient.clientLastName,
                                  ]
                                    .filter(Boolean)
                                    .join(" ") || "Client",
                              })
                            }
                          >
                            <span className="text-sm font-medium">
                              {patient.name}
                            </span>
                            <span className="ml-2 text-xs text-muted-foreground">
                              {[patient.clientFirstName, patient.clientLastName]
                                .filter(Boolean)
                                .join(" ")}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </>
                )}
              </div>
              <div className="space-y-2">
                <label
                  className="text-sm font-medium"
                  htmlFor="care-reminder-title"
                >
                  Reminder
                </label>
                <Input
                  id="care-reminder-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={255}
                  required
                />
              </div>
              <div className="space-y-2">
                <label
                  className="text-sm font-medium"
                  htmlFor="care-reminder-date"
                >
                  Due date
                </label>
                <Input
                  id="care-reminder-date"
                  type="date"
                  value={dueDate}
                  onChange={(event) => setDueDate(event.target.value)}
                  required
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <label
                  className="text-sm font-medium"
                  htmlFor="care-reminder-notes"
                >
                  Notes (optional)
                </label>
                <Textarea
                  id="care-reminder-notes"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  maxLength={4000}
                />
              </div>
              <div className="flex justify-end gap-2 md:col-span-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowCreate(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={
                    !selectedPatient ||
                    !title.trim() ||
                    !dueDate ||
                    create.isPending
                  }
                >
                  {create.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  Save reminder
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Metric label="Open" value={counts.open} icon={BellRing} />
        <Metric label="Due or overdue" value={counts.overdue} icon={Clock3} />
        <Metric label="Upcoming" value={counts.upcoming} icon={CheckCircle2} />
      </div>

      <Card>
        <CardHeader className="gap-4 sm:flex-row sm:items-center sm:justify-between sm:space-y-0">
          <div>
            <CardTitle>Patient follow-up queue</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Due dates use the practice day. Imported tasks retain source
              identity so retrying a migration cannot duplicate them.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={status === "open" ? "default" : "outline"}
              onClick={() => setStatus("open")}
            >
              Open
            </Button>
            <Button
              size="sm"
              variant={status === "completed" ? "default" : "outline"}
              onClick={() => {
                setStatus("completed");
                setDue("all");
              }}
            >
              Completed
            </Button>
            {status === "open" ? (
              <>
                {(["all", "overdue", "upcoming"] as const).map((value) => (
                  <Button
                    key={value}
                    size="sm"
                    variant={due === value ? "secondary" : "ghost"}
                    onClick={() => setDue(value)}
                    className="capitalize"
                  >
                    {value}
                  </Button>
                ))}
              </>
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <EmptyState
              icon={status === "open" ? BellRing : CheckCircle2}
              title={
                status === "open"
                  ? "No reminders in this view"
                  : "No completed reminders"
              }
              description={
                status === "open"
                  ? "Try another due-date filter, or add a reminder from a patient record."
                  : "Completed care reminders will remain available here for review."
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-3 pr-4 font-medium">Due</th>
                    <th className="py-3 pr-4 font-medium">Patient / client</th>
                    <th className="py-3 pr-4 font-medium">Reminder</th>
                    <th className="py-3 pr-4 font-medium">Source</th>
                    <th className="py-3 text-right font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const overdue =
                      item.status === "open" && item.dueDate <= today;
                    return (
                      <tr
                        key={item.id}
                        className="border-b border-border align-top last:border-0"
                      >
                        <td className="py-4 pr-4">
                          <span
                            className={
                              overdue
                                ? "font-medium text-destructive"
                                : "font-medium"
                            }
                          >
                            {displayDate(item.dueDate)}
                          </span>
                          {overdue ? (
                            <p className="mt-1 text-xs text-destructive">
                              Due or overdue
                            </p>
                          ) : null}
                        </td>
                        <td className="py-4 pr-4">
                          <Link
                            href={`/patients/${item.patientId}`}
                            className="font-medium text-primary hover:underline"
                          >
                            {item.patientName}
                          </Link>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {item.clientName}
                          </p>
                          {item.patientStatus !== "active" ? (
                            <Badge
                              variant="outline"
                              className="mt-2 capitalize"
                            >
                              {item.patientStatus}
                            </Badge>
                          ) : null}
                        </td>
                        <td className="py-4 pr-4">
                          <p className="font-medium">{item.title}</p>
                          {item.notes ? (
                            <p className="mt-1 max-w-xl whitespace-pre-wrap text-xs text-muted-foreground">
                              {item.notes}
                            </p>
                          ) : null}
                        </td>
                        <td className="py-4 pr-4">
                          <Badge
                            variant={item.imported ? "secondary" : "outline"}
                          >
                            {item.imported ? "Imported" : "OpenVPM"}
                          </Badge>
                        </td>
                        <td className="py-4 text-right">
                          {manageable ? (
                            <Button
                              size="sm"
                              variant={
                                item.status === "open" ? "default" : "outline"
                              }
                              disabled={update.isPending}
                              onClick={() =>
                                update.mutate({
                                  id: item.id,
                                  completed: item.status === "open",
                                  expectedUpdatedAt:
                                    item.updatedAt.toISOString(),
                                })
                              }
                            >
                              {item.status === "open" ? "Complete" : "Reopen"}
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              Read only
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number;
  icon: React.ElementType;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 pt-6">
        <div className="rounded-lg bg-primary/10 p-2 text-primary">
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <p className="text-2xl font-semibold">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}
