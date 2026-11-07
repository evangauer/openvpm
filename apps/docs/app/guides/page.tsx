import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Clock } from "lucide-react";
import { AreaIcon } from "@/components/area-icon";
import { categories, guidesIn } from "@/lib/content";

export const metadata: Metadata = {
  title: "All guides",
  description: "Every OpenVPM guide, grouped by the work it covers.",
  alternates: { canonical: "/guides" },
};

export default function GuidesIndex() {
  return (
    <div className="page pb-10 pt-10">
      <h1 className="text-[34px] font-bold">All guides</h1>
      <p className="lede">Short, step-by-step guides with real screens. Pick the task in front of you.</p>
      <div className="mt-8 grid gap-x-8 gap-y-10 md:grid-cols-2">
        {categories.map((category) => (
          <section key={category.id} aria-labelledby={`cat-${category.id}`} className="min-w-0">
            <h2 id={`cat-${category.id}`} className="text-lg font-bold">
              {category.title}
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{category.summary}</p>
            <ul className="card mt-3 divide-y divide-border">
              {guidesIn(category.id).map((g) => (
                <li key={g.slug}>
                  <Link href={`/guides/${g.slug}`} className="group flex items-center gap-3 px-4 py-3 hover:bg-[color:var(--teal-50)]">
                    <span className="icon-tile">
                      <AreaIcon area={g.area} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-[color:var(--ink)] group-hover:text-primary">{g.title}</span>
                      <span className="block truncate text-[13px] text-muted-foreground">{g.summary}</span>
                    </span>
                    <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
                      <Clock className="h-3.5 w-3.5" aria-hidden="true" /> {g.minutes} min
                    </span>
                    <ArrowRight className="icon text-muted-foreground group-hover:text-primary" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
