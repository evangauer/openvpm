import Link from "next/link";
import { ArrowRight, Briefcase, Calendar, CalendarPlus, CreditCard, FileText, Receipt, Stethoscope, UserCheck } from "lucide-react";
import { AreaIcon } from "@/components/area-icon";
import { Screenshot } from "@/components/screenshot";
import { SearchButton, SearchChip } from "@/components/search";
import { areas, firstDay } from "@/content/catalog";
import { getTour, guidesOnScreen, requireGuide, trainingGuides, trainings } from "@/lib/content";
import type { ShotRef, TeamId } from "@/content/types";

const roleCards: Record<TeamId, { icon: typeof Calendar; title: string; shot: ShotRef; top: string[] }> = {
  "front-desk": {
    icon: Calendar,
    title: "Front desk",
    shot: { id: "schedule", focus: ["date-nav", "lane"], pad: 8, aspect: 16 / 8, alt: "The OpenVPM schedule with a column for each doctor" },
    top: ["book-an-appointment", "check-in-a-patient", "take-a-payment"],
  },
  "clinical-team": {
    icon: Stethoscope,
    title: "Veterinarians and techs",
    shot: { id: "patient", focus: ["header", "allergies"], pad: 8, aspect: 16 / 8, alt: "A patient chart with an allergy alert" },
    top: ["write-a-soap-note", "record-a-vaccine", "record-lab-results"],
  },
  "practice-administration": {
    icon: Briefcase,
    title: "Practice managers",
    shot: { id: "dashboard", focus: ["stats", "followups"], pad: 8, aspect: 16 / 8, alt: "The OpenVPM dashboard with today's numbers" },
    top: ["set-up-your-clinic", "invite-and-manage-staff", "import-your-data"],
  },
};

const firstDayIcons = [CalendarPlus, UserCheck, FileText, Receipt, CreditCard];

export default function Home() {
  return (
    <>
      <section className="hero">
        <h1>How can we help your team today?</h1>
        <p className="mt-2 text-[17px] text-muted-foreground">Step-by-step guides with real screens, for every role in the clinic.</p>
        <SearchButton variant="hero" placeholder="Search for a task, like “refund a payment” or “recurring visit”" />
        <div className="mx-auto mt-4 flex max-w-2xl flex-wrap justify-center gap-2">
          {["Take a payment", "Book a recurring visit", "Record a vaccine", "Refund an invoice", "Invite a teammate"].map((q) => (
            <SearchChip key={q} query={q} />
          ))}
        </div>
      </section>

      <div className="page pb-6">
        <h2 className="section-title mt-4">Start with your role</h2>
        <div className="mt-4 grid gap-5 md:grid-cols-3">
          {trainings.map((training) => {
            const card = roleCards[training.id];
            const Icon = card.icon;
            return (
              <div key={training.id} className="card overflow-hidden">
                <Link href={`/training/${training.id}`} className="block border-b border-border" tabIndex={-1} aria-hidden="true">
                  <div className="[&_.shot-card]:rounded-none [&_.shot-card]:border-0 [&_.shot-card]:shadow-none">
                    <Screenshot shot={card.shot} priority />
                  </div>
                </Link>
                <div className="p-5">
                  <h3 className="flex items-center gap-2.5 text-lg font-bold">
                    <span className="icon-tile">
                      <Icon className="icon" aria-hidden="true" />
                    </span>
                    {card.title}
                  </h3>
                  <p className="mt-1.5 text-sm text-muted-foreground">{training.summary}</p>
                  <ul className="mt-3 text-sm">
                    {card.top.map((slug) => (
                      <li key={slug} className="border-t border-secondary">
                        <Link href={`/guides/${slug}`} className="block py-1.5 text-[color:var(--ink)] hover:text-primary">
                          {requireGuide(slug).title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                  <Link href={`/training/${training.id}`} className="mt-3 inline-flex items-center gap-1.5 font-heading text-sm font-semibold text-primary">
                    {training.shortTitle} path · {trainingGuides(training).length} guides <ArrowRight className="icon" aria-hidden="true" />
                  </Link>
                </div>
              </div>
            );
          })}
        </div>

        <div className="first-day mt-8">
          <div className="md:flex-[1.2]">
            <h2>New here? Follow one visit, start to finish</h2>
            <p className="mt-1 text-sm text-[#99c9c0]">
              Five short guides that cover a full clinic day. About {firstDay.reduce((m, s) => m + requireGuide(s.guide).minutes, 0)} minutes.
            </p>
          </div>
          <ol className="flex flex-[1.4] gap-1.5">
            {firstDay.map((step, i) => {
              const Icon = firstDayIcons[i]!;
              return (
                <li key={step.guide} className="flex-1 text-center text-[13px] text-[#d5ece7]">
                  <Link href={`/guides/${step.guide}`} className="group block">
                    <span className="mx-auto mb-1.5 grid h-9 w-9 place-items-center rounded-full bg-[rgba(45,212,191,0.16)] text-[color:var(--teal-400)] transition group-hover:bg-[rgba(45,212,191,0.3)]">
                      <Icon className="icon" aria-hidden="true" />
                    </span>
                    {step.label}
                  </Link>
                </li>
              );
            })}
          </ol>
          <Link href="/guides/your-first-day" className="btn self-start bg-[color:var(--teal-400)] text-[color:var(--teal-950)] md:self-auto">
            Start the walkthrough <ArrowRight className="icon" aria-hidden="true" />
          </Link>
        </div>

        <h2 className="section-title mt-10">Or find it by screen</h2>
        <p className="mt-1 text-muted-foreground">Each page matches a spot in the OpenVPM sidebar.</p>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {areas.map((area) => {
            const count = guidesOnScreen(area.id).length;
            if (!getTour(area.id)) return null;
            return (
              <Link key={area.id} href={`/screens/${area.id}`} className="card-link flex flex-col gap-0.5 p-3.5">
                <AreaIcon area={area.id} className="mb-2 h-5 w-5 text-muted-foreground" />
                <b className="text-sm font-semibold text-[color:var(--ink)]">{area.label}</b>
                <small className="text-xs text-muted-foreground">{count ? `${count} guide${count === 1 ? "" : "s"}` : "Screen tour"}</small>
              </Link>
            );
          })}
        </div>
      </div>
    </>
  );
}
