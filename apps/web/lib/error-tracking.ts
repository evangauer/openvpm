import { alertOps } from "@/lib/alerts";

export interface ErrorReportInput {
  source: string;
  message: string;
  stack?: string | null;
  digest?: string | null;
  path?: string | null;
}

function sanitizeErrorPath(path?: string | null): string | null {
  if (!path) return null;
  let pathname = path;
  try {
    pathname = new URL(path, "https://openvpm.local").pathname;
  } catch {
    pathname = path.split(/[?#]/)[0] ?? "";
  }
  const redacted = pathname
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      "[id]"
    )
    .replace(/[A-Za-z0-9_-]{24,}/g, "[token]")
    .slice(0, 300);
  return redacted || null;
}

export function sanitizeErrorReport(input: ErrorReportInput): ErrorReportInput {
  return {
    source: input.source.slice(0, 80),
    message: input.message.slice(0, 500),
    stack: input.stack ? input.stack.slice(0, 2000) : null,
    digest: input.digest ? input.digest.slice(0, 120) : null,
    path: sanitizeErrorPath(input.path),
  };
}

export async function captureException(input: ErrorReportInput): Promise<void> {
  const report = sanitizeErrorReport(input);
  await alertOps(
    `Unhandled app error (${report.source})`,
    [
      `message: ${report.message}`,
      report.path ? `path: ${report.path}` : null,
      report.digest ? `digest: ${report.digest}` : null,
      report.stack ? `stack:\n${report.stack}` : null,
    ]
      .filter(Boolean)
      .join("\n")
  );
}
