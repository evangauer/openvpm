"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Command } from "cmdk";
import {
  PawPrint,
  Users,
  Calendar,
  FileText,
  X,
  Search,
  Package,
  DollarSign,
  BarChart3,
  Settings,
  Clipboard,
  Mail,
  Loader2,
  AlertCircle,
  Syringe,
  FlaskConical,
} from "lucide-react";
import { trpc } from "@/lib/trpc";

const speciesEmoji: Record<string, string> = {
  canine: "\uD83D\uDC36",
  feline: "\uD83D\uDC31",
  avian: "\uD83D\uDC26",
  rabbit: "\uD83D\uDC30",
  reptile: "\uD83E\uDD8E",
  equine: "\uD83D\uDC34",
  other: "\uD83D\uDC3E",
};

type UserRole =
  | "admin"
  | "veterinarian"
  | "technician"
  | "front_desk"
  | "viewer";

type CommandItemConfig = {
  label: string;
  href: string;
  Icon: React.ElementType;
  roles: UserRole[];
};

const allRoles: UserRole[] = [
  "admin",
  "veterinarian",
  "technician",
  "front_desk",
  "viewer",
];

const navigationItems: CommandItemConfig[] = [
  { label: "Dashboard", href: "/", Icon: BarChart3, roles: allRoles },
  { label: "Patients", href: "/patients", Icon: PawPrint, roles: allRoles },
  { label: "Clients", href: "/clients", Icon: Users, roles: allRoles },
  { label: "Schedule", href: "/schedule", Icon: Calendar, roles: allRoles },
  { label: "Whiteboard", href: "/whiteboard", Icon: Clipboard, roles: allRoles },
  { label: "Records", href: "/records", Icon: FileText, roles: allRoles },
  {
    label: "Lab Inbox",
    href: "/lab-results",
    Icon: FlaskConical,
    roles: ["admin", "veterinarian", "technician", "front_desk", "viewer"],
  },
  { label: "Billing", href: "/billing", Icon: DollarSign, roles: allRoles },
  { label: "Inventory", href: "/inventory", Icon: Package, roles: allRoles },
  { label: "Inbox", href: "/inbox", Icon: Mail, roles: allRoles },
  {
    label: "Vaccination Recalls",
    href: "/recalls",
    Icon: Syringe,
    roles: ["admin", "veterinarian", "front_desk"],
  },
  { label: "Settings", href: "/settings", Icon: Settings, roles: ["admin"] },
];

const quickActionItems: CommandItemConfig[] = [
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
    label: "New Invoice",
    href: "/billing/new",
    Icon: DollarSign,
    roles: ["admin", "front_desk"],
  },
];

function isUserRole(role?: string | null): role is UserRole {
  return allRoles.includes(role as UserRole);
}

