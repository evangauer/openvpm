import { describe, expect, it, vi } from "vitest";
import {
  visitTreatmentPlanPresentations,
  visitTreatmentPlanResponseLines,
  visitTreatmentPlanResponses,
} from "@openpims/db";
import { finalizeTreatmentPlanResponseForConsent } from "./finalize";

function fakeDatabase(selectResults: unknown[][]) {
  const inserted: Array<{ table: unknown; values: unknown }> = [];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      for: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(async () => result),
    };
    return builder;
  });
  const insert = vi.fn((table: unknown) => ({
    values: vi.fn(async (values: unknown) => {
      inserted.push({ table, values });
    }),
  }));
  const updateResults = [[{ id: "presentation" }], [{ id: "plan" }]];
  const update = vi.fn((_table: unknown) => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => updateResults.shift() ?? []),
      })),
    })),
  }));
  const execute = vi.fn(async () => []);
  return {
    database: { select, insert, update, execute } as never,
    inserted,
    execute,
    update,
  };
}

const evidence = {
  practiceId: "00000000-0000-0000-0000-000000000001",
  consentRequestId: "00000000-0000-0000-0000-000000000002",
  signedFileId: "00000000-0000-0000-0000-000000000003",
  signedDocumentSha256: "d".repeat(64),
  signatureSha256: "s".repeat(64),
  signerName: "Jordan Marsh",
};

describe("treatment-plan signed response finalizer", () => {
  it("is a no-op for ordinary consent requests", async () => {
    const fake = fakeDatabase([[]]);
    await expect(
      finalizeTreatmentPlanResponseForConsent(fake.database, evidence),
    ).resolves.toBeNull();
    expect(fake.inserted).toHaveLength(0);
  });

  it("copies the exact staged choices and signed evidence into the immutable spine", async () => {
    const responseId = "00000000-0000-0000-0000-000000000004";
    const revisionId = "00000000-0000-0000-0000-000000000005";
    const planId = "00000000-0000-0000-0000-000000000006";
    const presentationId = "00000000-0000-0000-0000-000000000007";
    const lineId = "00000000-0000-0000-0000-000000000008";
    const responseSha256 = "a".repeat(64);
    const fake = fakeDatabase([
      [
        {
          id: presentationId,
          planId,
          revisionId,
          responseId,
          status: "awaiting_signature",
          decisions: [
            {
              revisionLineId: lineId,
              decision: "accepted",
              acceptedQuantity: "0.500",
              declineReason: null,
            },
          ],
          responseSha256,
        },
      ],
      [{ id: planId }],
      [{ id: revisionId }],
    ]);

    await expect(
      finalizeTreatmentPlanResponseForConsent(fake.database, evidence),
    ).resolves.toEqual({ responseId });

    expect(fake.inserted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: visitTreatmentPlanResponseLines,
          values: [
            expect.objectContaining({
              responseId,
              revisionLineId: lineId,
              decision: "accepted",
              acceptedQuantity: "0.500",
            }),
          ],
        }),
        {
          table: visitTreatmentPlanResponses,
          values: expect.objectContaining({
            id: responseId,
            consentRequestId: evidence.consentRequestId,
            signedFileId: evidence.signedFileId,
            signedDocumentSha256: evidence.signedDocumentSha256,
            signatureSha256: evidence.signatureSha256,
            signerName: evidence.signerName,
            decidedAt: expect.objectContaining({
              queryChunks: expect.any(Array),
            }),
            responseSha256,
          }),
        },
      ]),
    );
    expect(fake.execute).toHaveBeenCalledOnce();
    expect(fake.update).toHaveBeenNthCalledWith(
      1,
      visitTreatmentPlanPresentations,
    );
  });
});
