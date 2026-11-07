import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PREVISIT_INTAKE_FIELD_DEFINITIONS } from "../booking/previsit-intake";

describe("booking intake settings field picker", () => {
  const source = readFileSync(
    "components/settings/booking-intake-settings.tsx",
    "utf8",
  );

  it("renders the shared catalog with accessible checkbox labels", () => {
    expect(source).toContain(
      "PREVISIT_INTAKE_FIELD_DEFINITIONS.map((field) =>",
    );
    expect(source).toContain("const inputId = `booking-intake-${field.key}`");
    expect(source).toContain("id={inputId}");
    expect(source).toContain("htmlFor={inputId}");
    expect(PREVISIT_INTAKE_FIELD_DEFINITIONS[0]?.key).toBe("serviceAddress");
  });

  it("is controlled and emits a catalog-ordered selection", () => {
    expect(source).toContain(
      "selectedFieldKeys: readonly PrevisitIntakeFieldKey[]",
    );
    expect(source).toContain(
      "const selectedFieldKeySet = new Set(selectedFieldKeys)",
    );
    expect(source).toContain("onChange(nextFieldKeys)");
    expect(source).not.toContain("useState");
  });

  it("allows an empty selection and promises no demographic overwrite", () => {
    expect(source).toContain("Leave every field unchecked");
    expect(source).toContain("do not overwrite saved client or patient");
  });

  it("disables the fieldset and checkboxes while saving", () => {
    expect(source).toContain(
      'fieldset className="space-y-3" disabled={disabled}',
    );
    expect(source).toContain("disabled={disabled}");
  });
});
