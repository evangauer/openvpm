/**
 * Content for "Build your clinic": the guided, pre-checkout walkthrough a new
 * hosted clinic takes before the card gate. Client-safe and data-only so the
 * flow, the register API, and tests share one source.
 *
 * Every "ready" line must describe something the product does today. Gaps go
 * in `onTheWay`, said plainly, so a clinic finds out before it pays.
 */
import { z } from "zod";
import { inTreatment, percentFromEnv } from "@/lib/experiments/bucket";

export const BUILD_PRACTICE_TYPES = [
  "companion",
  "mobile",
  "equine",
  "specialty",
  "shelter",
] as const;
export type BuildPracticeType = (typeof BUILD_PRACTICE_TYPES)[number];

export const BUILD_SYSTEMS = [
  "cornerstone",
  "avimark",
  "ezyvet",
  "shepherd",
  "daysmart",
  "paper",
  "other",
] as const;
export type BuildSystem = (typeof BUILD_SYSTEMS)[number];

export const BUILD_SYSTEM_LABELS: Record<BuildSystem, string> = {
  cornerstone: "Cornerstone",
  avimark: "AVImark",
  ezyvet: "ezyVet",
  shepherd: "Shepherd",
  daysmart: "DaySmart",
  paper: "Paper or spreadsheets",
  other: "Something else",
};

/** Scenes in order. Ids are tracked, so treat them as a stable contract. */
export const BUILD_SCENES = [
  "practice",
  "brand",
  "services",
  "book",
  "remind",
  "visit",
  "paid",
  "records",
  "gate",
] as const;
export type BuildScene = (typeof BUILD_SCENES)[number];

export const BUILD_SCENE_LABELS: Record<BuildScene, string> = {
  practice: "Your practice",
  brand: "Your brand",
  services: "Services",
  book: "Booking",
  remind: "Reminders",
  visit: "The visit",
  paid: "Payments",
  records: "Your records",
  gate: "Start",
};

export interface BuildService {
  name: string;
  price: number;
}

/** The sample patient a practice type watches move through its clinic. */
export interface BuildSample {
  pet: string;
  owner: string;
  visit: string;
  /** SOAP lines the AI "drafts" in the visit scene. */
  soap: string[];
  charges: Array<{ label: string; price: number }>;
  /** What the recall text says is due, e.g. "a rabies vaccine". */
  due: string;
  /** The bulk recall shown going out, e.g. "Rabies recall · 38 pets due". */
  recall: string;
}

const DOG_WELLNESS: BuildSample = {
  pet: "Biscuit",
  owner: "Sam",
  visit: "Wellness exam",
  soap: [
    "S: Annual wellness. Eating well, no concerns from owner.",
    "O: T 101.5°F, HR 96, BCS 5/9. Mild tartar.",
    "A: Healthy adult. Grade 1 dental.",
    "P: Rabies + DHPP today. Recheck teeth in 6 months.",
  ],
  charges: [
    { label: "Wellness exam", price: 68 },
    { label: "Rabies vaccine", price: 32 },
    { label: "DHPP vaccine", price: 48 },
  ],
  due: "a rabies vaccine",
  recall: "Rabies recall · 38 pets due",
};

export interface BuildPracticeProfile {
  label: string;
  /** "companion clinics", for sentences. */
  plural: string;
  /** Navigation shown in the workspace mockup. */
  modules: string[];
  /** What we shape for this kind of practice. */
  traits: string[];
  /** Starting services; names match the starter catalog where one exists. */
  services: BuildService[];
  ready: string[];
  onTheWay: string[];
  sample: BuildSample;
}

const READY_COMMON = [
  "Online booking that creates the pet's chart",
  "Email and text reminders in your name",
  "AI-drafted SOAP notes you review",
  "Invoices clients can pay by card",
];

export const BUILD_PRACTICE_PROFILES: Record<
  BuildPracticeType,
  BuildPracticeProfile
