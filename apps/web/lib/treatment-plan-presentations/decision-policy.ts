import type { VisitTreatmentPlanPresentationDecision } from "@openpims/db";
import {
  canonicalQuantity,
  quantityToThousandths,
} from "@/lib/treatment-plan-authoring/policy";

export type OfferedTreatmentPlanLine = {
  id: string;
  sortOrder: number;
  description: string;
  offeredQuantity: string;
  unitPrice: string;
  lineSubtotal: string;
  taxAmount: string;
  lineTotal: string;
};

export type TreatmentPlanDecisionInput = {
  revisionLineId: string;
  decision: "accepted" | "declined";
  acceptedQuantity: string;
  declineReason?: string | null;
};

export const TREATMENT_PLAN_IN_FLIGHT_CONSENT_STATUSES = ["signing", "signed"];

export function treatmentPlanPresentationBlocksReplacement(
  presentation: {
    status: string;
    expiresAt: Date;
    consentStatus: string | null;
  },
  now = new Date(),
): boolean {
  return (
    presentation.status === "awaiting_signature" &&
    (presentation.expiresAt > now ||
      TREATMENT_PLAN_IN_FLIGHT_CONSENT_STATUSES.some(
        (status) => status === presentation.consentStatus,
      ))
  );
}

export function treatmentPlanDecisionsEqual(
  left: readonly VisitTreatmentPlanPresentationDecision[] | null,
  right: readonly VisitTreatmentPlanPresentationDecision[],
): boolean {
  if (!left || left.length !== right.length) return false;
  const leftByLine = new Map(
    left.map((decision) => [decision.revisionLineId, decision]),
  );
  if (leftByLine.size !== left.length) return false;
  const seen = new Set<string>();
  for (const decision of right) {
    if (seen.has(decision.revisionLineId)) return false;
    seen.add(decision.revisionLineId);
    const persisted = leftByLine.get(decision.revisionLineId);
    if (
      !persisted ||
      persisted.decision !== decision.decision ||
      persisted.acceptedQuantity !== decision.acceptedQuantity ||
      persisted.declineReason !== decision.declineReason
    ) {
      return false;
    }
  }
  return true;
}

export function canonicalTreatmentPlanDecisions(
  input: readonly TreatmentPlanDecisionInput[],
  lines: readonly OfferedTreatmentPlanLine[],
): VisitTreatmentPlanPresentationDecision[] | null {
  if (input.length !== lines.length) return null;
  const submitted = new Map(input.map((row) => [row.revisionLineId, row]));
  if (submitted.size !== lines.length) return null;
  const result: VisitTreatmentPlanPresentationDecision[] = [];
  for (const line of lines) {
    const row = submitted.get(line.id);
    if (!row) return null;
    if (row.decision === "declined") {
      if (row.acceptedQuantity !== "0" && row.acceptedQuantity !== "0.000") {
        return null;
      }
      result.push({
        revisionLineId: line.id,
        decision: "declined",
        acceptedQuantity: "0.000",
        declineReason: row.declineReason?.trim() || null,
      });
      continue;
    }
    let acceptedQuantity: string;
    try {
      acceptedQuantity = canonicalQuantity(row.acceptedQuantity);
      if (
        quantityToThousandths(acceptedQuantity) >
        quantityToThousandths(line.offeredQuantity)
      ) {
        return null;
      }
    } catch {
      return null;
    }
    result.push({
      revisionLineId: line.id,
      decision: "accepted",
      acceptedQuantity,
      declineReason: null,
    });
  }
  return result;
}

export function buildTreatmentPlanConsentBody(
  context: {
    patientName: string;
    revisionNumber: number;
    currency: string;
    subtotal: string;
    tax: string;
    total: string;
  },
  lines: readonly OfferedTreatmentPlanLine[],
  decisions: readonly VisitTreatmentPlanPresentationDecision[],
  responseSha256: string,
): string {
  const decisionByLine = new Map(
    decisions.map((decision) => [decision.revisionLineId, decision]),
  );
  return [
    `Treatment plan for ${context.patientName}`,
    `Revision ${context.revisionNumber}`,
    "",
    ...lines.flatMap((line) => {
      const decision = decisionByLine.get(line.id)!;
      const choice =
        decision.decision === "accepted"
          ? `ACCEPTED, quantity ${decision.acceptedQuantity}`
          : `DECLINED${decision.declineReason ? `: ${decision.declineReason}` : ""}`;
      return [
        line.description,
        `Offered ${line.offeredQuantity} × ${context.currency} ${line.unitPrice} = ${context.currency} ${line.lineTotal}`,
        `Decision: ${choice}`,
        "",
      ];
    }),
    `Subtotal: ${context.currency} ${context.subtotal}`,
    `Tax: ${context.currency} ${context.tax}`,
    `Total offered: ${context.currency} ${context.total}`,
    "",
    "I confirm these choices and authorize the clinic to keep this signed treatment-plan decision in the patient record. This signature does not itself charge me or schedule care.",
    "",
    `Treatment plan response SHA-256: ${responseSha256}`,
  ].join("\n");
}
