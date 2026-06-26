import { NextResponse } from "next/server";
import { isNull } from "drizzle-orm";
import { db } from "@openpims/db/client";
import { practices } from "@openpims/db";
import { exportPracticeData, backupKey } from "@/lib/backup/export";
import { uploadFile } from "@/lib/s3";
import { alertOps } from "@/lib/alerts";
import { withSystem, withTenant } from "@/lib/tenant-db";
import { cronAuthError } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Scheduled per-practice backup → object storage. A clinic gets a daily,
// restorable JSON snapshot of its data, independent of the live DB.
export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  const today = new Date().toISOString().slice(0, 10);
  let ok = 0;
  let failed = 0;

  try {
    // Cross-tenant sweep → system context (RLS bypass).
    const allPractices = await withSystem(db, (tx) =>
      tx
        .select({ id: practices.id })
        .from(practices)
        .where(isNull(practices.deletedAt))
    );

    for (const p of allPractices) {
      try {
        // Export each practice in its own tenant context (RLS-scoped).
        const data = await withTenant(db, p.id, (tx) =>
          exportPracticeData(tx, p.id, new Date().toISOString())
        );
        const key = backupKey(p.id, today);
        await uploadFile(key, Buffer.from(JSON.stringify(data)), "application/json");
        ok++;
      } catch (err) {
        failed++;
        void alertOps(
          "Practice backup failed",
          `practice ${p.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (failed > 0) {
      void alertOps(
        "Scheduled backup had failures",
        `${failed} of ${allPractices.length} practice backups failed for ${today}.`,
      );
    }

    return NextResponse.json({ date: today, practices: allPractices.length, ok, failed });
  } catch (error) {
    void alertOps(
      "Backup cron job crashed",
      error instanceof Error ? error.message : String(error),
    );
    console.error("Cron backup job failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
