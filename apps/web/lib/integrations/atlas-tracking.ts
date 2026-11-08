import { createHmac } from "node:crypto";
import type { Database } from "@openpims/db/client";
import { loadPracticeTracking } from "@/lib/admin/practice-tracking";
import type { TrackingCursor } from "@/lib/admin/practice-tracking-types";
import { billingEnforced } from "@/lib/billing/plans";

/** Operator-configured HTTPS destination; redirects never receive account data. */
export async function syncAtlasTracking(db: Database) {
  if (process.env.ATLAS_OPENVPM_SYNC_ENABLED !== "true")
    return { status: "disabled" as const, accepted: 0 };
  if (!billingEnforced() || process.env.OPENVPM_ENVIRONMENT !== "production" || (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production"))
    return { status: "disabled" as const, accepted: 0 };
  const secret = process.env.OPENVPM_USAGE_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error("OpenVPM Atlas signing secret is not configured");

  const intake = new URL(process.env.ATLAS_OPENVPM_INTAKE_URL || "");
  if (intake.protocol !== "https:" || intake.username || intake.password || intake.search || intake.hash || intake.pathname !== "/api/intake/openvpm/sync")
    throw new Error("Atlas tracking requires a credential-free HTTPS intake URL");
  const asOf = new Date();
  let cursor: TrackingCursor | undefined;
  let accepted = 0;
  for (let page = 0; page < 20; page++) {
    const snapshot = await loadPracticeTracking(db, { limit: 100, cursor, asOf });
    if (snapshot.practices.length) {
      const body = JSON.stringify({ schema: "openvpm-tracking-v1", snapshotAt: snapshot.snapshotAt, practices: snapshot.practices });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
      const response = await fetch(intake.toString(), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
        headers: { "Content-Type": "application/json", "x-atlas-timestamp": timestamp, "x-atlas-signature": `sha256=${signature}` },
        body,
      });
      if (!response.ok) throw new Error(`Atlas tracking intake returned HTTP ${response.status}`);
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || !("accepted" in result) || result.accepted !== snapshot.practices.length)
        throw new Error("Atlas tracking intake did not acknowledge the complete page");
      accepted += snapshot.practices.length;
    }
    if (!snapshot.nextCursor) return { status: "ok" as const, accepted };
    cursor = snapshot.nextCursor;
  }
  throw new Error("Atlas tracking exceeded the bounded sync page limit");
}
