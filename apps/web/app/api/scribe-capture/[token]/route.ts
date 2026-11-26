import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { and, eq, gt, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { captureSessions, practices, users } from "@openpims/db";
import { db, type Database } from "@openpims/db/client";
import { withSystem, withTenant } from "@/lib/tenant-db";
import { rateLimit, rateLimitResponseHeaders } from "@/lib/rate-limit";
import { clientIpFromRequest } from "@/lib/request-ip";
import { captureRateLimitKey, isCaptureTokenShape } from "@/lib/consult/tokens";
import { readRequestBytesWithLimit } from "@/lib/request-body";
import {
  base64ToBytes,
  inspectScribeWav,
  SCRIBE_SEGMENT_MAX_BASE64_LENGTH,
} from "@/lib/scribe/audio";
import { bindRecordingDevice, findRecording } from "@/lib/scribe/recordings";
import { canUseScribeRole, scribeRolloutEnabled } from "@/lib/scribe/availability";
import { transcribeIntoVisit } from "@/lib/scribe/visit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * No-login recording endpoint behind a Scribe phone link (see
 * scribe.startPhoneRecording). The phone sends the visit one short stretch of
 * audio at a time; each becomes part of that visit's transcript in the chart.
 *
 * Same security model as the photo capture route: the token shape is checked
 * before any work, the link is looked up under withSystem with the practice
 * alive and not on recovery hold, and every miss is the same generic 404. The
 * link records as the clinician who opened it, so it stops working if that
 * person can no longer use Scribe.
 *
 * Two things differ from the photo route, because a recording link is shown
 * on a screen in the exam room for a while. The link belongs to the first
 * phone that opens it: a second device with the same link is turned away.
 * And nothing that was said is ever sent back to the phone, which only needs
 * to know that a part arrived.
 */

/** The phone's own random secret, sent with every request once it has one. */
const DEVICE_HEADER = "x-scribe-device";
const DEVICE_KEY_PATTERN = /^[a-f0-9]{32,64}$/;

const TOKEN_LIMIT = 30;
const TOKEN_WINDOW_MS = 5 * 60 * 1000;
const IP_LIMIT = 300;
const IP_WINDOW_MS = 10 * 60 * 1000;
/** Base64 audio plus a little JSON around it. */
const REQUEST_MAX_BYTES = SCRIBE_SEGMENT_MAX_BASE64_LENGTH + 4096;

const bodySchema = z.union([
  z
    .object({
      audio: z.string().min(1).max(SCRIBE_SEGMENT_MAX_BASE64_LENGTH),
      clientKey: z.string().uuid(),
    })
    .strict(),
  z.object({ action: z.enum(["check", "finish"]) }).strict(),
]);

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}

function notFound(): NextResponse {
  return noStore(NextResponse.json({ error: "Not found" }, { status: 404 }));
}

function errorResponse(message: string, status: number): NextResponse {
  return noStore(NextResponse.json({ error: message }, { status }));
}

