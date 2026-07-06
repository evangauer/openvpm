export type MessagingSetupMode = "host" | "buy";

export function defaultMessagingSetupMode(
  existingPhone: string | null | undefined
): MessagingSetupMode {
  return existingPhone?.trim() ? "host" : "buy";
}

export function setupModeTitle(mode: MessagingSetupMode): string {
  return mode === "host"
    ? "Text-enable your existing number"
    : "Get a new local number";
}
