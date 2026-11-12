import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { categories } from "@/content/catalog";
import { guidesIn } from "@/lib/content";

export function GuideSidebar({ current }: { current?: string }) {
  return (
    <aside className="doc-sidebar">
      <nav aria-label="All guides">
        {categories.map((category) => (
          <div key={category.id}>
            <p className="group-title">{category.title}</p>
            {guidesIn(category.id).map((g) => (
              <Link key={g.slug} href={`/guides/${g.slug}`} aria-current={g.slug === current ? "page" : undefined}>
                {g.title}
              </Link>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}

const STATUSES = [
  { label: "Scheduled", className: "bg-gray-100 text-gray-600" },
  { label: "Confirmed", className: "bg-green-100 text-green-700" },
  { label: "Checked in", className: "bg-blue-100 text-blue-700" },
  { label: "In exam", className: "bg-purple-100 text-purple-700" },
  { label: "Checked out", className: "bg-gray-200 text-gray-900" },
];

export function StatusFlow() {
  return (
    <div className="card mt-8 px-5 py-4">
      <p className="text-sm font-semibold text-[color:var(--ink)]">Where a visit goes from here</p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2 text-slate-400">
        {STATUSES.map((s, i) => (
          <span key={s.label} className="contents">
            {i > 0 && <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />}
            <span className={`pill ${s.className}`}>{s.label}</span>
          </span>
        ))}
      </div>
      <p className="mt-2.5 text-[13px] text-muted-foreground">
        A visit can also end as <b>No show</b> or <b>Cancelled</b>.
      </p>
    </div>
  );
}
