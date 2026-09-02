import { describe, expect, it } from "vitest";
import {
  buildTreatmentPlanConsentBody,
  canonicalTreatmentPlanDecisions,
  type OfferedTreatmentPlanLine,
} from "./decision-policy";

const lines: OfferedTreatmentPlanLine[] = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    sortOrder: 0,
    description: "Blood work",
    offeredQuantity: "2.000",
    unitPrice: "25.00",
    lineSubtotal: "50.00",
    taxAmount: "0.00",
    lineTotal: "50.00",
  },
  {
    id: "00000000-0000-0000-0000-000000000002",
    sortOrder: 1,
    description: "Medication",
    offeredQuantity: "1.000",
    unitPrice: "15.00",
    lineSubtotal: "15.00",
    taxAmount: "1.50",
    lineTotal: "16.50",
  },
];

describe("treatment-plan client decision policy", () => {
  it("requires one decision per exact offered line and canonicalizes quantities", () => {
    expect(
      canonicalTreatmentPlanDecisions(
        [
          {
            revisionLineId: lines[0]!.id,
            decision: "accepted",
            acceptedQuantity: "1.5",
          },
          {
            revisionLineId: lines[1]!.id,
            decision: "declined",
            acceptedQuantity: "0",
            declineReason: "  not today  ",
          },
        ],
        lines,
      ),
    ).toEqual([
      {
        revisionLineId: lines[0]!.id,
        decision: "accepted",
        acceptedQuantity: "1.500",
        declineReason: null,
      },
      {
        revisionLineId: lines[1]!.id,
        decision: "declined",
        acceptedQuantity: "0.000",
        declineReason: "not today",
      },
    ]);
  });

  it("rejects missing, duplicate, unknown, zero, and over-offer acceptances", () => {
    expect(canonicalTreatmentPlanDecisions([], lines)).toBeNull();
    expect(
      canonicalTreatmentPlanDecisions(
        lines.map(() => ({
          revisionLineId: lines[0]!.id,
          decision: "accepted" as const,
          acceptedQuantity: "1",
        })),
        lines,
      ),
    ).toBeNull();
    expect(
      canonicalTreatmentPlanDecisions(
        [
          {
            revisionLineId: lines[0]!.id,
            decision: "accepted",
            acceptedQuantity: "2.001",
          },
          {
            revisionLineId: lines[1]!.id,
            decision: "accepted",
            acceptedQuantity: "1",
          },
        ],
        lines,
      ),
    ).toBeNull();
    expect(
      canonicalTreatmentPlanDecisions(
        [
          {
            revisionLineId: "00000000-0000-0000-0000-000000000099",
            decision: "accepted",
            acceptedQuantity: "1",
          },
          {
            revisionLineId: lines[1]!.id,
            decision: "accepted",
            acceptedQuantity: "1",
          },
        ],
        lines,
      ),
    ).toBeNull();
    expect(
      canonicalTreatmentPlanDecisions(
        [
          {
            revisionLineId: lines[0]!.id,
            decision: "accepted",
            acceptedQuantity: "0",
          },
          {
            revisionLineId: lines[1]!.id,
            decision: "accepted",
            acceptedQuantity: "1",
          },
        ],
        lines,
      ),
    ).toBeNull();
  });

  it("binds exact priced lines, choices, and the server response hash into consent copy", () => {
    const decisions = canonicalTreatmentPlanDecisions(
      [
        {
          revisionLineId: lines[0]!.id,
          decision: "accepted",
          acceptedQuantity: "2",
        },
        {
          revisionLineId: lines[1]!.id,
          decision: "declined",
          acceptedQuantity: "0",
        },
      ],
      lines,
    )!;
    const body = buildTreatmentPlanConsentBody(
      {
        patientName: "Peanut",
        revisionNumber: 3,
        currency: "USD",
        subtotal: "65.00",
        tax: "1.50",
        total: "66.50",
      },
      lines,
      decisions,
      "a".repeat(64),
    );
    expect(body).toContain("Blood work");
    expect(body).toContain("Offered 2.000 × USD 25.00 = USD 50.00");
    expect(body).toContain("Decision: ACCEPTED, quantity 2.000");
    expect(body).toContain("Decision: DECLINED");
    expect(body).toContain(
      `Treatment plan response SHA-256: ${"a".repeat(64)}`,
    );
    expect(body).toContain("does not itself charge me or schedule care");
  });
});
