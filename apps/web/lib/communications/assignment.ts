import { sql } from "drizzle-orm";
import { communications } from "@openpims/db";

export function latestAssignedToForClient(
  practiceId: string,
  clientId: string
) {
  return sql<string | null>`(
    select ${communications.assignedTo}
    from ${communications}
    where ${communications.practiceId} = ${practiceId}
      and ${communications.clientId} = ${clientId}
      and ${communications.assignedTo} is not null
      and ${communications.deletedAt} is null
    order by ${communications.createdAt} desc, ${communications.id} desc
    limit 1
  )`;
}
