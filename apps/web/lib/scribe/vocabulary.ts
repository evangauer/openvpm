import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { products } from "@openpims/db";
import type { Database } from "@openpims/db/client";

/**
 * Spelling hints for speech-to-text taken from the clinic's own product list,
 * so the drugs and preventives it actually stocks ("Simparica Trio",
 * "Otomax") come out spelled the way the clinic writes them. Product names
 * are not patient data. Hints only steer spelling; they never add words.
 */

export const SCRIBE_VOCABULARY_MAX_TERMS = 60;
export const SCRIBE_VOCABULARY_MAX_CHARACTERS = 400;
/** Enough rows to fill the hint after duplicates and sizes are dropped. */
const PRODUCT_SCAN_LIMIT = 300;

/**
 * The spoken part of a product name: "Simparica Trio (22.1-44 lbs, 6ct)"
 * becomes "Simparica Trio" and "Metacam 1.5mg/mL oral suspension" becomes
 * "Metacam". Returns null when nothing word-like is left.
 */
export function spokenProductName(name: string): string | null {
  const words: string[] = [];
  for (const word of name.replace(/[(—–,;/].*$/, "").split(/\s+/)) {
    if (!word || /^\d/.test(word)) break;
    words.push(word);
  }
  // A lone trailing letter is what is left of names like "Hill's i/d".
  while (words.length > 1 && words[words.length - 1]!.length < 2) words.pop();
  const term = words
    .join(" ")
    .replace(/[^\p{L}\p{N}' &+-]/gu, "")
    .replace(/[-\s]+$/, "")
    .trim();
  if (term.length < 3 || term.length > 40 || !/\p{L}{3}/u.test(term)) return null;
  return term;
}

/** Distinct spoken names, in order, within the hint's size limits. */
export function buildScribeVocabulary(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  let characters = 0;
  for (const name of names) {
    const term = spokenProductName(name);
    if (!term) continue;
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    if (characters + term.length + 2 > SCRIBE_VOCABULARY_MAX_CHARACTERS) break;
    seen.add(key);
    terms.push(term);
    characters += term.length + 2;
    if (terms.length >= SCRIBE_VOCABULARY_MAX_TERMS) break;
  }
  return terms;
}

/** The clinic's medicines and preventives first, then everything else. */
export async function loadScribeVocabulary(
  db: Database,
  practiceId: string,
): Promise<string[]> {
  const rows = await db
    .select({ name: products.name })
    .from(products)
    .where(and(eq(products.practiceId, practiceId), isNull(products.deletedAt)))
    .orderBy(
      sql`case when lower(coalesce(${products.category}, '')) similar to '%(medic|prevent|pharm|drug|vaccin|antibiot|parasit)%' then 0 else 1 end`,
      asc(products.name),
    )
    .limit(PRODUCT_SCAN_LIMIT);
  return buildScribeVocabulary(rows.map((row) => row.name));
}
