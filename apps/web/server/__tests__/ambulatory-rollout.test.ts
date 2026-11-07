import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  AMBULATORY_WORKSPACE_ENABLED_ENV,
  ambulatoryWorkspaceRolloutEnabled,
  effectiveAmbulatoryWorkspaceSettings,
} from "@/server/ambulatory-rollout";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ambulatory workspace rollout", () => {
  it("stays hard-dark unless the server flag is exactly true", () => {
    vi.stubEnv(AMBULATORY_WORKSPACE_ENABLED_ENV, "");
    expect(ambulatoryWorkspaceRolloutEnabled()).toBe(false);
    vi.stubEnv(AMBULATORY_WORKSPACE_ENABLED_ENV, "TRUE");
    expect(ambulatoryWorkspaceRolloutEnabled()).toBe(false);
    vi.stubEnv(AMBULATORY_WORKSPACE_ENABLED_ENV, "true");
    expect(ambulatoryWorkspaceRolloutEnabled()).toBe(true);
  });

  it("masks a previously enabled practice while the deployment is dark", () => {
    vi.stubEnv(AMBULATORY_WORKSPACE_ENABLED_ENV, "false");
    expect(
      effectiveAmbulatoryWorkspaceSettings({
        ambulatoryWorkspace: {
          enabled: true,
          measurementSystem: "us_customary",
          bodyConditionScale: 5,
          compactCloseout: false,
        },
      }),
    ).toEqual({
      enabled: false,
      measurementSystem: "us_customary",
      bodyConditionScale: 5,
      compactCloseout: false,
    });
  });

  it("lets the server advertise availability without exposing an enable control while dark", () => {
    const pageSource = readFileSync(
      new URL("../../app/(dashboard)/settings/page.tsx", import.meta.url),
      "utf8",
    );
    const cardSource = readFileSync(
      new URL(
        "../../components/settings/ambulatory-workspace-settings.tsx",
        import.meta.url,
      ),
      "utf8",
    );

    expect(pageSource).toContain(
      "practice.ambulatoryWorkspaceRolloutEnabled === true",
    );
    expect(cardSource).toContain("if (!rolloutEnabled) return null;");
  });
});
