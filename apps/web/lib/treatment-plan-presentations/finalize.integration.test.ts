import { afterAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { consentRequests, visitTreatmentPlanResponses } from "@openpims/db";
import { db } from "@openpims/db/client";
import { withTenant } from "@/lib/tenant-db";
import { finalizeTreatmentPlanResponseForConsent } from "./finalize";

const runDatabaseIntegration =
  process.env.TREATMENT_PLAN_FINALIZE_INTEGRATION === "1"
    ? describe
    : describe.skip;

const PRACTICE_ID = "33333333-3333-4333-8333-333333333331";

runDatabaseIntegration("treatment-plan exact timestamp finalization", () => {
  afterAll(async () => {
    await globalThis.__openpimsDb?.client.end();
    globalThis.__openpimsDb = undefined;
  });

  it("copies the database timestamp without a JavaScript millisecond round-trip", async () => {
    const consent = await withTenant(db, PRACTICE_ID, async (tx) => {
      const [row] = await tx
        .select({
          id: consentRequests.id,
          fileId: consentRequests.fileId,
          signatureSha256: consentRequests.signatureSha256,
          signerName: consentRequests.signerName,
        })
        .from(consentRequests)
        .where(eq(consentRequests.practiceId, PRACTICE_ID))
        .limit(1);
      return row;
    });
    expect(consent?.fileId).toBeTruthy();
    expect(consent?.signatureSha256).toBeTruthy();
    expect(consent?.signerName).toBeTruthy();

    await expect(
      withTenant(db, PRACTICE_ID, (tx) =>
        finalizeTreatmentPlanResponseForConsent(tx, {
          practiceId: PRACTICE_ID,
          consentRequestId: consent!.id,
          signedFileId: consent!.fileId!,
          signedDocumentSha256: "c".repeat(64),
          signatureSha256: consent!.signatureSha256!,
          signerName: consent!.signerName!,
        }),
      ),
    ).resolves.toEqual({
      responseId: "33333333-3333-4333-8333-333333333342",
    });

    const [evidence] = await withTenant(db, PRACTICE_ID, (tx) =>
      tx
        .select({
          exactTimestamp: sql<boolean>`${visitTreatmentPlanResponses.decidedAt} = ${consentRequests.signedAt}`,
        })
        .from(visitTreatmentPlanResponses)
        .innerJoin(
          consentRequests,
          and(
            eq(
              consentRequests.id,
              visitTreatmentPlanResponses.consentRequestId,
            ),
            eq(
              consentRequests.practiceId,
              visitTreatmentPlanResponses.practiceId,
            ),
          ),
        )
        .where(eq(visitTreatmentPlanResponses.practiceId, PRACTICE_ID))
        .limit(1),
    );
    expect(evidence?.exactTimestamp).toBe(true);
  });
});
