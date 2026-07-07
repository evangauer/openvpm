import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function tsxFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  return entries.flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? tsxFiles(path) : [path];
  }).filter((path) => path.endsWith(".tsx"));
}

const TABLE_PAGE_ROOTS = ["app/(dashboard)", "app/portal"];

describe("responsive dashboard and portal tables", () => {
  it("wraps tables in horizontal scroll containers", () => {
    const offenders: string[] = [];

    for (const file of TABLE_PAGE_ROOTS.flatMap(tsxFiles)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!line.includes("<table")) return;
        const localWrapper = lines
          .slice(Math.max(0, index - 5), index + 1)
          .some(
            (candidate) =>
              candidate.includes("overflow-x-auto") ||
              candidate.includes("<TableScroll")
          );
        if (!localWrapper) {
          offenders.push(`${file}:${index + 1}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
