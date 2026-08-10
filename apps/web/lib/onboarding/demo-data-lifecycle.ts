import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  appointments,
  clients,
  communications,
  invoiceItems,
  invoices,
  patients,
  practices,
  problemList,
  products,
  soapNotes,
  vaccinationRecords,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { seedDemoData, type DemoDataIds } from "./defaults";

export interface DemoDataProvenance extends DemoDataIds {
  /** Set after sample rows are cleared. IDs remain forever for attribution. */
  clearedAt?: string | null;
}

type StoredDemoData = Partial<DemoDataIds> & {
  clientIds: string[];
  patientIds: string[];
  appointmentIds: string[];
  clearedAt?: string | null;
};

type PracticeSettingsWithDemo = {
  demoData?: StoredDemoData;
};

function uniqueIds(...groups: Array<string[] | undefined>): string[] {
  return [...new Set(groups.flatMap((group) => group ?? []))];
}

export function mergeDemoDataProvenance(
  existing: StoredDemoData | undefined,
  latest: DemoDataIds,
): DemoDataProvenance {
  return {
    clientIds: uniqueIds(existing?.clientIds, latest.clientIds),
    patientIds: uniqueIds(existing?.patientIds, latest.patientIds),
    appointmentIds: uniqueIds(existing?.appointmentIds, latest.appointmentIds),
    soapNoteIds: uniqueIds(existing?.soapNoteIds, latest.soapNoteIds),
    vaccinationIds: uniqueIds(
      existing?.vaccinationIds,
      latest.vaccinationIds,
    ),
    problemIds: uniqueIds(existing?.problemIds, latest.problemIds),
    invoiceIds: uniqueIds(existing?.invoiceIds, latest.invoiceIds),
    invoiceItemIds: uniqueIds(
      existing?.invoiceItemIds,
      latest.invoiceItemIds,
    ),
    communicationIds: uniqueIds(
      existing?.communicationIds,
      latest.communicationIds,
    ),
    productIds: uniqueIds(existing?.productIds, latest.productIds),
    clearedAt: null,
  };
}

export function hasLiveDemoData(
  demo: StoredDemoData | null | undefined,
): boolean {
  return Boolean(demo && !demo.clearedAt);
}

function activePracticeWhere(practiceId: string) {
  return and(eq(practices.id, practiceId), isNull(practices.deletedAt));
}

