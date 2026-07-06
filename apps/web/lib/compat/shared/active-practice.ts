import { and, eq, isNull } from "drizzle-orm";
import { practices } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { apiError } from "./errors";

export function activePracticeWhere(practiceId: string) {
  return and(eq(practices.id, practiceId), isNull(practices.deletedAt));
}

export async function assertActivePractice(
  db: Database,
  practiceId: string
) {
  const [practice] = await db
    .select({ id: practices.id })
    .from(practices)
    .where(activePracticeWhere(practiceId))
    .limit(1);

  if (!practice) {
    return { ok: false as const, response: apiError("Practice not found", 404) };
  }

  return { ok: true as const };
}
