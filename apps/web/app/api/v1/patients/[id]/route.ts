import { eq, and, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@openpims/db/client";
import { patients } from "@openpims/db";
import { authenticateApiKey } from "@/lib/api-auth";
import { withTenant } from "@/lib/tenant-db";
import {
  apiError,
  withErrorHandling,
  notFound,
} from "@/lib/compat/shared/errors";
import { isUuid } from "@/lib/compat/shared/validation";
import { toApiPatient } from "@/lib/compat/openvpm";
import { assertActivePractice } from "@/lib/compat/shared/active-practice";

export const dynamic = "force-dynamic";

// GET /api/v1/patients/:id — fetch a single patient scoped to the practice.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await authenticateApiKey(req, "patients:read");
  if (!auth.ok) return auth.response;
  if (!isUuid(id)) {
    return apiError("Patient id must be a valid UUID", 400);
  }

  return withErrorHandling(() =>
    withTenant(db, auth.ctx.practiceId, async (tx) => {
      const activePractice = await assertActivePractice(tx, auth.ctx.practiceId);
      if (!activePractice.ok) return activePractice.response;

      const [row] = await tx
        .select()
        .from(patients)
        .where(
          and(
            eq(patients.id, id),
            eq(patients.practiceId, auth.ctx.practiceId),
            isNull(patients.deletedAt)
          )
        )
        .limit(1);

      if (!row) return notFound("Patient");
      return NextResponse.json({ data: toApiPatient(row) });
    })
  );
}
