"use client";

import { useMemo } from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { rowIssuesCsv, summarizeRowIssues } from "@/lib/csv/import";

export function ImportRowIssues({ errors, csv }: { errors: string[]; csv: string }) {
  const summary = useMemo(() => summarizeRowIssues(errors), [errors]);
  if (!errors.length) return null;

  function download() {
    const report = rowIssuesCsv(csv, errors);
    if (!report) {
      toast.error("Fix the file-level issues and check the CSV again before downloading rows.");
      return;
    }
    const url = URL.createObjectURL(new Blob(["\uFEFF", report], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "openvpm-import-rows-to-review.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <section aria-label="Import issues to review" className="mt-4 rounded-lg border border-amber-200 bg-amber-50/40 p-4 dark:border-amber-900 dark:bg-amber-950/10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-sm font-semibold">
          {summary.affectedRows ? `${summary.affectedRows} data row${summary.affectedRows === 1 ? "" : "s"} to review` : "Check the CSV file"}
        </h4>
        {summary.affectedRows > 0 ? (
          <Button type="button" variant="outline" size="sm" onClick={download} className="min-h-11">
            <Download className="mr-2 h-4 w-4" aria-hidden="true" /> Download rows to review
          </Button>
        ) : null}
      </div>
      {summary.fileIssues.length ? (
        <ul className="mt-3 list-inside list-disc space-y-1 text-sm">
          {summary.fileIssues.map((issue) => <li key={issue}>{issue}</li>)}
        </ul>
      ) : null}
      <ul className="mt-3 max-h-72 space-y-3 overflow-y-auto text-sm">
        {summary.groups.map((group) => (
          <li key={group.message}>
            <p><span className="font-medium">{group.count} row{group.count === 1 ? "" : "s"}</span> — {group.message}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Data rows: {group.rows.join(", ")}{group.remaining ? `, and ${group.remaining} more` : ""}
            </p>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        Data rows start at 1 after the header; blank lines do not count. The worksheet includes warnings and skipped rows. Correct the original file, then check it again before importing.
      </p>
    </section>
  );
}
