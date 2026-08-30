import { expect, test, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  authRecoveryCases,
  authRecoveryEvents,
  practices,
  users,
  webauthnChallenges,
  webauthnCredentials,
} from "@openpims/db";
import { db } from "@openpims/db/client";
import {
  authRecoveryGrantHash,
  beginAuthRecoveryRegistration,
  finishAuthRecoveryRegistration,
} from "../apps/web/server/auth-recovery-lifecycle";
import {
  beginWebAuthnAuthentication,
  beginWebAuthnRegistration,
  finishWebAuthnAuthentication,
  finishWebAuthnRegistration,
} from "../apps/web/lib/webauthn-ceremony";
import { withSystem } from "../apps/web/lib/tenant-db";

const configured =
  Boolean(process.env.DATABASE_URL?.trim()) &&
  Boolean(process.env.WEBAUTHN_RP_ID?.trim()) &&
  Boolean(process.env.WEBAUTHN_ORIGINS?.trim());

test.skip(
  !configured,
  "DATABASE_URL and exact WebAuthn RP/origin configuration are required",
);

test("verifies a real user-verified passkey ceremony and rejects wrong-origin replay", async ({
  context,
  page,
}) => {
  test.setTimeout(90_000);

  const practiceId = randomUUID();
  const userId = randomUUID();
  const requesterUserId = randomUUID();
  const approverUserId = randomUUID();
  const email = `passkey-crypto-${userId}@example.test`;
  const identity = {
    email,
    name: "Passkey Cryptographic Contract",
    practiceId,
    sessionVersion: 1,
    userId,
  };
  const originalOrigins = process.env.WEBAUTHN_ORIGINS;
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = (await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  )) as { authenticatorId: string };
  let secondAuthenticatorId: string | undefined;

  try {
    await db.insert(practices).values({
      id: practiceId,
      name: "Passkey Cryptographic Contract",
    });
    await db.insert(users).values({
      id: userId,
      email,
      name: identity.name,
      passwordHash: "not-a-real-password-hash",
      practiceId,
      role: "admin",
    });
    await db.insert(users).values([
      {
        id: requesterUserId,
        email: `recovery-requester-${requesterUserId}@example.test`,
        name: "Recovery Requester Contract",
        passwordHash: "not-a-real-password-hash",
        practiceId,
        role: "admin",
      },
      {
        id: approverUserId,
        email: `recovery-approver-${approverUserId}@example.test`,
        name: "Recovery Approver Contract",
        passwordHash: "not-a-real-password-hash",
        practiceId,
        role: "admin",
      },
    ]);

    await page.goto("/login", { waitUntil: "domcontentloaded" });

    const registration = await withSystem(db, (tx) =>
      beginWebAuthnRegistration({ database: tx, identity }),
    );
    const registrationResponse = await createCredential(
      page,
      registration.options,
    );
    await withSystem(db, (tx) =>
      finishWebAuthnRegistration({
        challengeId: registration.challengeId,
        database: tx,
        identity,
        name: "CI virtual authenticator",
        response: registrationResponse,
      }),
    );

    const [registered] = await db
      .select({
        counter: webauthnCredentials.counter,
        publicKey: webauthnCredentials.publicKey,
      })
      .from(webauthnCredentials)
      .where(
        and(
          eq(webauthnCredentials.practiceId, practiceId),
          eq(webauthnCredentials.userId, userId),
        ),
      );
    expect(registered?.publicKey.byteLength).toBeGreaterThanOrEqual(32);

    const authentication = await withSystem(db, (tx) =>
      beginWebAuthnAuthentication({
        database: tx,
        identity,
        purpose: "login",
      }),
    );
    const authenticationResponse = await getCredential(
      page,
      authentication.options,
    );

    // The assertion is genuinely signed for the browser page origin. A
    // different exact allowlist must fail before any counter/challenge update.
    process.env.WEBAUTHN_ORIGINS = "https://wrong.localhost";
    await expect(
      withSystem(db, (tx) =>
        finishWebAuthnAuthentication({
          challengeId: authentication.challengeId,
          database: tx,
          identity,
          purpose: "login",
          response: authenticationResponse,
        }),
      ),
    ).rejects.toThrow();
    process.env.WEBAUTHN_ORIGINS = originalOrigins;

    await withSystem(db, (tx) =>
      finishWebAuthnAuthentication({
        challengeId: authentication.challengeId,
        database: tx,
        identity,
        purpose: "login",
        response: authenticationResponse,
      }),
    );

    const [authenticated] = await db
      .select({
        counter: webauthnCredentials.counter,
        lastUsedAt: webauthnCredentials.lastUsedAt,
      })
      .from(webauthnCredentials)
      .where(
        and(
          eq(webauthnCredentials.practiceId, practiceId),
          eq(webauthnCredentials.userId, userId),
        ),
      );
    expect(authenticated?.counter).toBeGreaterThan(registered?.counter ?? -1);
    expect(authenticated?.lastUsedAt).toBeInstanceOf(Date);

    await expect(
      withSystem(db, (tx) =>
        finishWebAuthnAuthentication({
          challengeId: authentication.challengeId,
          database: tx,
          identity,
          purpose: "login",
          response: authenticationResponse,
        }),
      ),
    ).rejects.toThrow(/challenge is invalid/i);

    const recoveryCaseId = randomUUID();
    const rawRecoveryGrant = randomBytes(32).toString("base64url");
    const requestedAt = new Date();
    const approvedAt = new Date();
    await withSystem(db, async (tx) => {
      await tx.insert(authRecoveryCases).values({
        expiresAt: new Date(requestedAt.getTime() + 24 * 60 * 60 * 1_000),
        id: recoveryCaseId,
        identityProofReferenceHash: "a".repeat(64),
        practiceId,
        reasonCode: "lost_all_passkeys",
        requestedAt,
        requesterUserId,
        status: "pending",
        targetSessionVersion: 1,
        updatedAt: requestedAt,
        userId,
      });
      await tx.insert(authRecoveryEvents).values({
        actorUserId: requesterUserId,
        caseId: recoveryCaseId,
        eventType: "requested",
        occurredAt: requestedAt,
        practiceId,
        userId,
      });
    });
    await withSystem(db, async (tx) => {
      await tx
        .update(webauthnCredentials)
        .set({ deletedAt: approvedAt, updatedAt: approvedAt })
        .where(
          and(
            eq(webauthnCredentials.practiceId, practiceId),
            eq(webauthnCredentials.userId, userId),
            isNull(webauthnCredentials.deletedAt),
          ),
        );
      await tx
        .update(users)
        .set({ sessionVersion: 2 })
        .where(
          and(
            eq(users.id, userId),
            eq(users.practiceId, practiceId),
            eq(users.sessionVersion, 1),
          ),
        );
      await tx
        .update(authRecoveryCases)
        .set({
          approvedAt,
          approverUserId,
          grantExpiresAt: new Date(approvedAt.getTime() + 15 * 60 * 1_000),
          recoveryGrantHash: authRecoveryGrantHash(rawRecoveryGrant),
          revokedSessionVersion: 2,
          status: "approved",
          updatedAt: approvedAt,
        })
        .where(eq(authRecoveryCases.id, recoveryCaseId));
      await tx.insert(authRecoveryEvents).values({
        actorUserId: approverUserId,
        caseId: recoveryCaseId,
        eventType: "approved",
        occurredAt: approvedAt,
        practiceId,
        userId,
      });
    });

    const recoveryRegistration = await beginAuthRecoveryRegistration({
      database: db,
      grant: rawRecoveryGrant,
    });
    const staleSecondRegistration = await beginAuthRecoveryRegistration({
      database: db,
      grant: rawRecoveryGrant,
    });
    const recoveryResponse = await createCredential(
      page,
      recoveryRegistration.options,
    );
    const recovered = await finishAuthRecoveryRegistration({
      challengeId: recoveryRegistration.challengeId,
      credentialName: "Recovered CI virtual authenticator",
      database: db,
      grant: rawRecoveryGrant,
      response: recoveryResponse,
    });
    expect(recovered.credentialId).toBe(recoveryResponse.id);
    expect(recovered.complete).toBe(false);

    const [midRecoveryState] = await withSystem(db, (tx) =>
      tx
        .select({ status: authRecoveryCases.status })
        .from(authRecoveryCases)
        .where(eq(authRecoveryCases.id, recoveryCaseId)),
    );
    expect(midRecoveryState?.status).toBe("approved");

    await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
      authenticatorId,
      enabled: false,
    });
    ({ authenticatorId: secondAuthenticatorId } = (await cdp.send(
      "WebAuthn.addVirtualAuthenticator",
      {
        options: {
          protocol: "ctap2",
          transport: "usb",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      },
    )) as { authenticatorId: string });

    const staleSecondResponse = await createCredential(
      page,
      staleSecondRegistration.options,
    );
    await expect(
      finishAuthRecoveryRegistration({
        challengeId: staleSecondRegistration.challengeId,
        credentialName: "Preissued second authenticator",
        database: db,
        grant: rawRecoveryGrant,
        response: staleSecondResponse,
      }),
    ).rejects.toThrow(/invalid or expired/i);

    const secondRegistration = await beginAuthRecoveryRegistration({
      database: db,
      grant: rawRecoveryGrant,
    });
    const secondResponse = await createCredential(
      page,
      secondRegistration.options,
    );
    const secondRecovered = await finishAuthRecoveryRegistration({
      challengeId: secondRegistration.challengeId,
      credentialName: "Second recovered CI virtual authenticator",
      database: db,
      grant: rawRecoveryGrant,
      response: secondResponse,
    });
    expect(secondRecovered.credentialId).toBe(secondResponse.id);
    expect(secondRecovered.complete).toBe(true);

    const [recoveryState] = await withSystem(db, (tx) =>
      tx
        .select({ status: authRecoveryCases.status })
        .from(authRecoveryCases)
        .where(eq(authRecoveryCases.id, recoveryCaseId)),
    );
    const activeRecoveredCredentials = await db
      .select({ id: webauthnCredentials.id })
      .from(webauthnCredentials)
      .where(
        and(
          eq(webauthnCredentials.practiceId, practiceId),
          eq(webauthnCredentials.userId, userId),
          isNull(webauthnCredentials.deletedAt),
        ),
      );
    expect(recoveryState?.status).toBe("consumed");
    expect(activeRecoveredCredentials).toHaveLength(2);
    await expect(
      finishAuthRecoveryRegistration({
        challengeId: secondRegistration.challengeId,
        credentialName: "Replay must fail",
        database: db,
        grant: rawRecoveryGrant,
        response: secondResponse,
      }),
    ).rejects.toThrow(/invalid or expired/i);
  } finally {
    process.env.WEBAUTHN_ORIGINS = originalOrigins;
    await cdp
      .send("WebAuthn.removeVirtualAuthenticator", { authenticatorId })
      .catch(() => undefined);
    if (secondAuthenticatorId) {
      await cdp
        .send("WebAuthn.removeVirtualAuthenticator", {
          authenticatorId: secondAuthenticatorId,
        })
        .catch(() => undefined);
    }
    await cdp.send("WebAuthn.disable").catch(() => undefined);
    await db
      .transaction(async (tx) => {
        await tx.execute(sql`set local session_replication_role = replica`);
        await tx
          .delete(webauthnChallenges)
          .where(eq(webauthnChallenges.practiceId, practiceId));
        await tx
          .delete(webauthnCredentials)
          .where(eq(webauthnCredentials.practiceId, practiceId));
        await tx
          .delete(authRecoveryEvents)
          .where(eq(authRecoveryEvents.practiceId, practiceId));
        await tx
          .delete(authRecoveryCases)
          .where(eq(authRecoveryCases.practiceId, practiceId));
        await tx.delete(users).where(eq(users.practiceId, practiceId));
        await tx.delete(practices).where(eq(practices.id, practiceId));
      })
      .catch(() => undefined);
  }
});

