import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Github } from "lucide-react";
import { posts, getPost } from "@/lib/posts";
import { PostContent } from "@/components/blog/post-content";
import { SubscribeForm } from "@/components/subscribe-form";

export function generateStaticParams() {
  return posts.map((p) => ({ slug: p.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const post = getPost(params.slug);
  if (!post) return { title: "Not found" };
  return {
    title: post.title,
    description: post.excerpt,
    openGraph: { title: post.title, description: post.excerpt, type: "article" },
  };
}

export default function PostPage({ params }: { params: { slug: string } }) {
  const post = getPost(params.slug);
  if (!post) notFound();

  return (
    <article className="py-16 sm:py-24">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
        <Link
          href="/blog"
          className="inline-flex items-center gap-1.5 text-sm text-teal-600 hover:text-teal-700 mb-8"
        >
          <ArrowLeft className="w-4 h-4" />
          All writing
        </Link>

        <div className="flex items-center gap-3 text-sm text-gray-400 mb-4">
          <time>{post.date}</time>
          <span>·</span>
          <span>{post.author}</span>
          <span>·</span>
          <span>{post.readingMinutes} min read</span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold font-heading text-gray-900 tracking-tight leading-tight mb-8">
          {post.title}
        </h1>

        <PostContent blocks={post.content} />

        {/* Conversion: every post ends with a way to engage. */}
        <div className="mt-12 rounded-2xl border border-gray-100 bg-gray-50/60 p-6 sm:p-8">
          <h2 className="text-lg font-semibold font-heading text-gray-900 mb-2">
            We&apos;re building this in the open
          </h2>
          <p className="text-sm text-gray-600 mb-5">
            OpenVPM is free and MIT licensed. Try the live demo, star the repo, or
            subscribe and tell us where we&apos;re wrong — the harder the feedback, the better.
          </p>
          <div className="flex flex-wrap gap-3 mb-6">
            <a
              href="https://demo.openvpm.com/login"
              className="inline-flex items-center gap-2 rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 transition-colors"
            >
              Try the live demo
            </a>
            <a
              href="https://github.com/evangauer/openvpm"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border-2 border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:border-teal-200 hover:text-teal-600 transition-colors"
            >
              <Github className="w-4 h-4" />
              Star on GitHub
            </a>
          </div>
          <SubscribeForm source={`post:${post.slug}`} />
        </div>
      </div>
    </article>
  );
}
