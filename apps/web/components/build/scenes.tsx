"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { ImagePlus, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  BUILD_BRAND_COLORS,
  BUILD_PRACTICE_PROFILES,
  BUILD_PRACTICE_TYPES,
  BUILD_SERVICE_PRICE_MAX,
  BUILD_SYSTEM_LABELS,
  BUILD_SYSTEMS,
  type BuildPracticeType,
  type BuildSystem,
} from "@/lib/build/catalog";
import { suggestBookingSlug } from "@/lib/booking/page-config";
import { processLogo } from "@/lib/build/logo";
import {
  buildStyles as styles,
  ClinicMark,
  Desk,
  Phone,
  PhoneOverlay,
  ScheduleRow,
  Stage,
  WinCards,
  type StoryWin,
} from "./mockups";

export interface BuildServiceChoice {
  name: string;
  price: number;
  on: boolean;
}

export interface BuildState {
  practiceType: BuildPracticeType;
  currentSystem: BuildSystem;
  clinicName: string;
  brandColor: string;
  services: BuildServiceChoice[];
  /** A small PNG data URL of their logo, kept in this browser only. */
  logo: string | null;
}

export interface SceneProps {
  draft: BuildState;
  update: (patch: Partial<BuildState>) => void;
  /** Changes on every visit or replay, restarting the scene's animation. */
  playId: number;
  /** Reduced motion: show each scene's end state without animating. */
  still: boolean;
}

export function servicesFor(type: BuildPracticeType): BuildServiceChoice[] {
  return BUILD_PRACTICE_PROFILES[type].services.map((service) => ({
    ...service,
    on: true,
  }));
}

/** The clinic's name inside a sentence: "Let's build your clinic…". */
export function displayName(draft: BuildState): string {
  return draft.clinicName.trim() || "your clinic";
}

/** The clinic's name as it appears on its own screens. */
export function brandName(draft: BuildState): string {
  return draft.clinicName.trim() || "Your clinic";
}

export function sampleFor(draft: BuildState) {
  return BUILD_PRACTICE_PROFILES[draft.practiceType].sample;
}

export function sampleTotal(draft: BuildState): number {
  return sampleFor(draft).charges.reduce((sum, line) => sum + line.price, 0);
}

export function money(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: value % 1 ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}

function isFromPaper(draft: BuildState): boolean {
  return draft.currentSystem === "paper" || draft.currentSystem === "other";
}

/**
 * Steps through a scene's beats: `at[i]` is when beat i+1 begins (ms after
 * the scene starts). Returns how many beats have played.
 */
function useBeats(at: readonly number[], playId: number, still: boolean) {
  const [beat, setBeat] = useState(still ? at.length : 0);
  useEffect(() => {
    if (still) {
      setBeat(at.length);
      return;
    }
    setBeat(0);
    const timers = at.map((ms, i) => setTimeout(() => setBeat(i + 1), ms));
    return () => timers.forEach(clearTimeout);
    // The beat schedule is static per scene; replay keys off playId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playId, still]);
  return beat;
}

function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      whileTap={{ scale: 0.96 }}
      className={cn(
        "rounded-full border px-3.5 py-2 text-sm transition-colors",
        on
          ? "border-[var(--b)] bg-[color-mix(in_srgb,var(--b)_12%,white)] font-semibold text-slate-900"
          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
      )}
    >
      {children}
    </motion.button>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <p className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-slate-500 first:mt-0">
      {children}
    </p>
  );
}

// ---------------------------------------------------------------------------
// 1. Practice
// ---------------------------------------------------------------------------

