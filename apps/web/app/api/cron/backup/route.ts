import { NextResponse } from "next/server";
import { isNull } from "drizzle-orm";
import { db } from "@openpims/db/client";
import { practices } from "@openpims/db";
import { exportPracticeData, backupKey } from "@/lib/backup/export";
import { uploadFile } from "@/lib/s3";
import { alertOps } from "@/lib/alerts";
import { withSystem, withTenant } from "@/lib/tenant-db";
import { cronAuthError } from "@/lib/cron-auth";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";
import { formatDateInputForTimeZone } from "@/lib/date-input";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Scheduled per-practice backup → object storage. A clinic gets a daily,
// restorable JSON snapshot of its data, independent of the live DB.
export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  const startedAt = new Date();
  const exportedAt = startedAt.toISOString();
  const runDateUtc = exportedAt.slice(0, 10);
  let ok = 0;
  let failed = 0;

  try {
    // Cross-tenant sweep → system context (RLS bypass).
    const allPractices = await withSystem(db, (tx) =>
      tx
        .select({ id: practices.id, timezone: practices.timezone })
        .from(practices)
        .where(isNull(practices.deletedAt))
    );

    for (const p of allPractices) {
      try {
        // Export each practice in its own tenant context (RLS-scoped).
        const data = await withTenant(db, p.id, (tx) =>
          exportPracticeData(tx, p.id, exportedAt)
        );
        const backupDate = formatDateInputForTimeZone(
          startedAt,
          p.timezone?.trim() || "UTC"
        );
        const key = backupKey(p.id, backupDate);
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
        `${failed} of ${allPractices.length} practice backups failed for UTC run ${runDateUtc}.`,
      );
    }

    await reportCronHeartbeat({
      job: "backup",
      status: failed > 0 ? "degraded" : "ok",
      detail: `${ok} practice backups succeeded, ${failed} failed`,
      metrics: {
        practices: allPractices.length,
        ok,
        failed,
      },
    });

    return NextResponse.json({ date: runDateUtc, practices: allPractices.length, ok, failed });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void alertOps(
      "Backup cron job crashed",
      message,
    );
    console.error("Cron backup job failed:", error);
    await reportCronHeartbeat({
      job: "backup",
      status: "failed",
      detail: message,
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