async function createCredential(page: Page, options: unknown) {
  return page.evaluate(async (jsonOptions) => {
    const publicKey = registrationOptions(jsonOptions);
    const credential = (await navigator.credentials.create({
      publicKey,
    })) as PublicKeyCredential | null;
    if (!credential) throw new Error("Virtual registration returned no key.");
    const response = credential.response as AuthenticatorAttestationResponse;
    return {
      id: credential.id,
      rawId: encodeBase64url(credential.rawId),
      response: {
        clientDataJSON: encodeBase64url(response.clientDataJSON),
        attestationObject: encodeBase64url(response.attestationObject),
        transports: response.getTransports?.() ?? [],
      },
      ...(credential.authenticatorAttachment
        ? { authenticatorAttachment: credential.authenticatorAttachment }
        : {}),
      clientExtensionResults: credential.getClientExtensionResults(),
      type: "public-key" as const,
    };

    function registrationOptions(
      value: unknown,
    ): PublicKeyCredentialCreationOptions {
      const input = value as PublicKeyCredentialCreationOptionsJSON;
      return {
        ...input,
        challenge: decodeBase64url(input.challenge),
        user: { ...input.user, id: decodeBase64url(input.user.id) },
        excludeCredentials: input.excludeCredentials?.map((descriptor) => ({
          ...descriptor,
          id: decodeBase64url(descriptor.id),
        })),
      };
    }

    function decodeBase64url(value: string): ArrayBuffer {
      const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized.padEnd(
        normalized.length + ((4 - (normalized.length % 4)) % 4),
        "=",
      );
      const binary = atob(padded);
      return Uint8Array.from(binary, (character) => character.charCodeAt(0))
        .buffer;
    }

    function encodeBase64url(value: ArrayBuffer): string {
      const binary = String.fromCharCode(...new Uint8Array(value));
      return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
    }
  }, options);
}

