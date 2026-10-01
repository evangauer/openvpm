import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { and, eq, isNull } from "drizzle-orm";
import { practices } from "@openpims/db";
import { db } from "@openpims/db/client";
import { authOptions } from "@/lib/auth";
import { billingEnforced, hasHostedFullAccess } from "@/lib/billing/plans";
import { reviewLandingPath } from "@/lib/review-landing";
import { withTenant } from "@/lib/tenant-db";

export default async function PostLoginPage() {
  const session = await getServerSession(authOptions);
  const practiceId = session?.user?.practiceId;
  if (!practiceId) redirect("/login");

  const [practice] = await withTenant(db, practiceId, (tx) =>
    tx
      .select({
        recoveryHold: practices.recoveryHold,
        tier: practices.subscriptionTier,
        billingStatus: practices.billingStatus,
        trialEndsAt: practices.trialEndsAt,
      })
      .from(practices)
      .where(and(eq(practices.id, practiceId), isNull(practices.deletedAt)))
      .limit(1),
  );
  if (!practice) redirect("/login");

  if (session.user.role === "admin" && !practice.recoveryHold && billingEnforced() && !hasHostedFullAccess(
    practice.tier, practice.billingStatus, practice.trialEndsAt,
  )) redirect("/settings?tab=billing");

  redirect(reviewLandingPath(practice));
}
