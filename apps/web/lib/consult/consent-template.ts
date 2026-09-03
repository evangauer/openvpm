/**
 * Default consent copy for the e-sign dispatch modal. Staff can edit the
 * title and body before sending; whatever is sent gets snapshotted onto the
 * consent request so later edits never change what someone already signed.
 * Voice: plain and warm, fourth-grade reading level, no em dashes.
 */

export const CONSENT_TITLE_MAX_LENGTH = 200;
export const CONSENT_BODY_MAX_LENGTH = 8_000;
export const CONSENT_SIGNER_NAME_MAX_LENGTH = 120;

export const CONSENT_SIGNER_AUTHORITY_ATTESTATION =
  "I confirm that I am this pet's owner or an agent authorized by the owner to make care decisions and sign this record.";

export const CONSENT_ELECTRONIC_SIGNATURE_INTENT =
  "By selecting Agree and sign, I intend to sign this record electronically.";

export const CONSENT_SIGNER_ATTESTATION_VERSION = "owner-authority-v1";

/**
 * Consent templates intentionally ship with fill-in prompts. They are useful
 * while drafting, but a capability link must never be minted while a material
 * choice, amount, contact, procedure, or destination is still blank.
 */
const HIGH_RISK_PLACEHOLDER_PATTERNS = [
  /_{3,}/,
  /\{\{[^}\n]+\}\}/,
  /\$\{[^}\n]+\}/,
  /\[(?:insert|enter|fill in|choose|select)[^\]\n]*\]/i,
  /\bstaff\s*:\s*(?:fill|circle|choose|select|complete)\b/i,
] as const;

export function hasUnresolvedConsentPlaceholders(value: string): boolean {
  return HIGH_RISK_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value));
}

export const DEFAULT_CONSENT_TITLE = "Consent to treatment";

export const DEFAULT_CONSENT_BODY = [
  "I am the owner of this pet, or I am allowed to make decisions for this pet.",
  "",
  "I give this clinic permission to examine and treat my pet. The team has told me what they plan to do and why. I understand that medicine has risks, and that no outcome is promised.",
  "",
  "I understand I can ask questions at any time. If plans need to change during care, the team will contact me first unless it is an emergency.",
  "",
  "I agree to pay for the care my pet receives.",
].join("\n");
