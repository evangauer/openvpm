import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BookOpen, CircleCheck, Clock, MousePointerClick } from "lucide-react";
import { TrainingChecklist } from "@/components/training-checklist";
import { DEMO_URL } from "@/content/catalog";
import { getTraining, requireGuide, trainingGuides, trainingMinutes, trainings } from "@/lib/content";

export function generateStaticParams() {
  return trainings.map((t) => ({ team: t.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ team: string }> }): Promise<Metadata> {
  const training = getTraining((await params).team);
  if (!training) return {};
  return { title: training.title, description: training.summary, alternates: { canonical: `/training/${training.id}` } };
}

export default async function TrainingPage({ params }: { params: Promise<{ team: string }> }) {
  const training = getTraining((await params).team);
  if (!training) notFound();
  const sections = training.sections.map((s) => ({
    title: s.title,
    items: s.guides.map((slug) => {
      const g = requireGuide(slug);
      return { slug, title: g.title, summary: g.summary, minutes: g.minutes };
    }),
  }));

  return (
    <div className="page grid gap-10 pb-12 pt-8 lg:grid-cols-[minmax(0,1fr)_260px]">
      <div className="min-w-0 max-w-[820px]">
        <div className="crumb">
          <Link href="/training" className="hover:text-foreground">
            Team training
          </Link>
          <span aria-hidden="true">›</span>
          <span>{training.shortTitle}</span>
        </div>
        <h1 className="mt-2 text-[34px] font-bold leading-tight md:text-[38px]">{training.title}</h1>
        <p className="lede">{training.summary}</p>
        <TrainingChecklist id={training.id} sections={sections} />
      </div>
      <aside className="no-print lg:pt-16">
        <div className="card p-5 lg:sticky lg:top-24">
          <h2 className="text-base font-bold">This path at a glance</h2>
          <p className="mt-3 flex items-center gap-2 text-sm">
            <BookOpen className="icon text-primary" aria-hidden="true" /> {trainingGuides(training).length} guides
          </p>
          <p className="mt-1.5 flex items-center gap-2 text-sm">
            <Clock className="icon text-primary" aria-hidden="true" /> About {trainingMinutes(training)} minutes
          </p>
          <ol className="mt-4 space-y-2.5 border-t border-border pt-4 text-sm">
            {["Open a guide", "Practice it in the demo clinic", "Tick it off here"].map((t, i) => (
              <li key={t} className="flex items-center gap-2.5">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-primary font-heading text-xs font-bold text-white">{i + 1}</span>
                {t}
              </li>
            ))}
          </ol>
          <a href={DEMO_URL} className="btn mt-4 w-full justify-center">
            <MousePointerClick className="icon" aria-hidden="true" /> Open the demo clinic
          </a>
          <p className="mt-3 flex gap-1.5 text-xs text-muted-foreground">
            <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" /> Progress is saved in this browser only.
          </p>
        </div>
      </aside>
    </div>
  );
}
