"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { trpc } from "@/lib/trpc";
import {
  ArchiveDetail,
  formatImportedDate,
} from "@/components/migration/archive-detail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const sections = [
  { id: "medications", label: "Medications" },
  { id: "labs", label: "Labs" },
  { id: "documents", label: "Documents" },
] as const;
type Section = (typeof sections)[number]["id"];
const PAGE_SIZE = 20;

export function ImportedRecords({
  patientId,
  timeZone,
}: {
  patientId: string;
  timeZone?: string | null;
}) {
  return (
    <PatientImportedRecords
      key={patientId}
      patientId={patientId}
      timeZone={timeZone}
    />
  );
}

function PatientImportedRecords({
  patientId,
  timeZone,
}: {
  patientId: string;
  timeZone?: string | null;
}) {
  const id = useId();
  const [section, setSection] = useState<Section>("medications");
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = trpc.migrationArchive.list.useQuery({
    section,
    patientId,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });
  const detail = trpc.migrationArchive.detail.useQuery(
    {
      section,
      patientId,
      id: selectedId ?? "00000000-0000-0000-0000-000000000000",
    },
    { enabled: section !== "documents" && !!selectedId },
  );
  const totalPages = Math.max(
    1,
    Math.ceil((list.data?.total ?? 0) / PAGE_SIZE),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Imported records</CardTitle>
        <p className="text-sm text-muted-foreground">
          Read-only history imported from a prior system. Imported medications
          are historical and are not active prescriptions. Source dates are
          shown when available; missing source dates are labelled.
        </p>
        <div
          role="tablist"
          aria-label="Imported record types"
          className="flex max-w-full gap-1 overflow-x-auto rounded-lg bg-muted p-1"
        >
          {sections.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={section === item.id}
              id={`${id}-${item.id}`}
              aria-controls={`${id}-records`}
              tabIndex={section === item.id ? 0 : -1}
              onKeyDown={(event) => {
                const index = sections.findIndex(
                  (entry) => entry.id === section,
                );
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % sections.length
                    : event.key === "ArrowLeft"
                      ? (index + sections.length - 1) % sections.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? sections.length - 1
                          : null;
                if (next === null) return;
                event.preventDefault();
                setSection(sections[next].id);
                setPage(0);
                setSelectedId(null);
                event.currentTarget.parentElement
                  ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  [next]?.focus();
              }}
              className={`min-h-9 shrink-0 rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${section === item.id ? "bg-background shadow-sm" : "text-muted-foreground"}`}
              onClick={() => {
                setSection(item.id);
                setPage(0);
                setSelectedId(null);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <div
          id={`${id}-records`}
          aria-labelledby={`${id}-${section}`}
          tabIndex={0}
          role="tabpanel"
          className="min-w-0 space-y-3"
        >
          {list.isLoading ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading imported records…
            </p>
          ) : list.error ? (
            <div role="alert" className="space-y-2 text-sm">
              <p>Could not load imported records.</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => list.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : !list.data ? (
            <p role="alert">Imported records are unavailable.</p>
          ) : list.data.items.length === 0 ? (
            <p role="status" className="text-sm text-muted-foreground">
              No imported {section} are linked to this patient.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {list.data.items.map((item) => (
                <li key={item.id} className="min-w-0 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 break-words font-medium">
                      {item.title}
                    </p>
                    <Badge variant="secondary">
                      Source status: {item.status.replaceAll("_", " ")}
                    </Badge>
                    {item.needsReview ? (
                      <Badge variant="destructive">Needs review</Badge>
                    ) : null}
                    <Badge variant="outline">Imported</Badge>
                  </div>
                  <p className="mt-1 break-words text-sm text-muted-foreground">
                    {item.subtitle}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 break-words text-xs text-muted-foreground">
                    <span>
                      {"sourceDate" in item && item.sourceDate
                        ? `Source date: ${formatImportedDate(item.sourceDate, timeZone)}`
                        : "Source date unavailable"}
                    </span>
                    {item.meta.map((part, i) => (
                      <span className="min-w-0 break-words" key={i}>
                        {part}
                      </span>
                    ))}
                  </div>
                  {item.fileUrl ? (
                    <Link
                      href={item.fileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-3 inline-flex min-h-9 items-center text-sm font-medium text-primary underline-offset-4 hover:underline"
                    >
                      Open document
                    </Link>
                  ) : null}
                  {section !== "documents" ? (
                    <div className="mt-3">
                      <Button
                        size="sm"
                        variant="outline"
                        id={`${id}-toggle-${item.id}`}
                        aria-controls={`${id}-detail-${item.id}`}
                        aria-expanded={selectedId === item.id}
                        onClick={() =>
                          setSelectedId(selectedId === item.id ? null : item.id)
                        }
                      >
                        {selectedId === item.id
                          ? "Close details"
                          : "View details"}
                      </Button>
                    </div>
                  ) : null}
                  {selectedId === item.id && section !== "documents" ? (
                    <div
                      id={`${id}-detail-${item.id}`}
                      role="region"
                      className="mt-3 rounded-md border p-3"
                      aria-label="Imported record source detail"
                    >
                      <ArchiveDetail
                        data={detail.data}
                        isLoading={detail.isLoading}
                        errorMessage={
                          detail.error
                            ? "Could not load source details."
                            : undefined
                        }
                        timeZone={timeZone}
                      />
                      {detail.error ? (
                        <Button
                          className="mt-2"
                          size="sm"
                          variant="outline"
                          onClick={() => detail.refetch()}
                        >
                          Retry details
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {list.data && (page > 0 || list.data.total > PAGE_SIZE) ? (
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page === 0}
                onClick={() => {
                  setPage(page - 1);
                  setSelectedId(null);
                }}
              >
                Previous
              </Button>
              <span className="text-sm">
                Page {page + 1} of {totalPages}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={page + 1 >= totalPages}
                onClick={() => {
                  setPage(page + 1);
                  setSelectedId(null);
                }}
              >
                Next
              </Button>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