export function PracticeControls({ draft, update }: SceneProps) {
  return (
    <div>
      <Label>How do you practice?</Label>
      <div className="flex flex-wrap gap-2">
        {BUILD_PRACTICE_TYPES.map((type) => (
          <Chip
            key={type}
            on={draft.practiceType === type}
            onClick={() =>
              update({ practiceType: type, services: servicesFor(type) })
            }
          >
            {BUILD_PRACTICE_PROFILES[type].label}
          </Chip>
        ))}
      </div>
      <Label>What do you use today?</Label>
      <div className="flex flex-wrap gap-2">
        {BUILD_SYSTEMS.map((system) => (
          <Chip
            key={system}
            on={draft.currentSystem === system}
            onClick={() => update({ currentSystem: system })}
          >
            {BUILD_SYSTEM_LABELS[system]}
          </Chip>
        ))}
      </div>
    </div>
  );
}

export function PracticeStage({ draft }: SceneProps) {
  const profile = BUILD_PRACTICE_PROFILES[draft.practiceType];
  const lines = [
    ...profile.traits,
    isFromPaper(draft)
      ? "Start fresh, or import a spreadsheet"
      : `Bring your records from ${BUILD_SYSTEM_LABELS[draft.currentSystem]}`,
  ];
  return (
    <Stage>
      <Desk
        key={draft.practiceType}
        clinicName={brandName(draft)}
        logo={draft.logo}
        modules={profile.modules}
        active="Schedule"
        title={`Shaped for ${profile.plural}`}
      >
        {lines.map((line, i) => (
          <motion.div
            key={`${draft.currentSystem}-${line}`}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.15 + i * 0.12 }}
            className={cn(styles.row, "!border-l-[var(--b)]")}
          >
            <b>{i < profile.traits.length ? "✓" : "↪"}</b>
            {line}
          </motion.div>
        ))}
      </Desk>
    </Stage>
  );
}

// ---------------------------------------------------------------------------
// 2. Brand
// ---------------------------------------------------------------------------

export function BrandControls({ draft, update }: SceneProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setNote(null);
    try {
      const logo = await processLogo(file);
      update(
        logo.color
          ? { logo: logo.dataUrl, brandColor: logo.color }
          : { logo: logo.dataUrl },
      );
      setNote(logo.color ? "We matched your colour to your logo." : null);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "That image didn't work.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div>
      <Label>Clinic name</Label>
      <input
        value={draft.clinicName}
        onChange={(event) => update({ clinicName: event.target.value })}
        maxLength={120}
        placeholder="Neighborhood Veterinary"
        autoComplete="organization"
        className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-[var(--b)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--b)_25%,white)]"
      />
      <Label>Logo</Label>
      <div className="flex items-center gap-3">
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          className="sr-only"
          onChange={(event) => void onFile(event.target.files?.[0])}
          aria-label="Upload your logo"
        />
        {draft.logo ? (
          <>
            <ClinicMark name={brandName(draft)} logo={draft.logo} size={44} />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="text-sm font-medium text-slate-700 underline-offset-4 hover:underline"
            >
              Change
            </button>
            <button
              type="button"
              onClick={() => update({ logo: null })}
              className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"
            >
              <X className="h-3.5 w-3.5" />
              Remove
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="inline-flex h-11 items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:border-[var(--b)]"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ImagePlus className="h-4 w-4" />
            )}
            Upload your logo
          </button>
        )}
      </div>
      {note ? <p className="mt-2 text-sm text-slate-500">{note}</p> : null}
      <Label>Brand colour</Label>
      <div className="flex flex-wrap items-center gap-2">
        {BUILD_BRAND_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={`Use ${color}`}
            aria-pressed={draft.brandColor === color}
            onClick={() => update({ brandColor: color })}
            className={cn(
              "h-8 w-8 rounded-lg border-2 border-white shadow-[0_0_0_1px_#cbd5e1] transition-transform",
              draft.brandColor === color &&
                "scale-110 shadow-[0_0_0_2px_#0f172a]",
            )}
            style={{ background: color }}
          />
        ))}
        <label className="ml-1 inline-flex cursor-pointer items-center gap-2 text-sm text-slate-600">
          <input
            type="color"
            value={draft.brandColor}
            onChange={(event) => update({ brandColor: event.target.value })}
            className="h-8 w-8 cursor-pointer rounded-lg border border-slate-200 bg-white p-0.5"
          />
          Exact colour
        </label>
      </div>
    </div>
  );
}

