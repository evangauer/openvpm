import { and, eq, inArray, isNull } from "drizzle-orm";
import { appointmentTypes, bookingPages, services } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import type { BuildService } from "@/lib/build/catalog";
import {
  BOOKING_SLUG_MAX_LENGTH,
  BOOKING_WELCOME_MAX_LENGTH,
  DEFAULT_BOOKING_PAGE_CONFIG,
  isValidBookingSlug,
  suggestBookingSlug,
  type BookingPageConfig,
} from "@/lib/booking/page-config";

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

/**
 * Give a built clinic its online booking page, unpublished: a slug from its
 * name, every starter visit type bookable, and its brand colour. The clinic
 * reviews hours and publishes it from settings. Runs in a savepoint, so a
 * slug race or a bad name never fails registration; it just skips the page.
 */
export async function setUpBuildBookingPage(
  tx: Database,
  input: { practiceId: string; clinicName: string; brandColor: string },
): Promise<string | null> {
  const base = suggestBookingSlug(input.clinicName);
  if (!isValidBookingSlug(base)) return null;
  try {
    return await tx.transaction(async (sp) => {
      const candidates = [
        base,
        ...[2, 3, 4, 5].map((n) =>
          `${base.slice(0, BOOKING_SLUG_MAX_LENGTH - 2)}-${n}`,
        ),
      ].filter(isValidBookingSlug);
      const taken = new Set(
        (
          await sp
            .select({ slug: bookingPages.slug })
            .from(bookingPages)
            .where(inArray(bookingPages.slug, candidates))
        ).map((row) => row.slug),
      );
      const slug = candidates.find((candidate) => !taken.has(candidate));
      if (!slug) return null;
      const types = await sp
        .select({ id: appointmentTypes.id })
        .from(appointmentTypes)
        .where(eq(appointmentTypes.practiceId, input.practiceId));
      const config: BookingPageConfig = {
        ...DEFAULT_BOOKING_PAGE_CONFIG,
        bookableTypeIds: types.map((type) => type.id),
        accentColor: input.brandColor.toLowerCase(),
        welcomeText: `Book a visit with ${input.clinicName.trim()}.`.slice(
          0,
          BOOKING_WELCOME_MAX_LENGTH,
        ),
      };
      await sp.insert(bookingPages).values({
        practiceId: input.practiceId,
        slug,
        published: false,
        config,
      });
      return slug;
    });
  } catch (error) {
    console.error("[build] booking page setup skipped:", error);
    return null;
  }
}
