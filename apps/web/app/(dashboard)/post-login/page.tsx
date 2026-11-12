import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { and, eq, isNull } from "drizzle-orm";
import { practices, users } from "@openpims/db";
import { db } from "@openpims/db/client";
import { authOptions } from "@/lib/auth";
import { billingEnforced, hasHostedFullAccess } from "@/lib/billing/plans";
import { hasPreviewAccess } from "@/lib/billing/preview";
import { reviewLandingPath } from "@/lib/review-landing";
import { sessionVersionIsCurrent } from "@/lib/session-version";
import { withTenant } from "@/lib/tenant-db";

export default async function PostLoginPage() {
  const session = await getServerSession(authOptions);
  const practiceId = session?.user?.practiceId;
  const userId = session?.user?.id;
  if (!practiceId || !userId) redirect("/login");

  // Role and session generation come from the database, not the JWT, so a
  // demoted or signed-out-everywhere account lands like everyone else.
  const [account] = await withTenant(db, practiceId, (tx) =>
    tx
      .select({
        role: users.role,
        sessionVersion: users.sessionVersion,
        recoveryHold: practices.recoveryHold,
        tier: practices.subscriptionTier,
        billingStatus: practices.billingStatus,
        trialEndsAt: practices.trialEndsAt,
        stripeSubscriptionId: practices.stripeSubscriptionId,
        previewEndsAt: practices.previewEndsAt,
      })
      .from(practices)
      .innerJoin(
        users,
        and(
          eq(users.practiceId, practices.id),
          eq(users.id, userId),
          isNull(users.deletedAt),
        ),
      )
      .where(and(eq(practices.id, practiceId), isNull(practices.deletedAt)))
      .limit(1),
  );
  if (
    !account ||
    !sessionVersionIsCurrent(session.user.sessionVersion, account.sessionVersion)
  ) {
    redirect("/login");
  }

  // A clinic in its preview lands in the product; the card comes after setup.
  if (account.role === "admin" && !account.recoveryHold && billingEnforced() && !hasHostedFullAccess(
    account.tier, account.billingStatus, account.trialEndsAt,
  ) && !hasPreviewAccess(account)) redirect("/settings?tab=billing");

  redirect(reviewLandingPath(account));
}