export function BrandStage({ draft }: SceneProps) {
  const name = brandName(draft);
  const sample = sampleFor(draft);
  const dueLabel = sample.due
    .replace(/^an? /, "")
    .replace(/^./, (c) => c.toUpperCase());
  return (
    <Stage>
      <Phone
        clinicName={name}
        logo={draft.logo}
        subtitle="Client portal"
        tabs={{ items: ["Home", "Pets", "Visits", "Bills"], active: "Home" }}
      >
        <div className={styles.phoneBody}>
          <div className="mb-1.5 font-semibold">Hi {sample.owner} 👋</div>
          <div className={styles.item}>
            <span className="truncate">
              {sample.pet} · {sample.visit}
            </span>
            <b>Tue</b>
          </div>
          <div className={styles.item}>
            <span className="truncate">{dueLabel} due</span>
            <b style={{ color: "var(--b)" }}>Book</b>
          </div>
          <div className={styles.item}>
            <span>Invoice #1042</span>
            <b>{money(sampleTotal(draft))}</b>
          </div>
        </div>
      </Phone>
      <div className={styles.email}>
        <div className={styles.emailHead}>
          <ClinicMark name={name} logo={draft.logo} onBrand />
          <span className="truncate">{name}</span>
        </div>
        <div className={styles.emailBody}>
          <b>Reminder: {sample.pet}&apos;s visit</b>
          <br />
          Tuesday at 9:00 AM.
          <br />
          <span className={styles.emailButton}>View appointment</span>
        </div>
      </div>
    </Stage>
  );
}

// ---------------------------------------------------------------------------
// 3. Services
// ---------------------------------------------------------------------------

export function ServicesControls({ draft, update }: SceneProps) {
  const set = (index: number, patch: Partial<BuildServiceChoice>) =>
    update({
      services: draft.services.map((service, i) =>
        i === index ? { ...service, ...patch } : service,
      ),
    });
  return (
    <div className="space-y-2">
      {draft.services.map((service, i) => (
        <div
          key={service.name}
          className={cn(
            "flex items-center gap-3 rounded-xl border bg-white px-3 py-2 transition-colors",
            service.on ? "border-[var(--b)]" : "border-slate-200 opacity-60",
          )}
        >
          <input
            type="checkbox"
            checked={service.on}
            onChange={(event) => set(i, { on: event.target.checked })}
            aria-label={`Offer ${service.name}`}
            className="h-4 w-4 accent-[var(--b)]"
          />
          <span className="flex-1 text-sm font-medium">{service.name}</span>
          <span className="text-sm text-slate-500">$</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            max={BUILD_SERVICE_PRICE_MAX}
            step="1"
            value={service.price}
            onChange={(event) => {
              const price = Number(event.target.value);
              if (Number.isFinite(price) && price >= 0) set(i, { price });
            }}
            aria-label={`${service.name} price`}
            className="h-8 w-20 rounded-lg border border-slate-200 px-2 text-right text-sm"
          />
        </div>
      ))}
    </div>
  );
}

export function ServicesStage({ draft }: SceneProps) {
  const name = brandName(draft);
  const offered = draft.services.filter((service) => service.on);
  const slug = suggestBookingSlug(name) || "your-clinic";
  return (
    <Stage>
      <Phone clinicName={name} logo={draft.logo} subtitle="Book online">
        <div className={styles.phoneBody}>
          <div className="mb-1.5 font-semibold">What does your pet need?</div>
          {offered.map((service) => (
            <motion.div
              layout
              key={service.name}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              className={styles.item}
            >
              <span className="truncate">{service.name}</span>
              <b>{money(service.price)}</b>
            </motion.div>
          ))}
        </div>
      </Phone>
      <div className="max-w-[230px] self-center text-sm leading-6 text-slate-600">
        <b className="text-slate-900">Your booking page, ready to share.</b>
        <div className="my-2 truncate rounded-lg bg-white/90 px-2.5 py-1.5 font-mono text-[11px] text-slate-700 shadow-sm">
          app.openvpm.com/book/{slug}
        </div>
        Put it on your website or Google profile. Requests land on your
        schedule without phone tag.
      </div>
    </Stage>
  );
}

