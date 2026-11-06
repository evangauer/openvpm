"use client";

import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Bell,
  CalendarDays,
  ClipboardList,
  FileText,
  Globe,
  Inbox,
  Layers,
  LayoutDashboard,
  PawPrint,
  Plus,
  Receipt,
  Search,
  Users,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import styles from "./build.module.css";

const MODULE_ICONS: Record<string, LucideIcon> = {
  Dashboard: LayoutDashboard,
  Schedule: CalendarDays,
  Whiteboard: ClipboardList,
  Patients: PawPrint,
  Clients: Users,
  Records: FileText,
  Billing: Receipt,
  "Client portal": Globe,
  Reminders: Bell,
  Templates: Layers,
  Inbox: Inbox,
};

/** "CA" for "Cedar Animal Hospital"; a stand-in until a logo is uploaded. */
export function clinicInitials(name: string): string {
  const letters = name.match(/\b[A-Za-z]/g) ?? [];
  return (letters.slice(0, 2).join("") || "C").toUpperCase();
}

export function ClinicMark({
  name,
  logo,
  onBrand = false,
  size = 22,
}: {
  name: string;
  logo?: string | null;
  onBrand?: boolean;
  size?: number;
}) {
  if (logo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- local data URL preview
      <img
        src={logo}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-md bg-white object-contain"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className={cn(styles.logo, onBrand && styles.logoOnBrand)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {clinicInitials(name)}
    </span>
  );
}

/** The day-in-the-life clock shown on story scenes ("Mon · 9:41 PM"). */
export function StoryClock({ label }: { label: string }) {
  return (
    <motion.div
      key={label}
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      className="absolute left-3.5 top-3 z-10 rounded-full bg-white/90 px-2.5 py-1 text-[11px] font-semibold text-slate-700 shadow-sm"
    >
      {label}
    </motion.div>
  );
}

export interface StoryWin {
  /** What the client gets out of this moment. */
  client: string;
  /** What the vet and team get. */
  you: string;
}

/** The payoff of a story scene: one win for the client, one for the clinic. */
export function WinCards({ win, show }: { win: StoryWin; show: boolean }) {
  return (
    <div className="grid w-full gap-2 sm:grid-cols-2" aria-live="polite">
      <AnimatePresence>
        {show
          ? [
              { who: "Your client", text: win.client, icon: "🐾" },
              { who: "You", text: win.you, icon: "★" },
            ].map((card, i) => (
              <motion.div
                key={card.who}
                initial={{ opacity: 0, y: 14, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ type: "spring", stiffness: 380, damping: 26, delay: i * 0.15 }}
                className="flex items-start gap-2.5 rounded-xl bg-white/95 px-3 py-2.5 shadow-[0_6px_20px_-8px_rgba(15,23,42,0.25)]"
              >
                <span
                  className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] text-white"
                  style={{ background: "var(--b)" }}
                  aria-hidden="true"
                >
                  {card.icon}
                </span>
                <span className="text-[12.5px] leading-5 text-slate-700">
                  <b className="block text-[11px] uppercase tracking-wide text-slate-500">
                    {card.who}
                  </b>
                  {card.text}
                </span>
              </motion.div>
            ))
          : null}
      </AnimatePresence>
    </div>
  );
}

export function Stage({
  children,
  caption,
  clock,
  footer,
  className,
}: {
  children: ReactNode;
  caption?: string;
  clock?: string;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className={cn(styles.stage, clock && "pt-11", className)}>
        {clock ? <StoryClock label={clock} /> : null}
        {children}
        {caption ? <div className={styles.caption}>{caption}</div> : null}
      </div>
      {footer}
    </div>
  );
}

