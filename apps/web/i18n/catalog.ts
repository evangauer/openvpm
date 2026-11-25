import en from "../messages/en.json";
import es419 from "../messages/es-419.json";
import it from "../messages/it.json";
import { DEFAULT_LANGUAGE, type Language } from "./config";
import { deepMergeMessages, type MessageTree } from "./merge";

const CATALOGS: Record<Language, MessageTree> = {
  en,
  "es-419": es419,
  it,
};

/** English under the target catalog, so a missing translation still renders. */
export function messagesFor(
  language: Language,
  onMissing?: (path: string) => void,
): MessageTree {
  if (language === DEFAULT_LANGUAGE) return CATALOGS.en;
  return deepMergeMessages(CATALOGS.en, CATALOGS[language], onMissing);
}

export function englishMessages(): MessageTree {
  return CATALOGS.en;
}