// ---------------------------------------------------------------------------
// Story scenes: a day at the clinic, with a win for the client and for you.
// ---------------------------------------------------------------------------

export function bookWin(draft: BuildState): StoryWin {
  const { owner, pet } = sampleFor(draft);
  return {
    client: `${owner} booked at 9:41 PM in under a minute. No phone call.`,
    you: `It's on your schedule with ${pet}'s chart started. No phone tag.`,
  };
}

export function BookStage({ draft, playId, still }: SceneProps) {
  const beat = useBeats([900, 1700, 2500, 2900, 3700], playId, still);
  const name = brandName(draft);
  const offered = draft.services.filter((service) => service.on).slice(0, 3);
  const first = offered[0]?.name ?? "Wellness Exam";
  const sample = sampleFor(draft);
  const profile = BUILD_PRACTICE_PROFILES[draft.practiceType];
  return (
    <Stage
      clock="Monday · 9:41 PM"
      footer={<WinCards win={bookWin(draft)} show={beat >= 5} />}
    >
      <Phone
        clinicName={name}
        logo={draft.logo}
        subtitle="Book online"
        overlay={
          <PhoneOverlay
            on={beat >= 4}
            title="Request sent!"
            detail={
              <>
                Tue 9:00 · {first}
                <br />
                {name} will confirm shortly
              </>
            }
          />
        }
      >
        <div className={styles.phoneBody}>
          <div className="mb-1.5 font-semibold">Pick a service</div>
          {offered.map((service, i) => (
            <div
              key={service.name}
              className={cn(styles.item, i === 0 && beat >= 1 && styles.itemPicked)}
            >
              <span className="truncate">{service.name}</span>
              <b>{money(service.price)}</b>
            </div>
          ))}
          <div className={styles.slots}>
            {["8:30", "9:00", "9:30", "1:00", "2:30", "4:00"].map((slot) => (
              <span
                key={slot}
                className={cn(
                  styles.slot,
                  slot === "9:00" && beat >= 2 && styles.slotPicked,
                )}
              >
                {slot}
              </span>
            ))}
          </div>
          <motion.div
            className={styles.cta}
            animate={{ scale: beat === 3 ? 0.94 : 1 }}
          >
            Request appointment
          </motion.div>
        </div>
      </Phone>
      <Desk
        clinicName={name}
        logo={draft.logo}
        modules={profile.modules}
        active="Schedule"
        title="Tuesday · Schedule"
      >
        <ScheduleRow time="8:00" pet="Luna" what="Recheck" status="Booked" />
        {beat >= 4 ? (
          <ScheduleRow
            time="9:00"
            pet={sample.pet}
            what={first}
            status="New · online"
            tone="brand"
            fresh
          />
        ) : null}
        <ScheduleRow time="10:30" pet="Mango" what="Dental" status="Booked" />
      </Desk>
    </Stage>
  );
}

export function remindWin(draft: BuildState): StoryWin {
  const { owner } = sampleFor(draft);
  return {
    client: `${owner} got a friendly heads-up from you, right on time.`,
    you: "Reminders and recalls went out while you made coffee.",
  };
}

