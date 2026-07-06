import { QueryClient } from "@tanstack/react-query";

export const QUERY_STALE_TIME_MS = 30 * 1000;
export const QUERY_GC_TIME_MS = 5 * 60 * 1000;

const NON_RETRYABLE_TRPC_CODES = new Set([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "METHOD_NOT_SUPPORTED",
  "TIMEOUT",
  "CONFLICT",
  "PRECONDITION_FAILED",
  "PAYLOAD_TOO_LARGE",
  "UNPROCESSABLE_CONTENT",
  "TOO_MANY_REQUESTS",
  "CLIENT_CLOSED_REQUEST",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

export function shouldRetryQuery(failureCount: number, error: unknown) {
  if (failureCount >= 1) return false;

  const err = asRecord(error);
  const data = asRecord(err?.data);
  const shape = asRecord(err?.shape);
  const shapeData = asRecord(shape?.data);
  const code = stringField(data, "code") ?? stringField(shapeData, "code");
  if (code && NON_RETRYABLE_TRPC_CODES.has(code)) return false;

  const httpStatus =
    numberField(data, "httpStatus") ??
    numberField(shapeData, "httpStatus") ??
    numberField(err, "status") ??
    numberField(err, "statusCode");
  if (httpStatus && httpStatus >= 400 && httpStatus < 500) return false;

  return true;
}

export function createAppQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: QUERY_STALE_TIME_MS,
        gcTime: QUERY_GC_TIME_MS,
        refetchOnWindowFocus: false,
        retry: shouldRetryQuery,
      },
      mutations: {
        retry: false,
      },
    },
  });
}
