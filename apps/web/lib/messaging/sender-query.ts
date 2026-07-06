import { sql } from "drizzle-orm";
import { locationMessaging } from "@openpims/db";

export function hasNonBlankMessagingSender() {
  return sql`(
    nullif(trim(${locationMessaging.senderE164}), '') is not null
    or nullif(trim(${locationMessaging.messagingProfileId}), '') is not null
  )`;
}
