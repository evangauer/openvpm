import { NextRequest, NextResponse } from "next/server";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import {
  consentForms,
  consentRequests,
  patients,
  practices,
  visitTreatmentPlanPresentations,
  visitTreatmentPlanRevisionLines,
  visitTreatmentPlanRevisions,
  visitTreatmentPlans,
  type VisitTreatmentPlanPresentationDecision,
} from "@openpims/db";
import { db, type Database } from "@openpims/db/client";
import { appBaseUrl } from "@/lib/app-url";
import { billingEnforced, hasHostedFullAccess } from "@/lib/billing/plans";
import {
  buildTreatmentPlanConsentBody,
  canonicalTreatmentPlanDecisions,
  TREATMENT_PLAN_CONSENT_FORM_BODY,
  TREATMENT_PLAN_CONSENT_FORM_SLUG,
  TREATMENT_PLAN_CONSENT_FORM_TITLE,
  treatmentPlanDecisionsEqual,
  type OfferedTreatmentPlanLine,
} from "@/lib/treatment-plan-presentations/decision-policy";
import {
  hashTreatmentPlanPresentationToken,
  isTreatmentPlanPresentationTokenShape,
  treatmentPlanClientDecisionsEnabled,
} from "@/lib/treatment-plan-presentations/policy";
import {
  CONSENT_TOKEN_TTL_MS,
  captureRateLimitKey,
  deriveTreatmentPlanConsentToken,
  hashConsentToken,
} from "@/lib/consult/tokens";
import { rowsFromExecute } from "@/lib/db/execute-rows";
import { lockPracticeForExternalSideEffects } from "@/lib/recovery-hold";
import { rateLimit, rateLimitResponseHeaders } from "@/lib/rate-limit";
import { clientIpFromRequest } from "@/lib/request-ip";
import { readRequestBytesWithLimit } from "@/lib/request-body";
import { withSystem, withTenant } from "@/lib/tenant-db";
import { sanitizedExceptionTelemetry } from "@/lib/sanitized-exception-telemetry";

export const dynamic = "force-dynamic";

const TOKEN_LIMIT = 60;
const TOKEN_WINDOW_MS = 10 * 60 * 1000;
const IP_LIMIT = 30;
const IP_WINDOW_MS = 10 * 60 * 1000;
const DECISIONS_REQUEST_MAX_BYTES = 64_000;

const decisionInput = z.object({
  revisionLineId: z.string().uuid(),
  decision: z.enum(["accepted", "declined"]),
  acceptedQuantity: z.string().trim().max(32),
  declineReason: z.string().trim().max(2_000).nullable().optional(),
});
const decisionsInput = z.object({ decisions: z.array(decisionInput).max(100) });

type PresentationLookup = {
  id: string;
  practiceId: string;
  planId: string;
  revisionId: string;
  responseId: string;
  createdBy: string;
  expiresAt: Date;
  status: string;
  decisions: VisitTreatmentPlanPresentationDecision[] | null;
  responseSha256: string | null;
  consentRequestId: string | null;
  title: string;
  planStatus: string;
  patientId: string;
  appointmentId: string | null;
  patientName: string;
  revisionNumber: number;
  currency: string;
  subtotal: string;
  tax: string;
  total: string;
  tier: string | null;
  billingStatus: string | null;
  trialEndsAt: Date | null;
};

function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

function privateNoStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}

function billingBlocked(session: PresentationLookup): boolean {
  return (
    billingEnforced() &&
    !hasHostedFullAccess(
      session.tier,
      session.billingStatus,
      session.trialEndsAt,
    )
  );
}

async function enforceRateLimits(
  request: NextRequest,
  token: string,
  scope: string,
): Promise<NextResponse | null> {
  const ipResult = await rateLimit({
    key: `${scope}:ip:${clientIpFromRequest(request)}`,
    limit: IP_LIMIT,
    windowMs: IP_WINDOW_MS,
  });
  if (!ipResult.success) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: rateLimitResponseHeaders(IP_LIMIT, ipResult) },
    );
  }
  const tokenResult = await rateLimit({
    key: captureRateLimitKey(scope, token),
    limit: TOKEN_LIMIT,
    windowMs: TOKEN_WINDOW_MS,
  });
  return tokenResult.success
    ? null
    : NextResponse.json(
        { error: "Too many requests" },
        {
          status: 429,
          headers: rateLimitResponseHeaders(TOKEN_LIMIT, tokenResult),
        },
      );
}

