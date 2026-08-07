"use client";

import { useEffect, useState } from "react";

const FUNNEL_VISITOR_STORAGE_KEY = "openvpm_funnel_id";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let volatileFunnelVisitorId: string | null = null;

export function validFunnelVisitorId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && UUID_RE.test(trimmed) ? trimmed.toLowerCase() : null;
}

export function getFunnelVisitorId(): string | null {
  if (typeof window === "undefined") return null;

  const fromUrl = validFunnelVisitorId(
    new URLSearchParams(window.location.search).get("funnel_id")
  );
  if (fromUrl) {
    volatileFunnelVisitorId = fromUrl;
    try {
      window.localStorage.setItem(FUNNEL_VISITOR_STORAGE_KEY, fromUrl);
    } catch {
      // Storage can be unavailable in privacy modes; the URL id still works.
    }
    return fromUrl;
  }

  try {
    const stored = validFunnelVisitorId(
      window.localStorage.getItem(FUNNEL_VISITOR_STORAGE_KEY)
    );
    if (stored) {
      volatileFunnelVisitorId = stored;
      return stored;
    }
  } catch {
    // Fall through to the in-memory id for this page.
  }

  if (volatileFunnelVisitorId) return volatileFunnelVisitorId;

  const generated = validFunnelVisitorId(
    globalThis.crypto?.randomUUID?.() ?? null
  );
  if (!generated) return null;
  volatileFunnelVisitorId = generated;
  try {
    window.localStorage.setItem(FUNNEL_VISITOR_STORAGE_KEY, generated);
  } catch {
    // The caller can still use the generated id for this event.
  }
  return generated;
}

export function useFunnelVisitorId(): string | null {
  const [visitorId, setVisitorId] = useState<string | null>(null);
  useEffect(() => setVisitorId(getFunnelVisitorId()), []);
  return visitorId;
}
