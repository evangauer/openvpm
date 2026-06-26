import { createPublicKey, verify } from "node:crypto";

const SIGNATURE_TOLERANCE_SECONDS = 600;

/** Build a Node public key from Telnyx's base64 raw Ed25519 key (wrap in SPKI). */
function ed25519PublicKey(b64: string) {
  const der = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"), // Ed25519 SPKI prefix
    Buffer.from(b64, "base64"),
  ]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

/**
 * Verify a Telnyx webhook signature. Telnyx signs `${timestamp}|${rawBody}` with
 * Ed25519; the signature is in the `telnyx-signature-ed25519` header (base64) and
 * the unix timestamp in `telnyx-timestamp`. Rejects stale timestamps (replay).
 */
export function verifyTelnyxSignature(opts: {
  rawBody: string;
  signatureB64: string;
  timestamp: string;
  publicKeyB64: string;
  nowMs?: number;
  toleranceSeconds?: number;
}): boolean {
  try {
    const ts = Number(opts.timestamp);
    if (!Number.isFinite(ts)) return false;
    const now = opts.nowMs ?? Date.now();
    const tolerance = opts.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
    if (Math.abs(now / 1000 - ts) > tolerance) return false;
    const msg = Buffer.from(`${opts.timestamp}|${opts.rawBody}`, "utf8");
    return verify(
      null,
      msg,
      ed25519PublicKey(opts.publicKeyB64),
      Buffer.from(opts.signatureB64, "base64")
    );
  } catch {
    return false;
  }
}
