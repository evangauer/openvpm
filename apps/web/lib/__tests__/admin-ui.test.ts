import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("admin UI", () => {
  const source = readFileSync("app/(dashboard)/admin/page.tsx", "utf8");

  it("separates admin forbidden, load error, loading, and missing-data states", () => {
    expect(source).toContain(
      'import { EmptyState } from "@/components/common/empty-state"'
    );
    expect(source).toContain(
      'import { PageLoading } from "@/components/common/loading"'
    );
    expect(source).toContain("error, refetch");
    expect(source).toContain('error?.data?.code === "FORBIDDEN"');
    expect(source).toContain("Access Denied");
    expect(source).toContain('title="Unable to load platform admin"');
    expect(source).toContain("action={{ label: \"Retry\", onClick: () => refetch() }}");
    expect(source).toContain("if (isLoading) return <PageLoading");
    expect(source).toContain("if (!data)");
    expect(source).not.toContain("if (isLoading || !data)");
  });

  it("renders practice dates in each practice timezone", () => {
    expect(source).toContain(
      "function formatDate(d: Date | string | null, timeZone?: string | null)"
    );
    expect(source).toContain("if (Number.isNaN(date.getTime())) return");
    expect(source).toContain('timeZone: timeZone?.trim() || "UTC"');
    expect(source).toContain("formatDate(p.trialEndsAt, p.timezone)");
    expect(source).toContain("formatDate(p.createdAt, p.timezone)");
    expect(source).not.toContain("formatDate(p.trialEndsAt)}</td>");
    expect(source).not.toContain("formatDate(p.createdAt)}</td>");
  });
});
