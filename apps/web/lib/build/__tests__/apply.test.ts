import { describe, expect, it, vi } from "vitest";
import { applyBuildServices, setUpBuildBookingPage } from "@/lib/build/apply";

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

describe("setUpBuildBookingPage", () => {
  function bookingTx(taken: string[]) {
    const inserted: Array<Record<string, unknown>> = [];
    let selects = 0;
    const sp = {
      select: vi.fn(() => ({
        from: () => ({
          where: async () => {
            selects += 1;
            return selects === 1
              ? taken.map((slug) => ({ slug }))
              : [{ id: "type-1" }, { id: "type-2" }];
          },
        }),
      })),
      insert: vi.fn(() => ({
        values: async (values: Record<string, unknown>) => {
          inserted.push(values);
        },
      })),
    };
    const tx = { transaction: async (fn: (s: typeof sp) => unknown) => fn(sp) };
    return { tx, inserted };
  }

  it("creates an unpublished page from the clinic's name, types, and color", async () => {
    const { tx, inserted } = bookingTx(["harbor-view-vet"]);
    const slug = await setUpBuildBookingPage(tx as never, {
      practiceId: "practice-1",
      clinicName: "Harbor View Vet",
      brandColor: "#E8590C",
    });
    expect(slug).toBe("harbor-view-vet-2");
    expect(inserted).toEqual([
      expect.objectContaining({
        practiceId: "practice-1",
        slug: "harbor-view-vet-2",
        published: false,
        config: expect.objectContaining({
          bookableTypeIds: ["type-1", "type-2"],
          accentColor: "#e8590c",
          welcomeText: "Book a visit with Harbor View Vet.",
        }),
      }),
    ]);
  });

  it("never fails registration", async () => {
    const tx = {
      transaction: async () => {
        throw new Error("duplicate key");
      },
    };
    await expect(
      setUpBuildBookingPage(tx as never, {
        practiceId: "practice-1",
        clinicName: "Harbor View Vet",
        brandColor: "#e8590c",
      }),
    ).resolves.toBeNull();
  });
});
