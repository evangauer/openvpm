import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("command search UI", () => {
  const source = readFileSync("components/common/command-search.tsx", "utf8");

  it("keeps navigation and quick actions role-aware", () => {
    expect(source).toContain('import { useSession } from "next-auth/react"');
    expect(source).toContain("function isUserRole(role?: string | null): role is UserRole");
    expect(source).toContain("const { data: session, status } = useSession()");
    expect(source).toContain(
      "const role = isUserRole(session?.user?.role) ? session.user.role : undefined"
    );
    expect(source).toContain(
      'status === "authenticated" && role !== undefined'
    );
    expect(source).toContain(
      "{ label: \"Settings\", href: \"/settings\", Icon: Settings, roles: [\"admin\"] }"
    );
    expect(source).toContain("const quickActionItems: CommandItemConfig[] =");
    expect(source).toContain(
      'roles: ["admin", "veterinarian", "technician", "front_desk"]'
    );
    expect(source).toContain('roles: ["admin", "front_desk"]');
    expect(source).toContain("const visibleNavigationItems =");
    expect(source).toContain("const visibleQuickActionItems =");
    expect(source).toContain("visibleNavigationItems.length > 0");
    expect(source).toContain("visibleQuickActionItems.length > 0");
    expect(source).toContain("visibleNavigationItems.map");
    expect(source).toContain("visibleQuickActionItems.map");
    expect(source).not.toContain("Quick actions always visible");
  });

  it("surfaces live search failures before showing no-results copy", () => {
    expect(source).toContain("const canUseCommandSearch =");
    expect(source).toContain(
      "{ enabled: open && hasQuery && canUseCommandSearch }"
    );
    expect(source).toContain("const checkingSearchAccess =");
    expect(source).toContain("const searchUnavailable =");
    expect(source).toContain("canUseCommandSearch");
    expect(source).toContain("Boolean(patients.error)");
    expect(source).toContain("Boolean(clients.error)");
    expect(source).toContain("!patients.data");
    expect(source).toContain("!clients.data");
    expect(source).toContain("const searchAccessUnavailable =");
    expect(source).toContain("Unable to confirm search access");
    expect(source).toContain("Unable to load search results");
    expect(source).toContain("Retry before deciding this client or patient is missing.");
    expect(source).toContain("void patients.refetch();");
    expect(source).toContain("void clients.refetch();");
    expect(source).toContain("Retry search");
    expect(source.indexOf("{searchUnavailable && (")).toBeLessThan(
      source.indexOf("No patients or clients found.")
    );
    expect(source).toContain(
      "!searchAccessUnavailable &&\n              !searchUnavailable"
    );
    expect(source).toContain(
      "{hasQuery && !searchUnavailable && patientResults.length > 0 && ("
    );
    expect(source).toContain(
      "{hasQuery && !searchUnavailable && clientResults.length > 0 && ("
    );
    expect(source).toContain("patient.clientFirstName || patient.clientLastName");
    expect(source).toContain("Owner:");
    expect(source).not.toContain("const patientResults = patients.data ?? []");
    expect(source).not.toContain("const clientResults = clients.data ?? []");
  });
});