export function CommandSearch({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const { data: session, status } = useSession();
  const role = isUserRole(session?.user?.role) ? session.user.role : undefined;
  const canUseCommandSearch =
    status === "authenticated" && role !== undefined;
  const [search, setSearch] = useState("");

  const debouncedSearch = useDebounce(search, 200);
  const hasQuery = debouncedSearch.trim().length >= 1;

  const patients = trpc.patients.search.useQuery(
    { query: debouncedSearch },
    { enabled: open && hasQuery && canUseCommandSearch }
  );

  const clients = trpc.clients.search.useQuery(
    { query: debouncedSearch },
    { enabled: open && hasQuery && canUseCommandSearch }
  );

  const checkingSearchAccess = hasQuery && status === "loading";
  const isSearching =
    hasQuery &&
    (checkingSearchAccess ||
      (canUseCommandSearch && (patients.isFetching || clients.isFetching)));
  const searchAccessUnavailable =
    hasQuery && !checkingSearchAccess && !canUseCommandSearch;
  const searchUnavailable =
    hasQuery &&
    canUseCommandSearch &&
    !isSearching &&
    (Boolean(patients.error) ||
      Boolean(clients.error) ||
      !patients.data ||
      !clients.data);
  const visibleNavigationItems =
    status === "authenticated" && role !== undefined
      ? navigationItems.filter((item) => item.roles.includes(role))
      : [];
  const visibleQuickActionItems =
    status === "authenticated" && role !== undefined
      ? quickActionItems.filter((item) => item.roles.includes(role))
      : [];

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  function navigate(path: string) {
    onClose();
    router.push(path);
  }

  if (!open) return null;

  const patientResults =
    searchUnavailable || !patients.data ? [] : patients.data;
  const clientResults =
    searchUnavailable || !clients.data ? [] : clients.data;
  const hasResults = patientResults.length > 0 || clientResults.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
      role="dialog"
      aria-label="Search"
      aria-modal="true"
    >
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative mx-4 w-full max-w-2xl rounded-lg border border-border bg-background shadow-elevated">
        <Command className="flex flex-col" shouldFilter={!hasQuery}>
          <div className="flex items-center border-b border-border px-3">
            {isSearching ? (
              <Loader2 className="mr-2 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <Search className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <Command.Input
              value={search}
              onValueChange={setSearch}
              placeholder="Search patients, clients, or navigate..."
              className="flex h-11 w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
            />
            <button
              onClick={onClose}
              className="rounded-md p-1 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <Command.List className="max-h-80 overflow-y-auto p-2">
            {searchUnavailable && (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                <AlertCircle className="mx-auto mb-2 h-5 w-5 text-destructive" />
                <p className="font-medium text-foreground">
                  Unable to load search results
                </p>
                <p className="mt-1">
                  Retry before deciding this client or patient is missing.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    void patients.refetch();
                    void clients.refetch();
                  }}
                  className="mt-3 rounded-md border border-input px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
                >
                  Retry search
                </button>
              </div>
            )}

            {searchAccessUnavailable && (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                <AlertCircle className="mx-auto mb-2 h-5 w-5 text-destructive" />
                <p className="font-medium text-foreground">
                  Unable to confirm search access
                </p>
                <p className="mt-1">
                  Close and reopen search after your session is ready.
                </p>
              </div>
            )}

            {hasQuery &&
              !isSearching &&
              !searchAccessUnavailable &&
              !searchUnavailable &&
              !hasResults && (
                <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No patients or clients found.
                </Command.Empty>
              )}

            {/* Live search results */}
            {hasQuery && !searchUnavailable && patientResults.length > 0 && (
              <Command.Group
                heading="Patients"
                className="mb-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
              >
                {patientResults.map((patient) => (
                  <Command.Item
                    key={patient.id}
                    value={`patient-${patient.id}`}
                    onSelect={() => navigate(`/patients/${patient.id}`)}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent"
                  >
                    <span className="text-base">
                      {speciesEmoji[patient.species ?? "other"] ??
                        "\uD83D\uDC3E"}
                    </span>
                    <span className="font-medium">{patient.name}</span>
                    {patient.breed && (
                      <span className="text-muted-foreground">
                        {patient.breed}
                      </span>
                    )}
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {hasQuery && !searchUnavailable && clientResults.length > 0 && (
              <Command.Group
                heading="Clients"
                className="mb-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
              >
                {clientResults.map((client) => (
                  <Command.Item
                    key={client.id}
                    value={`client-${client.id}`}
                    onSelect={() => navigate(`/clients/${client.id}`)}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent"
                  >
                    <Users className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">
                      {client.firstName} {client.lastName}
                    </span>
                    {client.email && (
                      <span className="text-muted-foreground">
                        {client.email}
                      </span>
                    )}
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* Navigation (shown when no search query) */}
            {!hasQuery && visibleNavigationItems.length > 0 && (
              <Command.Group
                heading="Navigation"
                className="mb-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
              >
                {visibleNavigationItems.map(({ label, href, Icon }) => (
                  <Command.Item
                    key={href}
                    onSelect={() => navigate(href)}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent"
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {!hasQuery && visibleQuickActionItems.length > 0 && (
              <Command.Group
                heading="Quick Actions"
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
              >
                {visibleQuickActionItems.map(({ label, href, Icon }) => (
                  <Command.Item
                    key={href}
                    onSelect={() => navigate(href)}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent"
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}