async function lookupPresentation(
  database: Database,
  token: string,
): Promise<{
  session: PresentationLookup;
  lines: OfferedTreatmentPlanLine[];
} | null> {
  const tokenHash = hashTreatmentPlanPresentationToken(token);
  const [session] = await database
    .select({
      id: visitTreatmentPlanPresentations.id,
      practiceId: visitTreatmentPlanPresentations.practiceId,
      planId: visitTreatmentPlanPresentations.planId,
      revisionId: visitTreatmentPlanPresentations.revisionId,
      responseId: visitTreatmentPlanPresentations.responseId,
      createdBy: visitTreatmentPlanPresentations.createdBy,
      expiresAt: visitTreatmentPlanPresentations.expiresAt,
      status: visitTreatmentPlanPresentations.status,
      decisions: visitTreatmentPlanPresentations.decisions,
      responseSha256: visitTreatmentPlanPresentations.responseSha256,
      consentRequestId: visitTreatmentPlanPresentations.consentRequestId,
      title: visitTreatmentPlans.title,
      planStatus: visitTreatmentPlans.status,
      patientId: visitTreatmentPlans.patientId,
      appointmentId: visitTreatmentPlans.appointmentId,
      patientName: patients.name,
      revisionNumber: visitTreatmentPlanRevisions.revisionNumber,
      currency: visitTreatmentPlanRevisions.currency,
      subtotal: visitTreatmentPlanRevisions.subtotal,
      tax: visitTreatmentPlanRevisions.tax,
      total: visitTreatmentPlanRevisions.total,
      tier: practices.subscriptionTier,
      billingStatus: practices.billingStatus,
      trialEndsAt: practices.trialEndsAt,
    })
    .from(visitTreatmentPlanPresentations)
    .innerJoin(
      visitTreatmentPlans,
      and(
        eq(
          visitTreatmentPlans.practiceId,
          visitTreatmentPlanPresentations.practiceId,
        ),
        eq(visitTreatmentPlans.id, visitTreatmentPlanPresentations.planId),
      ),
    )
    .innerJoin(
      visitTreatmentPlanRevisions,
      and(
        eq(
          visitTreatmentPlanRevisions.practiceId,
          visitTreatmentPlanPresentations.practiceId,
        ),
        eq(
          visitTreatmentPlanRevisions.id,
          visitTreatmentPlanPresentations.revisionId,
        ),
      ),
    )
    .innerJoin(
      patients,
      and(
        eq(patients.practiceId, visitTreatmentPlanPresentations.practiceId),
        eq(patients.id, visitTreatmentPlans.patientId),
        isNull(patients.deletedAt),
      ),
    )
    .innerJoin(
      practices,
      and(
        eq(practices.id, visitTreatmentPlanPresentations.practiceId),
        eq(practices.recoveryHold, false),
        isNull(practices.deletedAt),
      ),
    )
    .where(
      and(
        eq(visitTreatmentPlanPresentations.tokenHash, tokenHash),
        gt(visitTreatmentPlanPresentations.expiresAt, new Date()),
        inArray(visitTreatmentPlanPresentations.status, [
          "pending",
          "awaiting_signature",
          "completed",
        ]),
        sql`not exists (
          select 1 from ${visitTreatmentPlanRevisions} newer
          where newer.practice_id = ${visitTreatmentPlanPresentations.practiceId}
            and newer.plan_id = ${visitTreatmentPlanPresentations.planId}
            and newer.revision_number > ${visitTreatmentPlanRevisions.revisionNumber}
        )`,
      ),
    )
    .limit(1);
  if (!session) return null;
  if (
    (session.status === "completed" && session.planStatus !== "completed") ||
    (session.status !== "completed" && session.planStatus !== "open")
  ) {
    return null;
  }
  const lines = await database
    .select({
      id: visitTreatmentPlanRevisionLines.id,
      sortOrder: visitTreatmentPlanRevisionLines.sortOrder,
      description: visitTreatmentPlanRevisionLines.description,
      offeredQuantity: visitTreatmentPlanRevisionLines.offeredQuantity,
      unitPrice: visitTreatmentPlanRevisionLines.unitPrice,
      lineSubtotal: visitTreatmentPlanRevisionLines.lineSubtotal,
      taxAmount: visitTreatmentPlanRevisionLines.taxAmount,
      lineTotal: visitTreatmentPlanRevisionLines.lineTotal,
    })
    .from(visitTreatmentPlanRevisionLines)
    .where(
      and(
        eq(visitTreatmentPlanRevisionLines.practiceId, session.practiceId),
        eq(visitTreatmentPlanRevisionLines.revisionId, session.revisionId),
      ),
    )
    .orderBy(
      asc(visitTreatmentPlanRevisionLines.sortOrder),
      asc(visitTreatmentPlanRevisionLines.id),
    );
  return lines.length ? { session, lines } : null;
}

