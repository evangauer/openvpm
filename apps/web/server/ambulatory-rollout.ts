import { envFlagEnabled } from "@/lib/env-bool";
import {
  ambulatoryWorkspaceSettings,
  type AmbulatoryWorkspaceSettings,
} from "@/lib/ambulatory-workspace";

export const AMBULATORY_WORKSPACE_ENABLED_ENV = "AMBULATORY_WORKSPACE_ENABLED";

/**
 * Platform kill switch for the ambulatory workspace. The practice setting is
 * a second gate; no stored tenant value can open the workflow while this
 * deployment-level switch is absent, malformed, or false.
 */
export function ambulatoryWorkspaceRolloutEnabled(): boolean {
  return envFlagEnabled(AMBULATORY_WORKSPACE_ENABLED_ENV);
}

export function effectiveAmbulatoryWorkspaceSettings(
  practiceSettings: unknown,
): AmbulatoryWorkspaceSettings {
  const settings = ambulatoryWorkspaceSettings(practiceSettings);
  return ambulatoryWorkspaceRolloutEnabled()
    ? settings
    : { ...settings, enabled: false };
}
