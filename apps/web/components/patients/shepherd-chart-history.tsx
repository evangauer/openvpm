"use client";

import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatClinicalDateTime } from "@/lib/records/clinical-dates";

const IMPORTED_BADGE = "Imported from Shepherd";

export function ShepherdChartHistory({
  patientId,
  timeZone,
  focus = "chart",
}: {
  patientId: string;
  timeZone?: string | null;
  focus?: "chart" | "visits";
}) {
  const chart = trpc.patientImportedHistory.chart.useQuery({ patientId });

  if (chart.isLoading) {
    if (focus === "visits") return null;
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading imported history…
      </p>
    );
  }
  if (chart.error || !chart.data) {
    if (focus === "visits") return null;
    return (
      <div role="alert" className="space-y-2 text-sm">
        <p>Could not load imported history.</p>
        <Button size="sm" variant="outline" onClick={() => chart.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const data = chart.data;
  const visits = <VisitList visits={data.visits} timeZone={timeZone} />;
  if (focus === "visits") {
    return data.visits.length === 0 ? null : (
      <section aria-label="Imported visits" className="space-y-3">
        {visits}
      </section>
    );
  }

  const empty =
    data.visits.length === 0 &&
    data.prescriptions.length === 0 &&
    data.labResults.length === 0 &&
    data.labReports.length === 0 &&
    data.documents.length === 0;

  return (
    <section
      aria-label="Imported Shepherd history"
      data-testid="shepherd-chart-history"
      className="space-y-4 rounded-lg border border-border bg-card p-6"
    >
      <div>
        <h3 className="font-heading text-base font-semibold">
          Imported history
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Historical records linked by source identity. Rows that still need a
          patient link stay in the migration archive. Financial documents stay
          in that archive too.
        </p>
      </div>
      {empty ? (
        <p role="status" className="text-sm text-muted-foreground">
          No imported history is linked to this patient.
        </p>
      ) : (
        <div className="space-y-6">
          {visits}
          <MedicationList prescriptions={data.prescriptions} timeZone={timeZone} />
          <LabResultList results={data.labResults} timeZone={timeZone} />
          <LabReportList reports={data.labReports} timeZone={timeZone} />
          <DocumentList documents={data.documents} timeZone={timeZone} />
        </div>
      )}
    </section>
  );
}

function SourceBadge({ badge }: { badge: string }) {
  return <Badge variant="secondary">{badge === IMPORTED_BADGE ? IMPORTED_BADGE : badge}</Badge>;
}

function VisitList({
  visits,
  timeZone,
}: {
  visits: Array<{
    id: string;
    startedAt: string;
    status: string;
    appointmentType: string | null;
    reason: string | null;
    badge: string;
    createsCalendarWork: false;
  }>;
  timeZone?: string | null;
}) {
  if (visits.length === 0) return null;
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold">Visits</h4>
      <p className="text-sm text-muted-foreground">
        Historical visit. It is not on the calendar.
      </p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {visits.map((visit) => (
          <li key={visit.id} className="space-y-1 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium">{visit.appointmentType || "Visit"}</p>
              <SourceBadge badge={visit.badge} />
              <Badge variant="outline">{visit.status.replaceAll("_", " ")}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {formatClinicalDateTime(visit.startedAt, timeZone, "Date unavailable")}
              {visit.reason ? ` · ${visit.reason}` : ""}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MedicationList({
  prescriptions,
  timeZone,
}: {
  prescriptions: Array<{
    id: string;
    medicationName: string;
    directions: string | null;
    status: string;
    prescribedAt: string | null;
    badge: string;
    dispensable: false;
    refillable: false;
    fills: Array<{
      id: string;
      filledAt: string | null;
      quantityDispensed: string | null;
      sourceStatus: string | null;
    }>;
  }>;
  timeZone?: string | null;
}) {
  if (prescriptions.length === 0) return null;
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold">Medications</h4>
      <p className="text-sm text-muted-foreground">
        Historical medication. It cannot be dispensed or refilled.
      </p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {prescriptions.map((prescription) => (
          <li key={prescription.id} className="space-y-2 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium">{prescription.medicationName}</p>
              <SourceBadge badge={prescription.badge} />
              <Badge variant="outline">
                {prescription.status.replaceAll("_", " ")}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {prescription.prescribedAt
                ? formatClinicalDateTime(
                    prescription.prescribedAt,
                    timeZone,
                    "Date unavailable",
                  )
                : "Date unavailable"}
              {prescription.directions ? ` · ${prescription.directions}` : ""}
            </p>
            {prescription.fills.length > 0 ? (
              <ul className="space-y-1 text-sm text-muted-foreground">
                {prescription.fills.map((fill) => (
                  <li key={fill.id}>
                    Fill
                    {fill.filledAt
                      ? ` ${formatClinicalDateTime(fill.filledAt, timeZone, "")}`
                      : ""}
                    {fill.quantityDispensed
                      ? ` · quantity ${fill.quantityDispensed}`
                      : ""}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No fills in the source history.</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function LabResultList({
  results,
  timeZone,
}: {
  results: Array<{
    id: string;
    testName: string;
    resultValue: string;
    unit: string | null;
    referenceRangeLow: string | null;
    referenceRangeHigh: string | null;
    resultFlag: string;
    resultedAt: string | null;
    badge: string;
  }>;
  timeZone?: string | null;
}) {
  if (results.length === 0) return null;
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold">Lab results</h4>
      <p className="text-sm text-muted-foreground">
        Scalar source results shown in the chart. Panels that do not fit a
        single result stay with the archive report.
      </p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {results.map((result) => (
          <li key={result.id} className="space-y-1 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium">{result.testName}</p>
              <SourceBadge badge={result.badge} />
              <Badge variant="outline">{result.resultFlag}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {result.resultValue}
              {result.unit ? ` ${result.unit}` : ""}
              {result.referenceRangeLow && result.referenceRangeHigh
                ? ` · reference ${result.referenceRangeLow}-${result.referenceRangeHigh}`
                : ""}
              {result.resultedAt
                ? ` · ${formatClinicalDateTime(result.resultedAt, timeZone, "")}`
                : ""}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LabReportList({
  reports,
  timeZone,
}: {
  reports: Array<{
    id: string;
    orderName: string | null;
    status: string;
    resultedAt: string | null;
    badge: string;
    panelKeptInArchive: boolean;
  }>;
  timeZone?: string | null;
}) {
  if (reports.length === 0) return null;
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold">Lab reports</h4>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {reports.map((report) => (
          <li key={report.id} className="space-y-1 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium">{report.orderName || "Lab report"}</p>
              <SourceBadge badge={report.badge} />
              <Badge variant="outline">{report.status.replaceAll("_", " ")}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {report.resultedAt
                ? formatClinicalDateTime(report.resultedAt, timeZone, "Date unavailable")
                : "Date unavailable"}
              {report.panelKeptInArchive
                ? " · Source panel kept in the migration archive."
                : ""}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DocumentList({
  documents,
  timeZone,
}: {
  documents: Array<{
    id: string;
    title: string;
    kind: string;
    documentDate: string | null;
    fileUrl: string | null;
    badge: string;
  }>;
  timeZone?: string | null;
}) {
  if (documents.length === 0) return null;
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold">Documents</h4>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {documents.map((document) => (
          <li key={document.id} className="space-y-1 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium">{document.title}</p>
              <SourceBadge badge={document.badge} />
              <Badge variant="outline">{document.kind.replaceAll("_", " ")}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {document.documentDate
                ? formatClinicalDateTime(
                    `${document.documentDate}T12:00:00.000Z`,
                    timeZone,
                    "Date unavailable",
                  )
                : "Date unavailable"}
            </p>
            {document.fileUrl ? (
              <a
                href={document.fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-9 items-center text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                Open document
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
