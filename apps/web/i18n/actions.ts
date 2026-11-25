"use server";

import { cookies } from "next/headers";
import {
  canonicalLanguage,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE_SECONDS,
} from "./config";

export async function setLanguage(language: string): Promise<void> {
  const canonical = canonicalLanguage(language);
  if (!canonical) return;

  const jar = await cookies();
  jar.set(LOCALE_COOKIE, canonical, {
    path: "/",
    sameSite: "lax",
    maxAge: LOCALE_COOKIE_MAX_AGE_SECONDS,
  });
}