export function RemindStage({ draft, playId, still }: SceneProps) {
  const beat = useBeats([500, 1600, 2600, 3400], playId, still);
  const name = brandName(draft);
  const sample = sampleFor(draft);
  const profile = BUILD_PRACTICE_PROFILES[draft.practiceType];
  const bubble = (on: boolean) => ({
    initial: false as const,
    animate: on ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 },
    transition: { type: "spring" as const, stiffness: 300, damping: 24 },
  });
  return (
    <Stage
      clock="Tuesday · 8:00 AM"
      footer={<WinCards win={remindWin(draft)} show={beat >= 4} />}
    >
      <Phone clinicName={name}>
        <div className={styles.thread}>
          <div className="flex items-center justify-center gap-1.5 text-[10px] text-slate-500">
            <ClinicMark name={name} logo={draft.logo} size={16} />
            {name}
          </div>
          <motion.div
            className={cn(styles.bubble, styles.bubbleIn, styles.bubbleOn)}
            {...bubble(beat >= 1)}
          >
            Hi {sample.owner}, this is {name}. {sample.pet}&apos;s{" "}
            {sample.visit.toLowerCase()} is tomorrow at 9:00 AM. See you then!
          </motion.div>
          <motion.div
            className={cn(styles.bubble, styles.bubbleIn, styles.bubbleOn)}
            {...bubble(beat >= 3)}
          >
            {sample.pet} is due for {sample.due}. Book a time online whenever
            it suits you.
          </motion.div>
        </div>
      </Phone>
      <Desk
        clinicName={name}
        logo={draft.logo}
        modules={profile.modules}
        active="Reminders"
        title="Tomorrow · Reminders"
      >
        <ScheduleRow time="8:00" pet="Luna" what="Recheck" status="Sent" tone="good" />
        <ScheduleRow
          time="9:00"
          pet={sample.pet}
          what={sample.visit}
          status={beat >= 2 ? "Text + email sent" : "Queued"}
          tone={beat >= 2 ? "good" : "neutral"}
        />
        <ScheduleRow time="10:30" pet="Mango" what="Dental" status="Sent" tone="good" />
        <motion.div
          className={cn(styles.row, "!border-l-[var(--b)]")}
          animate={{ opacity: beat >= 3 ? 1 : 0.45 }}
        >
          <b>↻</b>
          <span className="truncate">{sample.recall}</span>
          <span className={cn(styles.badge, beat >= 3 && styles.badgeBrand)}>
            {beat >= 3 ? "Sending" : "Ready"}
          </span>
        </motion.div>
      </Desk>
    </Stage>
  );
}

export function visitWin(draft: BuildState): StoryWin {
  const { pet } = sampleFor(draft);
  return {
    client: `${pet} got your full attention, not your keyboard.`,
    you: "The note was drafted for you. Review it, sign it, done.",
  };
}

export function VisitStage({ draft, playId, still }: SceneProps) {
  const sample = sampleFor(draft);
  const soap = sample.soap.join("\n");
  const beat = useBeats([600, 4400, 4800, 5200, 5900, 6500], playId, still);
  const [typed, setTyped] = useState(still ? soap.length : 0);
  useEffect(() => {
    if (still) {
      setTyped(soap.length);
      return;
    }
    setTyped(0);
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    const start = setTimeout(function tick() {
      i = Math.min(soap.length, i + 3);
      setTyped(i);
      if (i < soap.length) timer = setTimeout(tick, 28);
    }, 700);
    return () => {
      clearTimeout(start);
      clearTimeout(timer);
    };
  }, [playId, still, soap]);

  const profile = BUILD_PRACTICE_PROFILES[draft.practiceType];
  const status =
    beat >= 5 ? "Ready for checkout" : beat >= 1 ? "In exam" : "Checked in";
  return (
    <Stage
      clock="Tuesday · 9:00 AM"
      footer={<WinCards win={visitWin(draft)} show={beat >= 6} />}
    >
      <Desk
        clinicName={brandName(draft)}
        logo={draft.logo}
        modules={profile.modules}
        active="Records"
        width={470}
        title={
          <span className="flex items-center gap-2">
            {sample.pet} · {sample.visit}
            <motion.span
              key={status}
              initial={{ scale: 0.85, opacity: 0.4 }}
              animate={{ scale: 1, opacity: 1 }}
              className={cn(styles.badge, styles.badgeBrand)}
            >
              {status}
            </motion.span>
          </span>
        }
      >
        <div
          className={cn(
            styles.note,
            typed < soap.length && typed > 0 && styles.typing,
          )}
        >
          {typed === 0 ? (
            <span className="text-slate-500">✨ Drafting from your exam…</span>
          ) : (
            soap.slice(0, typed)
          )}
        </div>
        <h4 className={cn(styles.deskTitle, "mt-3")}>Charges</h4>
        {sample.charges.slice(0, Math.max(0, beat - 1)).map((line) => (
          <motion.div
            key={line.label}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            className={styles.line}
          >
            <span>{line.label}</span>
            <span>{money(line.price)}</span>
          </motion.div>
        ))}
      </Desk>
    </Stage>
  );
}

