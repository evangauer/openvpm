import { and, eq, isNull } from "drizzle-orm";
import { services } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import type { BuildService } from "@/lib/build/catalog";

/**
 * Put the services a clinic chose while building into its catalog at the
 * prices it set. A name that matches a starter-catalog service (ignoring case)
 * updates that service's price; anything else is added. Call inside the
 * registration transaction, after the starter catalog is seeded.
 */
export async function applyBuildServices(
  tx: Database,
  practiceId: string,
  chosen: readonly BuildService[],
): Promise<void> {
  if (chosen.length === 0) return;
  const existing = await tx
    .select({ id: services.id, name: services.name })
    .from(services)
    .where(and(eq(services.practiceId, practiceId), isNull(services.deletedAt)));
  const byName = new Map(
    existing.map((row) => [row.name.trim().toLowerCase(), row.id]),
  );

  const seen = new Set<string>();
  for (const service of chosen) {
    const key = service.name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const price = service.price.toFixed(2);
    const id = byName.get(key);
    if (id) {
      await tx
        .update(services)
        .set({ defaultPrice: price })
        .where(and(eq(services.id, id), eq(services.practiceId, practiceId)));
    } else {
      await tx.insert(services).values({
        practiceId,
        name: service.name.trim(),
        category: "Services",
        defaultPrice: price,
        taxable: false,
      });
    }
  }
}
