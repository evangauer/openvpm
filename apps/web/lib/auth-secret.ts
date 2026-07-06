export function nextAuthSecret(): string | undefined {
  const trimmed = process.env.NEXTAUTH_SECRET?.trim();
  return trimmed ? trimmed : undefined;
}

export function hasBlankConfiguredNextAuthSecret(): boolean {
  const value = process.env.NEXTAUTH_SECRET;
  return value !== undefined && value.trim().length === 0;
}
