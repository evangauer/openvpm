"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  BarChart3,
  BatteryFull,
  Calendar,
  Check,
  ClipboardList,
  FileText,
  LayoutDashboard,
  Lock,
  MessageSquare,
  PawPrint,
  Receipt,
  Signal,
  Users,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/** The app's own sidebar icons, so the mockup reads as the real product. */
const MODULE_ICONS: Record<string, LucideIcon> = {
  Dashboard: LayoutDashboard,
  Patients: PawPrint,
  Clients: Users,
  Schedule: Calendar,
  Records: FileText,
  Billing: Receipt,
  Inbox: MessageSquare,
  Whiteboard: ClipboardList,
  Reports: BarChart3,
};

/**
 * Every scene draws on the same fixed canvas, scaled to fit its column, so
 * windows, phones, and cards keep the same size from scene to scene.
 */
export const CANVAS_WIDTH = 640;
const DEVICE_HEIGHT = 340;
const FOOTER_HEIGHT = 64;
const CANVAS_GAP = 16;
const CANVAS_HEIGHT = DEVICE_HEIGHT + CANVAS_GAP + FOOTER_HEIGHT;

/** Widths that fit a window and a phone side by side on the canvas. */
export const WINDOW_WIDTH = 424;
export const PHONE_WIDTH = 184;

/** "CA" for "Cedar Animal Hospital"; a stand-in until a logo is uploaded. */
export function clinicInitials(name: string): string {
  const letters = name.match(/\b[A-Za-z]/g) ?? [];
  return (letters.slice(0, 2).join("") || "C").toUpperCase();
}

export function ClinicMark({
  name,
  logo,
  size = 22,
  className,
}: {
  name: string;
  logo?: string | null;
  size?: number;
  className?: string;
}) {
  const radius = Math.round(size * 0.25);
  if (logo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- local data URL preview
      <img
        src={logo}
        alt=""
        width={size}
        height={size}
        className={cn("shrink-0 border border-slate-200 bg-white object-contain", className)}
        style={{ width: size, height: size, borderRadius: radius }}
      />
    );
  }
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-semibold text-white transition-colors duration-500",
        className,
      )}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        fontSize: Math.round(size * 0.4),
        background: "var(--b)",
      }}
    >
      {clinicInitials(name)}
    </span>
  );
}

