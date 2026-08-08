"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { signIn, useSession } from "next-auth/react";
import { Loader2, UserRoundCog } from "lucide-react";
import {
  DEMO_ROLE_OPTIONS,
  type DemoSwitcherRole,
  demoRoleDestination,
  demoRoleLabel,
  isDemoSwitcherRole,
  requestDemoRoleSwitch,
  shouldShowDemoRoleSwitcher,
} from "@/lib/demo-role-switcher";

const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE?.trim() === "true";

type DemoRoleSwitcherViewProps = {
  currentRole: DemoSwitcherRole;
  pendingRole: DemoSwitcherRole | null;
  error: string | null;
  onRoleChange: (role: DemoSwitcherRole) => void;
};

export function DemoRoleSwitcherView({
  currentRole,
  pendingRole,
  error,
  onRoleChange,
}: DemoRoleSwitcherViewProps) {
  const isSwitching = pendingRole !== null;
  const currentLabel = demoRoleLabel(currentRole);

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-2">
        <label
          htmlFor="demo-role-switcher"
          className="shrink-0 text-xs font-medium text-muted-foreground"
        >
          Explore as
        </label>
        <div className="relative">
          <UserRoundCog
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <select
            id="demo-role-switcher"
            value={currentRole}
            disabled={isSwitching}
            aria-label={`Demo role. Current role: ${currentLabel}`}
            onChange={(event) => {
              const nextRole = event.currentTarget.value;
              if (isDemoSwitcherRole(nextRole)) onRoleChange(nextRole);
            }}
            className="h-8 max-w-40 appearance-none rounded-md border border-input bg-background py-1 pl-7 pr-7 text-xs font-medium text-foreground disabled:cursor-wait disabled:opacity-60"
          >
            {DEMO_ROLE_OPTIONS.map((role) => (
              <option key={role.value} value={role.value}>
                {role.label}
              </option>
            ))}
          </select>
          {isSwitching ? (
            <Loader2
              aria-hidden="true"
              className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground"
            />
          ) : (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground"
            >
              ▾
            </span>
          )}
        </div>
      </div>
      <span className="sr-only" aria-live="polite">
        {pendingRole
          ? `Switching to ${demoRoleLabel(pendingRole)}`
          : `Viewing demo as ${currentLabel}`}
      </span>
      {error ? (
        <p role="alert" className="max-w-64 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function DemoRoleSwitcher() {
  const pathname = usePathname();
  const { data: session, status } = useSession();
  const [pendingRole, setPendingRole] =
    React.useState<DemoSwitcherRole | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const sessionRole = session?.user?.role;

  if (!shouldShowDemoRoleSwitcher(DEMO_MODE, status, sessionRole)) {
    return null;
  }

  async function handleRoleChange(nextRole: DemoSwitcherRole) {
    if (pendingRole || nextRole === sessionRole) return;

    setError(null);
    setPendingRole(nextRole);
    const switched = await requestDemoRoleSwitch(
      nextRole,
      (provider, options) => signIn(provider, options),
    );
    if (!switched) {
      setPendingRole(null);
      setError(
        "We couldn't switch roles. Your current role is unchanged. Try again.",
      );
      return;
    }

    try {
      const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      const destination = demoRoleDestination(
        nextRole,
        pathname,
        currentPath,
      );
      // A full local navigation reloads the JWT-backed session before any
      // role-gated page or query can render under the new identity.
      window.location.assign(destination);
    } catch {
      setPendingRole(null);
      setError("Role changed. Refresh this page to finish switching views.");
    }
  }

  return (
    <DemoRoleSwitcherView
      currentRole={sessionRole}
      pendingRole={pendingRole}
      error={error}
      onRoleChange={handleRoleChange}
    />
  );
}
