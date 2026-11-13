"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  ChevronLeft,
  ChevronRight,
  LogOut,
  Grid2X2,
  Pin,
  PinOff,
} from "lucide-react";
import {
  availableNavigation,
  CORE_PATHS,
  isUserRole,
  isNavigationActive,
  type NavigationItem,
} from "@/lib/navigation";
import { useSidebarPins } from "@/lib/use-sidebar-pins";
import { SidebarTools } from "./sidebar-tools";
import { PawMark } from "@/components/brand/paw-mark";

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
    },
  );
  const { data: fieldPilot } = trpc.offlineField.availability.useQuery(
    undefined,
    {
      enabled: canShowNav && role === "admin",
      staleTime: 300_000,
      retry: false,
    },
  );
  const availableItems = canShowNav
    ? availableNavigation(role, fieldPilot?.enabled)
    : [];
  const coreItems = CORE_PATHS.flatMap((href) =>
    availableItems.filter((item) => item.href === href),
  );
  const toolItems = availableItems.filter(
    (item) => !CORE_PATHS.includes(item.href) && item.href !== "/settings",
  );
  const settingsItem = availableItems.find((item) => item.href === "/settings");
  const { pinned, togglePin } = useSidebarPins(
    session?.user?.practiceId,
    session?.user?.id,
  );
  const pinnedItems = pinned.flatMap((href) =>
    toolItems.filter((item) => item.href === href),
  );
  const currentTool = toolItems.find(
    (item) =>
      !pinned.includes(item.href) && isNavigationActive(item.href, pathname),
  );
  const [toolsOpen, setToolsOpen] = useState(false);
  const unreadInboxCount = Math.max(0, Number(unreadInbox?.total ?? 0));
  const unreadInboxLabel =
    unreadInboxCount > 99 ? "99+" : String(unreadInboxCount);

  function navLink(item: NavigationItem) {
    const active = isNavigationActive(item.href, pathname);
    return (
      <Link
        href={item.href}
        data-tour={`nav-${item.href}`}
        aria-label={item.label}
        title={isCollapsed ? item.label : undefined}
        aria-current={active ? "page" : undefined}
        onClick={onNavigate}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          active
            ? "bg-primary/10 text-primary"
            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        )}
      >
        <span className="relative shrink-0">
          <item.icon className="h-4 w-4" aria-hidden="true" />
          {isCollapsed && item.href === "/inbox" && unreadInboxCount > 0 && (
            <span
              aria-label={`${unreadInboxCount} unread inbox conversations`}
              className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-surface"
            />
          )}
        </span>
        {!isCollapsed && <span className="truncate">{item.label}</span>}
        {!isCollapsed && item.href === "/inbox" && unreadInboxCount > 0 && (
          <span
            aria-label={`${unreadInboxCount} unread inbox conversations`}
            className="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground"
          >
            {unreadInboxLabel}
          </span>
        )}
      </Link>
    );
  }

  return (
    <aside
      className={cn(
        "flex h-screen flex-col border-r border-border bg-surface transition-all duration-150",
        width === "full" ? "w-full" : isCollapsed ? "w-16" : "w-60",
        className,
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
            <span className="font-heading text-lg font-semibold">OpenVPM</span>
          )}
        </Link>
      </div>

      {/* Navigation */}
      <nav
        className="flex-1 overflow-y-auto px-2 py-2"
        role="navigation"
        aria-label="Main navigation"
      >
        <ul className="space-y-0.5" aria-label="Core navigation">
          {coreItems.map((item) => (
            <li key={item.href}>{navLink(item)}</li>
          ))}
        </ul>
        {canShowNav && (
          <div className="mt-4 border-t border-border pt-3">
            {!isCollapsed && (
              <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Your tools
              </p>
            )}
            <ul className="space-y-0.5" aria-label="Pinned tools">
              {pinnedItems.map((item) => (
                <li key={item.href} className="flex items-center">
                  {navLink(item)}
                  {!isCollapsed && (
                    <button
                      type="button"
                      onClick={() => togglePin(item.href)}
                      aria-label={`Unpin ${item.label}`}
                      title={`Unpin ${item.label}`}
                      className="shrink-0 rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <PinOff className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {!isCollapsed && !pinnedItems.length && (
              <p className="px-3 pb-2 text-xs leading-relaxed text-muted-foreground">
                Keep the tools you use most here.
              </p>
            )}
            {currentTool && (
              <div className="my-2" aria-label="Current tool">
                {!isCollapsed && (
                  <p className="px-3 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Currently viewing
                  </p>
                )}
                <div className="flex items-center">
                  {navLink(currentTool)}
                  {!isCollapsed && (
                    <button
                      type="button"
                      onClick={() => togglePin(currentTool.href)}
                      aria-label={`Pin ${currentTool.label}`}
                      title={`Pin ${currentTool.label}`}
                      className="rounded-md p-2 text-muted-foreground hover:bg-accent"
                    >
                      <Pin className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
            )}
            <SidebarTools
              open={toolsOpen}
              onOpenChange={setToolsOpen}
              items={toolItems}
              pinned={pinned}
              onTogglePin={togglePin}
              onNavigate={onNavigate}
            >
              <button
                type="button"
                aria-label="All tools"
                title={isCollapsed ? "All tools" : undefined}
                className="mt-1 flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Grid2X2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                {!isCollapsed && (
                  <>
                    <span>All tools</span>
                    <ChevronRight
                      className="ml-auto h-3.5 w-3.5"
                      aria-hidden="true"
                    />
                  </>
                )}
              </button>
            </SidebarTools>
          </div>
        )}
      </nav>

      {settingsItem && (
        <div className="border-t border-border px-2 py-2">
          {navLink(settingsItem)}
        </div>
      )}

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
