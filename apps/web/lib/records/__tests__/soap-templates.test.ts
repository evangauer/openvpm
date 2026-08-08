import { describe, expect, it } from "vitest";
import { soapSectionText } from "../soap-content";
import {
  SOAP_NOTE_TEMPLATES,
  SOAP_TEMPLATE_PROMPT_MARKER,
  applySoapTemplateToSections,
  getSoapTemplateById,
  hasUnresolvedSoapTemplatePrompts,
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

  it("uses unresolved drafting prompts instead of affirmative clinical claims", () => {
    for (const template of SOAP_NOTE_TEMPLATES) {
      for (const section of Object.values(template.sections)) {
        const sectionText = soapSectionText(section);
        const promptCount = sectionText.split(SOAP_TEMPLATE_PROMPT_MARKER).length - 1;
        const itemCount = section.match(/<li>/g)?.length ?? 0;

        expect(promptCount).toBe(itemCount);
        expect(promptCount).toBeGreaterThan(0);
        expect(sectionText).not.toMatch(
          /\b(vitals? (?:and (?:pain score|weight) )?recorded|exam performed|findings reviewed|needs assessed|procedure completed|instructions (?:reviewed|provided))\b/i
        );
      }

      expect(hasUnresolvedSoapTemplatePrompts(template.sections)).toBe(true);
    }
  });

  it("detects prompt bodies even if their visual markers are removed", () => {
    const template = getSoapTemplateById("wellness-exam");
    expect(template).toBeDefined();
    expect(hasUnresolvedSoapTemplatePrompts(template!.sections)).toBe(true);
    expect(
      hasUnresolvedSoapTemplatePrompts({
        subjective: template!.sections.subjective.replaceAll(
          SOAP_TEMPLATE_PROMPT_MARKER,
          ""
        ),
        objective: template!.sections.objective.replaceAll(
          SOAP_TEMPLATE_PROMPT_MARKER,
          ""
        ),
        assessment: template!.sections.assessment.replaceAll(
          SOAP_TEMPLATE_PROMPT_MARKER,
          ""
        ),
        plan: template!.sections.plan.replaceAll(
          SOAP_TEMPLATE_PROMPT_MARKER,
          ""
        ),
      })
    ).toBe(true);

    expect(
      hasUnresolvedSoapTemplatePrompts({
        subjective: "<p>Owner reports normal appetite.</p>",
        objective: "<p>T 101.2 F; HR 88; RR 20.</p>",
        assessment: "<p>Healthy adult dog.</p>",
        plan: "<p>Return in 12 months.</p>",
      })
    ).toBe(false);
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
