export const DEMO_ROLE_OPTIONS = [
  { value: "admin", label: "Practice Admin" },
  { value: "veterinarian", label: "Veterinarian" },
  { value: "technician", label: "Technician" },
  { value: "front_desk", label: "Front Desk" },
] as const;

export type DemoSwitcherRole = (typeof DEMO_ROLE_OPTIONS)[number]["value"];

type DemoSignInResult = {
  ok?: boolean;
  error?: string | null;
};

type DemoSignIn = (
  provider: "demo",
  options: { role: DemoSwitcherRole; redirect: false },
) => Promise<DemoSignInResult | undefined>;

const ALL_DEMO_ROLES: readonly DemoSwitcherRole[] = DEMO_ROLE_OPTIONS.map(
  ({ value }) => value,
);
const ADMIN_ONLY: readonly DemoSwitcherRole[] = ["admin"];
const CLINICAL_LEAD_ROLES: readonly DemoSwitcherRole[] = [
  "admin",
  "veterinarian",
];
const RECALL_ROLES: readonly DemoSwitcherRole[] = [
  "admin",
  "veterinarian",
  "front_desk",
];
const BILLING_WRITE_ROLES: readonly DemoSwitcherRole[] = [
  "admin",
  "front_desk",
];

const DEMO_ROUTE_ACCESS: ReadonlyArray<{
  prefix: string;
  roles: readonly DemoSwitcherRole[];
}> = [
  { prefix: "/settings", roles: ADMIN_ONLY },
  { prefix: "/agent", roles: CLINICAL_LEAD_ROLES },
  { prefix: "/controlled-substances", roles: CLINICAL_LEAD_ROLES },
  { prefix: "/reports", roles: CLINICAL_LEAD_ROLES },
  { prefix: "/records/new-soap", roles: CLINICAL_LEAD_ROLES },
  { prefix: "/billing/new", roles: BILLING_WRITE_ROLES },
  { prefix: "/recalls", roles: RECALL_ROLES },
  { prefix: "/patients", roles: ALL_DEMO_ROLES },
  { prefix: "/clients", roles: ALL_DEMO_ROLES },
  { prefix: "/schedule", roles: ALL_DEMO_ROLES },
  { prefix: "/records", roles: ALL_DEMO_ROLES },
  { prefix: "/billing", roles: ALL_DEMO_ROLES },
  { prefix: "/inventory", roles: ALL_DEMO_ROLES },
  { prefix: "/inbox", roles: ALL_DEMO_ROLES },
  { prefix: "/whiteboard", roles: ALL_DEMO_ROLES },
  { prefix: "/encounters", roles: ALL_DEMO_ROLES },
];

function matchesPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isDemoSwitcherRole(
  value: string | null | undefined,
): value is DemoSwitcherRole {
  return DEMO_ROLE_OPTIONS.some((role) => role.value === value);
}

export function demoRoleLabel(role: DemoSwitcherRole): string {
  return (
    DEMO_ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role
  );
}

export function shouldShowDemoRoleSwitcher(
  demoMode: boolean,
  sessionStatus: "authenticated" | "loading" | "unauthenticated",
  role: string | null | undefined,
): role is DemoSwitcherRole {
  return (
    demoMode &&
    sessionStatus === "authenticated" &&
    isDemoSwitcherRole(role)
  );
}

export function canPreserveDemoPath(
  role: DemoSwitcherRole,
  pathname: string,
): boolean {
  if (pathname === "/") return true;
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return false;

  const access = DEMO_ROUTE_ACCESS.find(({ prefix }) =>
    matchesPathPrefix(pathname, prefix),
  );
  return access?.roles.includes(role) ?? false;
}

export function demoRoleDestination(
  role: DemoSwitcherRole,
  pathname: string,
  currentPath: string,
): string {
  const currentPathIsLocal =
    currentPath.startsWith("/") && !currentPath.startsWith("//");
  return currentPathIsLocal && canPreserveDemoPath(role, pathname)
    ? currentPath
    : "/";
}

export async function requestDemoRoleSwitch(
  role: DemoSwitcherRole,
  signInDemo: DemoSignIn,
): Promise<boolean> {
  try {
    const result = await signInDemo("demo", { role, redirect: false });
    return result?.ok === true && !result.error;
  } catch {
    return false;
  }
}
