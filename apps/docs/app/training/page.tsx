import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Briefcase, Calendar, Stethoscope } from "lucide-react";
import { trainingGuides, trainingMinutes, trainings } from "@/lib/content";
import type { TeamId } from "@/content/types";

export const metadata: Metadata = {
  title: "Team training",
  description: "A short path of guides for each role, with a checklist your teammate can work through.",
  alternates: { canonical: "/training" },
};

const icons: Record<TeamId, typeof Calendar> = {
  "front-desk": Calendar,
  "clinical-team": Stethoscope,
  "practice-administration": Briefcase,
};

export default function TrainingIndex() {
  return (
    <div className="page pb-12 pt-10">
      <h1 className="text-[34px] font-bold">Team training</h1>
      <p className="lede max-w-2xl">
        Give each new teammate one path. They read a short guide, practice it in the demo clinic, and tick it off.
      </p>
      <div className="mt-8 grid gap-5 md:grid-cols-3">
        {trainings.map((t) => {
          const Icon = icons[t.id];
          return (
            <Link key={t.id} href={`/training/${t.id}`} className="card-link group flex flex-col p-6">
              <span className="icon-tile h-10 w-10">
                <Icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <h2 className="mt-4 text-lg font-bold">{t.title}</h2>
              <p className="mt-1 flex-1 text-sm text-muted-foreground">{t.summary}</p>
              <p className="mt-4 text-[13px] text-muted-foreground">
                {trainingGuides(t).length} guides · about {trainingMinutes(t)} minutes
              </p>
              <span className="mt-3 inline-flex items-center gap-1.5 font-heading text-sm font-semibold text-primary">
                Start this path <ArrowRight className="icon transition group-hover:translate-x-0.5" aria-hidden="true" />
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
