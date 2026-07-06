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

export const SOAP_NOTE_TEMPLATES: SoapTemplate[] = [
  {
    id: "wellness-exam",
    name: "Wellness Exam",
    sections: {
      subjective:
        "<ul><li>Presenting for routine wellness exam.</li><li>Appetite, thirst, urination, defecation, activity, and behavior reviewed.</li><li>Current medications, diet, parasite prevention, and vaccine status reviewed.</li></ul>",
      objective:
        "<ul><li>General: Bright, alert, and responsive.</li><li>Vitals: Temperature, pulse, respiration, weight, BCS recorded.</li><li>Physical exam: Eyes, ears, oral cavity, heart/lungs, abdomen, skin/coat, musculoskeletal, neurologic, and lymph nodes assessed.</li></ul>",
      assessment:
        "<ul><li>Wellness examination findings reviewed.</li><li>Preventive-care needs assessed.</li></ul>",
      plan:
        "<ul><li>Update vaccines, diagnostics, and parasite prevention as indicated.</li><li>Discuss nutrition, dental care, weight management, and home monitoring.</li><li>Return for routine wellness follow-up or sooner if concerns develop.</li></ul>",
    },
  },
  {
    id: "sick-visit",
    name: "Sick Visit",
    sections: {
      subjective:
        "<ul><li>Chief complaint, onset, duration, progression, and severity reviewed.</li><li>Appetite, water intake, energy, vomiting, diarrhea, coughing/sneezing, urination, and pain signs discussed.</li><li>Current medications, recent travel/boarding/exposures, and relevant history reviewed.</li></ul>",
      objective:
        "<ul><li>Vitals and pain score recorded.</li><li>Focused physical exam performed with abnormal findings documented.</li><li>Diagnostics recommended or performed based on presenting complaint.</li></ul>",
      assessment:
        "<ul><li>Primary problem list and differential diagnoses reviewed.</li><li>Patient stability and urgency assessed.</li></ul>",
      plan:
        "<ul><li>Treatment options, diagnostics, risks, and estimated costs discussed.</li><li>Medications, home care, monitoring instructions, and recheck timing provided.</li><li>Owner advised to seek urgent care if condition worsens.</li></ul>",
    },
  },
  {
    id: "recheck",
    name: "Recheck",
    sections: {
      subjective:
        "<ul><li>Reason for recheck and response to prior treatment reviewed.</li><li>Medication adherence, side effects, appetite, energy, and owner concerns discussed.</li></ul>",
      objective:
        "<ul><li>Vitals and weight recorded.</li><li>Focused recheck exam performed.</li><li>Follow-up diagnostics or monitoring results reviewed when available.</li></ul>",
      assessment:
        "<ul><li>Problem status updated: improved, unchanged, or worsened.</li><li>Current treatment response assessed.</li></ul>",
      plan:
        "<ul><li>Continue, adjust, or discontinue treatment as indicated.</li><li>Additional diagnostics, monitoring, and next recheck timing discussed.</li><li>Owner questions addressed.</li></ul>",
    },
  },
  {
    id: "procedure-discharge",
    name: "Procedure Discharge",
    sections: {
      subjective:
        "<ul><li>Procedure reason and pre-procedure history reviewed.</li><li>Fasting status, current medications, and owner concerns confirmed.</li></ul>",
      objective:
        "<ul><li>Pre-procedure exam, vitals, and anesthetic risk assessment completed.</li><li>Procedure performed and intraoperative findings documented.</li><li>Recovery status, pain score, and discharge readiness assessed.</li></ul>",
      assessment:
        "<ul><li>Procedure completed and recovery status assessed.</li><li>Complications, if any, documented.</li></ul>",
      plan:
        "<ul><li>Discharge medications, activity restriction, incision/procedure-site monitoring, and diet instructions reviewed.</li><li>Emergency warning signs and contact instructions provided.</li><li>Follow-up or recheck appointment timing documented.</li></ul>",
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

export function soapTemplateSectionsFit(template: SoapTemplate): boolean {
  return Object.values(template.sections).every(
    (section) => soapSectionText(section).length <= SOAP_SECTION_MAX_LENGTH
  );
}
