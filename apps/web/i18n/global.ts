import messages from "../messages/en.json";
import type { Language } from "./config";

declare module "next-intl" {
  interface AppConfig {
    Locale: Language;
    Messages: typeof messages;
  }
}