async function signUrl(
  database: Database,
  session: PresentationLookup,
  treatmentPlanToken: string,
): Promise<string | null> {
  if (!session.consentRequestId) return null;
  const consentToken = deriveTreatmentPlanConsentToken(treatmentPlanToken);
  const [consent] = await database
    .select({ id: consentRequests.id })
    .from(consentRequests)
    .where(
      and(
        eq(consentRequests.practiceId, session.practiceId),
        eq(consentRequests.id, session.consentRequestId),
        eq(consentRequests.tokenHash, hashConsentToken(consentToken)),
        isNull(consentRequests.deletedAt),
      ),
    )
    .limit(1);
  return consent ? `${appBaseUrl()}/sign/${consentToken}` : null;
}

async function handleGet(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (
    !treatmentPlanClientDecisionsEnabled() ||
    !isTreatmentPlanPresentationTokenShape(token)
  ) {
    return notFound();
  }
  const limited = await enforceRateLimits(
    request,
    token,
    "treatment-plan-view",
  );
  if (limited) return limited;
  return withSystem(db, async (systemTx) => {
    const found = await lookupPresentation(systemTx, token);
    if (!found || billingBlocked(found.session)) return notFound();
    if (
      !(await lockPracticeForExternalSideEffects(
        systemTx,
        found.session.practiceId,
      ))
    ) {
      return notFound();
    }
    if (found.session.status !== "pending") {
      if (found.session.status === "completed") {
        return NextResponse.json({ status: "completed", signUrl: null });
      }
      const url = await signUrl(systemTx, found.session, token);
      return NextResponse.json({
        status: found.session.status,
        signUrl: url,
      });
    }
    return NextResponse.json({
      status: "pending",
      title: found.session.title,
      patientName: found.session.patientName,
      revisionNumber: found.session.revisionNumber,
      currency: found.session.currency,
      subtotal: found.session.subtotal,
      tax: found.session.tax,
      total: found.session.total,
      lines: found.lines,
    });
  });
}

