import type { Metadata } from "next";
import Link from "next/link";
import { AreaIcon } from "@/components/area-icon";
import { areas } from "@/content/catalog";
import { getTour } from "@/lib/content";

export const metadata: Metadata = {
  title: "Screens",
  description: "What every part of each OpenVPM screen does, in the same order as the app's sidebar.",
  alternates: { canonical: "/screens" },
};

export default function ScreensIndex() {
  return (
    <div className="page pb-12 pt-10">
      <h1 className="text-[34px] font-bold">Screens</h1>
      <p className="lede max-w-2xl">Not sure what you&apos;re looking at? Pick the screen from the OpenVPM sidebar to see what each part does.</p>
      <div className="mt-8 grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
        {areas.map((area) => {
          const tour = getTour(area.id);
          if (!tour) return null;
          return (
            <Link key={area.id} href={`/screens/${area.id}`} className="card-link flex gap-3.5 p-4">
              <span className="icon-tile h-10 w-10">
                <AreaIcon area={area.id} className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <b className="block font-heading text-[color:var(--ink)]">{area.label}</b>
                <span className="mt-0.5 block text-sm text-muted-foreground">{tour.summary}</span>
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