async function getCredential(page: Page, options: unknown) {
  return page.evaluate(async (jsonOptions) => {
    const publicKey = authenticationOptions(jsonOptions);
    const credential = (await navigator.credentials.get({
      publicKey,
    })) as PublicKeyCredential | null;
    if (!credential) throw new Error("Virtual authentication returned no key.");
    const response = credential.response as AuthenticatorAssertionResponse;
    return {
      id: credential.id,
      rawId: encodeBase64url(credential.rawId),
      response: {
        clientDataJSON: encodeBase64url(response.clientDataJSON),
        authenticatorData: encodeBase64url(response.authenticatorData),
        signature: encodeBase64url(response.signature),
        ...(response.userHandle
          ? { userHandle: encodeBase64url(response.userHandle) }
          : {}),
      },
      ...(credential.authenticatorAttachment
        ? { authenticatorAttachment: credential.authenticatorAttachment }
        : {}),
      clientExtensionResults: credential.getClientExtensionResults(),
      type: "public-key" as const,
    };

    function authenticationOptions(
      value: unknown,
    ): PublicKeyCredentialRequestOptions {
      const input = value as PublicKeyCredentialRequestOptionsJSON;
      return {
        ...input,
        challenge: decodeBase64url(input.challenge),
        allowCredentials: input.allowCredentials?.map((descriptor) => ({
          ...descriptor,
          id: decodeBase64url(descriptor.id),
        })),
      };
    }

    function decodeBase64url(value: string): ArrayBuffer {
      const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized.padEnd(
        normalized.length + ((4 - (normalized.length % 4)) % 4),
        "=",
      );
      const binary = atob(padded);
      return Uint8Array.from(binary, (character) => character.charCodeAt(0))
        .buffer;
    }

    function encodeBase64url(value: ArrayBuffer): string {
      const binary = String.fromCharCode(...new Uint8Array(value));
      return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
    }
  }, options);
}