async function handlePost(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (
    !treatmentPlanClientDecisionsEnabled() ||
    !isTreatmentPlanPresentationTokenShape(token)
  ) {
    return notFound();
  }
  const limited = await enforceRateLimits(
    request,
    token,
    "treatment-plan-decide",
  );
  if (limited) return limited;
  const found = await withSystem(db, async (systemTx) => {
    const resolved = await lookupPresentation(systemTx, token);
    if (!resolved || billingBlocked(resolved.session)) return null;
    if (
      !(await lockPracticeForExternalSideEffects(
        systemTx,
        resolved.session.practiceId,
      ))
    ) {
      return null;
    }
    return resolved;
  });
  if (!found) return notFound();
  const body = await readRequestBytesWithLimit(
    request,
    DECISIONS_REQUEST_MAX_BYTES,
  );
  if (!body.ok) {
    return NextResponse.json(
      { error: "Request exceeds maximum size" },
      { status: 413 },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body.bytes).toString("utf8"));
  } catch {
    return NextResponse.json({ error: "Invalid decisions" }, { status: 400 });
  }
  const validated = decisionsInput.safeParse(parsed);
  if (!validated.success) {
    return NextResponse.json({ error: "Invalid decisions" }, { status: 400 });
  }
  const decisions = canonicalTreatmentPlanDecisions(
    validated.data.decisions,
    found.lines,
  );
  if (!decisions) {
    return NextResponse.json(
      { error: "Decide every line using a valid quantity" },
      { status: 400 },
    );
  }
  if (found.session.status === "completed") {
    return NextResponse.json({ status: "completed" });
  }
  if (found.session.status === "awaiting_signature") {
    if (!treatmentPlanDecisionsEqual(found.session.decisions, decisions)) {
      return NextResponse.json(
        { error: "These decisions do not match the saved response" },
        { status: 409 },
      );
    }
    const url = await withSystem(db, async (systemTx) => {
      if (
        !(await lockPracticeForExternalSideEffects(
          systemTx,
          found.session.practiceId,
        ))
      ) {
        return null;
      }
      return signUrl(systemTx, found.session, token);
    });
    return url
      ? NextResponse.json({ status: "awaiting_signature", signUrl: url })
      : notFound();
  }

  const consentToken = deriveTreatmentPlanConsentToken(token);
  const consentTokenHash = hashConsentToken(consentToken);
  const now = Date.now();
  const consentExpiresAt = new Date(
    Math.min(found.session.expiresAt.getTime(), now + CONSENT_TOKEN_TTL_MS),
  );
  try {
    const result = await withTenant(
      db,
      found.session.practiceId,
      async (tx) => {
        if (
          !(await lockPracticeForExternalSideEffects(
            tx,
            found.session.practiceId,
          ))
        ) {
          return null;
        }
        const [plan] = await tx
          .select({ id: visitTreatmentPlans.id })
          .from(visitTreatmentPlans)
          .where(
            and(
              eq(visitTreatmentPlans.practiceId, found.session.practiceId),
              eq(visitTreatmentPlans.id, found.session.planId),
              eq(visitTreatmentPlans.status, "open"),
            ),
          )
          .for("update")
          .limit(1);
        if (!plan) return null;
        const [presentation] = await tx
          .select({ status: visitTreatmentPlanPresentations.status })
          .from(visitTreatmentPlanPresentations)
          .where(
            and(
              eq(visitTreatmentPlanPresentations.id, found.session.id),
              eq(
                visitTreatmentPlanPresentations.practiceId,
                found.session.practiceId,
              ),
              eq(visitTreatmentPlanPresentations.status, "pending"),
              gt(
                visitTreatmentPlanPresentations.expiresAt,
                sql`clock_timestamp()`,
              ),
            ),
          )
          .for("update")
          .limit(1);
        if (!presentation) return null;
        const [latest] = await tx
          .select({ id: visitTreatmentPlanRevisions.id })
          .from(visitTreatmentPlanRevisions)
          .where(
            and(
              eq(
                visitTreatmentPlanRevisions.practiceId,
                found.session.practiceId,
              ),
              eq(visitTreatmentPlanRevisions.planId, found.session.planId),
            ),
          )
          .orderBy(desc(visitTreatmentPlanRevisions.revisionNumber))
          .limit(1);
        if (!latest || latest.id !== found.session.revisionId) return null;
        const hashRows = rowsFromExecute<{ responseSha256: string }>(
          await tx.execute(sql`
            select public.compute_visit_treatment_plan_response_sha256_from_decisions(
              ${found.session.practiceId}::uuid,
              ${found.session.planId}::uuid,
              ${found.session.revisionId}::uuid,
              ${found.session.responseId}::uuid,
              ${JSON.stringify(decisions)}::jsonb
            ) as "responseSha256"
          `),
        );
        const responseSha256 = hashRows[0]?.responseSha256;
        if (!responseSha256)
          throw new Error("Response hash could not be computed");
        await tx
          .insert(consentForms)
          .values({
            practiceId: found.session.practiceId,
            slug: TREATMENT_PLAN_CONSENT_FORM_SLUG,
            title: TREATMENT_PLAN_CONSENT_FORM_TITLE,
            body: TREATMENT_PLAN_CONSENT_FORM_BODY,
            sortOrder: 1_000,
            isActive: false,
          })
          .onConflictDoNothing();
        const [form] = await tx
          .select({ id: consentForms.id })
          .from(consentForms)
          .where(
            and(
              eq(consentForms.practiceId, found.session.practiceId),
              eq(consentForms.slug, TREATMENT_PLAN_CONSENT_FORM_SLUG),
            ),
          )
          .limit(1);
        if (!form) throw new Error("Consent form provenance is unavailable");
        const [consent] = await tx
          .insert(consentRequests)
          .values({
            practiceId: found.session.practiceId,
            patientId: found.session.patientId,
            createdBy: found.session.createdBy,
            appointmentId: found.session.appointmentId,
            formId: form.id,
            token: null,
            tokenHash: consentTokenHash,
            expiresAt: consentExpiresAt,
            title: `${found.session.title.slice(0, 190)} decisions`,
            bodyText: buildTreatmentPlanConsentBody(
              found.session,
              found.lines,
              decisions,
              responseSha256,
            ),
          })
          .returning({ id: consentRequests.id });
        if (!consent) throw new Error("Consent request could not be created");
        const [claimed] = await tx
          .update(visitTreatmentPlanPresentations)
          .set({
            status: "awaiting_signature",
            decisions,
            responseSha256,
            consentRequestId: consent.id,
          })
          .where(
            and(
              eq(visitTreatmentPlanPresentations.id, found.session.id),
              eq(
                visitTreatmentPlanPresentations.practiceId,
                found.session.practiceId,
              ),
              eq(visitTreatmentPlanPresentations.status, "pending"),
            ),
          )
          .returning({ id: visitTreatmentPlanPresentations.id });
        return claimed ? { responseSha256 } : null;
      },
    );
    if (!result) return notFound();
    return NextResponse.json(
      {
        status: "awaiting_signature",
        signUrl: `${appBaseUrl()}/sign/${consentToken}`,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error(
      "Treatment-plan decision claim failed:",
      sanitizedExceptionTelemetry(error),
    );
    return NextResponse.json(
      { error: "Could not save decisions" },
      { status: 500 },
    );
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  return privateNoStore(await handleGet(request, context));
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  return privateNoStore(await handlePost(request, context));
}
