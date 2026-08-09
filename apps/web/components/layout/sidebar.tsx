"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  PawPrint,
  Users,
  Calendar,
  FileText,
  Receipt,
  Package,
  MessageSquare,
  Syringe,
  ClipboardList,
  BarChart3,
  Settings,
  ShieldAlert,
  Bot,
  FlaskConical,
  ChevronLeft,
  ChevronRight,
  LogOut,
} from "lucide-react";
import { PawMark } from "@/components/brand/paw-mark";

type UserRole = "admin" | "veterinarian" | "technician" | "front_desk" | "viewer";

const allRoles: UserRole[] = [
  "admin",
  "veterinarian",
  "technician",
  "front_desk",
  "viewer",
];

function isUserRole(role?: string | null): role is UserRole {
  return allRoles.includes(role as UserRole);
}

const navItems: {
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
  { href: "/whiteboard", label: "Whiteboard", icon: ClipboardList, roles: allRoles },
  { href: "/agent", label: "Agent", icon: Bot, roles: ["admin", "veterinarian"] },
  { href: "/controlled-substances", label: "Controlled Substances", icon: ShieldAlert, roles: ["admin", "veterinarian"] },
  { href: "/reports", label: "Reports", icon: BarChart3, roles: ["admin", "veterinarian"] },
  { href: "/settings", label: "Settings", icon: Settings, roles: ["admin"] },
];

type SidebarProps = {
  className?: string;
  collapsible?: boolean;
  onNavigate?: () => void;
  width?: "fixed" | "full";
};

export function Sidebar({
  className,
  collapsible = true,
  onNavigate,
  width = "fixed",
}: SidebarProps = {}) {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  const { data: session, status } = useSession();
  const role = isUserRole(session?.user?.role) ? session.user.role : undefined;
  const { data: branding } = trpc.settings.getBranding.useQuery();
  const isCollapsed = collapsible && collapsed;
  const canShowNav = status === "authenticated" && role !== undefined;
  const { data: unreadInbox } = trpc.communications.listConversations.useQuery(
    { inboxFilter: "unread", limit: 1, offset: 0 },
    {
      enabled: canShowNav,
      refetchInterval: 30000,
      retry: false,
    }
  );
  const visibleNavItems = canShowNav
    ? navItems.filter((item) => item.roles.includes(role))
    : [];
  const unreadInboxCount = Math.max(0, Number(unreadInbox?.total ?? 0));
  const unreadInboxLabel =
    unreadInboxCount > 99 ? "99+" : String(unreadInboxCount);

  return (
    <aside
      className={cn(
        "flex h-screen flex-col border-r border-border bg-surface transition-all duration-150",
        width === "full" ? "w-full" : isCollapsed ? "w-16" : "w-60",
        className
      )}
    >
      {/* Logo */}
      <div className="flex h-14 items-center border-b border-border px-4">
        <Link href="/" className="flex items-center gap-2">
          {branding?.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={branding.logoUrl}
              alt={branding.name ?? "Practice logo"}
              className="h-8 w-8 rounded-lg object-cover"
            />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
              <PawMark className="h-4 w-4 text-primary-foreground" />
            </div>
          )}
          {!isCollapsed && (
            <span className="font-heading text-lg font-semibold">
              OpenVPM
            </span>
          )}
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2 py-2" role="navigation" aria-label="Main navigation">
        <ul className="space-y-0.5">
          {visibleNavItems.map((item) => {
            const isActive =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);

            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  data-tour={`nav-${item.href}`}
                  aria-current={isActive ? "page" : undefined}
                  onClick={onNavigate}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  <span className="relative shrink-0">
                    <item.icon className="h-4 w-4" />
                    {isCollapsed &&
                    item.href === "/inbox" &&
                    unreadInboxCount > 0 ? (
                      <span
                        aria-label={`${unreadInboxCount} unread inbox conversations`}
                        className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-surface"
                      />
                    ) : null}
                  </span>
                  {!isCollapsed && <span className="truncate">{item.label}</span>}
                  {!isCollapsed &&
                  item.href === "/inbox" &&
                  unreadInboxCount > 0 ? (
                    <span
                      aria-label={`${unreadInboxCount} unread inbox conversations`}
                      className="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground"
                    >
                      {unreadInboxLabel}
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* User & Collapse */}
      <div className="border-t border-border p-2">
        {session?.user && !isCollapsed && (
          <div className="mb-2 flex items-center gap-3 rounded-md px-3 py-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
              {session.user.name
                ?.split(" ")
                .map((n) => n[0])
                .join("")
                .slice(0, 2)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {session.user.name}
              </p>
              <p className="truncate text-xs text-muted-foreground capitalize">
                {session.user.role?.replace("_", " ")}
              </p>
            </div>
            <button
              onClick={() => signOut({ callbackUrl: "/login" })}
              aria-label="Sign out"
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        )}
        {collapsible && (
          <button
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="flex w-full items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {collapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </button>
        )}
      </div>
    </aside>
  );
}
