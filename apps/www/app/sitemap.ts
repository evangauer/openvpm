import type { MetadataRoute } from "next";
import { getAllPosts } from "../lib/blog";

const baseUrl = "https://openvpm.com";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const posts = await getAllPosts();
  return [
    { url: `${baseUrl}/`, lastModified: now, changeFrequency: "weekly", priority: 1.0 },
    { url: `${baseUrl}/features`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${baseUrl}/why`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${baseUrl}/install`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${baseUrl}/updates`, lastModified: now, changeFrequency: "weekly", priority: 0.6 },
    { url: `${baseUrl}/blog`, lastModified: now, changeFrequency: "weekly", priority: 0.7 },
    ...posts.map((post) => ({
      url: `${baseUrl}/blog/${post.slug}`,
      lastModified: new Date(`${post.date}T12:00:00Z`),
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
    { url: `${baseUrl}/feedback`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
  ];
}
