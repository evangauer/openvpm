import { TRPCError } from "@trpc/server";
import { alertOps } from "@/lib/alerts";
import { rateLimit, type RateLimitResult } from "@/lib/rate-limit";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const OUTBOUND_EMAIL_LIMITS = {
  newPracticeFirstDay: 5,
  userPerHour: 20,
  practicePerHour: 50,
  ipPerHour: 50,
  practicePerDay: 200,
} as const;

type OutboundEmailOperation =
  | "inbox"
  | "staff_invite"
  | "appointment_reminder"
  | "invoice"
  | "vaccination_recall";

type Quota = {
  name: string;
  key: string;
  limit: number;
  windowMs: number;
};

export type OutboundEmailSecurityContext = {
  practiceId: string;
  practiceCreatedAt: Date | string | null | undefined;
  userId: string;
  userEmailVerifiedAt: Date | string | null | undefined;
  ip?: string | null;
  operation: OutboundEmailOperation;
  now?: Date;
};

function validDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function quotaDetail(
  context: OutboundEmailSecurityContext,
  quota: Quota,
  result: RateLimitResult,
): string {
  return [
    `practice=${context.practiceId}`,
    `user=${context.userId}`,
    `ip=${context.ip ?? "unknown"}`,
    `operation=${context.operation}`,
    `quota=${quota.name}`,
    `limit=${quota.limit}`,
    `resetAt=${result.resetAt.toISOString()}`,
  ].join(" ");
}

/**
 * Shared abuse boundary for every staff-triggered email surface. The counters
 * deliberately contain no recipient, subject, or message content so security
 * telemetry remains useful without copying client data into logs.
 */
export async function assertOutboundEmailAllowed(
  context: OutboundEmailSecurityContext,
): Promise<void> {
  // The shared inbox previously accepted free-form email copy from any
  // authenticated practice and delivered it with the platform Resend key.
  // A bad actor could therefore register a tenant, edit a client's address,
  // and use OpenVPM as an arbitrary mail relay. Keep historical email rows
  // readable, but permanently fail closed for this untrusted compose surface.
  // Templated product mail (invites, invoices, reminders, recalls, and account
  // lifecycle messages) continues through its bounded, purpose-specific path.
  if (context.operation === "inbox") {
    console.warn(
      `[security.outbound-email] blocked practice=${context.practiceId} user=${context.userId} ip=${context.ip ?? "unknown"} operation=inbox reason=free_form_email_disabled`,
    );
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Free-form email sending from the inbox is disabled for account safety.",
    });
  }

  if (!validDate(context.userEmailVerifiedAt)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Verify your email address before sending external email.",
    });
  }

  const practiceCreatedAt = validDate(context.practiceCreatedAt);
  if (!practiceCreatedAt) {
    await alertOps(
      "Outbound email blocked: missing security context",
      `practice=${context.practiceId} user=${context.userId} operation=${context.operation}`,
    ).catch(() => undefined);
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Email sending is temporarily unavailable.",
    });
  }

  const now = context.now ?? new Date();
  const quotas: Quota[] = [
    {
      name: "user_hour",
      key: `outbound-email:user-hour:${context.userId}`,
      limit: OUTBOUND_EMAIL_LIMITS.userPerHour,
      windowMs: HOUR_MS,
    },
    {
      name: "practice_hour",
      key: `outbound-email:practice-hour:${context.practiceId}`,
      limit: OUTBOUND_EMAIL_LIMITS.practicePerHour,
      windowMs: HOUR_MS,
    },
    {
      name: "practice_day",
      key: `outbound-email:practice-day:${context.practiceId}`,
      limit: OUTBOUND_EMAIL_LIMITS.practicePerDay,
      windowMs: DAY_MS,
    },
  ];

  if (context.ip) {
    quotas.push({
      name: "ip_hour",
      key: `outbound-email:ip-hour:${context.ip}`,
      limit: OUTBOUND_EMAIL_LIMITS.ipPerHour,
      windowMs: HOUR_MS,
    });
  }

  const practiceAgeMs = now.getTime() - practiceCreatedAt.getTime();
  if (practiceAgeMs >= 0 && practiceAgeMs < DAY_MS) {
    quotas.push({
      name: "new_practice_first_day",
      key: `outbound-email:new-practice:${context.practiceId}`,
      limit: OUTBOUND_EMAIL_LIMITS.newPracticeFirstDay,
      windowMs: DAY_MS,
    });
  }

  let results: RateLimitResult[];
  try {
    results = await Promise.all(
      quotas.map((quota) =>
        rateLimit({
          key: quota.key,
          limit: quota.limit,
          windowMs: quota.windowMs,
          now,
        }),
      ),
    );
  } catch {
    await alertOps(
      "Outbound email blocked: quota service unavailable",
      `practice=${context.practiceId} user=${context.userId} ip=${context.ip ?? "unknown"} operation=${context.operation}`,
    ).catch(() => undefined);
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Email sending is temporarily unavailable.",
    });
  }

  const blockedIndex = results.findIndex((result) => !result.success);
  if (blockedIndex >= 0) {
    const quota = quotas[blockedIndex]!;
    const result = results[blockedIndex]!;
    await alertOps(
      "Outbound email abuse limit reached",
      quotaDetail(context, quota, result),
    ).catch(() => undefined);
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message:
        "Email sending is temporarily limited for account safety. Try again after the limit resets or contact OpenVPM support.",
    });
  }

  console.info(
    `[security.outbound-email] allowed practice=${context.practiceId} user=${context.userId} ip=${context.ip ?? "unknown"} operation=${context.operation}`,
  );
}