function ScaledCanvas({ children }: { children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const node = outer.current;
    if (!node) return;
    const measure = () =>
      setScale(Math.min(1, node.clientWidth / CANVAS_WIDTH) || 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={outer}
      className="relative w-full"
      style={{ height: CANVAS_HEIGHT * scale }}
    >
      <div
        className="absolute left-1/2 top-0 origin-top"
        style={{
          width: CANVAS_WIDTH,
          height: CANVAS_HEIGHT,
          transform: `translateX(-50%) scale(${scale})`,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * A scene's picture: a label row (the time of day in the story), the product
 * on a fixed canvas, and a footer row for the scene's payoff.
 */
export function Stage({
  label,
  icon: Icon,
  footer,
  children,
}: {
  label: string;
  icon?: LucideIcon;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:p-5">
      <div className="mb-3 flex h-5 items-center gap-1.5 text-xs font-medium text-slate-500">
        {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden="true" /> : null}
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={label}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {label}
          </motion.span>
        </AnimatePresence>
      </div>
      <ScaledCanvas>
        <div
          className="flex items-stretch justify-center gap-6"
          style={{ height: DEVICE_HEIGHT }}
        >
          {children}
        </div>
        <div style={{ height: FOOTER_HEIGHT, marginTop: CANVAS_GAP }}>
          {footer}
        </div>
      </ScaledCanvas>
    </div>
  );
}

export interface StoryWin {
  /** Who the first card speaks for, e.g. the client's name. */
  clientLabel: string;
  /** What the client gets out of this moment. */
  client: string;
  /** What the vet and team get. */
  you: string;
}

/** The payoff of a story scene: one win for the client, one for the clinic. */
export function WinCards({ win, show }: { win: StoryWin; show: boolean }) {
  const cards = [
    { who: win.clientLabel, text: win.client },
    { who: "For you", text: win.you },
  ];
  return (
    <div className="grid h-full grid-cols-2 gap-3" aria-live="polite">
      {cards.map((card, i) => (
        <motion.div
          key={card.who}
          initial={false}
          animate={show ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
          transition={{ duration: 0.35, ease: "easeOut", delay: show ? i * 0.12 : 0 }}
          className="flex h-full items-center gap-3 rounded-xl border border-slate-200 bg-white px-3.5"
        >
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white transition-colors duration-500"
            style={{ background: "var(--b)" }}
            aria-hidden="true"
          >
            <Check className="h-3.5 w-3.5" strokeWidth={3} />
          </span>
          <span className="min-w-0 text-[12.5px] leading-[17px] text-slate-700">
            <span className="block text-[11px] font-medium text-slate-500">
              {card.who}
            </span>
            {card.text}
          </span>
        </motion.div>
      ))}
    </div>
  );
}

/** A quiet footer row for the setup scenes: what this choice carries into. */
export function Caption({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center gap-5 text-[12.5px] text-slate-600">
      {children}
    </div>
  );
}

export function CaptionItem({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Check
        className="h-3.5 w-3.5 transition-colors duration-500"
        style={{ color: "var(--b)" }}
        strokeWidth={2.5}
        aria-hidden="true"
      />
      {children}
    </span>
  );
}

function WindowBar({ url }: { url?: string }) {
  return (
    <div className="relative flex h-7 shrink-0 items-center gap-1.5 border-b border-slate-100 bg-slate-50 px-3">
      <span className="h-2 w-2 rounded-full bg-slate-200" />
      <span className="h-2 w-2 rounded-full bg-slate-200" />
      <span className="h-2 w-2 rounded-full bg-slate-200" />
      {url ? (
        <span className="absolute left-1/2 flex max-w-[60%] -translate-x-1/2 items-center gap-1 truncate rounded-md bg-white px-2.5 py-0.5 text-[10px] text-slate-500 ring-1 ring-slate-200">
          <Lock className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{url}</span>
        </span>
      ) : null}
    </div>
  );
}

const windowFrame =
  "flex h-full shrink-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white text-slate-800 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_28px_-16px_rgba(15,23,42,0.25)]";

/** The OpenVPM workspace: the clinic's sidebar and one page. */
export function AppWindow({
  clinicName,
  logo,
  modules,
  active,
  title,
  actions,
  width = WINDOW_WIDTH,
  children,
}: {
  clinicName: string;
  logo?: string | null;
  modules: string[];
  active: string;
  title: ReactNode;
  actions?: ReactNode;
  width?: number;
  children: ReactNode;
}) {
  return (
    <div className={windowFrame} style={{ width }}>
      <WindowBar />
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[128px] shrink-0 flex-col border-r border-slate-100">
          <div className="flex h-11 items-center gap-2 border-b border-slate-100 px-2.5">
            <ClinicMark name={clinicName} logo={logo} size={22} />
            <span className="line-clamp-2 text-[11px] font-semibold leading-tight">
              {clinicName}
            </span>
          </div>
          <ul className="space-y-0.5 p-1.5">
            {modules.map((module, i) => {
              const Icon = MODULE_ICONS[module] ?? FileText;
              const on = module === active;
              return (
                <motion.li
                  key={module}
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.03 }}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-[5px] text-[11px] font-medium transition-colors duration-500",
                    on ? "text-[var(--b)]" : "text-slate-500",
                  )}
                  style={
                    on
                      ? { background: "color-mix(in srgb, var(--b) 10%, white)" }
                      : undefined
                  }
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {module}
                </motion.li>
              );
            })}
          </ul>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-slate-100 px-4">
            <span className="truncate font-heading text-[13px] font-semibold">
              {title}
            </span>
            {actions}
          </div>
          <div className="relative min-h-0 flex-1 overflow-hidden p-3.5">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A browser or mail window without the workspace sidebar. */
export function BrowserWindow({
  url,
  width = WINDOW_WIDTH,
  className,
  children,
}: {
  url?: string;
  width?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={windowFrame} style={{ width }}>
      <WindowBar url={url} />
      <div className={cn("relative min-h-0 flex-1 overflow-hidden", className)}>
        {children}
      </div>
    </div>
  );
}

/** A client's phone. `time` is the story clock, shown in the status bar. */
export function Phone({
  time = "9:41",
  dark = false,
  children,
  overlay,
}: {
  time?: string;
  /** A darker status bar for screens with a gray background. */
  dark?: boolean;
  children: ReactNode;
  overlay?: ReactNode;
}) {
  return (
    <div
      className="shrink-0 rounded-[30px] bg-slate-900 p-[6px] shadow-[0_12px_28px_-14px_rgba(15,23,42,0.45)]"
      style={{ width: PHONE_WIDTH, height: DEVICE_HEIGHT }}
    >
      <div
        className={cn(
          "relative flex h-full flex-col overflow-hidden rounded-[24px] text-[11px] text-slate-800",
          dark ? "bg-slate-50" : "bg-white",
        )}
      >
        <div className="flex h-6 shrink-0 items-center justify-between px-4 pt-0.5 text-[9.5px] font-semibold">
          <span>{time}</span>
          <span className="flex items-center gap-0.5" aria-hidden="true">
            <Signal className="h-2.5 w-2.5" />
            <Wifi className="h-2.5 w-2.5" />
            <BatteryFull className="h-3 w-3" />
          </span>
        </div>
        <div className="relative min-h-0 flex-1 overflow-hidden">{children}</div>
        {overlay}
      </div>
    </div>
  );
}

/** The client portal's header, as clinics' clients see it. */
export function PortalHeader({
  clinicName,
  logo,
}: {
  clinicName: string;
  logo?: string | null;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-slate-100 bg-white px-3 py-2">
      <ClinicMark name={clinicName} logo={logo} size={28} />
      <div className="min-w-0">
        <div className="truncate text-[11px] font-semibold">{clinicName}</div>
        <div
          className="text-[10px] font-medium transition-colors duration-500"
          style={{ color: "var(--b)" }}
        >
          Pet Portal
        </div>
      </div>
    </div>
  );
}

/** The public booking page's header card. */
export function BookingHeader({
  clinicName,
  logo,
}: {
  clinicName: string;
  logo?: string | null;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl bg-white p-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.06)]">
      <ClinicMark name={clinicName} logo={logo} size={30} className="rounded-lg" />
      <div className="min-w-0">
        <div className="truncate text-[11.5px] font-bold">{clinicName}</div>
        <div className="text-[10px] text-slate-500">Request an appointment</div>
      </div>
    </div>
  );
}

export function PhoneOverlay({
  on,
  title,
  detail,
}: {
  on: boolean;
  title: string;
  detail: ReactNode;
}) {
  return (
    <AnimatePresence>
      {on ? (
        <motion.div
          className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-white p-4 text-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.span
            className="mb-1 flex h-11 w-11 items-center justify-center rounded-full text-white"
            style={{ background: "var(--b)" }}
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 380, damping: 22, delay: 0.08 }}
          >
            <Check className="h-5 w-5" strokeWidth={3} aria-hidden="true" />
          </motion.span>
          <b className="text-[12.5px]">{title}</b>
          <span className="leading-4 text-slate-500">{detail}</span>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/** A status pill in the app's style: a colored dot and a label. */
export function StatusPill({
  label,
  tone,
}: {
  label: string;
  tone: "gray" | "blue" | "amber" | "green" | "brand";
}) {
  const dot = {
    gray: "#94a3b8",
    blue: "#3b82f6",
    amber: "#f59e0b",
    green: "#22c55e",
    brand: "var(--b)",
  }[tone];
  return (
    <motion.span
      key={label}
      initial={{ opacity: 0.4 }}
      animate={{ opacity: 1 }}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-medium text-slate-600"
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: dot }} />
      {label}
    </motion.span>
  );
}
