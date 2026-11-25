import {
  canonicalLanguage,
  DEFAULT_LANGUAGE,
  type Language,
} from "./config";

export type LanguageSource = {
  cookie?: string | null;
  acceptLanguage?: string | null;
};

/**
 * Cookie, then the best Accept-Language match, then English.
 * `es-*` maps to Latin American Spanish and `it-*` maps to Italian.
 * An unsupported cookie is ignored so the header can still match.
 */
export function resolveLanguage(source: LanguageSource = {}): Language {
  const fromCookie = canonicalLanguage(source.cookie);
  if (fromCookie) return fromCookie;

  for (const tag of acceptLanguageTags(source.acceptLanguage)) {
    const match = matchSupportedLanguage(tag);
    if (match) return match;
  }

  return DEFAULT_LANGUAGE;
}

function acceptLanguageTags(header: string | null | undefined): string[] {
  if (!header) return [];

  const ranges: { tag: string; q: number; index: number }[] = [];
  header.split(",").forEach((part, index) => {
    const [rawTag, ...params] = part.trim().split(";");
    const tag = rawTag?.trim();
    if (!tag) return;

    let q = 1;
    for (const param of params) {
      const [name, value] = param.trim().split("=");
      if (name?.trim().toLowerCase() !== "q") continue;
      const parsed = Number(value);
      if (Number.isFinite(parsed)) q = parsed;
    }
    if (q > 0) ranges.push({ tag, q, index });
  });

  ranges.sort((a, b) => b.q - a.q || a.index - b.index);
  return ranges.map((range) => range.tag);
}

function matchSupportedLanguage(tag: string): Language | null {
  const normalized = tag.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized || normalized === "*") return null;

  const exact = canonicalLanguage(normalized);
  if (exact) return exact;

  const primary = normalized.split("-")[0];
  if (primary === "es") return "es-419";
  if (primary === "it") return "it";
  if (primary === "en") return "en";
  return null;
}
