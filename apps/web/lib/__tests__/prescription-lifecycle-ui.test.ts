import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("prescription lifecycle UI safety", () => {
  it("disables dispensing-label printing for effectively inactive prescriptions", () => {
    const source = readFileSync("app/(dashboard)/records/page.tsx", "utf8");
    expect(source).toContain(
      'disabled={rx.effectiveStatus !== "active"}',
    );
    expect(source).toContain(
      "Only active prescriptions can print a dispensing label",
    );
  });

  it("distinguishes external authorization, clinic stock, and billing scope", () => {
    const source = readFileSync(
      "components/records/prescription-lifecycle-control.tsx",
      "utf8",
    );
    expect(source).toContain("Authorize external-pharmacy refill");
    expect(source).toContain("does not dispense stock or contact the pharmacy");
    expect(source).toContain("creates an unbilled dispense in Billing");
    expect(source).toContain("billing work created");
    expect(source).toContain("Billing: {event.dispenseChargeStatus}");
  });

  it("resets the idempotency key when lifecycle intent changes", () => {
    const source = readFileSync(
      "components/records/prescription-lifecycle-control.tsx",
      "utf8",
    );
    const reasonChange = source.match(
      /onChange=\{\(event\) => \{[\s\S]+?operationId\.current = null;[\s\S]+?\}\}/,
    );
    expect(reasonChange).not.toBeNull();
  });

  it("uses effective status in patient medical-summary exports", () => {
    const source = readFileSync(
      "app/(dashboard)/patients/[id]/page.tsx",
      "utf8",
    );
    expect(source).toContain('status: rx.effectiveStatus ?? "active"');
    expect(source).not.toContain('status: rx.status ?? "active"');
  });
});
