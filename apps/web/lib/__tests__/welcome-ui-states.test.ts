import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("welcome surface UI states", () => {
  const providerSource = readFileSync(
    "components/welcome/welcome-provider.tsx",
    "utf8"
  );
  const surfaceSource = readFileSync(
    "components/welcome/welcome-surface.tsx",
    "utf8"
  );
  const cardSource = readFileSync(
    "components/welcome/polaroid-card.tsx",
    "utf8"
  );
  const aiVignetteSource = readFileSync(
    "components/welcome/vignettes/ai-vignette.tsx",
    "utf8"
  );
  const copySource = readFileSync(
    "components/welcome/welcome-copy.ts",
    "utf8"
  );
  const journeySource = readFileSync(
    "components/onboarding/journey-overlay.tsx",
    "utf8"
  );
  const firstRunSource = readFileSync("lib/welcome/first-run.ts", "utf8");
  const sidebarSource = readFileSync("components/layout/sidebar.tsx", "utf8");

  it("auto-opens under the same server gates the wizard used", () => {
    // Exactly one first-run surface fires per mode: the welcome checks the
    // identical three gates before greeting a new admin.
    expect(providerSource).toContain(
      "onboardingStatus.data.completedAt == null"
    );
    expect(providerSource).toContain(
      "onboardingState.data.journeyDismissed === true"
    );
    expect(providerSource).toContain(
      "onboardingStatus.data.establishedPractice === true"
    );
    expect(providerSource).toContain("enabled: isAdmin");
    // Invited staff never trigger the admin-only queries.
    expect(providerSource).toContain("enabled: authed");
  });

  it("hands first-run ownership between welcome and wizard via one flag", () => {
    expect(firstRunSource).toContain("NEXT_PUBLIC_FIRST_RUN_MODE");
    expect(journeySource).toContain(
      'if (firstRunMode() === "welcome") return;'
    );
    expect(providerSource).toContain("if (!welcomeMode) return;");
  });

  it("persists welcome-seen per user on this device", () => {
    expect(providerSource).toContain("readWelcomeState(userId)");
    expect(providerSource).toContain("markWelcomeSeen(userId)");
    // Deep link for reviews and screenshots, stripped after use.
    expect(providerSource).toContain('.get("guides") === "1"');
    expect(providerSource).toContain("router.replace(pathname)");
  });

  it("keeps the animated vignette accessible and cheap", () => {
    expect(aiVignetteSource).toContain("prefers-reduced-motion");
    expect(aiVignetteSource).toContain("IntersectionObserver");
    expect(aiVignetteSource).toContain("animation-play-state: paused");
    expect(aiVignetteSource).toContain("aria-label");
  });

  it("Polaroids tilt at rest and straighten for hover and keyboard focus", () => {
    expect(cardSource).toContain("rotate-[var(--tilt)]");
    expect(cardSource).toContain("hover:rotate-0");
    expect(cardSource).toContain("focus-visible:ring-2");
  });

  it("offers admins a setup escape hatch and staff a plain skip", () => {
    expect(surfaceSource).toContain("showSetupLink");
    expect(surfaceSource).toContain("onSetupInstead");
    expect(providerSource).toContain("openJourney()");
    // Guides moved out of the sidebar into Settings (founder decision):
    // the sidebar stays clean, Settings owns the manual re-entry point.
    expect(sidebarSource).not.toContain("nav-guides");
    const settingsSource = readFileSync(
      "app/(dashboard)/settings/page.tsx",
      "utf8"
    );
    expect(settingsSource).toContain('data-tour="settings-guides"');
    expect(settingsSource).toContain("onClick={openWelcome}");
  });

  it("keeps the copy deck in voice: no em or en dashes", () => {
    expect(copySource).not.toMatch(/[—–]/);
  });
});
