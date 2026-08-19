const DEFAULT_EMAIL_FROM = "OpenVPM <noreply@mail.openvpm.com>";
const DEFAULT_EMAIL_FROM_ADDRESS = "noreply@mail.openvpm.com";

export function nonBlankEmailValue(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function emailEnv(name: string): string | undefined {
  return nonBlankEmailValue(process.env[name]);
}

export function defaultEmailFrom(override?: string | null): string {
  return (
    nonBlankEmailValue(override) ?? emailEnv("EMAIL_FROM") ?? DEFAULT_EMAIL_FROM
  );
}

export function clinicEmailFrom(practiceName: string): string {
  const configured = defaultEmailFrom();
  const bracketedAddress = configured.match(/<([^<>]+)>\s*$/)?.[1]?.trim();
  const plainAddress = /^[^\s<>@]+@[^\s<>@]+$/.test(configured.trim())
    ? configured.trim()
    : undefined;
  const address =
    bracketedAddress ?? plainAddress ?? DEFAULT_EMAIL_FROM_ADDRESS;
  const safeName = practiceName
    .replace(/[\r\n"]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return `"${safeName || "Your clinic"} via OpenVPM" <${address}>`;
}

export function emailDemoMode(): boolean {
  return emailEnv("NEXT_PUBLIC_DEMO_MODE") === "true";
}