export function Desk({
  clinicName,
  logo,
  modules,
  active,
  title,
  width,
  children,
}: {
  clinicName: string;
  logo?: string | null;
  modules: string[];
  active?: string;
  title: ReactNode;
  width?: number;
  children: ReactNode;
}) {
  return (
    <div className={styles.desk} style={width ? { width } : undefined}>
      <div className={styles.deskBar} aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className={styles.deskBody}>
        <div className={styles.side}>
          <div className={styles.sideBrand}>
            <ClinicMark name={clinicName} logo={logo} />
            <span className="truncate">{clinicName.split(" ")[0]}</span>
          </div>
          {modules.map((module, i) => {
            const Icon = MODULE_ICONS[module] ?? FileText;
            return (
              <div
                key={module}
                className={cn(
                  styles.sideItem,
                  "flex items-center gap-1.5",
                  module === active && styles.sideItemActive,
                )}
                style={{ animationDelay: `${i * 70}ms` }}
              >
                <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{module}</span>
              </div>
            );
          })}
        </div>
        <div className={styles.deskMain}>
          <div className="mb-2 flex items-center gap-2 border-b border-slate-100 pb-2">
            <span className="flex flex-1 items-center gap-1.5 rounded-md bg-slate-50 px-2 py-1 text-[10px] text-slate-400 ring-1 ring-slate-200">
              <Search className="h-3 w-3" aria-hidden="true" />
              Search…
            </span>
            <span
              className="flex items-center gap-0.5 rounded-md px-2 py-1 text-[10px] font-semibold text-white"
              style={{ background: "var(--b)" }}
            >
              <Plus className="h-3 w-3" aria-hidden="true" />
              New
            </span>
          </div>
          <h4 className={styles.deskTitle}>{title}</h4>
          {children}
        </div>
      </div>
    </div>
  );
}

export function Phone({
  clinicName,
  logo,
  subtitle,
  tabs,
  children,
  overlay,
}: {
  clinicName: string;
  logo?: string | null;
  subtitle?: string;
  /** Portal tab bar, with the active tab first-class. */
  tabs?: { items: string[]; active: string };
  children: ReactNode;
  overlay?: ReactNode;
}) {
  return (
    <div className={styles.phone}>
      <div className={cn(styles.screen, "flex flex-col")}>
        {subtitle !== undefined ? (
          <div className={styles.phoneHeader}>
            <div className={styles.phoneHeaderName}>
              <ClinicMark name={clinicName} logo={logo} onBrand />
              <span className="truncate">{clinicName}</span>
            </div>
            <span className={styles.phoneHeaderSub}>{subtitle}</span>
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        {tabs ? (
          <div className="flex border-t border-slate-100 bg-white px-1 py-1.5">
            {tabs.items.map((item) => (
              <span
                key={item}
                className="flex-1 text-center text-[9.5px] font-medium"
                style={{ color: item === tabs.active ? "var(--b)" : "#94a3b8" }}
              >
                {item}
              </span>
            ))}
          </div>
        ) : null}
        {overlay}
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
          className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-white p-3 text-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            className={styles.tickStatic}
            initial={{ scale: 0, rotate: -30 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 18, delay: 0.1 }}
          >
            ✓
          </motion.div>
          <b>{title}</b>
          <span className="text-slate-500">{detail}</span>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export function ScheduleRow({
  time,
  pet,
  what,
  status,
  tone = "neutral",
  fresh = false,
}: {
  time: string;
  pet: string;
  what: string;
  status: string;
  tone?: "neutral" | "good" | "brand";
  fresh?: boolean;
}) {
  return (
    <motion.div
      layout
      initial={fresh ? { opacity: 0, scale: 0.85, y: -10 } : false}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 420, damping: 24 }}
      className={cn(styles.row, fresh && "!border-l-[var(--b)]")}
    >
      <span className={styles.rowTime}>{time}</span>
      <b>{pet}</b>
      <span className="truncate">{what}</span>
      <motion.span
        key={status}
        initial={{ scale: 0.8, opacity: 0.4 }}
        animate={{ scale: 1, opacity: 1 }}
        className={cn(
          styles.badge,
          tone === "good" && styles.badgeGood,
          tone === "brand" && styles.badgeBrand,
        )}
      >
        {status}
      </motion.span>
    </motion.div>
  );
}

export { styles as buildStyles };
