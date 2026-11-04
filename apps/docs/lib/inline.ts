/**
 * Parses the small inline markup used in guide text (see content/types.ts)
 * into tokens. Kept separate from rendering so search can index plain text
 * and tests can check links and callout references.
 */
export type InlineToken =
  | { kind: "text"; value: string }
  | { kind: "ui"; value: string }
  | { kind: "bold"; value: string }
  | { kind: "link"; value: string; href: string }
  | { kind: "ref"; value: number };

const PATTERN = /\[\[([^\]]+)\]\]|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|\(\((\d+)\)\)/g;

export function parseInline(source: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let last = 0;
  for (const match of source.matchAll(PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ kind: "text", value: source.slice(last, index) });
    const [, ui, bold, linkText, href, ref] = match;
    if (ui) tokens.push({ kind: "ui", value: ui });
    else if (bold) tokens.push({ kind: "bold", value: bold });
    else if (linkText && href) tokens.push({ kind: "link", value: linkText, href });
    else if (ref) tokens.push({ kind: "ref", value: Number(ref) });
    last = index + match[0].length;
  }
  if (last < source.length) tokens.push({ kind: "text", value: source.slice(last) });
  return tokens;
}

/** Plain words for search and page descriptions. */
export function plainText(source: string): string {
  return parseInline(source)
    .map((t) => (t.kind === "ref" ? "" : t.value))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}
