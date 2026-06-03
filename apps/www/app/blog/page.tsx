import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { posts } from "@/lib/posts";
import { SubscribeForm } from "@/components/subscribe-form";

export const metadata: Metadata = {
  title: "Writing",
  description:
    "Notes on building open, API-first veterinary software — owning your data, open APIs, and AI agents in the clinic.",
};

export default function BlogIndexPage() {
  return (
    <div className="py-16 sm:py-24">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-12">
          <h1 className="text-4xl sm:text-5xl font-bold font-heading text-gray-900 tracking-tight mb-4">
            Writing
          </h1>
          <p className="text-lg text-gray-600 max-w-2xl">
            Notes on building veterinary software in the open — owning your data,
            open APIs, and putting AI agents to work in the clinic. We publish our
            thinking here and we want yours back.
          </p>
        </div>

        <div className="space-y-8">
          {posts.map((post) => (
            <article
              key={post.slug}
              className="group rounded-2xl border border-gray-100 bg-white p-6 sm:p-8 hover:border-teal-200 hover:shadow-lg hover:shadow-teal-50 transition-all"
            >
              <div className="flex items-center gap-3 text-sm text-gray-400 mb-3">
                <time>{post.date}</time>
                <span>·</span>
                <span>{post.readingMinutes} min read</span>
              </div>
              <h2 className="text-2xl font-bold font-heading text-gray-900 tracking-tight mb-2">
                <Link href={`/blog/${post.slug}`} className="hover:text-teal-700">
                  {post.title}
                </Link>
              </h2>
              <p className="text-gray-600 leading-relaxed mb-4">{post.excerpt}</p>
              <Link
                href={`/blog/${post.slug}`}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-teal-600 group-hover:text-teal-700"
              >
                Read
                <ArrowRight className="w-4 h-4" />
              </Link>
            </article>
          ))}
        </div>

        <div className="mt-14 rounded-2xl border border-teal-100 bg-teal-50/40 p-8 text-center">
          <h2 className="text-xl font-semibold font-heading text-gray-900 mb-2">
            Get new writing by email
          </h2>
          <p className="text-gray-600 mb-6 max-w-md mx-auto">
            No spam — just our notes on open veterinary software as we publish them.
            Reply with your thoughts; we read every one.
          </p>
          <div className="max-w-sm mx-auto">
            <SubscribeForm source="blog" />
          </div>
        </div>
      </div>
    </div>
  );
}
