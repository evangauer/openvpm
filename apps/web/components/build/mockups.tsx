"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import styles from "./build.module.css";

/** "CA" for "Cedar Animal Hospital"; a stand-in until a logo is uploaded. */
export function clinicInitials(name: string): string {
  const letters = name.match(/\b[A-Za-z]/g) ?? [];
  return (letters.slice(0, 2).join("") || "C").toUpperCase();
}

export function ClinicMark({
  name,
  onBrand = false,
}: {
  name: string;
  onBrand?: boolean;
}) {
  return (
    <span className={cn(styles.logo, onBrand && styles.logoOnBrand)}>
      {clinicInitials(name)}
    </span>
  );
}

export function Stage({
  children,
  caption,
  className,
}: {
  children: ReactNode;
  caption?: string;
  className?: string;
}) {
  return (
    <div className={cn(styles.stage, className)}>
      {children}
      {caption ? <div className={styles.caption}>{caption}</div> : null}
    </div>
  );
}

export function Desk({
  clinicName,
  modules,
  active,
  title,
  width,
  children,
}: {
  clinicName: string;
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
            <ClinicMark name={clinicName} />
            <span className="truncate">{clinicName.split(" ")[0]}</span>
          </div>
          {modules.map((module, i) => (
            <div
              key={module}
              className={cn(
                styles.sideItem,
                module === active && styles.sideItemActive,
              )}
              style={{ animationDelay: `${i * 70}ms` }}
            >
              {module}
            </div>
          ))}
        </div>
        <div className={styles.deskMain}>
          <h4 className={styles.deskTitle}>{title}</h4>
          {children}
        </div>
      </div>
    </div>
  );
}

export function Phone({
  clinicName,
  subtitle,
  children,
  overlay,
}: {
  clinicName: string;
  subtitle?: string;
  children: ReactNode;
  overlay?: ReactNode;
}) {
  return (
    <div className={styles.phone}>
      <div className={styles.screen}>
        {subtitle !== undefined ? (
          <div className={styles.phoneHeader}>
            <div className={styles.phoneHeaderName}>
              <ClinicMark name={clinicName} onBrand />
              <span className="truncate">{clinicName}</span>
            </div>
            <span className={styles.phoneHeaderSub}>{subtitle}</span>
          </div>
        ) : null}
        {children}
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
    <div className={cn(styles.overlay, on && styles.overlayOn)} aria-hidden={!on}>
      <div className={styles.tick}>✓</div>
      <b>{title}</b>
      <span className="text-slate-500">{detail}</span>
    </div>
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
    <div className={cn(styles.row, fresh && styles.rowNew)}>
      <span className={styles.rowTime}>{time}</span>
      <b>{pet}</b>
      <span className="truncate">{what}</span>
      <span
        className={cn(
          styles.badge,
          tone === "good" && styles.badgeGood,
          tone === "brand" && styles.badgeBrand,
        )}
      >
        {status}
      </span>
    </div>
  );
}

export { styles as buildStyles };
