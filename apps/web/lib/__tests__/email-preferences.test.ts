import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CANONICAL_EMAIL_PREFERENCE_BASE_URL,
  createEmailPreferenceLinks,
  createEmailPreferenceToken,
  emailPreferenceBaseUrl,
  emailPreferenceIdentityKeyFingerprint,
  emailPreferenceRecipientHash,
  normalizeEmailPreferenceBaseUrl,
  verifyEmailPreferenceToken,
} from "../email-preferences";

const IDENTITY_SECRET = "identity-secret-kept-stable-at-least-32-bytes";
const SIGNING_SECRET = "current-signing-secret-at-least-32-bytes";
const PREVIOUS_SIGNING_SECRET = "previous-test-key-".repeat(3);
const NOW = new Date("2026-08-09T12:00:00Z");
const RECIPIENT_HASH = emailPreferenceRecipientHash("owner@example.com", {
  identitySecret: IDENTITY_SECRET,
})!;
const IDENTITY_FINGERPRINT = emailPreferenceIdentityKeyFingerprint({
  identitySecret: IDENTITY_SECRET,
})!;

beforeEach(() => {
  vi.stubEnv("EMAIL_PREFERENCE_IDENTITY_SECRET", IDENTITY_SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("email preference tokens", () => {
  it("signs and verifies a PII-free recipient target", () => {
    const token = createEmailPreferenceToken(
      { kind: "recipient", id: RECIPIENT_HASH },
      { now: NOW, signingSecret: SIGNING_SECRET },
    );

    expect(token).toBeTruthy();
    expect(token).not.toContain("owner@example.com");
    expect(
      verifyEmailPreferenceToken(token, {
        now: NOW,
        signingSecret: SIGNING_SECRET,
      }),
    ).toMatchObject({
      v: 1,
      purpose: "unsubscribe_marketing",
      kid: expect.stringMatching(/^[a-f0-9]{16}$/),
      identityKeyFingerprint: IDENTITY_FINGERPRINT,
      target: { kind: "recipient", id: RECIPIENT_HASH },
    });
  });

  it("uses a separate stable identity key for normalized recipient hashes", () => {
    expect(
      emailPreferenceRecipientHash(" OWNER@Example.com ", {
        identitySecret: IDENTITY_SECRET,
      }),
    ).toBe(RECIPIENT_HASH);
    expect(
      emailPreferenceRecipientHash("owner@example.com", {
        identitySecret: SIGNING_SECRET,
      }),
    ).not.toBe(RECIPIENT_HASH);
    expect(
      emailPreferenceRecipientHash("owner@example.com", {
        identitySecret: " ",
      }),
    ).toBeNull();
  });

  it("exposes a non-secret fingerprint for identity-key drift detection", () => {
    const fingerprint = emailPreferenceIdentityKeyFingerprint({
      identitySecret: IDENTITY_SECRET,
    });

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain(IDENTITY_SECRET);
    expect(
      emailPreferenceIdentityKeyFingerprint({ identitySecret: " " }),
    ).toBeNull();
  });

  it("rejects tampering, malformed identifiers, and missing signing secrets", () => {
    const token = createEmailPreferenceToken(
      { kind: "recipient", id: RECIPIENT_HASH },
      { now: NOW, signingSecret: SIGNING_SECRET },
    )!;

    expect(
      verifyEmailPreferenceToken(`${token}x`, {
        now: NOW,
        signingSecret: SIGNING_SECRET,
      }),
    ).toBeNull();
    expect(
      createEmailPreferenceToken(
        { kind: "recipient", id: "not-a-hash" },
        { now: NOW, signingSecret: SIGNING_SECRET },
      ),
    ).toBeNull();
    expect(
      createEmailPreferenceToken(
        { kind: "recipient", id: RECIPIENT_HASH },
        { now: NOW, signingSecret: " " },
      ),
    ).toBeNull();
    expect(
      createEmailPreferenceToken(
        { kind: "recipient", id: RECIPIENT_HASH },
        {
          now: NOW,
          identitySecret: " ",
          signingSecret: SIGNING_SECRET,
        },
      ),
    ).toBeNull();
  });

  it("rejects a correctly signed token created for a different purpose", () => {
    const encoded = Buffer.from(
      JSON.stringify({
        v: 1,
        purpose: "verify_email",
        kid: "0123456789abcdef",
        identityKeyFingerprint: IDENTITY_FINGERPRINT,
        target: { kind: "recipient", id: RECIPIENT_HASH },
        iat: Math.floor(NOW.getTime() / 1000),
      }),
    ).toString("base64url");
    const signature = createHmac("sha256", SIGNING_SECRET)
      .update(encoded)
      .digest("base64url");

    expect(
      verifyEmailPreferenceToken(`${encoded}.${signature}`, {
        now: NOW,
        signingSecret: SIGNING_SECRET,
      }),
    ).toBeNull();
  });

  it("keeps unsubscribe-only links durable", () => {
    const token = createEmailPreferenceToken(
      { kind: "recipient", id: RECIPIENT_HASH },
      { now: NOW, signingSecret: SIGNING_SECRET },
    );

    expect(
      verifyEmailPreferenceToken(token, {
        now: new Date("2036-08-09T12:00:00Z"),
        signingSecret: SIGNING_SECRET,
      }),
    ).not.toBeNull();
  });

  it("verifies durable links after rotation with the previous-key ring", () => {
    const oldToken = createEmailPreferenceToken(
      { kind: "recipient", id: RECIPIENT_HASH },
      { now: NOW, signingSecret: PREVIOUS_SIGNING_SECRET },
    );

    expect(
      verifyEmailPreferenceToken(oldToken, {
        now: NOW,
        signingSecret: SIGNING_SECRET,
        previousSigningSecrets: PREVIOUS_SIGNING_SECRET,
      }),
    ).not.toBeNull();
    expect(
      verifyEmailPreferenceToken(oldToken, {
        now: NOW,
        signingSecret: SIGNING_SECRET,
      }),
    ).toBeNull();
  });

  it("rejects a durable link after an unexpected identity-key change", () => {
    const token = createEmailPreferenceToken(
      { kind: "recipient", id: RECIPIENT_HASH },
      { now: NOW, signingSecret: SIGNING_SECRET },
    );

    expect(
      verifyEmailPreferenceToken(token, {
        now: NOW,
        identitySecret: "different-stable-identity-secret-at-least-32-bytes",
        signingSecret: SIGNING_SECRET,
      }),
    ).toBeNull();
  });

  it("fails closed when any configured previous signing key is invalid", () => {
    const token = createEmailPreferenceToken(
      { kind: "recipient", id: RECIPIENT_HASH },
      { now: NOW, signingSecret: SIGNING_SECRET },
    );

    expect(
      verifyEmailPreferenceToken(token, {
        now: NOW,
        signingSecret: SIGNING_SECRET,
        previousSigningSecrets: `${PREVIOUS_SIGNING_SECRET},too-short`,
      }),
    ).toBeNull();

    expect(
      createEmailPreferenceLinks(
        { kind: "recipient", id: RECIPIENT_HASH },
        {
          now: NOW,
          signingSecret: SIGNING_SECRET,
          previousSigningSecrets: `${PREVIOUS_SIGNING_SECRET},too-short`,
          baseUrl: CANONICAL_EMAIL_PREFERENCE_BASE_URL,
        },
      ),
    ).toBeNull();
  });

  it("defaults links to the configured canonical HTTPS origin", () => {
    vi.stubEnv(
      "EMAIL_PREFERENCE_BASE_URL",
      CANONICAL_EMAIL_PREFERENCE_BASE_URL,
    );
    const links = createEmailPreferenceLinks(
      { kind: "recipient", id: RECIPIENT_HASH },
      {
        now: NOW,
        signingSecret: SIGNING_SECRET,
        baseUrl: "https://demo.openvpm.com",
      },
    );

    expect(links?.preferencesUrl).toMatch(
      /^https:\/\/app\.openvpm\.com\/email-preferences\?token=/,
    );
    expect(links?.oneClickUrl).toMatch(
      /^https:\/\/app\.openvpm\.com\/api\/email-preferences\/unsubscribe\?token=/,
    );
    expect(emailPreferenceBaseUrl()).toBe(CANONICAL_EMAIL_PREFERENCE_BASE_URL);
  });

  it("rejects non-HTTPS or non-origin preference base URLs", () => {
    expect(
      normalizeEmailPreferenceBaseUrl("http://app.openvpm.com"),
    ).toBeNull();
    expect(
      normalizeEmailPreferenceBaseUrl("https://app.openvpm.com/path"),
    ).toBeNull();
    expect(normalizeEmailPreferenceBaseUrl("https://app.openvpm.com")).toBe(
      CANONICAL_EMAIL_PREFERENCE_BASE_URL,
    );

    const links = createEmailPreferenceLinks(
      { kind: "recipient", id: RECIPIENT_HASH },
      {
        now: NOW,
        signingSecret: SIGNING_SECRET,
        baseUrl: "https://demo.openvpm.com",
      },
    );
    expect(links?.preferencesUrl).toMatch(
      /^https:\/\/demo\.openvpm\.com\/email-preferences\?token=/,
    );
  });

  it("rejects a noncanonical preference owner in hosted deployments", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("EMAIL_PREFERENCE_BASE_URL", "https://demo.openvpm.com");

    expect(emailPreferenceBaseUrl()).toBeNull();
    expect(
      createEmailPreferenceLinks(
        { kind: "recipient", id: RECIPIENT_HASH },
        { now: NOW, signingSecret: SIGNING_SECRET },
      ),
    ).toBeNull();
  });
});
