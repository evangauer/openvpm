import { describe, expect, it, vi } from "vitest";
import { applyBuildServices } from "@/lib/build/apply";

function fakeTx(existing: Array<{ id: string; name: string }>) {
  const updates: unknown[] = [];
  const inserts: unknown[] = [];
  const tx = {
    select: vi.fn(() => ({
      from: () => ({ where: async () => existing }),
    })),
    update: vi.fn(() => ({
      set: (values: unknown) => ({
        where: async () => {
          updates.push(values);
        },
      }),
    })),
    insert: vi.fn(() => ({
      values: async (values: unknown) => {
        inserts.push(values);
      },
    })),
  };
  return { tx, updates, inserts };
}

describe("applyBuildServices", () => {
  it("reprices starter services and adds the rest, once each", async () => {
    const { tx, updates, inserts } = fakeTx([
      { id: "s1", name: "Wellness Exam" },
    ]);
    await applyBuildServices(tx as never, "practice-1", [
      { name: "wellness exam", price: 80 },
      { name: "Trip Fee", price: 45.5 },
      { name: "trip fee", price: 99 },
    ]);
    expect(updates).toEqual([{ defaultPrice: "80.00" }]);
    expect(inserts).toEqual([
      {
        practiceId: "practice-1",
        name: "Trip Fee",
        category: "Services",
        defaultPrice: "45.50",
        taxable: false,
      },
    ]);
  });

  it("does nothing without choices", async () => {
    const { tx } = fakeTx([]);
    await applyBuildServices(tx as never, "practice-1", []);
    expect(tx.select).not.toHaveBeenCalled();
  });
});
