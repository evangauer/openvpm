export interface SearchEntry {
  href: string;
  title: string;
  summary: string;
  /** Where the result sits, e.g. "Front desk" or "Screen". */
  section: string;
  keywords: string[];
  body: string;
}

export interface SearchHit {
  entry: SearchEntry;
  score: number;
}

/** Lowercase words with simple plurals and verb endings folded together. */
export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 || /\d/.test(w))
    .map(stem);
}

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

const STOP = new Set(["a", "an", "the", "to", "do", "i", "how", "can", "my", "of", "for", "in", "on", "and", "or", "is", "it"].map(stem));

interface Indexed {
  entry: SearchEntry;
  title: Set<string>;
  titleText: string;
  keywords: Set<string>;
  summary: Set<string>;
  body: Set<string>;
}

export function buildIndex(entries: SearchEntry[]): Indexed[] {
  return entries.map((entry) => ({
    entry,
    title: new Set(terms(entry.title)),
    titleText: entry.title.toLowerCase(),
    keywords: new Set(entry.keywords.flatMap(terms)),
    summary: new Set(terms(entry.summary)),
    body: new Set(terms(entry.body)),
  }));
}

function has(set: Set<string>, term: string): "exact" | "prefix" | null {
  if (set.has(term)) return "exact";
  if (term.length >= 3) for (const word of set) if (word.startsWith(term)) return "prefix";
  return null;
}

export function search(index: Indexed[], query: string, limit = 8): SearchHit[] {
  const q = terms(query).filter((t) => !STOP.has(t));
  if (!q.length) return [];
  const phrase = query.trim().toLowerCase();

  const hits: SearchHit[] = [];
  for (const item of index) {
    let score = 0;
    let matched = 0;
    for (const term of q) {
      const t = has(item.title, term);
      const k = has(item.keywords, term);
      const s = has(item.summary, term);
      const b = has(item.body, term);
      const best = (t === "exact" ? 40 : t ? 28 : 0) || (k === "exact" ? 30 : k ? 20 : 0) || (s ? 12 : 0) || (b ? 4 : 0);
      if (best) matched++;
      score += best;
    }
    if (!matched) continue;
    // Every word should match somewhere; partial matches rank well below.
    if (matched < q.length) score *= 0.35;
    if (item.titleText.includes(phrase)) score += 50;
    if (item.entry.section === "Screen") score *= 0.9;
    hits.push({ entry: item.entry, score });
  }
  return hits.sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title)).slice(0, limit);
}
