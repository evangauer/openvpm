import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("patient duplicate review UI", () => {
  const listSource = readFileSync("app/(dashboard)/patients/page.tsx", "utf8");
  const reviewSource = readFileSync(
    "app/(dashboard)/patients/duplicates/page.tsx",
    "utf8",
  );

  it("exposes duplicate review only to practice administrators", () => {
    expect(listSource).toContain(
      'const canReviewDuplicates = session?.user?.role === "admin"',
    );
    expect(listSource).toContain('router.push("/patients/duplicates")');
    expect(listSource).toContain("Review duplicates");
    expect(reviewSource).toContain(
      'const isAdmin = session?.user?.role === "admin"',
    );
    expect(reviewSource).toContain("enabled: isAdmin");
    expect(reviewSource).toContain(
      "Only practice administrators can review or merge duplicate patient",
    );
  });

  it("requires a server preview, reason, typed intent, and stable operation ID", () => {
    expect(reviewSource).toContain("trpc.patients.previewMerge.useQuery");
    expect(reviewSource).toContain("preview.data?.allowed === true");
    expect(reviewSource).toContain("MERGE_REASON_MIN_LENGTH");
    expect(reviewSource).toContain("MERGE_REASON_MAX_LENGTH");
    expect(reviewSource).toContain('const MERGE_CONFIRMATION = "MERGE"');
    expect(reviewSource).toContain(
      "operationId.current ??= crypto.randomUUID()",
    );
    expect(reviewSource).toContain("operationId: operationId.current");
    expect(reviewSource).toContain("disabled={!canMerge}");
  });

  it("makes identity evidence and blockers explicit before merging", () => {
    expect(reviewSource).toContain(
      "Never merge charts merely because pet names match",
    );
    expect(reviewSource).toContain("Microchip");
    expect(reviewSource).toContain("External ID");
    expect(reviewSource).toContain("Retained-history checks");
    expect(reviewSource).toContain("Prospective work");
    expect(reviewSource).toContain(
      "Keep both chart identities—this merge is blocked.",
    );
    expect(reviewSource).toContain(
      "Historical records are never silently reassigned",
    );
  });
});
