import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("tRPC capability transport privacy", () => {
  it("posts query inputs so capability tokens never enter request URLs", () => {
    const providers = readFileSync("lib/providers.tsx", "utf8");
    const route = readFileSync("app/api/trpc/[trpc]/route.ts", "utf8");

    expect(providers).toContain('methodOverride: "POST"');
    expect(route).toContain("allowMethodOverride: true");
  });

  it("marks every tRPC response private and non-cacheable", () => {
    const route = readFileSync("app/api/trpc/[trpc]/route.ts", "utf8");

    expect(route).toContain('"Cache-Control": "private, no-store, max-age=0"');
  });
});
