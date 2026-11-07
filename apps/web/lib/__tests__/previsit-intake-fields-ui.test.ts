import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { PrevisitIntakeFields } from "@/components/booking/previsit-intake-fields";
import {
  PREVISIT_INTAKE_FIELD_MAX_LENGTH,
  type PrevisitIntakeFieldKey,
} from "@/lib/booking/previsit-intake";

function renderFields(enabledFieldKeys: readonly PrevisitIntakeFieldKey[]) {
  return renderToStaticMarkup(
    createElement(PrevisitIntakeFields, {
      enabledFieldKeys,
      value: {},
      onChange: vi.fn(),
    }),
  );
}

describe("pre-visit intake fields", () => {
  it("renders nothing when the clinic enables no fields", () => {
    expect(renderFields([])).toBe("");
  });

  it("renders the service address first regardless of selection order", () => {
    const markup = renderFields([
      "handlingNotes",
      "symptoms",
      "serviceAddress",
    ]);
    expect(markup.indexOf("Service or farm address")).toBeLessThan(
      markup.indexOf("Current signs or symptoms"),
    );
    expect(markup.indexOf("Current signs or symptoms")).toBeLessThan(
      markup.indexOf("Handling or access notes"),
    );
    expect(markup).not.toContain("Known allergies or past reactions");
  });

  it("associates every label and textarea with a unique shared id", () => {
    const markup = renderFields(["serviceAddress", "symptoms", "diet"]);
    const labelIds = [...markup.matchAll(/<label[^>]*for="([^"]+)"/g)].map(
      (match) => match[1],
    );
    const textareaIds = [...markup.matchAll(/<textarea[^>]*id="([^"]+)"/g)].map(
      (match) => match[1],
    );

    expect(labelIds).toEqual(textareaIds);
    expect(new Set(textareaIds).size).toBe(3);
    expect(markup.match(/aria-describedby="[^"]+"/g)).toHaveLength(3);
  });

  it("applies the shared maximum length and explains data provenance", () => {
    const markup = renderFields(["serviceAddress", "medicalHistory"]);
    expect(
      markup.match(
        new RegExp(`maxlength="${PREVISIT_INTAKE_FIELD_MAX_LENGTH}"`, "gi"),
      ),
    ).toHaveLength(2);
    expect(markup).toContain("owner-reported details");
    expect(markup).toContain("remain unverified");
  });

  it("uses controlled functional updates instead of duplicate form state", () => {
    const source = readFileSync(
      "components/booking/previsit-intake-fields.tsx",
      "utf8",
    );
    expect(source).toContain("onChange((current) => ({");
    expect(source).not.toContain("useState(");
  });
});
