import { describe, expect, it } from "vitest";
import { layoutOverlaps } from "../overlap-layout";

const at = (minutes: number) => minutes * 60_000;

function item(id: string, startMin: number, endMin: number) {
  return { id, startMs: at(startMin), endMs: at(endMin) };
}

describe("layoutOverlaps", () => {
  it("gives non-overlapping items the full width", () => {
    const layout = layoutOverlaps([item("a", 0, 30), item("b", 30, 60)]);
    expect(layout.get("a")).toEqual({ column: 0, columns: 1 });
    expect(layout.get("b")).toEqual({ column: 0, columns: 1 });
  });

  it("splits two concurrent items side by side (the Biscuit bug)", () => {
    const layout = layoutOverlaps([item("a", 0, 30), item("b", 0, 30)]);
    expect(layout.get("a")).toEqual({ column: 0, columns: 2 });
    expect(layout.get("b")).toEqual({ column: 1, columns: 2 });
  });

  it("splits partial overlaps too", () => {
    const layout = layoutOverlaps([item("a", 0, 45), item("b", 30, 60)]);
    expect(layout.get("a")).toEqual({ column: 0, columns: 2 });
    expect(layout.get("b")).toEqual({ column: 1, columns: 2 });
  });

  it("reuses a column once it frees up inside a cluster", () => {
    // Longer blocks claim the first column, so b (0-60) takes column 0 and
    // a (0-30) column 1. When c (30-60) starts, a's column is free again:
    // the cluster stays at two columns.
    const layout = layoutOverlaps([
      item("a", 0, 30),
      item("b", 0, 60),
      item("c", 30, 60),
    ]);
    expect(layout.get("b")).toEqual({ column: 0, columns: 2 });
    expect(layout.get("a")).toEqual({ column: 1, columns: 2 });
    expect(layout.get("c")).toEqual({ column: 1, columns: 2 });
  });

  it("shares the widest column count across a connected chain", () => {
    // Three-deep overlap at the peak: everyone in the cluster renders at
    // one-third width so edges line up.
    const layout = layoutOverlaps([
      item("a", 0, 60),
      item("b", 10, 40),
      item("c", 20, 50),
    ]);
    expect(layout.get("a")!.columns).toBe(3);
    expect(layout.get("b")!.columns).toBe(3);
    expect(layout.get("c")!.columns).toBe(3);
    const columns = ["a", "b", "c"].map((id) => layout.get(id)!.column);
    expect(new Set(columns).size).toBe(3);
  });

  it("starts a fresh cluster after a gap", () => {
    const layout = layoutOverlaps([
      item("a", 0, 30),
      item("b", 0, 30),
      item("c", 60, 90),
    ]);
    expect(layout.get("c")).toEqual({ column: 0, columns: 1 });
  });

  it("treats back-to-back items as non-overlapping", () => {
    const layout = layoutOverlaps([item("a", 0, 30), item("b", 30, 60)]);
    expect(layout.get("a")!.columns).toBe(1);
    expect(layout.get("b")!.columns).toBe(1);
  });

  it("handles zero-duration items without dividing by zero", () => {
    const layout = layoutOverlaps([item("a", 0, 0), item("b", 0, 30)]);
    expect(layout.get("a")!.columns).toBe(2);
    expect(layout.get("b")!.columns).toBe(2);
  });

  it("is deterministic for identical times", () => {
    const layout = layoutOverlaps([item("b", 0, 30), item("a", 0, 30)]);
    expect(layout.get("a")).toEqual({ column: 0, columns: 2 });
    expect(layout.get("b")).toEqual({ column: 1, columns: 2 });
  });
});
