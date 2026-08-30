import { isPlatformAdmin } from "@/lib/platform-admin";

export type WebAuthnAdminPolicy = "disabled" | "migration" | "required";

export type WebAuthnConfiguration = {
  origins: string[];
  policy: WebAuthnAdminPolicy;
  rpID: string;
  rpName: string;
};

function validRpID(value: string): boolean {
  if (value === "localhost") return true;
  if (value.length > 253 || !value.includes(".")) return false;
  return value
    .split(".")
    .every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    );
}

function exactOrigin(value: string, rpID: string): string | null {
  try {
    const parsed = new URL(value);
    if (
      parsed.origin !== value ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    const local = parsed.hostname === "localhost";
    if (
      parsed.protocol !== "https:" &&
      !(local && parsed.protocol === "http:")
    ) {
      return null;
    }
    if (parsed.hostname !== rpID && !parsed.hostname.endsWith(`.${rpID}`)) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function webauthnAdminPolicy(): WebAuthnAdminPolicy {
  const value = process.env.WEBAUTHN_ADMIN_POLICY?.trim().toLowerCase();
  return value === "migration" || value === "required" ? value : "disabled";
}

export function webauthnConfiguration(): WebAuthnConfiguration | null {
  const rpID = process.env.WEBAUTHN_RP_ID?.trim().toLowerCase() ?? "";
  const rpName = process.env.WEBAUTHN_RP_NAME?.trim() ?? "OpenVPM";
  const rawOrigins = process.env.WEBAUTHN_ORIGINS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    !validRpID(rpID) ||
    rpName.length < 1 ||
    rpName.length > 64 ||
    !rawOrigins?.length ||
    rawOrigins.length > 10
  ) {
    return null;
  }
  const origins = rawOrigins.map((value) => exactOrigin(value, rpID));
  if (origins.some((value) => value === null)) return null;
  const uniqueOrigins = [...new Set(origins as string[])];
  if (uniqueOrigins.length !== origins.length) return null;
  return {
    origins: uniqueOrigins,
    policy: webauthnAdminPolicy(),
    rpID,
    rpName,
  };
}

export function passkeyRequiredForIdentity(input: {
  email?: string | null;
  role?: string | null;
}): boolean {
  return (
    webauthnAdminPolicy() === "required" &&
    (input.role === "admin" || isPlatformAdmin(input.email))
  );
}
