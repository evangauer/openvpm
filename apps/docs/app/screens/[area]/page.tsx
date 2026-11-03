import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Clock, Info } from "lucide-react";
import { AreaIcon } from "@/components/area-icon";
import { RichText } from "@/components/rich-text";
import { Screenshot } from "@/components/screenshot";
import { getTour, requireGuide, tours } from "@/lib/content";

export function generateStaticParams() {
  return tours.map((t) => ({ area: t.area }));
}

export async function generateMetadata({ params }: { params: Promise<{ area: string }> }): Promise<Metadata> {
  const tour = getTour((await params).area);
  if (!tour) return {};
  return { title: `The ${tour.title} screen`, description: tour.summary, alternates: { canonical: `/screens/${tour.area}` } };
}

export default async function ScreenPage({ params }: { params: Promise<{ area: string }> }) {
  const tour = getTour((await params).area);
  if (!tour) notFound();

  return (
    <div className="page pb-12 pt-8">
      <div className="crumb">
        <Link href="/screens" className="hover:text-foreground">
          Screens
        </Link>
        <span aria-hidden="true">›</span>
        <span>{tour.title}</span>
      </div>
      <h1 className="mt-2 flex items-center gap-3.5 text-[34px] font-bold leading-tight md:text-[38px]">
        <span className="icon-tile h-11 w-11">
          <AreaIcon area={tour.area} className="h-6 w-6" />
        </span>
        {tour.title}
      </h1>
      <p className="lede max-w-3xl">{tour.summary}</p>

      <div className={`mt-6 grid items-start gap-7 ${tour.legend.length ? "lg:grid-cols-[minmax(0,1fr)_300px]" : "max-w-5xl"}`}>
        <Screenshot shot={tour.shot} browser priority />
        {tour.legend.length > 0 && (
        <ol className="legend" aria-label="Parts of this screen">
          {tour.legend.map((item, i) => (
            <li key={item.title}>
              <span className="legend-n" aria-hidden="true">
                {i + 1}
              </span>
              <div>
                <h2 className="text-[15px] font-bold">
                  <span className="sr-only">{i + 1}. </span>
                  {item.title}
                </h2>
                <p className="mt-0.5 text-[13px] text-muted-foreground">
                  <RichText text={item.body} />
                </p>
              </div>
            </li>
          ))}
        </ol>
        )}
      </div>

      {tour.goodToKnow?.length ? (
        <div className="note mt-8 max-w-4xl">
          <Info className="icon mt-0.5 text-primary" aria-hidden="true" />
          <div className="space-y-1.5">
            <b>Good to know</b>
            {tour.goodToKnow.map((t) => (
              <p key={t}>
                <RichText text={t} />
              </p>
            ))}
          </div>
        </div>
      ) : null}

      {tour.tasks.length > 0 && (
        <>
          <h2 className="section-title mt-10">What you can do here</h2>
          <div className="mt-4 grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
            {tour.tasks.map((slug) => {
              const g = requireGuide(slug);
              return (
                <Link key={slug} href={`/guides/${slug}`} className="card-link p-4">
                  <span className="icon-tile mb-2.5">
                    <AreaIcon area={g.area} />
                  </span>
                  <b className="block font-heading text-[color:var(--ink)]">{g.title}</b>
                  <span className="mt-0.5 block text-sm text-muted-foreground">{g.summary}</span>
                  <small className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3.5 w-3.5" aria-hidden="true" /> {g.minutes} min · {g.audience}
                  </small>
                </Link>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
