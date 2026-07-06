import { describe, expect, it } from "vitest";
import { soapSectionText } from "../soap-content";
import {
  SOAP_NOTE_TEMPLATES,
  applySoapTemplateToSections,
  getSoapTemplateById,
  soapTemplateSectionsFit,
} from "../soap-templates";

describe("SOAP note templates", () => {
  it("ships structured templates with all SOAP sections populated", () => {
    expect(SOAP_NOTE_TEMPLATES.length).toBeGreaterThanOrEqual(4);
    expect(getSoapTemplateById("wellness-exam")?.name).toBe("Wellness Exam");

    for (const template of SOAP_NOTE_TEMPLATES) {
      expect(template.id).toMatch(/^[a-z0-9-]+$/);
      expect(template.name.trim()).not.toBe("");
      expect(soapTemplateSectionsFit(template)).toBe(true);
      expect(soapSectionText(template.sections.subjective)).not.toBe("");
      expect(soapSectionText(template.sections.objective)).not.toBe("");
      expect(soapSectionText(template.sections.assessment)).not.toBe("");
      expect(soapSectionText(template.sections.plan)).not.toBe("");
    }
  });

  it("fills blank SOAP sections without overwriting drafted sections by default", () => {
    const template = getSoapTemplateById("sick-visit");
    expect(template).toBeDefined();

    const next = applySoapTemplateToSections(
      {
        subjective: "<p>Owner reports coughing overnight.</p>",
        objective: "",
        assessment: "<p>Suspect respiratory disease.</p>",
        plan: "",
      },
      template!
    );

    expect(next.subjective).toBe("<p>Owner reports coughing overnight.</p>");
    expect(next.assessment).toBe("<p>Suspect respiratory disease.</p>");
    expect(next.objective).toBe(template!.sections.objective);
    expect(next.plan).toBe(template!.sections.plan);
  });

  it("can explicitly replace existing SOAP sections", () => {
    const template = getSoapTemplateById("recheck");
    expect(template).toBeDefined();

    const next = applySoapTemplateToSections(
      {
        subjective: "<p>Existing subjective.</p>",
        objective: "<p>Existing objective.</p>",
        assessment: "<p>Existing assessment.</p>",
        plan: "<p>Existing plan.</p>",
      },
      template!,
      { replaceExisting: true }
    );

    expect(next).toEqual(template!.sections);
  });
});
