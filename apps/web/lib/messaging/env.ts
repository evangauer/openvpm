import type { MessagingSender } from "./types";

export function nonBlank(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function envValue(name: string): string | undefined {
  return nonBlank(process.env[name]);
}

export function cleanSender(sender: MessagingSender): MessagingSender {
  return {
    messagingServiceId: nonBlank(sender.messagingServiceId),
    from: nonBlank(sender.from),
  };
}
