import {
  SOAP_SECTION_MAX_LENGTH,
  normalizeSoapSection,
  soapSectionText,
} from "./soap-content";

export type SoapSections = {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
};

export type SoapTemplate = {
  id: string;
  name: string;
  sections: SoapSections;
};

export const SOAP_TEMPLATE_PROMPT_MARKER =
  "[DRAFT PROMPT — REPLACE OR DELETE]";

const soapTemplatePromptTexts: string[] = [];

function promptList(...prompts: string[]): string {
  for (const prompt of prompts) {
    soapTemplatePromptTexts.push(prompt);
  }

  return `<ul>${prompts
    .map(
      (prompt) =>
        `<li><strong>${SOAP_TEMPLATE_PROMPT_MARKER}</strong> ${prompt}</li>`
    )
    .join("")}</ul>`;
}

export const SOAP_NOTE_TEMPLATES: SoapTemplate[] = [
  {
    id: "wellness-exam",
    name: "Wellness Exam",
    sections: {
      subjective: promptList(
        "Document today's presenting reason in the owner's words.",
        "Document only the appetite, thirst, elimination, activity, or behavior history actually reported today.",
        "Document the medications, diet, parasite prevention, and vaccine history actually reviewed today."
      ),
      objective: promptList(
        "Enter measured vital values and body condition score; do not infer or assume normal findings.",
        "Document the patient's observed general appearance.",
        "Document the systems actually examined and their specific findings, including pertinent negatives."
      ),
      assessment: promptList(
        "Enter the clinician's interpretation of today's wellness findings.",
        "Enter the preventive-care needs identified from today's history and exam."
      ),
      plan: promptList(
        "Document the vaccines, diagnostics, and parasite-prevention decisions made today.",
        "Document the nutrition, dental, weight, or home-monitoring guidance actually discussed.",
        "Document the follow-up interval and return precautions actually provided."
      ),
    },
  },
  {
    id: "sick-visit",
    name: "Sick Visit",
    sections: {
      subjective: promptList(
        "Document the chief complaint, onset, duration, progression, and severity actually reported.",
        "Document pertinent positive and negative symptoms actually reported by the owner.",
        "Document current medications, exposures, and relevant history actually reviewed."
      ),
      objective: promptList(
        "Enter measured vital values and pain score; do not infer or assume normal findings.",
        "Document the focused physical exam actually performed and its specific findings.",
        "Document available diagnostic results; keep recommendations in the Plan section."
      ),
      assessment: promptList(
        "Enter the clinician's problem list and supported differential diagnoses.",
        "Enter the clinician's assessment of stability and urgency."
      ),
      plan: promptList(
        "Document the diagnostics and treatment options actually discussed or selected.",
        "Document medications, home care, monitoring, and recheck instructions actually provided.",
        "Document the return precautions and emergency guidance actually provided."
      ),
    },
  },
  {
    id: "recheck",
    name: "Recheck",
    sections: {
      subjective: promptList(
        "Document the reason for recheck and treatment response actually reported.",
        "Document adherence, side effects, appetite, energy, and owner concerns actually reported."
      ),
      objective: promptList(
        "Enter measured vital values and weight; do not infer or assume normal findings.",
        "Document the focused recheck exam actually performed and its specific findings.",
        "Document follow-up diagnostic or monitoring results available today."
      ),
      assessment: promptList(
        "Enter whether each problem is improved, unchanged, worsened, or otherwise characterized.",
        "Enter the clinician's interpretation of treatment response."
      ),
      plan: promptList(
        "Document the treatment decisions made today, including any continuation, change, or discontinuation.",
        "Document additional diagnostics, monitoring, and recheck timing actually discussed.",
        "Document owner questions and the answers actually provided."
      ),
    },
  },
  {
    id: "procedure-discharge",
    name: "Procedure Discharge",
    sections: {
      subjective: promptList(
        "Document the procedure indication and pre-procedure history actually reviewed.",
        "Document fasting status, current medications, and owner concerns actually confirmed."
      ),
      objective: promptList(
        "Enter measured pre-procedure vitals, exam findings, and the clinician's anesthetic risk assessment.",
        "Document the procedure actually performed and its specific intraoperative findings.",
        "Document observed recovery status, measured pain score, and discharge-readiness findings."
      ),
      assessment: promptList(
        "Enter the clinician's assessment of the procedure outcome and recovery status.",
        "Document observed complications, or explicitly state none only when clinically verified."
      ),
      plan: promptList(
        "Document the medications, restrictions, site monitoring, and diet instructions actually provided.",
        "Document the emergency warning signs and contact instructions actually provided.",
        "Document the follow-up or recheck timing actually arranged or recommended."
      ),
    },
  },
];

export function getSoapTemplateById(id: string): SoapTemplate | undefined {
  return SOAP_NOTE_TEMPLATES.find((template) => template.id === id);
}

export function applySoapTemplateToSections(
  current: SoapSections,
  template: SoapTemplate,
  options: { replaceExisting?: boolean } = {}
): SoapSections {
  const replaceExisting = options.replaceExisting ?? false;

  return {
    subjective:
      replaceExisting || !normalizeSoapSection(current.subjective)
        ? template.sections.subjective
        : current.subjective,
    objective:
      replaceExisting || !normalizeSoapSection(current.objective)
        ? template.sections.objective
        : current.objective,
    assessment:
      replaceExisting || !normalizeSoapSection(current.assessment)
        ? template.sections.assessment
        : current.assessment,
    plan:
      replaceExisting || !normalizeSoapSection(current.plan)
        ? template.sections.plan
        : current.plan,
  };
}

export function hasUnresolvedSoapTemplatePrompts(
  sections: Partial<SoapSections>
): boolean {
  return Object.values(sections).some((section) => {
    const text = soapSectionText(section ?? "");
    return (
      text.includes(SOAP_TEMPLATE_PROMPT_MARKER) ||
      soapTemplatePromptTexts.some((prompt) => text.includes(prompt))
    );
  });
}

export function soapTemplateSectionsFit(template: SoapTemplate): boolean {
  return Object.values(template.sections).every(
    (section) => soapSectionText(section).length <= SOAP_SECTION_MAX_LENGTH
  );
}
