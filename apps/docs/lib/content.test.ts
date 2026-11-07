import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { shots as captureShots } from "@/capture/shots";
import { areas, firstDay } from "@/content/catalog";
import type { ShotRef } from "@/content/types";
import { getGuide, getTour, guides, tours, trainings } from "./content";
import { parseInline } from "./inline";
import { getShot, shotIds } from "./shots";

const allShotRefs: { where: string; shot: ShotRef; text: string[] }[] = [
  ...guides.flatMap((g) =>
    g.steps.filter((s) => s.shot).map((s) => ({ where: `${g.slug}#${s.id}`, shot: s.shot!, text: [...s.body, s.tip ?? "", s.important ?? ""] })),
  ),
  ...tours.map((t) => ({ where: `screens/${t.area}`, shot: t.shot, text: [] })),
];

const allText: { where: string; text: string }[] = [
  ...guides.flatMap((g) => [
    ...(g.before ? [{ where: g.slug, text: g.before }] : []),
    ...g.steps.flatMap((s) => [...s.body, s.tip ?? "", s.important ?? ""].map((text) => ({ where: `${g.slug}#${s.id}`, text }))),
    ...(g.faq ?? []).map(([, a]) => ({ where: `${g.slug} faq`, text: a })),
  ]),
  ...tours.flatMap((t) => [...t.legend.map((l) => l.body), ...(t.goodToKnow ?? [])].map((text) => ({ where: `screens/${t.area}`, text }))),
];

describe("guides", () => {
  it("have unique slugs", () => {
    expect(new Set(guides.map((g) => g.slug)).size).toBe(guides.length);
  });

  it("only point to guides that exist", () => {
    const missing = [
      ...guides.filter((g) => g.next && !getGuide(g.next)).map((g) => `${g.slug} → ${g.next}`),
      ...trainings.flatMap((t) => t.sections.flatMap((s) => s.guides.filter((slug) => !getGuide(slug)).map((slug) => `${t.id} → ${slug}`))),
      ...tours.flatMap((t) => t.tasks.filter((slug) => !getGuide(slug)).map((slug) => `screens/${t.area} → ${slug}`)),
      ...firstDay.filter((s) => !getGuide(s.guide)).map((s) => `first day → ${s.guide}`),
    ];
    expect(missing).toEqual([]);
  });

  it("have internal links that resolve", () => {
    const broken = allText.flatMap(({ where, text }) =>
      parseInline(text)
        .filter((t) => t.kind === "link" && t.href.startsWith("/"))
        .flatMap((t) => {
          const href = (t as { href: string }).href;
          const [, kind, id] = href.split("/");
          const ok =
            (kind === "guides" && getGuide(id!)) || (kind === "screens" && getTour(id!)) || (kind === "training" && trainings.some((tr) => tr.id === id));
          return ok ? [] : [`${where}: ${href}`];
        }),
    );
    expect(broken).toEqual([]);
  });

  it("number callout references to match the screenshot's callouts", () => {
    const problems = allShotRefs.flatMap(({ where, shot, text }) => {
      const refs = text.flatMap((t) => parseInline(t).filter((tok) => tok.kind === "ref").map((tok) => (tok as { value: number }).value));
      const count = shot.callouts?.length ?? 0;
      return refs.filter((n) => n < 1 || n > count).map((n) => `${where}: ((${n})) but only ${count} callouts`);
    });
    expect(problems).toEqual([]);
  });

  it("explain every callout on a screen tour", () => {
    const mismatched = tours.filter((t) => (t.shot.callouts?.length ?? 0) !== t.legend.length).map((t) => t.area);
    expect(mismatched).toEqual([]);
  });
});

describe("screen tours", () => {
  it("cover every item in the OpenVPM sidebar", () => {
    expect(areas.filter((a) => !getTour(a.id)).map((a) => a.id)).toEqual([]);
  });
});

describe("screenshots", () => {
  it("exist for every shot the guides use, with every named part", () => {
    const problems = allShotRefs.flatMap(({ where, shot }) => {
      const captured = getShot(shot.id);
      if (!captured) return [`${where}: no capture named "${shot.id}"`];
      const names = [...(Array.isArray(shot.focus) ? shot.focus : shot.focus ? [shot.focus] : []), ...(shot.callouts ?? [])];
      return names.filter((n) => !captured.targets[n]).map((n) => `${where}: "${shot.id}" has no target "${n}"`);
    });
    expect(problems).toEqual([]);
  });

  it("are defined in the capture script and saved to disk", () => {
    const defined = new Set(captureShots.map((s) => s.id));
    const problems = shotIds().flatMap((id) => [
      ...(defined.has(id) ? [] : [`${id} is in the manifest but not in capture/shots.ts`]),
      ...(existsSync(path.join(__dirname, "../public/screens", getShot(id)!.file)) ? [] : [`${id}: image file missing`]),
    ]);
    expect(problems).toEqual([]);
  });

  it("have alt text", () => {
    expect(allShotRefs.filter(({ shot }) => shot.alt.trim().length < 10).map((r) => r.where)).toEqual([]);
  });
});
