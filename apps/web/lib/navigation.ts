import {
  LayoutDashboard,
  WifiOff,
  PawPrint,
  Users,
  Calendar,
  FileText,
  Receipt,
  Package,
  MessageSquare,
  Syringe,
  BellRing,
  ClipboardList,
  BarChart3,
  Settings,
  ShieldAlert,
  Bot,
  FlaskConical,
  Archive,
} from "lucide-react";

export type UserRole =
  | "admin"
  | "veterinarian"
  | "technician"
  | "front_desk"
  | "viewer";

const allRoles: UserRole[] = [
  "admin",
  "veterinarian",
  "technician",
  "front_desk",
  "viewer",
];

export function isUserRole(role?: string | null): role is UserRole {
  return allRoles.includes(role as UserRole);
}

const baseItems: {
  href: string;
  label: string;
  icon: React.ElementType;
  roles: UserRole[];
}[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, roles: allRoles },
  { href: "/patients", label: "Patients", icon: PawPrint, roles: allRoles },
  { href: "/clients", label: "Clients", icon: Users, roles: allRoles },
  { href: "/schedule", label: "Schedule", icon: Calendar, roles: allRoles },
  { href: "/records", label: "Records", icon: FileText, roles: allRoles },
  {
    href: "/lab-results",
    label: "Lab Inbox",
    icon: FlaskConical,
    roles: ["admin", "veterinarian", "technician", "front_desk", "viewer"],
  },
  { href: "/billing", label: "Billing", icon: Receipt, roles: allRoles },
  { href: "/inventory", label: "Inventory", icon: Package, roles: allRoles },
  { href: "/inbox", label: "Inbox", icon: MessageSquare, roles: allRoles },
  {
    href: "/recalls",
    label: "Recalls",
    icon: Syringe,
    roles: ["admin", "veterinarian", "front_desk"],
  },
  {
    href: "/care-reminders",
    label: "Care Reminders",
    icon: BellRing,
    roles: allRoles,
  },
  {
    href: "/migration-archive",
    label: "Imported History",
    icon: Archive,
    roles: allRoles,
  },
  {
    href: "/whiteboard",
    label: "Whiteboard",
    icon: ClipboardList,
    roles: allRoles,
  },
  {
    href: "/agent",
    label: "Agent",
    icon: Bot,
    roles: ["admin", "veterinarian"],
  },
  {
    href: "/controlled-substances",
    label: "Controlled Substances",
    icon: ShieldAlert,
    roles: ["admin", "veterinarian"],
  },
  {
    href: "/reports",
    label: "Reports",
    icon: BarChart3,
    roles: ["admin", "veterinarian"],
  },
  { href: "/settings", label: "Settings", icon: Settings, roles: ["admin"] },
];

export const CORE_PATHS = [
  "/",
  "/schedule",
  "/patients",
  "/clients",
  "/billing",
  "/inbox",
];
export type NavigationItem = (typeof baseItems)[number] & {
  description: string;
};
const descriptions: Record<string, string> = {
  "/records": "Clinical notes and patient records",
  "/lab-results": "Review incoming laboratory results",
  "/inventory": "Stock, products and supplies",
  "/recalls": "Vaccination recalls and follow-ups",
  "/care-reminders": "Upcoming preventive care",
  "/migration-archive": "Records imported from another system",
  "/whiteboard": "See the clinic’s active visits",
  "/agent": "Ask for help with clinic work",
  "/controlled-substances": "Controlled drug records and accountability",
  "/reports": "Practice activity and financial reports",
};
const fieldItem: NavigationItem = {
  href: "/offline/field.html",
  label: "Field Visits",
  icon: WifiOff,
  roles: ["admin"],
  description: "Prepare house calls, write notes and print receipts offline",
};
export const TOOL_PATHS = [
  ...baseItems
    .filter(
      (item) => !CORE_PATHS.includes(item.href) && item.href !== "/settings",
    )
    .map((item) => item.href),
  fieldItem.href,
];
export function availableNavigation(
  role: string | null | undefined,
  fieldEnabled = false,
) {
  if (!isUserRole(role)) return [];
  return [...baseItems, ...(fieldEnabled ? [fieldItem] : [])]
    .filter((item) => item.roles.includes(role))
    .map((item) => ({
      ...item,
      description:
        descriptions[item.href] ??
        (item.href === fieldItem.href ? fieldItem.description : ""),
    }));
}
export function isNavigationActive(href: string, pathname: string) {
  return href === "/"
    ? pathname === "/"
    : pathname === href ||
        pathname.startsWith(`${href}/`) ||
        (href === "/lab-results" && pathname.startsWith("/lab-reports"));
}
