import type { Metadata } from "next";
import { Github, MessageSquare } from "lucide-react";
import { FeedbackForm } from "@/components/feedback-form";

export const metadata: Metadata = {
  title: "Feedback",
  description:
    "Share feedback on OpenVPM — what's working, what's not, and what you'd love to see. Every note helps.",
};

export default function FeedbackPage() {
  return (
    <div className="py-16 sm:py-24">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-teal-50 text-teal-600 mb-5">
            <MessageSquare className="w-6 h-6" />
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold font-heading text-gray-900 tracking-tight mb-4">
            Tell us what you think
          </h1>
          <p className="text-lg text-gray-600">
            OpenVPM is built in the open, with the veterinary community. If you
            tried the demo or are running it yourself, we&apos;d love your notes —
            what worked, what didn&apos;t, what&apos;s missing. We read every one.
          </p>
        </div>

        <div className="rounded-2xl border border-gray-100 bg-white p-6 sm:p-8 shadow-sm">
          <FeedbackForm />
        </div>

        {/* Developers: point to the real OSS channels rather than a form. */}
        <div className="mt-8 rounded-2xl border border-gray-100 bg-gray-50/60 p-6">
          <h2 className="flex items-center gap-2 text-base font-semibold font-heading text-gray-900 mb-2">
            <Github className="w-4 h-4" />
            Building on OpenVPM?
          </h2>
          <p className="text-sm text-gray-600">
            Bug reports, feature requests, and contributions are best filed on
            GitHub, where the whole community can see and weigh in:
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <a
              href="https://github.com/evangauer/openvpm/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border-2 border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:border-teal-200 hover:text-teal-600 transition-colors"
            >
              <Github className="w-4 h-4" />
              Open an issue
            </a>
            <a
              href="https://github.com/evangauer/openvpm/discussions"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border-2 border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:border-teal-200 hover:text-teal-600 transition-colors"
            >
              <MessageSquare className="w-4 h-4" />
              Start a discussion
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
