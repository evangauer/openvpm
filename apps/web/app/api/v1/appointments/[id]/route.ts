import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@openpims/db/client";
import { appointments } from "@openpims/db";
import { authenticateApiKey } from "@/lib/api-auth";
import { withTenant } from "@/lib/tenant-db";
import {
  apiError,
  notFound,
  withErrorHandling,
} from "@/lib/compat/shared/errors";
import { isUuid } from "@/lib/compat/shared/validation";
import { toApiAppointment } from "@/lib/compat/openvpm";
import { assertActivePractice } from "@/lib/compat/shared/active-practice";

export const dynamic = "force-dynamic";

// GET /api/v1/appointments/:id — fetch a single appointment scoped to the practice.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await authenticateApiKey(req, "appointments:read");
  if (!auth.ok) return auth.response;
  if (!isUuid(id)) {
    return apiError("Appointment id must be a valid UUID", 400);
  }

  return withErrorHandling(() =>
    withTenant(db, auth.ctx.practiceId, async (tx) => {
      const activePractice = await assertActivePractice(tx, auth.ctx.practiceId);
      if (!activePractice.ok) return activePractice.response;

      const [row] = await tx
        .select()
        .from(appointments)
        .where(
          and(
            eq(appointments.id, id),
            eq(appointments.practiceId, auth.ctx.practiceId),
            isNull(appointments.deletedAt)
          )
        )
        .limit(1);

      if (!row) return notFound("Appointment");
      return NextResponse.json({ data: toApiAppointment(row) });
    })
  );
}
