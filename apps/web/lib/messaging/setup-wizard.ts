export type MessagingSetupMode = "host" | "buy";

export function defaultMessagingSetupMode(
  _existingPhone: string | null | undefined
): MessagingSetupMode {
  return "buy";
}

export function setupModeTitle(mode: MessagingSetupMode): string {
  return mode === "host"
    ? "Existing-number texting is not available"
    : "Get a new local number";
}
