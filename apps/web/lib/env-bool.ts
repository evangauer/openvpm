export function envFlagEnabled(name: string): boolean {
  return process.env[name]?.trim() === "true";
}
