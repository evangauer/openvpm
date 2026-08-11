import { envFlagEnabled } from "@/lib/env-bool";
import { envValue } from "@/lib/messaging/env";

function commaSeparatedValues(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function exactUuidScope(values: string[]): boolean {
  return values.length === 1 && isUuid(values[0]!);
}

function isBase64EncodedBytes(
  value: string | undefined,
  bytes: number,
): boolean {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    return Buffer.from(value, "base64").length === bytes;
  } catch {
    return false;
  }
}

/** Secret-free platform diagnostics safe for the protected operator console. */
export function hostedSmsConfigurationDiagnostics() {
  const provisioningPracticeIds = commaSeparatedValues(
    "MESSAGING_PROVISIONING_PRACTICE_IDS",
  );
  const sendingPracticeIds = commaSeparatedValues(
    "MESSAGING_SENDING_PRACTICE_IDS",
  );
  const sendingLocationIds = commaSeparatedValues(
    "MESSAGING_SENDING_LOCATION_IDS",
  );
  const provisioningEnabled = envFlagEnabled("MESSAGING_PROVISIONING_ENABLED");
  const sendingEnabled = envFlagEnabled("MESSAGING_SENDING_ENABLED");
  const inboundEnabled = envFlagEnabled("MESSAGING_INBOUND_ENABLED");

  return {
    providerIsTelnyx:
      envValue("MESSAGING_PROVIDER")?.toLowerCase() === "telnyx",
    apiKeyShapeValid:
      Boolean(envValue("TELNYX_API_KEY")?.startsWith("KEY_")) &&
      (envValue("TELNYX_API_KEY")?.length ?? 0) >= 20,
    webhookPublicKeyShapeValid: isBase64EncodedBytes(
      envValue("TELNYX_PUBLIC_KEY"),
      32,
    ),
    registrationEncryptionKeyShapeValid: isBase64EncodedBytes(
      envValue("MESSAGING_REGISTRATION_ENCRYPTION_KEY"),
      32,
    ),
    provisioningEnabled,
    sendingEnabled,
    inboundEnabled,
    provisioningPracticeScopeCount: provisioningPracticeIds.length,
    sendingPracticeScopeCount: sendingPracticeIds.length,
    sendingLocationScopeCount: sendingLocationIds.length,
    provisioningScopeExact: exactUuidScope(provisioningPracticeIds),
    sendingScopeExact:
      exactUuidScope(sendingPracticeIds) && exactUuidScope(sendingLocationIds),
    rolloutIntended:
      provisioningEnabled ||
      sendingEnabled ||
      inboundEnabled ||
      provisioningPracticeIds.length > 0 ||
      sendingPracticeIds.length > 0 ||
      sendingLocationIds.length > 0,
  };
}

export function hostedSmsCredentialIssueCount(): number {
  const status = hostedSmsConfigurationDiagnostics();
  return [
    status.apiKeyShapeValid,
    status.webhookPublicKeyShapeValid,
    status.registrationEncryptionKeyShapeValid,
  ].filter((valid) => !valid).length;
}
