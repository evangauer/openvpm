import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { DemoRoleSwitcherView } from "@/components/demo/demo-role-switcher";
import {
  DEMO_ROLE_OPTIONS,
  addDemoRoleSwitchMarker,
  canPreserveDemoPath,
  demoRoleDestination,
  requestDemoRoleSwitch,
  shouldShowDemoRoleSwitcher,
  stripDemoRoleSwitchMarker,
} from "@/lib/demo-role-switcher";

describe("post-gate demo role switcher", () => {
  it("offers every seeded clinic role with a human-readable label", () => {
    expect(DEMO_ROLE_OPTIONS).toEqual([
      { value: "admin", label: "Practice Admin" },
      { value: "veterinarian", label: "Veterinarian" },
      { value: "technician", label: "Technician" },
      { value: "front_desk", label: "Front Desk" },
    ]);
  });

  it("is fail-closed outside an authenticated demo-role session", () => {
    expect(shouldShowDemoRoleSwitcher(false, "authenticated", "admin")).toBe(
      false,
    );
    expect(shouldShowDemoRoleSwitcher(true, "loading", "admin")).toBe(false);
    expect(
      shouldShowDemoRoleSwitcher(true, "unauthenticated", "admin"),
    ).toBe(false);
    expect(shouldShowDemoRoleSwitcher(true, "authenticated", "viewer")).toBe(
      false,
    );
    expect(
      shouldShowDemoRoleSwitcher(true, "authenticated", "veterinarian"),
    ).toBe(true);
  });

  it("uses only the existing demo provider and treats every uncertain result as failure", async () => {
    const signInDemo = vi.fn(async () => ({ ok: true, error: null }));

    await expect(
      requestDemoRoleSwitch("technician", signInDemo),
    ).resolves.toBe(true);
    expect(signInDemo).toHaveBeenCalledWith("demo", {
      role: "technician",
      redirect: false,
    });

    await expect(
      requestDemoRoleSwitch("admin", async () => ({
        ok: false,
        error: "CredentialsSignin",
      })),
    ).resolves.toBe(false);
    await expect(
      requestDemoRoleSwitch("admin", async () => undefined),
    ).resolves.toBe(false);
    await expect(
      requestDemoRoleSwitch("admin", async () => {
        throw new Error("network down");
      }),
    ).resolves.toBe(false);
  });

  it("preserves a safe current route and falls back to the dashboard after privilege changes", () => {
    expect(canPreserveDemoPath("technician", "/patients/abc")).toBe(true);
    expect(canPreserveDemoPath("veterinarian", "/records/new-soap/abc")).toBe(
      true,
    );
    expect(canPreserveDemoPath("front_desk", "/settings")).toBe(false);
    expect(canPreserveDemoPath("technician", "/billing/new")).toBe(false);
    expect(canPreserveDemoPath("admin", "/admin")).toBe(false);
    expect(
      demoRoleDestination(
        "veterinarian",
        "/encounters/abc",
        "/encounters/abc?tab=soap#draft",
      ),
    ).toBe("/encounters/abc?tab=soap#draft");
    expect(
      demoRoleDestination("front_desk", "/settings", "/settings?tab=staff"),
    ).toBe("/");
    expect(
      demoRoleDestination("admin", "/patients", "//outside.example/path"),
    ).toBe("/");
  });

  it("marks role-switch landings and strips only the one-time marker", () => {
    expect(
      addDemoRoleSwitchMarker("/encounters/abc?tab=soap#draft"),
    ).toBe("/encounters/abc?tab=soap&demo_role_switch=1#draft");
    expect(addDemoRoleSwitchMarker("https://outside.example/path")).toBe("/");

    expect(
      stripDemoRoleSwitchMarker(
        "/encounters/abc?tab=soap&demo_role_switch=1#draft",
      ),
    ).toEqual({
      hadMarker: true,
      path: "/encounters/abc?tab=soap#draft",
    });
    expect(stripDemoRoleSwitchMarker("/encounters/abc?tab=soap")).toEqual({
      hadMarker: false,
      path: "/encounters/abc?tab=soap",
    });
  });

  it("shows the current role and disables switching while a role change is pending", () => {
    const currentMarkup = renderToStaticMarkup(
      createElement(DemoRoleSwitcherView, {
        currentRole: "front_desk",
        pendingRole: null,
        error: null,
        onRoleChange: vi.fn(),
      }),
    );
    expect(currentMarkup).toContain("Explore as");
    expect(currentMarkup).toContain("Current role: Front Desk");
    expect(currentMarkup).toContain("Viewing demo as Front Desk");
    expect(currentMarkup).toContain('value="front_desk" selected=""');
    expect(currentMarkup).not.toContain(' disabled=""');

    const pendingMarkup = renderToStaticMarkup(
      createElement(DemoRoleSwitcherView, {
        currentRole: "admin",
        pendingRole: "technician",
        error: null,
        onRoleChange: vi.fn(),
      }),
    );
    expect(pendingMarkup).toContain(' disabled=""');
    expect(pendingMarkup).toContain("Switching to Technician");
    expect(pendingMarkup).toContain("animate-spin");
  });

  it("surfaces role-switch failures without touching the pre-gate flow or funnel", () => {
    const failureMarkup = renderToStaticMarkup(
      createElement(DemoRoleSwitcherView, {
        currentRole: "admin",
        pendingRole: null,
        error: "Your current role is unchanged.",
        onRoleChange: vi.fn(),
      }),
    );
    expect(failureMarkup).toContain('role="alert"');
    expect(failureMarkup).toContain("Your current role is unchanged.");

    const componentSource = readFileSync(
      "components/demo/demo-role-switcher.tsx",
      "utf8",
    );
    const barSource = readFileSync(
      "components/demo/demo-conversion-bar.tsx",
      "utf8",
    );
    const loginSource = readFileSync("app/(auth)/login/page.tsx", "utf8");
    const welcomeSource = readFileSync(
      "components/welcome/welcome-provider.tsx",
      "utf8",
    );

    expect(componentSource).toContain("NEXT_PUBLIC_DEMO_MODE");
    expect(componentSource).toContain("signIn(provider, options)");
    expect(componentSource).toContain(
      "window.location.assign(addDemoRoleSwitchMarker(destination))",
    );
    expect(componentSource).not.toContain("/api/demo-access");
    expect(componentSource).not.toContain("trackFunnelEvent");
    expect(componentSource).not.toContain("FUNNEL_EVENTS");
    expect(barSource).toContain("<DemoRoleSwitcher />");
    expect(loginSource).not.toContain("DemoRoleSwitcher");
    expect(welcomeSource).toContain("stripDemoRoleSwitchMarker");
    expect(welcomeSource).toContain("autoDecided.current = true");
  });
});
