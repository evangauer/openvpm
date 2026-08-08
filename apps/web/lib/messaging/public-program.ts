import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@openpims/db/client";
import { messagingRegistrations, practices } from "@openpims/db";
import { appBaseUrl } from "@/lib/app-url";
import { withSystem } from "@/lib/tenant-db";

const practiceIdSchema = z.string().uuid();

export type PublicMessagingProgram = {
  practiceId: string;
  displayName: string;
  businessPhone: string | null;
  website: string | null;
};

function publicHttpsUrlOrNull(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function messagingProgramUrls(
  practiceId: string,
  baseUrl = appBaseUrl(),
) {
  const safePracticeId = practiceIdSchema.parse(practiceId);
  const base = new URL(baseUrl);
  const programUrl = new URL(
    `/sms/${encodeURIComponent(safePracticeId)}`,
    base,
  ).toString();

  return {
    programUrl,
    privacyPolicyUrl: new URL("privacy", `${programUrl}/`).toString(),
    termsUrl: new URL("terms", `${programUrl}/`).toString(),
    optInUrl: new URL("opt-in", `${programUrl}/`).toString(),
  };
}

/**
 * Load only the clinic details that are appropriate for a public carrier and
 * client-facing SMS disclosure. Legal names, addresses, EINs, and registration
 * contacts intentionally never cross this boundary.
 */
export async function getPublicMessagingProgram(
  practiceId: string,
): Promise<PublicMessagingProgram | null> {
  const parsed = practiceIdSchema.safeParse(practiceId);
  if (!parsed.success) return null;

  return withSystem(db, async (tx) => {
    const [row] = await tx
      .select({
        practiceId: practices.id,
        practiceName: practices.name,
        practicePhone: practices.phone,
        practiceWebsite: practices.website,
        registrationDisplayName: messagingRegistrations.displayName,
        registrationBusinessPhone: messagingRegistrations.businessPhone,
        registrationWebsite: messagingRegistrations.website,
      })
      .from(practices)
      .leftJoin(
        messagingRegistrations,
        and(
          eq(messagingRegistrations.practiceId, practices.id),
          isNull(messagingRegistrations.deletedAt),
        ),
      )
      .where(
        and(
          eq(practices.id, parsed.data),
          eq(practices.country, "US"),
          isNull(practices.deletedAt),
        ),
      )
      .limit(1);

    if (!row) return null;
    return {
      practiceId: row.practiceId,
      displayName: row.registrationDisplayName || row.practiceName,
      businessPhone: row.registrationBusinessPhone || row.practicePhone || null,
      website: publicHttpsUrlOrNull(
        row.registrationWebsite || row.practiceWebsite
      ),
    };
  });
}