async function lookupScribeLink(database: Database, token: string) {
  const [row] = await database
    .select({
      id: captureSessions.id,
      practiceId: captureSessions.practiceId,
      appointmentId: captureSessions.appointmentId,
      createdBy: captureSessions.createdBy,
      creatorRole: users.role,
    })
    .from(captureSessions)
    .innerJoin(
      practices,
      and(
        eq(practices.id, captureSessions.practiceId),
        eq(practices.recoveryHold, false),
        isNull(practices.deletedAt),
      ),
    )
    .innerJoin(
      users,
      and(
        eq(users.id, captureSessions.createdBy),
        eq(users.practiceId, captureSessions.practiceId),
        isNull(users.deletedAt),
      ),
    )
    .where(
      and(
        eq(captureSessions.token, token),
        eq(captureSessions.purpose, "scribe"),
        isNull(captureSessions.deletedAt),
        gt(captureSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!scribeRolloutEnabled() || !isCaptureTokenShape(token)) {
    return notFound();
  }

  const ipResult = await rateLimit({
    key: `scribe-capture:ip:${clientIpFromRequest(request)}`,
    limit: IP_LIMIT,
    windowMs: IP_WINDOW_MS,
  });
  if (!ipResult.success) {
    return noStore(
      NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: rateLimitResponseHeaders(IP_LIMIT, ipResult) },
      ),
    );
  }
  const tokenResult = await rateLimit({
    key: captureRateLimitKey("scribe-capture", token),
    limit: TOKEN_LIMIT,
    windowMs: TOKEN_WINDOW_MS,
  });
  if (!tokenResult.success) {
    return noStore(
      NextResponse.json(
        { error: "Too many requests" },
        {
          status: 429,
          headers: rateLimitResponseHeaders(TOKEN_LIMIT, tokenResult),
        },
      ),
    );
  }

  const link = await withSystem(db, (tx) => lookupScribeLink(tx, token));
  if (
    !link ||
    !link.appointmentId ||
    !link.createdBy ||
    !canUseScribeRole(link.creatorRole)
  ) {
    return notFound();
  }

  const raw = await readRequestBytesWithLimit(request, REQUEST_MAX_BYTES);
  if (!raw.ok) return errorResponse("That recording is too large.", 413);
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(JSON.parse(new TextDecoder().decode(raw.bytes)));
  } catch {
    return errorResponse("That request could not be read.", 400);
  }

  const appointmentId = link.appointmentId;
  const creatorId = link.createdBy;

  // The link belongs to one phone. The first to present a device secret keeps
  // it; anyone else holding the same link gets no further.
  const deviceKey = request.headers.get(DEVICE_HEADER) ?? "";
  if (!DEVICE_KEY_PATTERN.test(deviceKey)) {
    return errorResponse("That request could not be read.", 400);
  }
  const deviceKeyHash = createHash("sha256").update(deviceKey).digest("hex");
  const ownsLink = await withTenant(db, link.practiceId, async (tx) => {
    if ("action" in body && body.action === "check") {
      return bindRecordingDevice(tx, {
        practiceId: link.practiceId,
        recordingKey: link.id,
        deviceKeyHash,
      });
    }
    const recording = await findRecording(tx, link.practiceId, link.id);
    return recording?.deviceKeyHash === deviceKeyHash;
  });
  if (!ownsLink) {
    return errorResponse("This link is already open on another phone.", 409);
  }

  if ("action" in body) {
    if (body.action === "finish") {
      await withTenant(db, link.practiceId, (tx) =>
        tx
          .update(captureSessions)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(captureSessions.id, link.id),
              eq(captureSessions.practiceId, link.practiceId),
            ),
          ),
      );
    }
    return noStore(NextResponse.json({ ok: true }));
  }

  const wav = base64ToBytes(body.audio);
  const inspection = wav ? inspectScribeWav(wav) : null;
  if (!wav || !inspection?.ok) {
    return errorResponse("That recording could not be read. Record it again.", 400);
  }

  try {
    const result = await withTenant(db, link.practiceId, (tx) =>
      transcribeIntoVisit(
        { db: tx, practiceId: link.practiceId, user: { id: creatorId } },
        {
          appointmentId,
          clientKey: body.clientKey,
          // One link is one recording, whatever the phone says.
          recordingKey: link.id,
          wav,
          durationSeconds: inspection.durationSeconds,
          source: "phone",
          phoneLinkId: link.id,
        },
      ),
    );
    // Never the words: the phone only counts the parts that held speech.
    return noStore(
      NextResponse.json({ ok: true, heardSpeech: result.text.length > 0 }),
    );
  } catch (error) {
    if (error instanceof TRPCError) {
      // Say only what the person holding the phone can act on. Why a clinic,
      // a visit, or a plan stopped taking recordings is not theirs to know.
      switch (error.code) {
        case "TOO_MANY_REQUESTS":
          return errorResponse("Too many requests", 429);
        case "CONFLICT":
          return errorResponse(
            "This visit is already being recorded on another device.",
            409,
          );
        case "BAD_REQUEST":
          return errorResponse(
            "This recording is full. Tap Finish to write the note.",
            400,
          );
        case "INTERNAL_SERVER_ERROR":
          return errorResponse(
            "Could not transcribe that part of the recording.",
            500,
          );
        default:
          return notFound();
      }
    }
    console.error(
      "[scribe-capture] request failed:",
      error instanceof Error ? error.name : "unknown",
    );
    return errorResponse("Could not transcribe that part of the recording.", 500);
  }
}
