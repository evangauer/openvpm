import { IntlMessageFormat } from "intl-messageformat";
import { SUPPORTED_LANGUAGES, type Language } from "./config";
import { isMessageTree, type MessageTree } from "./merge";

export type CatalogIssue = {
  language: string;
  path: string;
  message: string;
};

export type CatalogCoverage = {
  language: Language;
  total: number;
  missing: number;
  percentMissing: number;
};

export type CatalogCheck = {
  errors: CatalogIssue[];
  coverage: CatalogCoverage[];
};

const PLACEHOLDER_TYPES = new Set([1, 2, 3, 4, 5, 6, 8]);

type AstNode = {
  type: number;
  value?: string | AstNode[];
  children?: AstNode[];
  options?: Record<string, { value: AstNode[] }>;
};

/**
 * Fails on orphan keys, invalid ICU, and placeholder mismatches.
 * Missing translations are reported as coverage and do not fail the check.
 */
export function checkCatalogs(
  catalogs: Partial<Record<Language, MessageTree>>,
): CatalogCheck {
  const english = catalogs.en;
  const errors: CatalogIssue[] = [];
  if (!english) {
    errors.push({
      language: "en",
      path: "",
      message: "English catalog is missing.",
    });
    return { errors, coverage: [] };
  }

  const englishLeaves = collectLeaves(english);
  for (const [path, message] of englishLeaves) {
    const parsed = parseIcu(message, "en");
    if (typeof parsed === "string") {
      errors.push({ language: "en", path, message: parsed });
    }
  }

  const coverage: CatalogCoverage[] = [];
  for (const language of SUPPORTED_LANGUAGES) {
    if (language === "en") continue;
    const catalog = catalogs[language];
    if (!catalog) {
      errors.push({
        language,
        path: "",
        message: "Catalog file is missing or not an object.",
      });
      continue;
    }

    const leaves = collectLeaves(catalog);
    let missing = 0;
    for (const path of englishLeaves.keys()) {
      const translated = leaves.get(path);
      if (translated === undefined || translated.trim() === "") missing += 1;
    }
    const total = englishLeaves.size;
    coverage.push({
      language,
      total,
      missing,
      percentMissing: total === 0 ? 0 : Math.round((missing / total) * 100),
    });

    for (const [path, message] of leaves) {
      const source = englishLeaves.get(path);
      if (source === undefined) {
        errors.push({
          language,
          path,
          message: "Orphan key. It does not exist in en.json.",
        });
        continue;
      }

      const parsed = parseIcu(message, language);
      if (typeof parsed === "string") {
        errors.push({ language, path, message: parsed });
        continue;
      }

      const sourceNames = placeholderNames(source, "en");
      const translatedNames = placeholderNames(message, language);
      if (!sameNames(sourceNames, translatedNames)) {
        errors.push({
          language,
          path,
          message: `Placeholder mismatch. English has {${[...sourceNames].sort().join(", ")}}, ${language} has {${[...translatedNames].sort().join(", ")}}.`,
        });
      }
    }
  }

  return { errors, coverage };
}

export function collectLeaves(
  tree: MessageTree,
  prefix = "",
): Map<string, string> {
  const leaves = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      leaves.set(path, value);
    } else if (isMessageTree(value)) {
      for (const [childPath, childValue] of collectLeaves(value, path)) {
        leaves.set(childPath, childValue);
      }
    }
  }
  return leaves;
}

function parseIcu(message: string, locale: string): Set<string> | string {
  try {
    const ast = new IntlMessageFormat(message, locale).getAst() as AstNode[];
    return collectPlaceholders(ast);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Invalid ICU message.";
    return `Invalid ICU message: ${detail}`;
  }
}

function placeholderNames(message: string, locale: string): Set<string> {
  const parsed = parseIcu(message, locale);
  return parsed instanceof Set ? parsed : new Set();
}

function collectPlaceholders(nodes: readonly AstNode[]): Set<string> {
  const names = new Set<string>();
  function visit(list: readonly AstNode[]) {
    for (const node of list) {
      if (PLACEHOLDER_TYPES.has(node.type) && typeof node.value === "string") {
        names.add(node.value);
      }
      if (Array.isArray(node.value)) visit(node.value);
      if (node.children) visit(node.children);
      if (node.options) {
        for (const option of Object.values(node.options)) visit(option.value);
      }
    }
  }
  visit(nodes);
  return names;
}

function sameNames(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const name of left) {
    if (!right.has(name)) return false;
  }
  return true;
}
