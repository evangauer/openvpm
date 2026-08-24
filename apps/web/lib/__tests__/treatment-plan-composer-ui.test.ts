import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const composer = readFileSync(
  "components/encounters/treatment-plan-composer.tsx",
  "utf8",
);
const encounter = readFileSync(
  "app/(dashboard)/encounters/[appointmentId]/page.tsx",
  "utf8",
);
const providers = readFileSync("lib/providers.tsx", "utf8");

describe("treatment-plan composer UI", () => {
  it("stays inside the existing encounter and clinical-role boundary", () => {
    expect(encounter).toContain("<TreatmentPlanComposer");
    expect(encounter).toContain(
      'import("@/components/encounters/treatment-plan-composer")',
    );
    expect(encounter).toContain("{ ssr: false, loading: () => null }");
    expect(encounter).toContain("canRecordVitals(role) &&");
    expect(encounter).toContain("appointment.patientId &&");
    expect(encounter).toContain("appointment.clientId ?");
  });

  it("uses bounded server catalog search and server-authoritative quotes", () => {
    expect(composer).toContain(
      "trpc.visitTreatmentPlans.searchCatalog.useQuery",
    );
    expect(composer).toContain("useDeferredValue(search)");
    expect(composer).toContain(
      "maxLength={TEMPLATE_CATALOG_SEARCH_MAX_LENGTH}",
    );
    expect(composer).toContain("trpc.visitTreatmentPlans.quote.useQuery");
    expect(composer).toContain("formatCurrency(quote.total, currency)");
    expect(providers).toContain('"visitTreatmentPlans.searchCatalog"');
    expect(providers).toContain('"visitTreatmentPlans.quote"');
    expect(providers).toContain('methodOverride: "POST"');
  });

  it("supports a small keyboard and touch-friendly editing flow", () => {
    expect(composer).toContain('event.key === "ArrowDown"');
    expect(composer).toContain('event.key === "ArrowUp"');
    expect(composer).toContain('event.key === "Enter"');
    expect(composer).toContain('event.key === "Escape"');
    expect(composer).toContain('role="listbox"');
    expect(composer).toContain('role="option"');
    expect(composer).toContain('role="combobox"');
    expect(composer).toContain("Move ${line.name} up");
    expect(composer).toContain("Remove ${line.name}");
  });

  it("keeps retries idempotent and refreshes stale revisions", () => {
    expect(composer).toContain(
      "useRef<{ fingerprint: string; id: string } | null>(null)",
    );
    expect(composer).toContain("operation.current?.fingerprint");
    expect(composer).toContain("expectedRevisionNumber");
    expect(composer).toContain("await planQuery.refetch()");
  });

  it("does not expose downstream execution actions", () => {
    expect(composer).not.toMatch(
      /charge client|send to client|reserve inventory/i,
    );
    expect(composer).not.toContain("trpc.billing");
    expect(composer).not.toContain("trpc.inventory");
    expect(composer).not.toContain("trpc.appointments.update");
    expect(composer).toMatch(
      /Saving this plan does not charge the client, adjust inventory, or\s+schedule care\./,
    );
  });
});
