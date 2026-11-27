import { and, eq, isNull } from "drizzle-orm";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { practices, users } from "@openpims/db";
import { db } from "@openpims/db/client";
import { authOptions } from "@/lib/auth";
import { hasHostedFullAccess } from "@/lib/billing/plans";
import {
  DISCHARGE_AUTHOR_ROLES,
  DISCHARGE_TOOL_PATH,
} from "@/lib/encounters/discharge-handout";
import { withTenant } from "@/lib/tenant-db";
import { DischargeEditor } from "./discharge-editor";

export const metadata = { title: "Discharge instructions · OpenVPM" };

export default async function DischargeInstructionsPage() {
  const session = await getServerSession(authOptions);
  const login = `/login?next=${encodeURIComponent(DISCHARGE_TOOL_PATH)}`;
  if (!session?.user?.id || !session.user.practiceId) redirect(login);
  const { id, practiceId } = session.user;

  const [account] = await withTenant(db, practiceId, (tx) =>
    tx
      .select({
        role: users.role,
        practice: practices.name,
        phone: practices.phone,
        recoveryHold: practices.recoveryHold,
        tier: practices.subscriptionTier,
        status: practices.billingStatus,
        trialEnd: practices.trialEndsAt,
      })
      .from(users)
      .innerJoin(practices, eq(practices.id, users.practiceId))
      .where(
        and(
          eq(users.id, id),
          eq(users.practiceId, practiceId),
          isNull(users.deletedAt),
          isNull(practices.deletedAt),
        ),
      )
      .limit(1),
  );
  if (!account) redirect(login);
  if (account.recoveryHold) redirect("/migration-archive");

  const clinicalStaff = DISCHARGE_AUTHOR_ROLES.some(
    (role) => role === account.role,
  );
  if (
    !clinicalStaff ||
    !hasHostedFullAccess(account.tier, account.status, account.trialEnd)
  ) {
    return (
      <main id="main-content" className="mx-auto max-w-xl space-y-4 px-5 py-16">
        <h1 className="font-heading text-2xl font-semibold">
          Discharge instructions
        </h1>
        <p>
          {clinicalStaff
            ? "An active OpenVPM Cloud subscription or trial is required to prepare a handout."
            : "A veterinarian, technician, or practice administrator can prepare a handout."}
        </p>
        <Link href="/" className="text-primary underline">
          Return to your practice
        </Link>
      </main>
    );
  }
  return (
    <DischargeEditor practice={account.practice} phone={account.phone ?? ""} />
  );
}
