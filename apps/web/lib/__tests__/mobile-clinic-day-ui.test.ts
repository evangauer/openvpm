import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readDashboardPage = (name: string) =>
  readFileSync(`app/(dashboard)/${name}/page.tsx`, "utf8");

describe("mobile clinic-day UI", () => {
  it("uses a touch-friendly phone agenda while preserving the full schedule at larger viewports", () => {
    const source = readDashboardPage("schedule");

    expect(source).toContain("function PhoneAgenda({");
    expect(source).toContain("aria-label={`${rangeLabel} appointment agenda`}");
    expect(source).toContain(
      'className="mt-4 max-w-full space-y-4 overflow-hidden sm:hidden"'
    );
    expect(source).toContain('className="hidden sm:block"');
    expect(source).toContain(
      "aria-label={`Open ${patientName} appointment at ${formatTime(start, timeZone)}`}"
    );
    expect(source).toContain(
      'className="min-h-11 w-full overflow-hidden rounded-lg border border-border bg-card p-3'
    );
    expect(source).toContain('className="h-11 w-full sm:h-9 sm:w-auto"');
    expect(source).toContain(
      'className="flex w-full min-w-0 flex-wrap items-center gap-2'
    );
  });

  it("renders clients as full-width phone cards and keeps the desktop table", () => {
    const source = readDashboardPage("clients");

    expect(source).toContain('className="mt-6 space-y-3 sm:hidden"');
    expect(source).toContain("aria-label={`Open client ${fullName}`}");
    expect(source).toContain(
      'className="min-h-11 w-full min-w-0 overflow-hidden rounded-lg border'
    );
    expect(source).toContain(
      'className="mt-6 hidden overflow-x-auto rounded-lg border border-border sm:block"'
    );
    expect(source).toContain('className="h-11 pl-9 sm:h-10"');
  });

  it("renders patients as full-width phone cards with owner and status context", () => {
    const source = readDashboardPage("patients");

    expect(source).toContain('className="mt-6 space-y-3 sm:hidden"');
    expect(source).toContain("aria-label={`Open patient ${patient.name}`}");
    expect(source).toContain("Owner: {ownerName}");
    expect(source).toContain(
      'className="mt-6 hidden overflow-x-auto rounded-lg border border-border sm:block"'
    );
    expect(source).toContain(
      'className="h-11 w-full rounded-md border border-input'
    );
  });

  it("keeps record tabs reachable and clinical forms single-column on phones", () => {
    const source = readDashboardPage("records");

    expect(source).toContain(
      'className="mt-6 max-w-full overflow-x-auto border-b border-border"'
    );
    expect(source).toContain('className="flex min-w-max gap-0"');
    expect(source).toContain(
      '"relative flex min-h-11 shrink-0 items-center gap-2 px-4 py-2.5'
    );
    expect(source).toContain(
      'className="grid grid-cols-1 gap-4 sm:grid-cols-2"'
    );
    expect(source).toContain(
      'className="grid grid-cols-1 gap-4 sm:grid-cols-3"'
    );
    expect(source).not.toContain('className="grid grid-cols-2 gap-4"');
  });
});
