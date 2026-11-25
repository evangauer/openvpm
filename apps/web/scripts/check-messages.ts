import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCatalogs } from "../i18n/catalog-check";
import { SUPPORTED_LANGUAGES, type Language } from "../i18n/config";
import { isMessageTree, type MessageTree } from "../i18n/merge";

const messagesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../messages");
const catalogs: Partial<Record<Language, MessageTree>> = {};
let invalid = false;

for (const language of SUPPORTED_LANGUAGES) {
  const file = resolve(messagesDir, `${language}.json`);
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isMessageTree(parsed)) {
      console.error(`${language}: catalog must be a JSON object.`);
      invalid = true;
      continue;
    }
    catalogs[language] = parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Could not read catalog.";
    console.error(`${language}: invalid JSON (${detail}).`);
    invalid = true;
  }
}

if (invalid) process.exit(1);

const result = checkCatalogs(catalogs);
for (const coverage of result.coverage) {
  console.log(
    `${coverage.language}: ${coverage.missing} missing of ${coverage.total} (${coverage.percentMissing}% missing)`,
  );
}

for (const issue of result.errors) {
  const path = issue.path ? ` ${issue.path}` : "";
  console.error(`${issue.language}:${path} ${issue.message}`);
}

if (result.errors.length > 0) process.exit(1);
