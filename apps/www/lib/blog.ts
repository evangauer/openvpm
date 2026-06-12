import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { compileMDX } from "next-mdx-remote/rsc";

// Blog posts are MDX files with YAML frontmatter in content/blog/. The content
// pipeline (rpa-agents blog-writer, Brand: openvpm) drops posts here via PR;
// frontmatter matches the rpastudiowebsite convention so output is portable.
export interface PostFrontmatter {
  title: string;
  description: string;
  date: string; // YYYY-MM-DD
  author?: string;
  tags?: string[];
}

export interface PostMeta extends PostFrontmatter {
  slug: string;
}

const BLOG_DIR = path.join(process.cwd(), "content", "blog");

export async function getPostSlugs(): Promise<string[]> {
  try {
    const files = await readdir(BLOG_DIR);
    return files
      .filter((file) => file.endsWith(".mdx") || file.endsWith(".md"))
      .map((file) => file.replace(/\.mdx?$/, ""));
  } catch {
    return []; // no posts yet
  }
}

async function readPostSource(slug: string): Promise<string> {
  try {
    return await readFile(path.join(BLOG_DIR, `${slug}.mdx`), "utf-8");
  } catch {
    return await readFile(path.join(BLOG_DIR, `${slug}.md`), "utf-8");
  }
}

export async function getPost(slug: string) {
  const source = await readPostSource(slug);
  const { content, frontmatter } = await compileMDX<PostFrontmatter>({
    source,
    options: { parseFrontmatter: true },
  });
  return { content, meta: { ...frontmatter, slug } as PostMeta };
}

export async function getAllPosts(): Promise<PostMeta[]> {
  const slugs = await getPostSlugs();
  const posts = await Promise.all(
    slugs.map(async (slug) => {
      const { meta } = await getPost(slug);
      return meta;
    })
  );
  return posts.sort((a, b) => (a.date < b.date ? 1 : -1));
}
