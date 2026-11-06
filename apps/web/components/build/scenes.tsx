"use client";

import { useEffect, useState, type ReactNode } from "react";
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
import {
  buildStyles as styles,
  Desk,
  Phone,
  PhoneOverlay,
  ScheduleRow,
  Stage,
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

function sampleFor(draft: BuildState) {
  return BUILD_PRACTICE_PROFILES[draft.practiceType].sample;
}

function sampleTotal(draft: BuildState): number {
  return sampleFor(draft).charges.reduce((sum, line) => sum + line.price, 0);
}

function money(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: value % 1 ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
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
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "rounded-full border px-3.5 py-2 text-sm transition-all",
        on
          ? "border-[var(--b)] bg-[color-mix(in_srgb,var(--b)_12%,white)] font-semibold text-slate-900"
          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
      )}
    >
      {children}
    </button>
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
  const fromPaper =
    draft.currentSystem === "paper" || draft.currentSystem === "other";
  return (
    <Stage>
      <Desk
        key={draft.practiceType}
        clinicName={brandName(draft)}
        modules={profile.modules}
        active="Schedule"
        title={`Shaped for ${profile.plural}`}
      >
        {profile.traits.map((trait, i) => (
          <div
            key={trait}
            className={cn(styles.row, styles.rowNew)}
            style={{ animationDelay: `${200 + i * 150}ms` }}
          >
            <b>✓</b>
            {trait}
          </div>
        ))}
        <div
          key={draft.currentSystem}
          className={cn(styles.row, styles.rowNew)}
          style={{ animationDelay: "700ms" }}
        >
          <b>↪</b>
          {fromPaper
            ? "Start fresh, or import a spreadsheet"
            : `Bring your records from ${BUILD_SYSTEM_LABELS[draft.currentSystem]}`}
        </div>
      </Desk>
    </Stage>
  );
}

// ---------------------------------------------------------------------------
// 2. Brand
// ---------------------------------------------------------------------------

export function BrandControls({ draft, update }: SceneProps) {
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
          Your exact colour
        </label>
      </div>
      <p className="mt-4 text-sm leading-6 text-slate-500">
        You&apos;ll add your logo once you&apos;re in. It appears everywhere
        your colour does.
      </p>
    </div>
  );
}

export function BrandStage({ draft }: SceneProps) {
  const name = brandName(draft);
  const sample = sampleFor(draft);
  return (
    <Stage>
      <Phone clinicName={name} subtitle="Client portal">
        <div className={styles.phoneBody}>
          <div className="mb-1.5 font-semibold">Hi {sample.owner} 👋</div>
          <div className={styles.item}>
            <span className="truncate">
              {sample.pet} · {sample.visit}
            </span>
            <b>Tue</b>
          </div>
          <div className={styles.item}>
            <span className="truncate">
              {sample.due.replace(/^an? /, "").replace(/^./, (c) => c.toUpperCase())} due
            </span>
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
          <span className={cn(styles.logo, styles.logoOnBrand)}>
            {name.slice(0, 1).toUpperCase()}
          </span>
          <span className="truncate">{name}</span>
        </div>
        <div className={styles.emailBody}>
          <b>Reminder: {sample.pet}&apos;s visit</b>
          <br />
          Tuesday at 9:00 AM with Dr. Lee.
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
      <p className="pt-1 text-sm text-slate-500">
        These start your price list and your online booking menu. Add the rest
        anytime.
      </p>
    </div>
  );
}

export function ServicesStage({ draft }: SceneProps) {
  const name = brandName(draft);
  const offered = draft.services.filter((service) => service.on);
  return (
    <Stage>
      <Phone clinicName={name} subtitle="Book online">
        <div className={styles.phoneBody}>
          <div className="mb-1.5 font-semibold">What does your pet need?</div>
          {offered.map((service, i) => (
            <div
              key={service.name}
              className={styles.item}
              style={{ animationDelay: `${i * 80}ms` }}
            >
              <span className="truncate">{service.name}</span>
              <b>{money(service.price)}</b>
            </div>
          ))}
        </div>
      </Phone>
      <div className="max-w-[230px] self-center text-sm leading-6 text-slate-600">
        <b className="text-slate-900">
          Clients book themselves, any hour.
        </b>
        <br />
        Share your booking link on your website, Google profile, or social
        pages. Requests land on your schedule without phone tag.
      </div>
    </Stage>
  );
}

// ---------------------------------------------------------------------------
// 4. A client books
// ---------------------------------------------------------------------------

