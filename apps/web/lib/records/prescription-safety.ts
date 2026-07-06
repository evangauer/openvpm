export type SafetySeverity = "minor" | "moderate" | "major";

export type PrescriptionSafetyWarning = {
  type: "allergy" | "interaction";
  severity: SafetySeverity;
  title: string;
  message: string;
  requiresOverride: boolean;
};

export type AllergyForSafety = {
  allergen: string;
  severity: string | null;
  reaction?: string | null;
};

export type ActivePrescriptionForSafety = {
  medicationName: string;
};

export type DrugInteractionForSafety = {
  drugA: string;
  drugB: string;
  severity: SafetySeverity;
  description?: string | null;
};

export function normalizeMedicationName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokens(value: string): string[] {
  return normalizeMedicationName(value)
    .split(" ")
    .filter((token) => token.length >= 3);
}

export function medicationNamesMatch(candidate: string, known: string): boolean {
  const a = normalizeMedicationName(candidate);
  const b = normalizeMedicationName(known);
  if (!a || !b) return false;
  if (a === b) return true;
  if (` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `)) {
    return true;
  }

  const candidateTokens = new Set(tokens(candidate));
  return tokens(known).some((token) => candidateTokens.has(token));
}

function allergySeverity(severity: string | null | undefined): SafetySeverity {
  if (severity === "severe") return "major";
  if (severity === "mild") return "minor";
  return "moderate";
}

function severityRank(severity: SafetySeverity): number {
  switch (severity) {
    case "major":
      return 3;
    case "moderate":
      return 2;
    case "minor":
      return 1;
  }
}

export function evaluatePrescriptionSafety(input: {
  medicationName: string;
  allergies: readonly AllergyForSafety[];
  activePrescriptions: readonly ActivePrescriptionForSafety[];
  interactions: readonly DrugInteractionForSafety[];
}): {
  warnings: PrescriptionSafetyWarning[];
  requiresOverride: boolean;
} {
  const medicationName = input.medicationName.trim();
  const warnings: PrescriptionSafetyWarning[] = [];

  for (const allergy of input.allergies) {
    if (!medicationNamesMatch(medicationName, allergy.allergen)) continue;
    const severity = allergySeverity(allergy.severity);
    const reaction = allergy.reaction ? ` Reaction: ${allergy.reaction}` : "";
    warnings.push({
      type: "allergy",
      severity,
      title: `${allergy.allergen} allergy`,
      message: `${medicationName} matches a recorded ${allergy.severity ?? "moderate"} allergy.${reaction}`,
      requiresOverride: true,
    });
  }

  const seenInteractions = new Set<string>();
  for (const currentRx of input.activePrescriptions) {
    for (const interaction of input.interactions) {
      const matchedForward =
        medicationNamesMatch(medicationName, interaction.drugA) &&
        medicationNamesMatch(currentRx.medicationName, interaction.drugB);
      const matchedReverse =
        medicationNamesMatch(medicationName, interaction.drugB) &&
        medicationNamesMatch(currentRx.medicationName, interaction.drugA);

      if (!matchedForward && !matchedReverse) continue;

      const otherDrug = matchedForward ? interaction.drugB : interaction.drugA;
      const key = `${currentRx.medicationName}:${interaction.drugA}:${interaction.drugB}`;
      if (seenInteractions.has(key)) continue;
      seenInteractions.add(key);

      warnings.push({
        type: "interaction",
        severity: interaction.severity,
        title: `${interaction.severity} interaction with ${currentRx.medicationName}`,
        message:
          interaction.description ||
          `${medicationName} may interact with active ${otherDrug} therapy.`,
        requiresOverride: interaction.severity !== "minor",
      });
    }
  }

  warnings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

  return {
    warnings,
    requiresOverride: warnings.some((warning) => warning.requiresOverride),
  };
}
