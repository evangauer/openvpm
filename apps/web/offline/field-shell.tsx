import type { MouseEvent, ReactNode } from "react";
import {
  Calendar,
  LayoutDashboard,
  PawPrint,
  WifiOff,
  ArrowUpRight,
} from "lucide-react";
import { PawMark } from "../components/brand/paw-mark";

export type ClinicConnection =
  | "checking"
  | "connected"
  | "unreachable"
  | "signed-out"
  | "access-denied";

export function FieldShell({
  children,
  online,
  connection,
  checkConnection,
  busy,
}: {
  children: ReactNode;
  online: boolean;
  connection: ClinicConnection;
  checkConnection: () => void;
  busy: boolean;
}) {
  const connected = online && connection === "connected";
  const focusWorkspace = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    document.getElementById("field-main")?.focus();
  };
  const status = !online
    ? "Working offline"
    : connection === "connected"
      ? "Clinic connected"
      : connection === "checking"
        ? "Checking connection…"
        : connection === "signed-out"
          ? "Sign-in needed"
          : connection === "access-denied"
            ? "Field access unavailable"
            : "Clinic unreachable";
  return (
    <div className="min-h-screen bg-surface font-sans antialiased md:pl-60">
      <a
        href="#field-main"
        onClick={focusWorkspace}
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-background focus:p-3"
      >
        Skip to field workspace
      </a>
      <aside
        className="border-r bg-background md:fixed md:inset-y-0 md:left-0 md:flex md:w-60 md:flex-col"
        aria-label="OpenVPM navigation"
      >
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <PawMark className="h-4 w-4" />
          </span>
          <span className="font-heading text-lg font-semibold">OpenVPM</span>
        </div>
        <nav
          className="grid grid-cols-4 gap-1 p-2 md:block md:space-y-1"
          aria-label="Clinic navigation"
        >
          {(
            [
              ["Dashboard", "/", LayoutDashboard],
              ["Patients", "/patients", PawPrint],
              ["Schedule", "/schedule", Calendar],
            ] as const
          ).map(([label, href, Icon]) => {
            const content = (
              <>
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{label}</span>
              </>
            );
            const classes =
              "flex flex-col items-center gap-1 rounded-md px-2 py-2 text-xs font-medium md:flex-row md:gap-3 md:px-3 md:text-sm";
            return connected ? (
              <a
                key={label}
                className={`${classes} text-muted-foreground hover:bg-accent`}
                href={href}
                target="_blank"
                rel="noreferrer"
                title="Opens clinic in a new tab"
              >
                {content}
              </a>
            ) : (
              <span
                key={label}
                className={`${classes} text-muted-foreground opacity-50`}
                aria-disabled="true"
                title="Reconnect to open the clinic"
              >
                {content}
              </span>
            );
          })}
          <a
            className="flex flex-col items-center gap-1 whitespace-nowrap rounded-md bg-primary/10 px-2 py-2 text-xs font-medium text-primary md:flex-row md:gap-3 md:px-3 md:text-sm"
            href="#field-main"
            onClick={focusWorkspace}
            aria-current="page"
          >
            <WifiOff className="h-4 w-4" aria-hidden="true" />
            Field Visits
          </a>
        </nav>
        <div className="mt-auto hidden border-t p-4 text-xs leading-relaxed text-muted-foreground md:block">
          Field visits stay on this device until you synchronize. Clinic
          navigation opens in a separate tab.
        </div>
      </aside>
      <header className="flex min-h-14 flex-wrap items-center justify-between gap-2 border-b bg-background px-4 py-2 sm:px-6">
        <h1 className="font-heading text-lg font-semibold">Field Visits</h1>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${connected ? "bg-primary/10 text-primary" : "bg-amber-50 text-amber-900"}`}
          >
            {status}
          </span>
          <button
            type="button"
            className="text-sm underline underline-offset-4 disabled:opacity-50"
            disabled={!online || busy || connection === "checking"}
            onClick={checkConnection}
          >
            Check connection
          </button>
          {connected ? (
            <a
              className="inline-flex items-center gap-1 text-sm text-primary"
              href="/"
              target="_blank"
              rel="noreferrer"
            >
              Back to clinic
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </a>
          ) : online && connection === "signed-out" ? (
            <a
              href="/login"
              target="_blank"
              rel="noreferrer"
              className="text-primary underline"
            >
              Sign in online
            </a>
          ) : null}
        </div>
      </header>
      {children}
    </div>
  );
}
