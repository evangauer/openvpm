export const COMMUNICATION_SUBJECT_MAX_LENGTH = 255;
export const COMMUNICATION_CONTENT_MAX_LENGTH = 5000;
export const SMS_COMMUNICATION_CONTENT_MAX_LENGTH = 1600;

export type CommunicationComposeChannel = "sms" | "email" | "portal";

export function communicationContentMaxLength(
  channel: CommunicationComposeChannel
): number {
  return channel === "sms"
    ? SMS_COMMUNICATION_CONTENT_MAX_LENGTH
    : COMMUNICATION_CONTENT_MAX_LENGTH;
}

export function isCommunicationSubjectValid(value: string): boolean {
  return value.trim().length <= COMMUNICATION_SUBJECT_MAX_LENGTH;
}

export function isCommunicationContentValid(
  value: string,
  channel: CommunicationComposeChannel
): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= communicationContentMaxLength(channel)
  );
}
