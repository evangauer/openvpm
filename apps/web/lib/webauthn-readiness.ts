import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { users, webauthnCredentials } from "@openpims/db";
import { db } from "@openpims/db/client";
import { platformAdminEmails } from "@/lib/platform-admin";
import { withSystem } from "@/lib/tenant-db";
import {
  webauthnAdminPolicy,
  webauthnConfiguration,
} from "@/lib/webauthn-config";

export type WebAuthnReadinessCheck = {
  ok: boolean;
  detail: string;
};

type RequiredIdentity = { id: string; email: string };

export function evaluateWebAuthnEnrollmentReadiness(input: {
  requiredIdentities: RequiredIdentity[];
  credentialUserIds: string[];
  operatorEmails: string[];
}): WebAuthnReadinessCheck {
  const enrollmentCount = new Map<string, number>();
  for (const userId of input.credentialUserIds) {
    enrollmentCount.set(userId, (enrollmentCount.get(userId) ?? 0) + 1);
  }
  const identitiesByEmail = new Map<string, RequiredIdentity[]>();
  for (const identity of input.requiredIdentities) {
    const email = identity.email.trim().toLowerCase();
    identitiesByEmail.set(email, [
      ...(identitiesByEmail.get(email) ?? []),
      identity,
    ]);
  }
  const everyRequiredIdentityEnrolled =
    input.requiredIdentities.length > 0 &&
    input.requiredIdentities.every(
      (identity) => (enrollmentCount.get(identity.id) ?? 0) >= 2,
    );
  const everyOperatorPresentAndEnrolled = input.operatorEmails.every(
    (email) => {
      const identities = identitiesByEmail.get(email.trim().toLowerCase());
      return Boolean(
        identities?.length &&
        identities.some(
          (identity) => (enrollmentCount.get(identity.id) ?? 0) >= 2,
        ),
      );
    },
  );
  const ok = everyRequiredIdentityEnrolled && everyOperatorPresentAndEnrolled;
  return {
    ok,
    detail: ok
      ? "Hosted administrator/operator passkey enrollment and redundancy are complete"
      : "Required administrator/operator passkey enrollment or redundancy is incomplete",
  };
}

export async function checkHostedWebAuthnReadiness(): Promise<WebAuthnReadinessCheck> {
  if (!webauthnConfiguration()) {
    return {
      ok: false,
      detail:
        "Hosted WebAuthn relying-party configuration is missing or invalid",
    };
  }
  if (webauthnAdminPolicy() !== "required") {
    return {
      ok: false,
      detail:
        "Hosted WebAuthn administrator/operator enforcement is not required",
    };
  }

  const operatorEmails = [...new Set(platformAdminEmails())];
  return withSystem(db, async (tx) => {
    const clinicAdmins = await tx
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.role, "admin"), isNull(users.deletedAt)));
    const operators = operatorEmails.length
      ? await tx
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(
            and(
              isNull(users.deletedAt),
              inArray(sql`lower(${users.email})`, operatorEmails),
            ),
          )
      : [];
    const requiredById = new Map(
      [...clinicAdmins, ...operators].map((identity) => [
        identity.id,
        identity,
      ]),
    );
    const requiredIdentities = [...requiredById.values()];
    const credentialRows = requiredIdentities.length
      ? await tx
          .select({ userId: webauthnCredentials.userId })
          .from(webauthnCredentials)
          .where(
            and(
              inArray(
                webauthnCredentials.userId,
                requiredIdentities.map((identity) => identity.id),
              ),
              isNull(webauthnCredentials.deletedAt),
            ),
          )
      : [];

    return evaluateWebAuthnEnrollmentReadiness({
      requiredIdentities,
      credentialUserIds: credentialRows.map((row) => row.userId),
      operatorEmails,
    });
  });
}
