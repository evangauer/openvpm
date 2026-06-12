import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getAllPosts } from "../../lib/blog";

export const metadata: Metadata = {
  title: "Blog",
  description:
    "Notes from building OpenVPM — the open-source veterinary practice management system. Practice ownership, open data, and what we're learning along the way.",
};

function formatDate(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default async function BlogIndexPage() {
  const posts = await getAllPosts();

  return (
    <div className="py-16 sm:py-24">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-14">
          <h1 className="text-4xl sm:text-5xl font-bold font-heading text-gray-900 tracking-tight mb-4">
            Blog
          </h1>
          <p className="text-lg text-gray-600 max-w-xl mx-auto">
            Notes from building an open-source PIMS, in the open, with the
            veterinary community.
          </p>
        </div>

        {posts.length === 0 ? (
          <p className="text-center text-gray-500">First post coming soon.</p>
        ) : (
          <div className="space-y-8">
            {posts.map((post) => (
              <article
                key={post.slug}
                className="rounded-2xl border border-gray-100 bg-white p-6 sm:p-8 shadow-sm hover:border-teal-200 transition-colors"
              >
                <time className="text-sm text-gray-400">{formatDate(post.date)}</time>
                <h2 className="mt-2 text-xl font-semibold font-heading text-gray-900">
                  <Link href={`/blog/${post.slug}`} className="hover:text-teal-600 transition-colors">
                    {post.title}
                  </Link>
                </h2>
                <p className="mt-3 text-gray-600 leading-relaxed">{post.description}</p>
                <Link
                  href={`/blog/${post.slug}`}
                  className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-teal-600 hover:text-teal-700"
                >
                  Read post <ArrowRight className="w-4 h-4" />
                </Link>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
