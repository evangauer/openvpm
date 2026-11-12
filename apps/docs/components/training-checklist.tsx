"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Clock, Printer, RotateCcw } from "lucide-react";

interface Item {
  slug: string;
  title: string;
  summary: string;
  minutes: number;
}

/**
 * Progress lives in this browser only. It helps one teammate keep their
 * place; it is not a record of training.
 */
export function TrainingChecklist({ id, sections }: { id: string; sections: { title: string; items: Item[] }[] }) {
  const key = `openvpm-help:training:${id}`;
  const all = [...new Set(sections.flatMap((s) => s.items.map((i) => i.slug)))];
  const [done, setDone] = useState<string[]>([]);

  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
      setDone(Array.isArray(saved) ? saved.filter((s): s is string => typeof s === "string") : []);
    } catch {
      setDone([]);
    }
  }, [key]);

  // Browsers that block storage still get a working checklist; it just
  // won't be remembered.
  function save(next: string[]) {
    setDone(next);
    try {
      if (next.length) localStorage.setItem(key, JSON.stringify(next));
      else localStorage.removeItem(key);
    } catch {}
  }

  function toggle(slug: string) {
    save(done.includes(slug) ? done.filter((s) => s !== slug) : [...done, slug]);
  }

  const count = all.filter((s) => done.includes(s)).length;
  const percent = Math.round((count / all.length) * 100);

  return (
    <>
      <div className="mt-6 flex flex-wrap items-center gap-4">
        <div className="min-w-[220px] flex-1">
          <div className="flex justify-between text-sm">
            <b className="text-[color:var(--ink)]">
              {count} of {all.length} done
            </b>
            <span className="text-muted-foreground">{percent}%</span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Training progress">
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
          </div>
        </div>
        <div className="no-print flex gap-2">
          <button type="button" className="btn-ghost" onClick={() => window.print()}>
            <Printer className="icon" aria-hidden="true" /> Print checklist
          </button>
          {count > 0 && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => save([])}
            >
              <RotateCcw className="icon" aria-hidden="true" /> Start over
            </button>
          )}
        </div>
      </div>

      <div className="mt-6 space-y-6">
        {sections.map((section) => (
          <section key={section.title} className="card overflow-hidden">
            <h2 className="border-b border-border bg-surface px-5 py-3 text-base font-bold">{section.title}</h2>
            <ul className="divide-y divide-border">
              {section.items.map((item) => {
                const checked = done.includes(item.slug);
                return (
                  <li key={item.slug} className="flex items-center gap-3 px-5 py-3">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(item.slug)}
                      className="h-[18px] w-[18px] shrink-0 accent-[hsl(var(--primary))]"
                      aria-label={`Mark “${item.title}” done`}
                    />
                    <Link href={`/guides/${item.slug}`} className="group min-w-0 flex-1">
                      <span className={`block font-medium group-hover:text-primary ${checked ? "text-muted-foreground line-through decoration-1" : "text-[color:var(--ink)]"}`}>
                        {item.title}
                      </span>
                      <span className="block truncate text-[13px] text-muted-foreground">{item.summary}</span>
                    </Link>
                    <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
                      <Clock className="h-3.5 w-3.5" aria-hidden="true" /> {item.minutes} min
                    </span>
                    <ArrowRight className="icon text-muted-foreground" aria-hidden="true" />
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
