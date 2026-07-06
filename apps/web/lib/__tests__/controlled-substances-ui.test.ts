import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONTROLLED_SUBSTANCE_DRUG_NAME_MAX_LENGTH,
  CONTROLLED_SUBSTANCE_LOT_NUMBER_MAX_LENGTH,
  CONTROLLED_SUBSTANCE_NOTES_MAX_LENGTH,
  CONTROLLED_SUBSTANCE_QUANTITY_MAX,
  CONTROLLED_SUBSTANCE_QUANTITY_MIN,
  CONTROLLED_SUBSTANCE_QUANTITY_STEP,
  CONTROLLED_SUBSTANCE_UNIT_MAX_LENGTH,
  isControlledSubstanceOptionalTextInputValid,
  isControlledSubstanceQuantityInputValid,
  isControlledSubstanceRequiredTextInputValid,
} from "../controlled-substances/policy";

describe("controlled substances UI bounds", () => {
  const source = readFileSync(
    "app/(dashboard)/controlled-substances/page.tsx",
    "utf8"
  );

  it("keeps log entry controls aligned to shared policy", () => {
    expect(CONTROLLED_SUBSTANCE_DRUG_NAME_MAX_LENGTH).toBe(255);
    expect(CONTROLLED_SUBSTANCE_UNIT_MAX_LENGTH).toBe(32);
    expect(CONTROLLED_SUBSTANCE_LOT_NUMBER_MAX_LENGTH).toBe(64);
    expect(CONTROLLED_SUBSTANCE_NOTES_MAX_LENGTH).toBe(2000);
    expect(CONTROLLED_SUBSTANCE_QUANTITY_MIN).toBe(0.001);
    expect(CONTROLLED_SUBSTANCE_QUANTITY_MAX).toBe(9999999.999);
    expect(CONTROLLED_SUBSTANCE_QUANTITY_STEP).toBe(0.001);
    expect(isControlledSubstanceQuantityInputValid("1.500")).toBe(true);
    expect(isControlledSubstanceQuantityInputValid("1.2345")).toBe(false);
    expect(isControlledSubstanceQuantityInputValid("10000000")).toBe(false);
    expect(
      isControlledSubstanceRequiredTextInputValid(" Ketamine ", 255)
    ).toBe(true);
    expect(isControlledSubstanceRequiredTextInputValid(" ", 255)).toBe(false);
    expect(isControlledSubstanceOptionalTextInputValid("", 64)).toBe(true);
    expect(source).toContain(
      "maxLength={CONTROLLED_SUBSTANCE_DRUG_NAME_MAX_LENGTH}"
    );
    expect(source).toContain("step={CONTROLLED_SUBSTANCE_QUANTITY_STEP}");
    expect(source).toContain("min={CONTROLLED_SUBSTANCE_QUANTITY_MIN}");
    expect(source).toContain("max={CONTROLLED_SUBSTANCE_QUANTITY_MAX}");
    expect(source).toContain(
      "maxLength={CONTROLLED_SUBSTANCE_LOT_NUMBER_MAX_LENGTH}"
    );
    expect(source).toContain(
      "maxLength={CONTROLLED_SUBSTANCE_NOTES_MAX_LENGTH}"
    );
    expect(source).toContain("const canSubmit =");
    expect(source).toContain("isControlledSubstanceQuantityInputValid");
    expect(source).toContain(
      "form.action !== \"administered\" || Boolean(form.patientId)"
    );
    expect(source).toContain(
      "form.action !== \"wasted\" || Boolean(form.witnessedBy)"
    );
    expect(source).toContain("drugName: form.drugName.trim()");
    expect(source).toContain("quantity: form.quantity.trim()");
    expect(source).toContain("unit: form.unit.trim()");
    expect(source).toContain("lotNumber: trimmedOrUndefined(form.lotNumber)");
    expect(source).toContain("notes: trimmedOrUndefined(form.notes)");
    expect(source).toContain("disabled={!canSubmit}");
    expect(source).not.toContain("if (!form.drugName || !form.quantity) return;");
  });

  it("keeps controlled-substance search aligned to shared policy", () => {
    expect(source).toContain("const searchFilter = search.trim()");
    expect(source).toContain("drugName: searchFilter || undefined");
    expect(source).toContain(
      "maxLength={CONTROLLED_SUBSTANCE_DRUG_NAME_MAX_LENGTH}"
    );
  });

  it("fails closed when patient or witness lookups return no payload", () => {
    expect(source).toContain("const patientsMissing =");
    expect(source).toContain("const witnessesMissing =");
    expect(source).toContain("const patientOptions =");
    expect(source).toContain("const witnessOptions =");
    expect(source).toContain("patientsMissing");
    expect(source).toContain("witnessesMissing");
    expect(source).toContain("patientOptions.map((patient)");
    expect(source).toContain("witnessOptions.map((user)");
    expect(source).toContain(
      "Patient lookup returned no data. Please retry before recording an administered dose."
    );
    expect(source).toContain(
      "Witness lookup returned no data. Please retry before recording wasted inventory."
    );
    expect(source).toContain(
      "Patient lookup is unavailable. Please retry."
    );
    expect(source).toContain(
      "Witness lookup is unavailable. Please retry."
    );
    expect(source.indexOf("patientsQuery.error || patientsMissing")).toBeLessThan(
      source.indexOf(': "No patient"')
    );
    expect(
      source.indexOf("witnessesQuery.error || witnessesMissing")
    ).toBeLessThan(source.indexOf(': "No witness"'));
    expect(source).not.toContain("patientsQuery.data?.items.map");
    expect(source).not.toContain("witnessesQuery.data?.map");
  });

  it("renders log timestamps in the practice timezone", () => {
    expect(source).toContain(
      "trpc.controlledSubstances.settings.useQuery"
    );
    expect(source).toContain("const logError = settingsQuery.error ?? error");
    expect(source).toContain(
      "const isLogLoading = settingsQuery.isLoading || isLoading"
    );
    expect(source).toContain("const verifiedLogPayload =");
    expect(source).toContain("settingsQuery.data &&");
    expect(source).toContain("? { settings: settingsQuery.data, log: data }");
    expect(source).toContain(
      "const canRecordControlledSubstance = Boolean(verifiedLogPayload)"
    );
    expect(source).toContain("if (!canRecordControlledSubstance && showForm)");
    expect(source).toContain("disabled={!canRecordControlledSubstance}");
    expect(source).toContain(
      "{canRecordControlledSubstance && showForm && ("
    );
    expect(source).toContain("verifiedLogPayload.log.items.map((entry)");
    expect(source).toContain(
      "formatControlledSubstanceDateTime(\n                            entry.performedAt,\n                            verifiedLogPayload.settings.timezone"
    );
    expect(source).toContain("verifiedLogPayload.log.total");
    expect(source).not.toContain("const logTimeZone = settingsQuery.data?.timezone");
    expect(source).not.toContain("settingsQuery.data?.timezone");
    expect(source).not.toContain("data && data.items.length > 0");
    expect(source).not.toContain("showForm && <LogEntryForm");
    expect(source).not.toContain(
      "new Date(entry.performedAt).toLocaleString()"
    );
  });

  it("gates direct-route access to controlled-substance roles", () => {
    expect(source).toContain('import { useRouter } from "next/navigation"');
    expect(source).toContain('import { useSession } from "next-auth/react"');
    expect(source).toContain(
      "function canManageControlledSubstancesRole(role?: string | null): boolean"
    );
    expect(source).toContain('role === "admin" || role === "veterinarian"');
    expect(source).toContain("const { data: session, status } = useSession()");
    expect(source).toContain('if (status === "loading")');
    expect(source).toContain(
      "if (!canManageControlledSubstancesRole(session?.user?.role))"
    );
    expect(source).toContain("Controlled substance log is restricted");
    expect(source).toContain("return <ControlledSubstancesLogPage />");
    expect(source).toContain("function ControlledSubstancesLogPage()");
    expect(source.indexOf("function ControlledSubstancesLogPage()")).toBeLessThan(
      source.indexOf("trpc.controlledSubstances.settings.useQuery")
    );
  });
});