const COLLECTED_BEFORE = 1092;

export function paidWin(draft: BuildState): StoryWin {
  const { owner } = sampleFor(draft);
  return {
    client: `${owner} paid from their phone in one tap.`,
    you: `${money(sampleTotal(draft))} collected before they left. Nothing to chase.`,
  };
}

export function PaidStage({ draft, playId, still }: SceneProps) {
  const beat = useBeats([1200, 1500, 2600], playId, still);
  const sample = sampleFor(draft);
  const total = sampleTotal(draft);
  const after = COLLECTED_BEFORE + total;
  const [collected, setCollected] = useState(still ? after : COLLECTED_BEFORE);
  useEffect(() => {
    if (beat < 2) {
      setCollected(still ? after : COLLECTED_BEFORE);
      return;
    }
    let value = COLLECTED_BEFORE;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      value = Math.min(after, value + Math.max(1, Math.round(total / 18)));
      setCollected(value);
      if (value < after) timer = setTimeout(step, 16);
    };
    step();
    return () => clearTimeout(timer);
  }, [beat, still, after, total]);

  const name = brandName(draft);
  const paid = beat >= 2;
  return (
    <Stage
      clock="Tuesday · 9:42 AM"
      footer={<WinCards win={paidWin(draft)} show={beat >= 3} />}
    >
      <Phone
        clinicName={name}
        logo={draft.logo}
        subtitle="Invoice #1042"
        tabs={{ items: ["Home", "Pets", "Visits", "Bills"], active: "Bills" }}
        overlay={
          <PhoneOverlay
            on={paid}
            title={`Paid · ${money(total)}`}
            detail={`Receipt sent to ${sample.owner}`}
          />
        }
      >
        <div className={styles.phoneBody}>
          {sample.charges.map((line) => (
            <div key={line.label} className={styles.line}>
              <span>{line.label}</span>
              <span>{money(line.price)}</span>
            </div>
          ))}
          <div className="my-2 flex justify-between font-bold">
            Total<span>{money(total)}</span>
          </div>
          <motion.div
            className={styles.cta}
            animate={{ scale: beat === 1 ? 0.94 : 1 }}
          >
            Pay {money(total)}
          </motion.div>
        </div>
      </Phone>
      <div className={styles.desk} style={{ width: 300 }}>
        <div className={styles.deskBar} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className={styles.deskMain}>
          <h4 className={styles.deskTitle}>Today</h4>
          <div className={styles.kpis}>
            <div className={styles.kpi}>
              <small>Visits</small>
              <b>8</b>
            </div>
            <div className={styles.kpi}>
              <small>Collected</small>
              <b>${collected.toLocaleString("en-US")}</b>
            </div>
            <div className={styles.kpi}>
              <small>Unpaid</small>
              <b>{paid ? "$0" : money(total)}</b>
            </div>
          </div>
          <ScheduleRow
            time="9:00"
            pet={sample.pet}
            what={sample.visit}
            status={paid ? "Paid ✓" : "Visit done"}
            tone={paid ? "good" : "neutral"}
          />
        </div>
      </div>
    </Stage>
  );
}

// ---------------------------------------------------------------------------
// 8. Records and fit
// ---------------------------------------------------------------------------

