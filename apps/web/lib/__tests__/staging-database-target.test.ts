import { describe, expect, it } from "vitest";
import { verifyStagingDatabaseTarget } from "../staging-database-target";

const isolatedRef = "abcdefghijklmnopqrst";

describe("isolated Supabase staging target", () => {
  it("accepts an exact direct connection to a new configured project", () => {
    expect(
      verifyStagingDatabaseTarget({
        databaseUrl: `postgresql://migration:secret@db.${isolatedRef}.supabase.co:5432/postgres?sslmode=require`,
        expectedProjectRef: isolatedRef,
      }),
    ).toEqual({
      projectRefFingerprint:
        "dd65eea0329dcb94b17187af9dff28c31a1d78026737a16af75979a1fa4618e5",
      connectionMode: "direct",
    });
  });

  it("accepts an exact Supavisor connection routed by the configured ref", () => {
    expect(
      verifyStagingDatabaseTarget({
        databaseUrl: `postgres://openpims_owner.${isolatedRef}:secret@aws-0-us-east-2.pooler.supabase.com:5432/postgres`,
        expectedProjectRef: isolatedRef,
      }).connectionMode,
    ).toBe("pooler");
  });

  it.each([
    "pgcbnjctkohehngiyola",
    "suankbigilnqurfbspnk",
  ])("rejects protected data-bearing project identity %s", (projectRef) => {
    expect(() =>
      verifyStagingDatabaseTarget({
        databaseUrl: `postgresql://migration:secret@db.${projectRef}.supabase.co:5432/postgres`,
        expectedProjectRef: projectRef,
      }),
    ).toThrow(
      "Configured Supabase project is a protected data-bearing environment",
    );
  });

  it("rejects a URL from a project other than the environment-scoped ref", () => {
    expect(() =>
      verifyStagingDatabaseTarget({
        databaseUrl:
          "postgresql://migration:secret@db.zyxwvutsrqponmlkjihg.supabase.co:5432/postgres",
        expectedProjectRef: isolatedRef,
      }),
    ).toThrow(
      "STAGING_DATABASE_URL does not identify the configured Supabase staging project.",
    );
  });

  it.each([
    ["not-a-ref", `postgresql://migration:secret@db.${isolatedRef}.supabase.co/postgres`],
    [isolatedRef, "https://db.example/postgres"],
    [isolatedRef, "not a URL"],
  ])("fails closed on malformed identity inputs", (projectRef, url) => {
    expect(() =>
      verifyStagingDatabaseTarget({
        databaseUrl: url,
        expectedProjectRef: projectRef,
      }),
    ).toThrow();
  });
});
