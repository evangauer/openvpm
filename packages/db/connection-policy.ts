/**
 * Detect transaction-pooler URLs without substring matching attacker-
 * controlled credentials, paths, or query values.
 */
export function isPooledDatabaseConnection(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const supabasePooler =
      hostname === "pooler.supabase.com" ||
      hostname.endsWith(".pooler.supabase.com");
    return (
      supabasePooler ||
      url.port === "6543" ||
      url.searchParams.get("pgbouncer")?.toLowerCase() === "true"
    );
  } catch {
    return false;
  }
}
