import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, ArrowUpRight, CircleCheck, CircleHelp, Clock, Info, Lightbulb, MousePointerClick, TriangleAlert, User } from "lucide-react";
import { AreaIcon } from "@/components/area-icon";
import { Feedback, OnThisPage } from "@/components/client-parts";
import { GuideSidebar, StatusFlow } from "@/components/doc-parts";
import { RichText } from "@/components/rich-text";
import { Screenshot } from "@/components/screenshot";
import { DEMO_URL, SUPPORT_EMAIL, areas } from "@/content/catalog";
import { categoryTitle, getGuide, getTour, guides } from "@/lib/content";
import { plainText } from "@/lib/inline";
import { getShot } from "@/lib/shots";

export function generateStaticParams() {
  return guides.map((g) => ({ slug: g.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const guide = getGuide((await params).slug);
  if (!guide) return {};
  const shot = guide.steps.find((s) => s.shot)?.shot;
  const image = shot && getShot(shot.id);
  return {
    title: guide.title,
    description: guide.summary,
    alternates: { canonical: `/guides/${guide.slug}` },
    openGraph: {
      siteName: "OpenVPM Help",
      type: "article",
      url: `/guides/${guide.slug}`,
      title: guide.title,
      description: guide.summary,
      ...(image && shot ? { images: [{ url: `/screens/${image.file}`, alt: shot.alt }] } : {}),
    },
  };
}

export default async function GuidePage({ params }: { params: Promise<{ slug: string }> }) {
  const guide = getGuide((await params).slug);
  if (!guide) notFound();
  const next = guide.next ? getGuide(guide.next) : undefined;
  const area = areas.find((a) => a.id === guide.area);
  const toc = [
    ...guide.steps.map((s, i) => ({ id: s.id, label: `${i + 1} · ${s.title}` })),
    ...(guide.faq?.length ? [{ id: "questions", label: "Something not working?" }] : []),
  ];

  return (
    <div className="doc-layout">
      <GuideSidebar current={guide.slug} />
      <article className="doc">
        <div className="crumb">
          <Link href="/guides" className="hover:text-foreground">
            Guides
          </Link>
          <span aria-hidden="true">›</span>
          <span>{categoryTitle(guide.category)}</span>
        </div>
        <h1>{guide.title}</h1>
        <p className="lede">{guide.summary}</p>
        <div className="meta">
          <span>
            <Clock className="h-3.5 w-3.5" aria-hidden="true" /> {guide.minutes} min
          </span>
          <span>
            <User className="h-3.5 w-3.5" aria-hidden="true" /> {guide.audience}
          </span>
          {area && getTour(area.id) && (
            <Link href={`/screens/${area.id}`} className="hover:border-[color:var(--teal-200)] hover:text-foreground">
              <AreaIcon area={area.id} className="h-3.5 w-3.5 text-primary" /> On the {area.label} screen
            </Link>
          )}
        </div>

        {guide.before && (
          <div className="note">
            <Info className="icon mt-0.5 text-primary" aria-hidden="true" />
            <p>
              <b className="mr-1.5">Before you start</b>
              <RichText text={guide.before} />
            </p>
          </div>
        )}

        {guide.steps.map((step, i) => (
          <section key={step.id} id={step.id} aria-labelledby={`${step.id}-title`}>
            <div className="step">
              <span className="step-n" aria-hidden="true">
                {i + 1}
              </span>
              <div className="step-body">
                <h2 id={`${step.id}-title`}>
                  <span className="sr-only">Step {i + 1}: </span>
                  {step.title}
                </h2>
                {step.body.map((p, j) => (
                  <p key={j}>
                    <RichText text={p} />
                  </p>
                ))}
                {step.tip && (
                  <div className="note-tip">
                    <Lightbulb className="icon mt-0.5 text-amber-700" aria-hidden="true" />
                    <p>
                      <RichText text={step.tip} />
                    </p>
                  </div>
                )}
                {step.important && (
                  <div className="note-warn">
                    <TriangleAlert className="icon mt-0.5 text-amber-700" aria-hidden="true" />
                    <p>
                      <RichText text={step.important} />
                    </p>
                  </div>
                )}
              </div>
            </div>
            {step.shot && (
              <div className="mt-4 md:ml-[46px]">
                <Screenshot shot={step.shot} priority={i === 0} />
              </div>
            )}
          </section>
        ))}

        {guide.statusFlow && (
          <div className="md:ml-[46px]">
            <StatusFlow />
          </div>
        )}

        {guide.faq?.length ? (
          <section id="questions" className="mt-12">
            <h2 className="mb-2 flex items-center gap-2 text-xl font-bold">
              <CircleHelp className="h-5 w-5 text-primary" aria-hidden="true" /> Something not working?
            </h2>
            {guide.faq.map(([q, a], i) => (
              <details key={q} className="faq" open={i === 0}>
                <summary>{q}</summary>
                <p className="mt-2 text-muted-foreground">
                  <RichText text={a} />
                </p>
              </details>
            ))}
          </section>
        ) : null}

        <Feedback title={guide.title} email={SUPPORT_EMAIL} />

        {next && (
          <Link href={`/guides/${next.slug}`} className="card-link mt-6 block px-5 py-4">
            <small className="text-xs text-muted-foreground">Next up</small>
            <span className="flex items-center gap-1.5 font-heading text-[17px] font-semibold text-primary">
              {next.title} <ArrowRight className="icon" aria-hidden="true" />
            </span>
            <span className="block text-sm text-muted-foreground">{plainText(next.summary)}</span>
          </Link>
        )}
      </article>
      <aside className="toc">
        <div>
          <OnThisPage items={toc} />
          <div className="card mt-6 p-4">
            <span className="icon-tile mb-2">
              <MousePointerClick className="icon" aria-hidden="true" />
            </span>
            <b className="block font-heading text-[color:var(--ink)]">Try it in the demo</b>
            <span className="mb-3 mt-1 block text-muted-foreground">Practice with sample pets. Nothing you do touches real data.</span>
            <a href={DEMO_URL} className="btn px-3 py-1.5 text-[13px]">
              Open the demo <ArrowUpRight className="icon" aria-hidden="true" />
            </a>
          </div>
          <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
            <CircleCheck className="h-3.5 w-3.5 text-primary" aria-hidden="true" /> Screens captured from the seeded demo clinic
          </p>
        </div>
      </aside>
    </div>
  );
}
