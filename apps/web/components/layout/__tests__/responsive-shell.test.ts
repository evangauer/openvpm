import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("responsive dashboard shell", () => {
  it("uses a desktop-only sidebar plus a mobile navigation dialog", () => {
    const source = readFileSync("app/(dashboard)/layout.tsx", "utf8");

    expect(source).toContain('<Sidebar className="hidden lg:flex" />');
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain('aria-label="Main navigation"');
    expect(source).toContain('width="full"');
    expect(source).toContain('onNavigate={() => setMobileNavOpen(false)}');
  });

  it("keeps the mobile nav button accessible and phone-sized top bar controls compact", () => {
    const source = readFileSync("components/layout/top-bar.tsx", "utf8");

    expect(source).toContain('aria-label="Open navigation"');
    expect(source).toContain("lg:hidden");
    expect(source).toContain('aria-label="Open search"');
    // The search label and the shortcut hint stay hidden on phones; the
    // trigger only takes its comfortable search-bar width from sm up.
    expect(source).toContain('className="hidden sm:inline"');
    expect(source).toContain('className="ml-auto hidden');
    expect(source).toContain("sm:w-64");
  });

  it("keeps top bar labels and quick-create actions aligned with app roles", () => {
    const source = readFileSync("components/layout/top-bar.tsx", "utf8");

    expect(source).toContain('"/agent": "Agent"');
    expect(source).toContain('"/controlled-substances": "Controlled Substances"');
    expect(source).toContain("useSession()");
    expect(source).toContain("availableNewActions");
    expect(source).toContain(
      'roles: ["admin", "veterinarian", "front_desk"]'
    );
    expect(source).toContain('roles: ["admin", "front_desk"]');
    expect(source).toContain("availableNewActions.length > 0");
    expect(source).toContain("availableNewActions.map");
  });

  it("allows the sidebar to render full width inside the mobile drawer without collapse controls", () => {
    const source = readFileSync("components/layout/sidebar.tsx", "utf8");

    expect(source).toContain('width?: "fixed" | "full"');
    expect(source).toContain('width === "full" ? "w-full"');
    expect(source).toContain("{collapsible && (");
    expect(source).toContain("onClick={onNavigate}");
  });

  it("does not default the sidebar to a writable staff role before session resolution", () => {
    const source = readFileSync("components/layout/sidebar.tsx", "utf8");

    expect(source).toContain("function isUserRole(role?: string | null): role is UserRole");
    expect(source).toContain("const { data: session, status } = useSession()");
    expect(source).toContain(
      "const role = isUserRole(session?.user?.role) ? session.user.role : undefined"
    );
    expect(source).toContain(
      'const canShowNav = status === "authenticated" && role !== undefined'
    );
    expect(source).toContain("const visibleNavItems = canShowNav");
    expect(source).not.toContain('?? "front_desk"');
  });

  it("shows a live inbox unread badge without querying before nav access is known", () => {
    const source = readFileSync("components/layout/sidebar.tsx", "utf8");

    expect(source).toContain(
      "trpc.communications.listConversations.useQuery"
    );
    expect(source).toContain('{ inboxFilter: "unread", limit: 1, offset: 0 }');
    expect(source).toContain("enabled: canShowNav");
    expect(source).toContain("refetchInterval: 30000");
    expect(source).toContain("const unreadInboxCount =");
    expect(source).toContain('item.href === "/inbox"');
    expect(source).toContain("unreadInboxCount > 0");
    expect(source).toContain("unreadInboxLabel");
    expect(source).toContain("unread inbox conversations");
  });

  it("offers explicit all-device session revocation with confirmation", () => {
    const source = readFileSync("components/layout/sidebar.tsx", "utf8");

    expect(source).toContain("trpc.auth.revokeAllSessions.useMutation");
    expect(source).toContain('aria-label="Sign out everywhere"');
    expect(source).toContain('title="Sign out everywhere?"');
    expect(source).toContain("<ActionConfirmationDialog");
    expect(source).toContain('await signOut({ callbackUrl: "/login" })');
  });
});
