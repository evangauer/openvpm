import { describe, expect, it } from "vitest";
import { isPooledDatabaseConnection } from "@openpims/db/connection-policy";

describe("database connection policy", () => {
  it("recognizes Supabase pooler hosts, the pooler port, and the explicit flag", () => {
    expect(
      isPooledDatabaseConnection(
        "postgresql://user:pass@aws-0-us-east-1.pooler.supabase.com:5432/db",
      ),
    ).toBe(true);
    expect(
      isPooledDatabaseConnection(
        "postgresql://user:pass@db.example.com:6543/db",
      ),
    ).toBe(true);
    expect(
      isPooledDatabaseConnection(
        "postgresql://user:pass@db.example.com:5432/db?pgbouncer=true",
      ),
    ).toBe(true);
  });

  it("does not trust pooler-looking credentials, paths, or sibling domains", () => {
    expect(
      isPooledDatabaseConnection(
        "postgresql://pooler.supabase.com:pass@db.example.com:5432/db",
      ),
    ).toBe(false);
    expect(
      isPooledDatabaseConnection(
        "postgresql://user:pass@pooler.supabase.com.example.org:5432/db",
      ),
    ).toBe(false);
    expect(
      isPooledDatabaseConnection(
        "postgresql://user:pass@db.example.com:5432/pooler.supabase.com",
      ),
    ).toBe(false);
  });
});
