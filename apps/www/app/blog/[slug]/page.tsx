import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getAllPosts, getPost, getPostSlugs } from "../../../lib/blog";

interface Props {
  params: { slug: string };
}

export async function generateStaticParams() {
  const slugs = await getPostSlugs();
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const posts = await getAllPosts();
  const post = posts.find((p) => p.slug === params.slug);
  if (!post) return { title: "Post not found" };
  return {
    title: post.title,
    description: post.description,
    openGraph: { title: post.title, description: post.description, type: "article" },
  };
}

function formatDate(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default async function BlogPostPage({ params }: Props) {
  let post;
  try {
    post = await getPost(params.slug);
  } catch {
    notFound();
  }

  const { content, meta } = post;

  return (
    <div className="py-16 sm:py-24">
      <article className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <Link
          href="/blog"
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-teal-600 hover:text-teal-700 mb-8"
        >
          <ArrowLeft className="w-4 h-4" /> All posts
        </Link>

        <header className="mb-10">
          <time className="text-sm text-gray-400">{formatDate(meta.date)}</time>
          <h1 className="mt-2 text-3xl sm:text-4xl font-bold font-heading text-gray-900 tracking-tight">
            {meta.title}
          </h1>
          {meta.author && <p className="mt-3 text-sm text-gray-500">By {meta.author}</p>}
        </header>

        <div className="prose prose-gray prose-headings:font-heading prose-a:text-teal-600 hover:prose-a:text-teal-700 prose-code:before:content-none prose-code:after:content-none max-w-none">
          {content}
        </div>

        <div className="mt-14 rounded-2xl border border-teal-100 bg-teal-50/40 p-8 text-center">
          <h2 className="text-xl font-semibold font-heading text-gray-900 mb-2">
            Try OpenVPM
          </h2>
          <p className="text-gray-600 mb-6">
            Open-source veterinary practice management. Live demo, no signup.
          </p>
          <a
            href="https://demo.openvpm.com"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-teal-600 px-6 py-3 text-sm font-semibold text-white hover:bg-teal-700 transition-colors"
          >
            Open the demo
          </a>
        </div>
      </article>
    </div>
  );
}
