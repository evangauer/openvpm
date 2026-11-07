import { categories, trainings } from "@/content/catalog";
import { guides } from "@/content/guides";
import { tours } from "@/content/screens";
import type { AreaId, CategoryId, Guide, ScreenTour, Training } from "@/content/types";
import { plainText } from "./inline";
import type { SearchEntry } from "./search";

export { guides, tours, trainings, categories };

const guideBySlug = new Map(guides.map((g) => [g.slug, g]));
const tourByArea = new Map(tours.map((t) => [t.area, t]));

export function getGuide(slug: string): Guide | undefined {
  return guideBySlug.get(slug);
}

export function requireGuide(slug: string): Guide {
  const guide = guideBySlug.get(slug);
  if (!guide) throw new Error(`Unknown guide: ${slug}`);
  return guide;
}

export function getTour(area: string): ScreenTour | undefined {
  return tourByArea.get(area as AreaId);
}

export function getTraining(id: string): Training | undefined {
  return trainings.find((t) => t.id === id);
}

export function guidesIn(category: CategoryId): Guide[] {
  return guides.filter((g) => g.category === category);
}

export function guidesOnScreen(area: AreaId): Guide[] {
  return guides.filter((g) => g.area === area);
}

export function categoryTitle(id: CategoryId): string {
  return categories.find((c) => c.id === id)?.title ?? id;
}

export function trainingGuides(training: Training): Guide[] {
  return [...new Set(training.sections.flatMap((s) => s.guides))].map(requireGuide);
}

export function trainingMinutes(training: Training): number {
  return trainingGuides(training).reduce((sum, g) => sum + g.minutes, 0);
}

export function searchEntries(): SearchEntry[] {
  return [
    ...guides.map((g) => ({
      href: `/guides/${g.slug}`,
      title: g.title,
      summary: g.summary,
      section: categoryTitle(g.category),
      keywords: g.keywords ?? [],
      body: [
        g.before ?? "",
        ...g.steps.flatMap((s) => [s.title, ...s.body, s.tip ?? "", s.important ?? ""]),
        ...(g.faq ?? []).flat(),
      ]
        .map(plainText)
        .join(" "),
    })),
    ...tours.map((t) => ({
      href: `/screens/${t.area}`,
      title: `The ${t.title} screen`,
      summary: t.summary,
      section: "Screen",
      keywords: [t.navLabel, ...(t.keywords ?? [])],
      body: [...t.legend.flatMap((l) => [l.title, l.body]), ...(t.goodToKnow ?? [])].map(plainText).join(" "),
    })),
    ...trainings.map((t) => ({
      href: `/training/${t.id}`,
      title: t.title,
      summary: t.summary,
      section: "Team training",
      keywords: ["training", "onboarding", "new hire", t.shortTitle],
      body: t.sections.map((s) => s.title).join(" "),
    })),
  ];
}