export function BookStage({ draft, playId, still }: SceneProps) {
  const beat = useBeats([900, 1700, 2500, 2900], playId, still);
  const name = brandName(draft);
  const offered = draft.services.filter((service) => service.on).slice(0, 3);
  const first = offered[0]?.name ?? "Wellness Exam";
  const sample = sampleFor(draft);
  const profile = BUILD_PRACTICE_PROFILES[draft.practiceType];
  return (
    <Stage
      caption={
        beat >= 4
          ? `${sample.pet}'s chart, created from the booking`
          : "Online booking → your schedule"
      }
    >
      <Phone
        clinicName={name}
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
          <div className={cn(styles.cta, beat === 3 && styles.ctaPressed)}>
            Request appointment
          </div>
        </div>
      </Phone>
      <Desk
        clinicName={name}
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

// ---------------------------------------------------------------------------
// 5. Reminders
// ---------------------------------------------------------------------------

export function RemindStage({ draft, playId, still }: SceneProps) {
  const beat = useBeats([500, 1600, 2600], playId, still);
  const name = brandName(draft);
  const sample = sampleFor(draft);
  const profile = BUILD_PRACTICE_PROFILES[draft.practiceType];
  return (
    <Stage>
      <Phone clinicName={name}>
        <div className={styles.thread}>
          <div className="text-center text-[10px] text-slate-500">{name}</div>
          <div className={cn(styles.bubble, styles.bubbleIn, beat >= 1 && styles.bubbleOn)}>
            Hi {sample.owner}, this is {name}. {sample.pet}&apos;s{" "}
            {sample.visit.toLowerCase()} is tomorrow at 9:00 AM. See you
            then!
          </div>
          <div className={cn(styles.bubble, styles.bubbleIn, beat >= 3 && styles.bubbleOn)}>
            {sample.pet} is due for {sample.due}. Book a time online whenever
            it suits you.
          </div>
        </div>
      </Phone>
      <Desk
        clinicName={name}
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
        <div className={cn(styles.row, beat >= 3 && styles.rowNew)} style={{ opacity: beat >= 3 ? 1 : 0.4 }}>
          <b>↻</b>
          <span className="truncate">{sample.recall}</span>
          <span className={cn(styles.badge, beat >= 3 && styles.badgeBrand)}>
            {beat >= 3 ? "Sending" : "Ready"}
          </span>
        </div>
      </Desk>
    </Stage>
  );
}

// ---------------------------------------------------------------------------
// 6. The visit
// ---------------------------------------------------------------------------



export function VisitStage({ draft, playId, still }: SceneProps) {
  const sample = sampleFor(draft);
  const SOAP_DRAFT = sample.soap.join("\n");
  const beat = useBeats([600, 4400, 4800, 5200, 5900], playId, still);
  const [typed, setTyped] = useState(still ? SOAP_DRAFT.length : 0);
  useEffect(() => {
    if (still) {
      setTyped(SOAP_DRAFT.length);
      return;
    }
    setTyped(0);
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    const start = setTimeout(function tick() {
      i = Math.min(SOAP_DRAFT.length, i + 3);
      setTyped(i);
      if (i < SOAP_DRAFT.length) timer = setTimeout(tick, 28);
    }, 700);
    return () => {
      clearTimeout(start);
      clearTimeout(timer);
    };
    // SOAP_DRAFT is fixed per practice type, which also restarts playId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playId, still]);

  const profile = BUILD_PRACTICE_PROFILES[draft.practiceType];
  const status =
    beat >= 5 ? "Ready for checkout" : beat >= 1 ? "In exam" : "Checked in";
  const charges = sample.charges.map(
    (line) => [line.label, money(line.price)] as const,
  );
  return (
    <Stage>
      <Desk
        clinicName={brandName(draft)}
        modules={profile.modules}
        active="Records"
        width={470}
        title={
          <span className="flex items-center gap-2">
            {sample.pet} · {sample.visit}
            <span className={cn(styles.badge, styles.badgeBrand)}>{status}</span>
          </span>
        }
      >
        <div className={cn(styles.note, typed < SOAP_DRAFT.length && typed > 0 && styles.typing)}>
          {typed === 0 ? (
            <span className="text-slate-500">✨ Drafting from your exam…</span>
          ) : (
            SOAP_DRAFT.slice(0, typed)
          )}
        </div>
        <h4 className={cn(styles.deskTitle, "mt-3")}>Charges</h4>
        {charges.slice(0, Math.max(0, beat - 1)).map(([label, amount]) => (
          <div key={label} className={styles.line}>
            <span>{label}</span>
            <span>{amount}</span>
          </div>
        ))}
      </Desk>
    </Stage>
  );
}

// ---------------------------------------------------------------------------
// 7. Getting paid
// ---------------------------------------------------------------------------

const COLLECTED_BEFORE = 1092;

export function PaidStage({ draft, playId, still }: SceneProps) {
  const beat = useBeats([1200, 1500], playId, still);
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
    <Stage>
      <Phone
        clinicName={name}
        subtitle="Invoice #1042"
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
          <div className={cn(styles.cta, beat === 1 && styles.ctaPressed)}>
            Pay {money(total)}
          </div>
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
  const fromPaper =
    draft.currentSystem === "paper" || draft.currentSystem === "other";
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
// 9. The gate summary
// ---------------------------------------------------------------------------

export function GateStage({ draft }: SceneProps) {
  const profile = BUILD_PRACTICE_PROFILES[draft.practiceType];
  const offered = draft.services.filter((service) => service.on).length;
  const fromPaper =
    draft.currentSystem === "paper" || draft.currentSystem === "other";
  const lines = [
    `${displayName(draft)} colours on your portal, booking page & reminders`,
    `${offered} service${offered === 1 ? "" : "s"} on your price list and booking menu`,
    `Shaped for ${profile.plural}`,
    "Email and text reminders, ready to switch on",
    "AI-drafted notes and card payments",
    fromPaper
      ? "A spreadsheet import whenever you're ready"
      : `An import from ${BUILD_SYSTEM_LABELS[draft.currentSystem]}, ready to review`,
  ];
  return (
    <Stage className="!min-h-0">
      <div className={cn(styles.panel, "max-w-md")}>
        <b className="text-base">What&apos;s waiting inside</b>
        <ul className="mt-3 space-y-2 text-sm">
          {lines.map((line, i) => (
            <li
              key={line}
              className={cn(styles.check, styles.reveal)}
              style={{ animationDelay: `${i * 90}ms` }}
            >
              {line}
            </li>
          ))}
        </ul>
      </div>
    </Stage>
  );
}
