import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("public capability page privacy", () => {
  for (const capability of ["capture", "sign"] as const) {
    it(`${capability} pages suppress indexing, caching, and referrers`, () => {
      const source = readFileSync(`app/${capability}/layout.tsx`, "utf8");

      expect(source).toContain('referrer: "no-referrer"');
      expect(source).toContain("index: false");
      expect(source).toContain("follow: false");
      expect(source).toContain("nocache: true");
    });
  }

  it("sets capability privacy at the HTTP boundary before subresources load", () => {
    const config = readFileSync("next.config.js", "utf8");

    for (const path of [
      "/capture/:path*",
      "/sign/:path*",
      "/api/capture/:path*",
      "/api/sign/:path*",
    ]) {
      expect(config).toContain(`source: "${path}"`);
    }
    expect(config).toContain('{ key: "Referrer-Policy", value: "no-referrer" }');
    expect(config).toContain(
      '{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" }',
    );
    expect(config).toContain(
      '{ key: "Cache-Control", value: "private, no-store, max-age=0" }',
    );
  });
});
