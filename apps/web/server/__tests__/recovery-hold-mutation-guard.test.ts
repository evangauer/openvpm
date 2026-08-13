import { describe, expect, it, vi } from "vitest";
import { createRouter, protectedProcedure } from "../trpc";

describe("recovery-hold mutation guard", () => {
  it("rejects before the mutation handler or database transaction can run", async () => {
    const handler = vi.fn(() => ({ ok: true }));
    const transaction = vi.fn();
    const router = createRouter({
      write: protectedProcedure.mutation(handler),
    });
    const caller = router.createCaller({
      db: { transaction },
      session: {
        expires: new Date(Date.now() + 60_000).toISOString(),
        user: {
          id: "user-review",
          email: "review@example.invalid",
          name: "Review user",
          role: "admin",
          practiceId: "practice-review",
          recoveryHold: true,
        },
      },
      ip: null,
    } as never);

    await expect(caller.write()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("protected data review mode"),
    });
    expect(handler).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});