async function lockDemoLifecycle(
  db: Database,
  practiceId: string,
): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${'openvpm:demo-data:' + practiceId}, 0))`,
  );
}

function settingsDemoPatch(demoData: DemoDataProvenance) {
  return sql`coalesce(${practices.settings}, '{}'::jsonb) || ${JSON.stringify({ demoData })}::jsonb`;
}

export async function clearSeededDemoData(
  db: Database,
  practiceId: string,
): Promise<{ found: boolean; alreadyCleared: boolean }> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    await lockDemoLifecycle(tx, practiceId);

    const [practice] = await tx
      .select({ settings: practices.settings })
      .from(practices)
      .where(activePracticeWhere(practiceId))
      .for("update");
    if (!practice) return { found: false, alreadyCleared: false };

    const settings = (practice.settings ?? {}) as PracticeSettingsWithDemo;
    const demo = settings.demoData;
    if (!demo || demo.clearedAt) {
      return { found: true, alreadyCleared: true };
    }

    const now = new Date();
    const storedDemoSoapNoteIds = demo.soapNoteIds ?? [];
    let demoSoapNoteIds = [...storedDemoSoapNoteIds];
    if (demo.appointmentIds.length > 0 || demo.patientIds.length > 0) {
      const discoveredDemoSoapNotes = await tx
        .select({ id: soapNotes.id })
        .from(soapNotes)
        .where(
          and(
            eq(soapNotes.practiceId, practiceId),
            or(
              inArray(soapNotes.appointmentId, demo.appointmentIds),
              inArray(soapNotes.patientId, demo.patientIds),
            ),
          ),
        );
      demoSoapNoteIds = uniqueIds(
        storedDemoSoapNoteIds,
        discoveredDemoSoapNotes.map((note) => note.id),
      );
    }

    if (demo.productIds?.length) {
      await tx
        .update(products)
        .set({ deletedAt: now })
        .where(
          and(
            eq(products.practiceId, practiceId),
            inArray(products.id, demo.productIds),
          ),
        );
    }
    if (demo.communicationIds?.length) {
      await tx
        .update(communications)
        .set({ deletedAt: now })
        .where(
          and(
            eq(communications.practiceId, practiceId),
            inArray(communications.id, demo.communicationIds),
          ),
        );
    }
    if (demo.invoiceItemIds?.length) {
      await tx
        .update(invoiceItems)
        .set({ deletedAt: now })
        .where(
          and(
            inArray(invoiceItems.id, demo.invoiceItemIds),
            sql`exists (
              select 1
              from ${invoices}
              where ${invoices.id} = ${invoiceItems.invoiceId}
                and ${invoices.practiceId} = ${practiceId}
            )`,
          ),
        );
    }
    if (demo.invoiceIds?.length) {
      await tx
        .update(invoices)
        .set({ deletedAt: now })
        .where(
          and(
            eq(invoices.practiceId, practiceId),
            inArray(invoices.id, demo.invoiceIds),
          ),
        );
    }
    if (demo.problemIds?.length) {
      await tx
        .update(problemList)
        .set({ deletedAt: now })
        .where(
          and(
            eq(problemList.practiceId, practiceId),
            inArray(problemList.id, demo.problemIds),
          ),
        );
    }
    if (demo.vaccinationIds?.length) {
      await tx
        .update(vaccinationRecords)
        .set({ deletedAt: now })
        .where(
          and(
            eq(vaccinationRecords.practiceId, practiceId),
            inArray(vaccinationRecords.id, demo.vaccinationIds),
          ),
        );
    }
    if (demoSoapNoteIds.length) {
      await tx
        .update(soapNotes)
        .set({ deletedAt: now })
        .where(
          and(
            eq(soapNotes.practiceId, practiceId),
            inArray(soapNotes.id, demoSoapNoteIds),
          ),
        );
    }
    if (demo.appointmentIds.length) {
      await tx
        .update(appointments)
        .set({ deletedAt: now })
        .where(
          and(
            eq(appointments.practiceId, practiceId),
            inArray(appointments.id, demo.appointmentIds),
          ),
        );
    }
    if (demo.patientIds.length) {
      await tx
        .update(patients)
        .set({ deletedAt: now })
        .where(
          and(
            eq(patients.practiceId, practiceId),
            inArray(patients.id, demo.patientIds),
          ),
        );
    }
    if (demo.clientIds.length) {
      await tx
        .update(clients)
        .set({ deletedAt: now })
        .where(
          and(
            eq(clients.practiceId, practiceId),
            inArray(clients.id, demo.clientIds),
          ),
        );
    }

    const preserved: DemoDataProvenance = {
      clientIds: demo.clientIds,
      patientIds: demo.patientIds,
      appointmentIds: demo.appointmentIds,
      soapNoteIds: demoSoapNoteIds,
      vaccinationIds: demo.vaccinationIds ?? [],
      problemIds: demo.problemIds ?? [],
      invoiceIds: demo.invoiceIds ?? [],
      invoiceItemIds: demo.invoiceItemIds ?? [],
      communicationIds: demo.communicationIds ?? [],
      productIds: demo.productIds ?? [],
      clearedAt: now.toISOString(),
    };
    const [updated] = await tx
      .update(practices)
      .set({ settings: settingsDemoPatch(preserved) })
      .where(activePracticeWhere(practiceId))
      .returning({ id: practices.id });
    if (!updated) return { found: false, alreadyCleared: false };

    return { found: true, alreadyCleared: false };
  });
}

export async function reseedSampleClinic(
  db: Database,
  practiceId: string,
): Promise<{ found: boolean; alreadyPresent: boolean }> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    await lockDemoLifecycle(tx, practiceId);

    const [practice] = await tx
      .select({ settings: practices.settings })
      .from(practices)
      .where(activePracticeWhere(practiceId))
      .for("update");
    if (!practice) return { found: false, alreadyPresent: false };

    const settings = (practice.settings ?? {}) as PracticeSettingsWithDemo;
    if (hasLiveDemoData(settings.demoData)) {
      return { found: true, alreadyPresent: true };
    }

    const latest = await seedDemoData(tx, { practiceId });
    const preserved = mergeDemoDataProvenance(settings.demoData, latest);
    const [updated] = await tx
      .update(practices)
      .set({ settings: settingsDemoPatch(preserved) })
      .where(activePracticeWhere(practiceId))
      .returning({ id: practices.id });
    if (!updated) return { found: false, alreadyPresent: false };

    return { found: true, alreadyPresent: false };
  });
}
