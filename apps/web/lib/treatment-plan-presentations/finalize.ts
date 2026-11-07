import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";

import {
  consentRequests,
  visitTreatmentPlanPresentations,
  visitTreatmentPlanResponseLines,
  visitTreatmentPlanResponses,
  visitTreatmentPlanRevisions,
  visitTreatmentPlans,
  type VisitTreatmentPlanPresentationDecision,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";

export async function finalizeTreatmentPlanResponseForConsent(
  tx: Database,
  input: {
    practiceId: string;
    consentRequestId: string;
    signedFileId: string;
    signedDocumentSha256: string;
    signatureSha256: string;
    signerName: string;
  },
): Promise<{ responseId: string } | null> {
  const [presentation] = await tx
    .select({
      id: visitTreatmentPlanPresentations.id,
      planId: visitTreatmentPlanPresentations.planId,
      revisionId: visitTreatmentPlanPresentations.revisionId,
      responseId: visitTreatmentPlanPresentations.responseId,
      status: visitTreatmentPlanPresentations.status,
      decisions: visitTreatmentPlanPresentations.decisions,
      responseSha256: visitTreatmentPlanPresentations.responseSha256,
    })
    .from(visitTreatmentPlanPresentations)
    .where(
      and(
        eq(visitTreatmentPlanPresentations.practiceId, input.practiceId),
        eq(
          visitTreatmentPlanPresentations.consentRequestId,
          input.consentRequestId,
        ),
      ),
    )
    .for("update")
    .limit(1);
  if (!presentation) return null;
  if (presentation.status === "completed") {
    const [response] = await tx
      .select({ id: visitTreatmentPlanResponses.id })
      .from(visitTreatmentPlanResponses)
      .where(
        and(
          eq(visitTreatmentPlanResponses.practiceId, input.practiceId),
          eq(visitTreatmentPlanResponses.id, presentation.responseId),
          eq(
            visitTreatmentPlanResponses.consentRequestId,
            input.consentRequestId,
          ),
        ),
      )
      .limit(1);
    if (!response) {
      throw new Error("Completed presentation is missing its sealed response");
    }
    return { responseId: response.id };
  }
  if (
    presentation.status !== "awaiting_signature" ||
    !presentation.decisions ||
    !presentation.responseSha256
  ) {
    throw new Error("Treatment-plan presentation is not ready to seal");
  }

  const [plan] = await tx
    .select({ id: visitTreatmentPlans.id })
    .from(visitTreatmentPlans)
    .where(
      and(
        eq(visitTreatmentPlans.practiceId, input.practiceId),
        eq(visitTreatmentPlans.id, presentation.planId),
        eq(visitTreatmentPlans.status, "open"),
      ),
    )
    .for("update")
    .limit(1);
  if (!plan) throw new Error("Treatment plan is no longer open");
  const [latest] = await tx
    .select({ id: visitTreatmentPlanRevisions.id })
    .from(visitTreatmentPlanRevisions)
    .where(
      and(
        eq(visitTreatmentPlanRevisions.practiceId, input.practiceId),
        eq(visitTreatmentPlanRevisions.planId, presentation.planId),
      ),
    )
    .orderBy(desc(visitTreatmentPlanRevisions.revisionNumber))
    .limit(1);
  if (!latest || latest.id !== presentation.revisionId) {
    throw new Error("Treatment plan revision changed before signature");
  }

  const decisions =
    presentation.decisions as VisitTreatmentPlanPresentationDecision[];
  await tx.insert(visitTreatmentPlanResponseLines).values(
    decisions.map((decision) => ({
      id: randomUUID(),
      practiceId: input.practiceId,
      revisionId: presentation.revisionId,
      responseId: presentation.responseId,
      revisionLineId: decision.revisionLineId,
      decision: decision.decision,
      acceptedQuantity: decision.acceptedQuantity,
      declineReason: decision.declineReason,
    })),
  );
  await tx.insert(visitTreatmentPlanResponses).values({
    id: presentation.responseId,
    practiceId: input.practiceId,
    planId: presentation.planId,
    revisionId: presentation.revisionId,
    consentRequestId: input.consentRequestId,
    signedFileId: input.signedFileId,
    signatureSha256: input.signatureSha256,
    signedDocumentSha256: input.signedDocumentSha256,
    signerName: input.signerName,
    // signed_at is captured by PostgreSQL's clock_timestamp() with
    // microsecond precision. A JavaScript Date truncates that value to
    // milliseconds, so round-tripping through application memory would fail
    // the database seal trigger's exact evidence match. Source the value from
    // the bound consent row inside this INSERT to preserve the original
    // timestamp.
    decidedAt: sql`(
      select ${consentRequests.signedAt}
      from ${consentRequests}
      where ${consentRequests.practiceId} = ${input.practiceId}
        and ${consentRequests.id} = ${input.consentRequestId}
        and ${consentRequests.status} = 'signed'
        and ${consentRequests.deletedAt} is null
    )`,
    operationId: presentation.responseId,
    operationPayloadHash: presentation.responseSha256,
    responseSha256: presentation.responseSha256,
  });
  await tx.execute(sql`set constraints all immediate`);

  const [completedPresentation] = await tx
    .update(visitTreatmentPlanPresentations)
    .set({ status: "completed" })
    .where(
      and(
        eq(visitTreatmentPlanPresentations.practiceId, input.practiceId),
        eq(visitTreatmentPlanPresentations.id, presentation.id),
        eq(visitTreatmentPlanPresentations.status, "awaiting_signature"),
      ),
    )
    .returning({ id: visitTreatmentPlanPresentations.id });
  if (!completedPresentation) {
    throw new Error("Treatment-plan presentation completion lost a race");
  }
  const [completedPlan] = await tx
    .update(visitTreatmentPlans)
    .set({ status: "completed" })
    .where(
      and(
        eq(visitTreatmentPlans.practiceId, input.practiceId),
        eq(visitTreatmentPlans.id, presentation.planId),
        eq(visitTreatmentPlans.status, "open"),
      ),
    )
    .returning({ id: visitTreatmentPlans.id });
  if (!completedPlan) throw new Error("Treatment plan completion lost a race");
  return { responseId: presentation.responseId };
}
