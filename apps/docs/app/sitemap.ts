import type { MetadataRoute } from "next";
import { guides, tours, trainings } from "@/lib/content";

const SITE = "https://docs.openvpm.com";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    "/",
    "/guides",
    "/training",
    "/screens",
    ...guides.map((g) => `/guides/${g.slug}`),
    ...trainings.map((t) => `/training/${t.id}`),
    ...tours.map((t) => `/screens/${t.area}`),
  ].map((path) => ({ url: `${SITE}${path === "/" ? "" : path}` }));
}
