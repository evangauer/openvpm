import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Github } from "lucide-react";
import updatesData from "../../content/updates.json";

export const metadata: Metadata = {
  title: "Updates",
  description:
    "What's new in OpenVPM — product updates, shipped features, and where the open-source veterinary PIMS is headed.",
};

interface Update {
  date: string;
  tag: "Platform" | "Clinical" | "AI" | "Direction";
  title: string;
  body: string;
  points?: string[];
}

const tagStyles: Record<Update["tag"], string> = {
  Platform: "bg-blue-50 text-blue-700 border-blue-200",
  Clinical: "bg-emerald-50 text-emerald-700 border-emerald-200",
  AI: "bg-purple-50 text-purple-700 border-purple-200",
  Direction: "bg-teal-50 text-teal-700 border-teal-200",
};

// Newest first. Entries live in content/updates.json so ship-log updates are a
// data change, not a code change.
const updates = updatesData as Update[];

export default function UpdatesPage() {
  return (
    <div className="py-16 sm:py-24">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-14">
          <h1 className="text-4xl sm:text-5xl font-bold font-heading text-gray-900 tracking-tight mb-4">
            Updates
          </h1>
          <p className="text-lg text-gray-600 max-w-xl mx-auto">
            What&apos;s shipping in OpenVPM and where we&apos;re headed. Built in the
            open, with the veterinary community.
          </p>
        </div>

        <div className="space-y-10">
          {updates.map((u, i) => (
            <article
              key={`${u.date}-${i}`}
              className="relative rounded-2xl border border-gray-100 bg-white p-6 sm:p-8 shadow-sm"
            >
              <div className="flex items-center gap-3 mb-3">
                <span
                  className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${tagStyles[u.tag]}`}
                >
                  {u.tag}
                </span>
                <time className="text-sm text-gray-400">{u.date}</time>
              </div>
              <h2 className="text-xl font-semibold font-heading text-gray-900 mb-3">
                {u.title}
              </h2>
              <p className="text-gray-600 leading-relaxed">{u.body}</p>
              {u.points && (
                <ul className="mt-4 space-y-2">
                  {u.points.map((p) => (
                    <li key={p} className="flex items-start gap-2 text-sm text-gray-500">
                      <ArrowRight className="w-4 h-4 text-teal-500 mt-0.5 shrink-0" />
                      {p}
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>

        <div className="mt-14 rounded-2xl border border-teal-100 bg-teal-50/40 p-8 text-center">
          <h2 className="text-xl font-semibold font-heading text-gray-900 mb-2">
            Want these in your inbox?
          </h2>
          <p className="text-gray-600 mb-6">
            Follow along as we build. Join the list and we&apos;ll send the big ones.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              href="/#waitlist"
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-teal-600 px-6 py-3 text-sm font-semibold text-white hover:bg-teal-700 transition-colors"
            >
              Join the list
              <ArrowRight className="w-4 h-4" />
            </Link>
            <a
              href="https://github.com/evangauer/openvpm"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 rounded-lg border-2 border-gray-200 bg-white px-6 py-3 text-sm font-semibold text-gray-700 hover:border-teal-200 hover:text-teal-600 transition-colors"
            >
              <Github className="w-4 h-4" />
              Watch on GitHub
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
