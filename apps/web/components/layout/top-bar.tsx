"use client";

import { useState, useRef, useEffect } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  Search,
  Plus,
  Users,
  PawPrint,
  Calendar,
  Receipt,
  Menu,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TrialBadge } from "@/components/layout/trial-badge";

const routeLabels: Record<string, string> = {
  "/": "Dashboard",
  "/patients": "Patients",
  "/clients": "Clients",
  "/schedule": "Schedule",
  "/records": "Records",
  "/lab-results": "Lab Inbox",
  "/billing": "Billing",
  "/inventory": "Inventory",
  "/inbox": "Inbox",
  "/recalls": "Vaccination Recalls",
  "/whiteboard": "Whiteboard",
  "/agent": "Agent",
  "/controlled-substances": "Controlled Substances",
  "/reports": "Reports",
  "/settings": "Settings",
};

type UserRole =
  | "admin"
  | "veterinarian"
  | "technician"
  | "front_desk"
  | "viewer";

type NewAction = {
  label: string;
  href: string;
  Icon: React.ElementType;
  roles: UserRole[];
};

const NEW_ACTIONS: NewAction[] = [
  {
    label: "New Client",
    href: "/clients/new",
    Icon: Users,
    roles: ["admin", "veterinarian", "technician", "front_desk"],
  },
  {
    label: "New Patient",
    href: "/patients/new",
    Icon: PawPrint,
    roles: ["admin", "veterinarian", "technician", "front_desk"],
  },
  {
    label: "New Appointment",
    href: "/schedule",
    Icon: Calendar,
    roles: ["admin", "veterinarian", "front_desk"],
  },
  {
    label: "New Invoice",
    href: "/billing/new",
    Icon: Receipt,
    roles: ["admin", "front_desk"],
  },
];

export function TopBar({
  onMenuOpen,
  onSearchOpen,
}: {
  onMenuOpen?: () => void;
  onSearchOpen?: () => void;
}) {
  const pathname = usePathname();
  const basePath = "/" + (pathname.split("/")[1] ?? "");
  const label = routeLabels[basePath] ?? "OpenVPM";
  const { data: session } = useSession();
  const role = session?.user?.role as UserRole | undefined;
  const availableNewActions = role
    ? NEW_ACTIONS.filter((action) => action.roles.includes(role))
    : [];

  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const newMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!newMenuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) {
        setNewMenuOpen(false);
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setNewMenuOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [newMenuOpen]);

  return (
    <header className="flex h-14 items-center justify-between gap-2 border-b border-border bg-background px-3 sm:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onMenuOpen}
          aria-label="Open navigation"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        <h1 className="truncate font-heading text-lg font-semibold">{label}</h1>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {/* Below sm the pill would crush the page title into one character. */}
        <div className="hidden sm:block">
          <TrialBadge />
        </div>
        <button
          type="button"
          onClick={onSearchOpen}
          aria-label="Open search"
          className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-2 text-sm text-muted-foreground transition-colors hover:bg-accent sm:w-64 sm:px-3 md:w-80"
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="hidden sm:inline">Search...</span>
          <kbd className="ml-auto hidden rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium md:inline">
            ⌘K
          </kbd>
        </button>

        {availableNewActions.length > 0 && (
          <div className="relative" ref={newMenuRef}>
            <Button
              size="sm"
              className="gap-1"
              onClick={() => setNewMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={newMenuOpen}
            >
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">New</span>
            </Button>
            {newMenuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full z-50 mt-1 w-52 overflow-hidden rounded-md border border-border bg-popover shadow-md"
              >
                {availableNewActions.map(
                  ({ label: actionLabel, href, Icon }) => (
                    <Link
                      key={href}
                      href={href}
                      role="menuitem"
                      onClick={() => setNewMenuOpen(false)}
                      className="flex items-center gap-2 px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      <Icon className="h-4 w-4 text-muted-foreground" />
                      {actionLabel}
                    </Link>
                  )
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
