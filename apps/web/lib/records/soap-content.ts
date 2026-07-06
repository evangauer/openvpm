const HTML_TAG_RE = /<[^>]*>/g;
const WHITESPACE_RE = /\s+/g;

export const SOAP_SECTION_MAX_LENGTH = 10000;

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function decodeEntity(entity: string): string {
  const value = entity.slice(1, -1);
  if (value.startsWith("#x") || value.startsWith("#X")) {
    const codePoint = Number.parseInt(value.slice(2), 16);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : " ";
  }
  if (value.startsWith("#")) {
    const codePoint = Number.parseInt(value.slice(1), 10);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : " ";
  }
  return HTML_ENTITIES[value.toLowerCase()] ?? " ";
}

export function soapSectionText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(HTML_TAG_RE, " ")
    .replace(/&(?:amp|apos|gt|lt|nbsp|quot|#\d+|#x[a-f0-9]+);/gi, decodeEntity)
    .replace(WHITESPACE_RE, " ")
    .trim();
}

export function normalizeSoapSection(
  value: string | null | undefined
): string | undefined {
  if (!soapSectionText(value)) {
    return undefined;
  }
  return value?.trim();
}

export function hasSoapContent(sections: {
  subjective?: string | null;
  objective?: string | null;
  assessment?: string | null;
  plan?: string | null;
}): boolean {
  return [
    sections.subjective,
    sections.objective,
    sections.assessment,
    sections.plan,
  ].some((section) => Boolean(normalizeSoapSection(section)));
}
