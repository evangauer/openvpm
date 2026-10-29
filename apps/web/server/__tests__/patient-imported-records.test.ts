import { PgDialect } from "drizzle-orm/pg-core";
import {
  externalPrescriptions,
  externalLabReports,
  historicalDocuments,
} from "@openpims/db";
import { describe, expect, it } from "vitest";
import { patientArchiveFilter } from "../patient-archive-filter";

const practiceId = "11111111-1111-4111-8111-111111111111";
const patientId = "22222222-2222-4222-8222-222222222222";

describe("patient imported record isolation", () => {
  it.each([
    ["external_prescriptions", externalPrescriptions],
    ["external_lab_reports", externalLabReports],
    ["historical_documents", historicalDocuments],
  ] as const)(
    "scopes %s to the exact live patient and practice",
    (tableName, table) => {
      const { sql, params } = new PgDialect().sqlToQuery(
        patientArchiveFilter(table, practiceId, patientId)!,
      );
      expect(sql).toContain(`"${tableName}"."practice_id" =`);
      expect(sql).toContain(`"${tableName}"."patient_id" =`);
      expect(sql).toContain(`"${tableName}"."deleted_at" is null`);
      expect(sql).toContain('"patients"."id" =');
      expect(sql).toContain('"patients"."practice_id" =');
      expect(sql).toContain('"patients"."deleted_at" is null');
      expect(params.filter((v) => v === patientId)).toHaveLength(2);
      expect(params.filter((v) => v === practiceId)).toHaveLength(2);
      expect(sql).not.toMatch(/name|ilike/i);
    },
  );
});

// Check that the tested predicate is actually used by both the list and count
// queries and that the chart uses the authenticated archive read path.
describe("patient chart archive wiring", () => {
  it("applies patient filters to each supported archive section", async () => {
    const { readFileSync } = await import("node:fs");
    const router = readFileSync(
      new URL("../routers/migration-archive.ts", import.meta.url),
      "utf8",
    );
    for (const table of [
      "externalPrescriptions",
      "externalLabReports",
      "historicalDocuments",
    ]) {
      expect(router).toMatch(
        new RegExp(
          `patientArchiveFilter\\(\\s*${table},\\s*practiceId,\\s*input.patientId`,
        ),
      );
    }
    expect(router).toContain("list: protectedProcedure.input(listInput).query");
    expect(router).toContain(
      '!["medications", "labs", "documents"].includes(input.section)',
    );
    const medicationSection = router
      .split('if (input.section === "medications")')[1]
      .split('if (input.section === "labs")')[0];
    const labSection = router
      .split('if (input.section === "labs")')[1]
      .split('if (input.section === "financial")')[0];
    const documentSection = router
      .split(
        "    const filter = and(\n      eq(historicalDocuments.practiceId, practiceId)",
      )[1]
      .split("detail: protectedProcedure")[0];
    for (const section of [medicationSection, labSection, documentSection]) {
      expect(section.match(/\.where\(filter\)/g)).toHaveLength(2);
      expect(section).toContain("sourceDate:");
    }
  });

  it("scopes chart detail reads and excludes deleted files", async () => {
    const { readFileSync } = await import("node:fs");
    const router = readFileSync(
      new URL("../routers/migration-archive.ts", import.meta.url),
      "utf8",
    );
    const detail = router.split("detail: protectedProcedure")[1];
    expect(detail).toContain("patientId: z.string().guid().optional()");
    for (const table of ["externalPrescriptions", "externalLabReports"]) {
      expect(detail).toMatch(
        new RegExp(
          `patientArchiveFilter\\(\\s*${table},\\s*practiceId,\\s*input.patientId`,
        ),
      );
    }
    expect(router).toContain("isNull(files.deletedAt)");
  });

  it("renders an explicitly read-only chart section with archive downloads", async () => {
    const { readFileSync } = await import("node:fs");
    const chart = readFileSync(
      new URL(
        "../../components/patients/imported-records.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    const page = readFileSync(
      new URL("../../app/(dashboard)/patients/[id]/page.tsx", import.meta.url),
      "utf8",
    );
    expect(page).toContain(
      "<ImportedRecords patientId={patientId} timeZone={timeZone} />",
    );
    expect(chart).toContain("trpc.migrationArchive.list.useQuery");
    expect(chart).toContain("patientId,");
    expect(chart).toContain("Read-only history imported from a prior system");
    expect(chart).toContain("not active prescriptions");
    expect(chart).toContain("href={item.fileUrl}");
    expect(chart).toContain("Needs review");
    expect(chart).not.toContain("useMutation");
  });
});

import { formatImportedDate } from "../../components/migration/archive-detail";

describe("imported source dates", () => {
  it("reports missing and invalid dates without inventing a source date", () => {
    expect(formatImportedDate(null)).toBe("Date unavailable");
    expect(formatImportedDate("")).toBe("Date unavailable");
    expect(formatImportedDate("invalid")).toBe("Date unavailable");
  });
  it("preserves date-only documents and uses clinic time for timestamps", () => {
    expect(formatImportedDate("2020-04-03", "Pacific/Kiritimati")).toBe(
      "Apr 3, 2020",
    );
    expect(
      formatImportedDate("2020-04-03T01:00:00.000Z", "America/Los_Angeles"),
    ).toBe("Apr 2, 2020");
  });
});
