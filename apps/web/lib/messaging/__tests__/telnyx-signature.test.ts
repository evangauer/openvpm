import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyTelnyxSignature } from "../telnyx-signature";

// Generate an Ed25519 keypair and expose the public key the way Telnyx does:
// a base64-encoded raw 32-byte key (the tail of the DER SPKI encoding).
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const spki = publicKey.export({ format: "der", type: "spki" });
const publicKeyB64 = spki.subarray(spki.length - 32).toString("base64");

function signPayload(timestamp: string, rawBody: string): string {
  return sign(null, Buffer.from(`${timestamp}|${rawBody}`, "utf8"), privateKey).toString(
    "base64"
  );
}

describe("verifyTelnyxSignature", () => {
  const nowMs = 1_770_000_000_000; // fixed clock
  const timestamp = String(Math.floor(nowMs / 1000));
  const body = JSON.stringify({ data: { event_type: "message.received" } });

  it("accepts a valid signature", () => {
    expect(
      verifyTelnyxSignature({
        rawBody: body,
        signatureB64: signPayload(timestamp, body),
        timestamp,
        publicKeyB64,
        nowMs,
      })
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(
      verifyTelnyxSignature({
        rawBody: body + "x",
        signatureB64: signPayload(timestamp, body),
        timestamp,
        publicKeyB64,
        nowMs,
      })
    ).toBe(false);
  });

  it("rejects a stale timestamp (replay)", () => {
    const oldTs = String(Math.floor(nowMs / 1000) - 1000); // > tolerance
    expect(
      verifyTelnyxSignature({
        rawBody: body,
        signatureB64: signPayload(oldTs, body),
        timestamp: oldTs,
        publicKeyB64,
        nowMs,
      })
    ).toBe(false);
  });

  it("rejects a garbage signature", () => {
    expect(
      verifyTelnyxSignature({
        rawBody: body,
        signatureB64: "not-a-valid-signature",
        timestamp,
        publicKeyB64,
        nowMs,
      })
    ).toBe(false);
  });
});
