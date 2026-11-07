import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const nextConfig = require("../../next.config.js") as {
  headers: () => Promise<
    {
      source: string;
      headers: { key: string; value: string }[];
    }[]
  >;
};

describe("public capability page privacy", () => {
  for (const capability of ["capture", "sign", "treatment-plan"] as const) {
    it(`${capability} pages suppress indexing, caching, and referrers`, () => {
      const source = readFileSync(`app/${capability}/layout.tsx`, "utf8");

      expect(source).toContain('referrer: "no-referrer"');
      expect(source).toContain("index: false");
      expect(source).toContain("follow: false");
      expect(source).toContain("nocache: true");
    });
  }

  it("sets capability privacy at the HTTP boundary before subresources load", async () => {
    const configuredHeaders = await nextConfig.headers();
    const expectedHeaders = [
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
      { key: "Cache-Control", value: "private, no-store, max-age=0" },
    ];

    for (const path of [
      "/capture/:path*",
      "/sign/:path*",
      "/treatment-plan/:path*",
      "/api/capture/:path*",
      "/api/sign/:path*",
      "/api/treatment-plan/:path*",
    ]) {
      expect(configuredHeaders).toContainEqual({
        source: path,
        headers: expectedHeaders,
      });
    }
  });
});