> = {
  companion: {
    label: "Companion clinic",
    plural: "companion clinics",
    modules: ["Schedule", "Whiteboard", "Patients", "Records", "Billing", "Client portal", "Reminders"],
    traits: ["Dogs, cats & exotics", "Exam rooms & a live whiteboard", "Vaccine recalls & care reminders"],
    services: [
      { name: "Wellness Exam", price: 65 },
      { name: "Sick / Problem Exam", price: 75 },
      { name: "Rabies Vaccine", price: 35 },
      { name: "Dental Cleaning", price: 450 },
      { name: "Spay / Neuter", price: 350 },
    ],
    sample: DOG_WELLNESS,
    ready: READY_COMMON,
    onTheWay: [],
  },
  mobile: {
    label: "Mobile / house-call",
    plural: "mobile practices",
    modules: ["Schedule", "Patients", "Records", "Billing", "Client portal", "Reminders"],
    traits: ["Your day from your phone", "House-call & trip fee pricing", "Clients book and pay without calling"],
    services: [
      { name: "House-Call Exam", price: 120 },
      { name: "Trip Fee", price: 45 },
      { name: "Rabies Vaccine", price: 35 },
      { name: "Sick / Problem Exam", price: 110 },
      { name: "In-Home Euthanasia", price: 295 },
    ],
    sample: {
      ...DOG_WELLNESS,
      visit: "House-call exam",
      charges: [
        { label: "House-call exam", price: 120 },
        { label: "Trip fee", price: 45 },
        { label: "Rabies vaccine", price: 35 },
      ],
    },
    ready: READY_COMMON,
    onTheWay: ["Offline mode for spots with no signal"],
  },
  equine: {
    label: "Equine & farm",
    plural: "equine and farm practices",
    modules: ["Schedule", "Patients", "Records", "Billing", "Reminders"],
    traits: ["Horses, cattle & small ruminants", "Farm-call pricing", "Owner reminders by text and email"],
    services: [
      { name: "Farm Call", price: 95 },
      { name: "Lameness Exam", price: 140 },
      { name: "Coggins Test", price: 45 },
      { name: "Dental Float", price: 150 },
      { name: "Herd Health Visit", price: 180 },
    ],
    sample: {
      pet: "Juniper",
      owner: "Sam",
      visit: "Lameness exam",
      soap: [
        "S: Mild left-fore lameness after a trail ride two days ago.",
        "O: T 99.8°F, HR 40. Grade 2/5 LF lame, positive hoof testers at the toe.",
        "A: Suspected sole bruise, left fore.",
        "P: Poultice and wrap, bute 2 g PO q24h × 3 days. Recheck in 1 week.",
      ],
      charges: [
        { label: "Farm call", price: 95 },
        { label: "Lameness exam", price: 140 },
        { label: "Hoof testing & wrap", price: 45 },
      ],
      due: "a Coggins test",
      recall: "Coggins recall · 24 horses due",
    },
    ready: READY_COMMON,
    onTheWay: ["Herd-level records", "Offline mode for spots with no signal"],
  },
  specialty: {
    label: "Specialty / wellness",
    plural: "specialty and wellness practices",
    modules: ["Schedule", "Patients", "Records", "Templates", "Billing", "Client portal"],
    traits: ["Consults & follow-ups", "Your own note templates", "An open API for your tools"],
    services: [
      { name: "Consultation", price: 180 },
      { name: "Follow-Up Visit", price: 75 },
      { name: "Nutrition Plan", price: 120 },
      { name: "Rehab Session", price: 90 },
    ],
    sample: {
      ...DOG_WELLNESS,
      visit: "Consultation",
      soap: [
        "S: Referred for weight management. Owner reports low energy.",
        "O: 34.2 kg, BCS 7/9. Bloodwork from referring vet unremarkable.",
        "A: Obesity, otherwise healthy.",
        "P: Nutrition plan, 10% calorie reduction. Weigh-in every 4 weeks.",
      ],
      charges: [
        { label: "Consultation", price: 180 },
        { label: "Nutrition plan", price: 120 },
      ],
    },
    ready: READY_COMMON,
    onTheWay: [],
  },
  shelter: {
    label: "Shelter / nonprofit",
    plural: "shelters and nonprofits",
    modules: ["Schedule", "Patients", "Records", "Billing", "Reminders"],
    traits: ["Fast intake records", "Low-cost clinic pricing", "Roles for staff & volunteers"],
    services: [
      { name: "Intake Exam", price: 25 },
      { name: "Spay / Neuter", price: 95 },
      { name: "Rabies Vaccine", price: 15 },
      { name: "Microchip", price: 20 },
    ],
    sample: {
      ...DOG_WELLNESS,
      pet: "Pepper",
      visit: "Intake exam",
      soap: [
        "S: Stray intake. No history available.",
        "O: T 101.8°F, BCS 4/9. Ear mites, otherwise healthy.",
        "A: Healthy young adult, otitis externa (mites).",
        "P: DHPP + rabies, microchip, ear treatment. Ready for spay next week.",
      ],
      charges: [
        { label: "Intake exam", price: 25 },
        { label: "Rabies vaccine", price: 15 },
        { label: "Microchip", price: 20 },
      ],
    },
    ready: READY_COMMON,
    onTheWay: [],
  },
};

export const BUILD_BRAND_COLORS = [
  "#0d9488",
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#ea580c",
  "#16a34a",
  "#0f172a",
] as const;

export const BUILD_SERVICE_MAX = 12;
export const BUILD_SERVICE_PRICE_MAX = 100_000;

/** What the gate sends with registration so the workspace opens built. */
export const buildDraftSchema = z
  .object({
    practiceType: z.enum(BUILD_PRACTICE_TYPES),
    currentSystem: z.enum(BUILD_SYSTEMS),
    brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    services: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(80),
            price: z.number().finite().min(0).max(BUILD_SERVICE_PRICE_MAX),
          })
          .strict(),
      )
      .max(BUILD_SERVICE_MAX),
  })
  .strict();
export type BuildDraft = z.infer<typeof buildDraftSchema>;

/** The guided-setup goal implied by where the clinic is coming from. */
export function buildFirstGoal(
  system: BuildSystem,
): "import_records" | "run_visit" {
  return system === "paper" || system === "other"
    ? "run_visit"
    : "import_records";
}

export const BUILDER_PERCENT_ENV = "HOSTED_BUILDER_PERCENT";

/** Share (0-100) of card-required signups sent through the builder. */
export function builderPercent(
  raw: string | undefined = process.env[BUILDER_PERCENT_ENV],
): number {
  return percentFromEnv(raw);
}

export function inBuilderArm(
  funnelId: string | null | undefined,
  percent: number,
): boolean {
  return inTreatment(funnelId, percent, "build-your-clinic");
}
