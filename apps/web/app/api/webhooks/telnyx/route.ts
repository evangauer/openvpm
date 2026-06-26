import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@openpims/db/client";
import { locationMessaging, clients, communications } from "@openpims/db";
import { withSystem, withTenant } from "@/lib/tenant-db";
import {
  addSuppression,
  removeSuppression,
  normalizeE164,
} from "@/lib/messaging";
import { verifyTelnyxSignature } from "@/lib/messaging/telnyx-signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Carrier-mandated opt-out / opt-in keywords (Telnyx also auto-handles these at
// the network level; we mirror them into our own suppression list for the gate).
const STOP_KEYWORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "REVOKE",
  "OPTOUT",
]);
const START_KEYWORDS = new Set(["START", "YES", "UNSTOP"]);

/** Best-effort: find a client in the practice whose phone matches (last 10 digits). */
async function findClientId(
  practiceId: string,
  e164: string
): Promise<string | null> {
  const digits = e164.replace(/\D/g, "").slice(-10);
  if (digits.length < 10) return null;
  const [row] = await withSystem(db, (tx) =>
    tx
      .select({ id: clients.id })
      .from(clients)
      .where(
        and(
          eq(clients.practiceId, practiceId),
          sql`right(regexp_replace(${clients.phone}, '\D', '', 'g'), 10) = ${digits}`
        )
      )
      .limit(1)
  );
  return row?.id ?? null;
}

/** Flip a client's SMS consent flag (best-effort audit on opt-out/opt-in). */
async function setClientConsent(
  practiceId: string,
  e164: string,
  consent: boolean
): Promise<void> {
  const digits = e164.replace(/\D/g, "").slice(-10);
  if (digits.length < 10) return;
  await withSystem(db, (tx) =>
    tx
      .update(clients)
      .set({ smsConsent: consent, smsConsentAt: new Date() })
      .where(
        and(
          eq(clients.practiceId, practiceId),
          sql`right(regexp_replace(${clients.phone}, '\D', '', 'g'), 10) = ${digits}`
        )
      )
  );
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  // Fail closed: this public route mutates tenant data (suppression, consent,
  // inbox), so a missing key, missing headers, or a bad signature all reject —
  // matching the codebase's fail-closed auth elsewhere (cron-auth, Stripe webhook).
  const publicKey = process.env.TELNYX_PUBLIC_KEY;
  const sig = request.headers.get("telnyx-signature-ed25519");
  const ts = request.headers.get("telnyx-timestamp");
  if (
    !publicKey ||
    !sig ||
    !ts ||
    !verifyTelnyxSignature({
      rawBody,
      signatureB64: sig,
      timestamp: ts,
      publicKeyB64: publicKey,
    })
  ) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const data = (event as { data?: Record<string, unknown> })?.data;
  const eventType = data?.event_type as string | undefined;
  const payload = data?.payload as
    | {
        from?: { phone_number?: string };
        to?: Array<{ phone_number?: string }> | { phone_number?: string };
        text?: string;
      }
    | undefined;

  // We only act on inbound messages. DLRs and other events are acked.
  if (eventType !== "message.received" || !payload) {
    return NextResponse.json({ ok: true });
  }

  const toRaw = Array.isArray(payload.to)
    ? payload.to[0]?.phone_number
    : payload.to?.phone_number;
  const fromPhone = normalizeE164(payload.from?.phone_number);
  const toPhone = normalizeE164(toRaw);
  const text = (payload.text ?? "").trim();
  if (!fromPhone || !toPhone) {
    return NextResponse.json({ ok: true });
  }

  // Attribute the inbound number to a practice/location by our sender number.
  const [loc] = await withSystem(db, (tx) =>
    tx
      .select({
        practiceId: locationMessaging.practiceId,
        locationId: locationMessaging.locationId,
      })
      .from(locationMessaging)
      .where(eq(locationMessaging.senderE164, toPhone))
      .limit(1)
  );
  if (!loc) {
    console.warn(`[telnyx-webhook] inbound to unrecognised number ${toPhone}`);
    return NextResponse.json({ ok: true });
  }

  const keyword = text.toUpperCase().replace(/[^A-Z]/g, "");

  if (STOP_KEYWORDS.has(keyword)) {
    await addSuppression({
      practiceId: loc.practiceId,
      locationId: loc.locationId,
      phone: fromPhone,
      reason: "stop",
      detail: `Inbound opt-out: "${text}"`,
    });
    await setClientConsent(loc.practiceId, fromPhone, false);
    return NextResponse.json({ ok: true, action: "suppressed" });
  }

  if (START_KEYWORDS.has(keyword)) {
    await removeSuppression(loc.practiceId, fromPhone);
    await setClientConsent(loc.practiceId, fromPhone, true);
    return NextResponse.json({ ok: true, action: "unsuppressed" });
  }

  // A real inbound reply → write to the two-way inbox (communications).
  const clientId = await findClientId(loc.practiceId, fromPhone);
  await withTenant(db, loc.practiceId, (tx) =>
    tx.insert(communications).values({
      practiceId: loc.practiceId,
      clientId: clientId ?? undefined,
      channel: "sms",
      direction: "inbound",
      subject: `SMS from ${fromPhone}`,
      content: text,
      status: "delivered",
    })
  );
  return NextResponse.json({ ok: true, action: "logged" });
}