export function RecordsStage({ draft, playId, still }: SceneProps) {
  const beat = useBeats([300, 650, 1000, 1350], playId, still);
  const profile = BUILD_PRACTICE_PROFILES[draft.practiceType];
  const source = BUILD_SYSTEM_LABELS[draft.currentSystem];
  const fromPaper = isFromPaper(draft);
  const meters: Array<[string, string]> = [
    ["Clients", "100%"],
    ["Patients", "100%"],
    ["Vaccine history", "92%"],
    ["Visit notes", "78%"],
  ];
  return (
    <Stage className="flex-col !items-stretch">
      <div className={styles.panel}>
        <div className="mb-2 font-semibold">
          Import preview · {fromPaper ? "your spreadsheet" : `${source} export`}
        </div>
        {meters.map(([label, width], i) => (
          <div key={label}>
            <div className="text-[11px]">{label}</div>
            <div className={styles.meter}>
              <i style={{ width: beat > i ? width : "0%" }} />
            </div>
          </div>
        ))}
        <div className="text-[11px] text-slate-500">
          Nothing is saved until you review it. Your current system stays in
          place while you try OpenVPM.
        </div>
      </div>
      <div className="grid w-full gap-3 sm:grid-cols-2">
        <div className={styles.panel}>
          <b>Ready for {profile.plural}</b>
          <ul className="mt-2 space-y-1 text-[12.5px]">
            {profile.ready.map((line) => (
              <li key={line} className={styles.check}>
                {line}
              </li>
            ))}
          </ul>
        </div>
        <div className={styles.panel}>
          <b>Being straight with you</b>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-[12.5px]">
            {profile.onTheWay.map((line) => (
              <li key={line}>Not yet: {line.toLowerCase()}</li>
            ))}
            <li>
              Missing something you rely on
              {fromPaper ? "" : ` in ${source}`}? Tell us, and we&apos;ll
              show you a workaround or when it&apos;s coming.
            </li>
          </ul>
        </div>
      </div>
    </Stage>
  );
}

// ---------------------------------------------------------------------------
// 9. The gate: your day, recapped, and what's waiting inside
// ---------------------------------------------------------------------------

export function GateStage({ draft }: SceneProps) {
  const name = brandName(draft);
  const profile = BUILD_PRACTICE_PROFILES[draft.practiceType];
  const offered = draft.services.filter((service) => service.on).length;
  const tiles = [
    { big: "1", small: "booking, no phone call" },
    { big: "2", small: "reminders sent for you" },
    { big: "1", small: "note drafted for you" },
    { big: money(sampleTotal(draft)), small: "collected on the spot" },
  ];
  const lines = [
    `${draft.logo ? "Your logo and " : ""}${name} colours on your portal, booking page & reminders`,
    `${offered} service${offered === 1 ? "" : "s"} on your price list`,
    `A booking page ready to publish at /book/${suggestBookingSlug(name) || "your-clinic"}`,
    `Shaped for ${profile.plural}`,
    isFromPaper(draft)
      ? "A spreadsheet import whenever you're ready"
      : `An import from ${BUILD_SYSTEM_LABELS[draft.currentSystem]}, ready to review`,
  ];
  return (
    <Stage className="!min-h-0 flex-col !items-stretch">
      <div className="w-full">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Your day at {name}
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {tiles.map((tile, i) => (
            <motion.div
              key={tile.small}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 320, damping: 24, delay: i * 0.1 }}
              className="rounded-xl bg-white/95 p-3 shadow-sm"
            >
              <div
                className="font-heading text-2xl font-bold"
                style={{ color: "var(--b)" }}
              >
                {tile.big}
              </div>
              <div className="text-[12px] leading-4 text-slate-600">
                {tile.small}
              </div>
            </motion.div>
          ))}
        </div>
      </div>
      <div className={cn(styles.panel, "w-full")}>
        <b className="text-base">Waiting inside {name}</b>
        <ul className="mt-3 space-y-2 text-sm">
          {lines.map((line, i) => (
            <motion.li
              key={line}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.4 + i * 0.08 }}
              className={styles.check}
            >
              {line}
            </motion.li>
          ))}
        </ul>
      </div>
    </Stage>
  );
}
