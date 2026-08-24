import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import * as schema from "../../../../packages/db/schema/index";
import { clientsRouter } from "../routers/clients";
import { patientsRouter } from "../routers/patients";
import { withTenant } from "@/lib/tenant-db";

const repoRoot = resolve(process.cwd(), "../..");
const describeWithPatientSearchPostgres =
  process.env.PATIENT_SEARCH_DB_INTEGRATION === "1" ? describe : describe.skip;

describeWithPatientSearchPostgres(
  "patient + owner search PostgreSQL contract",
  () => {
    it("is literal, deterministic, bounded, and tenant isolated", async () => {
      const adminUrl = process.env.DATABASE_URL;
      if (!adminUrl) throw new Error("DATABASE_URL is required");

      const databaseName = `openpims_patient_search_${randomUUID().replaceAll("-", "")}`;
      if (!/^openpims_patient_search_[a-f0-9]+$/.test(databaseName)) {
        throw new Error("unsafe disposable database name");
      }

      const databaseUrl = new URL(adminUrl);
      databaseUrl.pathname = `/${databaseName}`;
      databaseUrl.search = "";
      databaseUrl.hash = "";

      const adminSql = postgres(adminUrl, { max: 1 });
      let ownerSql: ReturnType<typeof postgres> | undefined;

      await adminSql.unsafe(`create database "${databaseName}"`);

      try {
        execFileSync("pnpm", ["--filter", "@openpims/db", "db:migrate"], {
          cwd: repoRoot,
          env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
          encoding: "utf8",
        });
        execFileSync("pnpm", ["--filter", "@openpims/db", "db:rls"], {
          cwd: repoRoot,
          env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
          encoding: "utf8",
        });

        ownerSql = postgres(databaseUrl.toString(), { max: 1 });
        const ownerDb = drizzle(ownerSql, { schema });

        const [practiceA, practiceB] = await ownerDb
          .insert(schema.practices)
          .values([
            { name: "Synthetic Search Clinic A" },
            { name: "Synthetic Search Clinic B" },
          ])
          .returning({ id: schema.practices.id });
        if (!practiceA || !practiceB)
          throw new Error("failed to seed practices");

        const [
          grayOwner,
          percentOwner,
          wildcardClient,
          otherOwner,
          crossTenantOwner,
        ] = await ownerDb
          .insert(schema.clients)
          .values([
            {
              practiceId: practiceA.id,
              firstName: "Morgan",
              lastName: "Gray",
            },
            {
              practiceId: practiceA.id,
              firstName: "50%_off",
              lastName: "Literal",
            },
            {
              practiceId: practiceA.id,
              firstName: "50xxoff",
              lastName: "Wildcard Decoy",
            },
            {
              practiceId: practiceA.id,
              firstName: "Exact",
              lastName: "Patient",
            },
            {
              practiceId: practiceB.id,
              firstName: "Morgan",
              lastName: "Gray",
            },
          ])
          .returning({ id: schema.clients.id });
        if (
          !grayOwner ||
          !percentOwner ||
          !wildcardClient ||
          !otherOwner ||
          !crossTenantOwner
        ) {
          throw new Error("failed to seed clients");
        }

        const [exactGray, literalPatient, wildcardDecoy, crossTenantPatient] =
          await ownerDb
            .insert(schema.patients)
            .values([
              {
                practiceId: practiceA.id,
                clientId: otherOwner.id,
                name: "Gray",
                species: "canine",
              },
              {
                practiceId: practiceA.id,
                clientId: grayOwner.id,
                name: "50%_off",
                species: "feline",
              },
              {
                practiceId: practiceA.id,
                clientId: otherOwner.id,
                name: "50xxoff",
                species: "feline",
              },
              {
                practiceId: practiceB.id,
                clientId: crossTenantOwner.id,
                name: "Lucy",
                species: "canine",
              },
            ])
            .returning({ id: schema.patients.id });
        if (
          !exactGray ||
          !literalPatient ||
          !wildcardDecoy ||
          !crossTenantPatient
        ) {
          throw new Error("failed to seed base patients");
        }

        const ambiguousPatients = await ownerDb
          .insert(schema.patients)
          .values(
            Array.from({ length: 24 }, () => ({
              practiceId: practiceA.id,
              clientId: grayOwner.id,
              name: "Lucy",
              species: "canine" as const,
            })),
          )
          .returning({ id: schema.patients.id });

        const session = (practiceId: string) => ({
          user: {
            id: randomUUID(),
            email: "synthetic-search@example.invalid",
            name: "Synthetic Search User",
            role: "front_desk",
            practiceId,
          },
        });
        const caller = (db: typeof ownerDb, practiceId: string) =>
          patientsRouter.createCaller({
            db,
            session: session(practiceId),
          } as never);
        const clientCaller = (db: typeof ownerDb, practiceId: string) =>
          clientsRouter.createCaller({
            db,
            session: session(practiceId),
          } as never);

        await ownerSql`set role openpims_app`;
        const [emptyContext] = await ownerSql<
          Array<{
            currentUser: string;
            practiceId: string | null;
            bypass: string | null;
          }>
        >`
          select
            current_user as "currentUser",
            nullif(current_setting('app.current_practice_id', true), '') as "practiceId",
            nullif(current_setting('app.rls_bypass', true), '') as bypass
        `;
        expect(emptyContext).toEqual({
          currentUser: "openpims_app",
          practiceId: null,
          bypass: null,
        });
        const [noContext] = await ownerSql<
          Array<{ count: number }>
        >`select count(*)::int as count from patients`;
        expect(noContext?.count).toBe(0);

        const runAsTenant = <T>(
          practiceId: string,
          fn: (tenantCaller: ReturnType<typeof caller>) => Promise<T>,
        ) => fn(caller(ownerDb, practiceId));

        const combined = await runAsTenant(practiceA.id, (tenantCaller) =>
          tenantCaller.search({ query: "  LuCy   gRaY  " }),
        );
        const reversed = await runAsTenant(practiceA.id, (tenantCaller) =>
          tenantCaller.search({ query: "gray lucy" }),
        );
        const duplicate = await runAsTenant(practiceA.id, (tenantCaller) =>
          tenantCaller.search({ query: "lucy LUCY gray" }),
        );

        const expectedAmbiguousIds = ambiguousPatients
          .map((patient) => patient.id)
          .sort()
          .slice(0, 10);
        expect(combined.map((patient) => patient.id)).toEqual(
          expectedAmbiguousIds,
        );
        expect(reversed.map((patient) => patient.id)).toEqual(
          expectedAmbiguousIds,
        );
        expect(duplicate.map((patient) => patient.id)).toEqual(
          expectedAmbiguousIds,
        );
        expect(combined).toHaveLength(10);

        const exact = await runAsTenant(practiceA.id, (tenantCaller) =>
          tenantCaller.search({ query: "gray" }),
        );
        expect(exact[0]?.id).toBe(exactGray.id);

        const literal = await runAsTenant(practiceA.id, (tenantCaller) =>
          tenantCaller.search({ query: "50%_off" }),
        );
        expect(literal.map((patient) => patient.id)).toEqual([
          literalPatient.id,
        ]);
        expect(literal.map((patient) => patient.id)).not.toContain(
          wildcardDecoy.id,
        );

        const literalClient = await clientCaller(ownerDb, practiceA.id).search({
          query: "50%_off",
        });
        expect(literalClient.map((client) => client.id)).toEqual([
          percentOwner.id,
        ]);
        expect(literalClient.map((client) => client.id)).not.toContain(
          wildcardClient.id,
        );

        const normalClient = await clientCaller(ownerDb, practiceA.id).search({
          query: "Morgan Gray",
        });
        expect(normalClient.map((client) => client.id)).toEqual([grayOwner.id]);

        const listedClients = await clientCaller(ownerDb, practiceA.id).list({
          search: "50%_off",
          limit: 25,
          offset: 0,
        });
        expect(listedClients.items.map((client) => client.id)).toEqual([
          percentOwner.id,
        ]);
        expect(listedClients.total).toBe(1);

        const listed = await runAsTenant(practiceA.id, (tenantCaller) =>
          tenantCaller.list({
            search: "lucy gray",
            limit: 7,
            offset: 0,
          }),
        );
        expect(listed.items).toHaveLength(7);
        expect(listed.total).toBe(24);

        const [crossTenant] = await withTenant(
          ownerDb,
          practiceA.id,
          async (tx) =>
            tx.execute<{ count: number }>(drizzleSql`
              select count(*)::int as count
              from ${schema.patients}
              where ${schema.patients.practiceId} = ${practiceB.id}
            `),
        );
        expect(crossTenant?.count).toBe(0);

        const [contextAfterSearch] = await ownerSql<
          Array<{ practiceId: string | null }>
        >`
          select nullif(current_setting('app.current_practice_id', true), '') as "practiceId"
        `;
        expect(contextAfterSearch?.practiceId).toBeNull();

        await ownerSql`reset role`;

        await ownerSql`set enable_seqscan = off`;
        try {
          const plan = await ownerSql`
            explain (format json)
            select p.id
            from patients p
            left join clients c
              on c.id = p.client_id
             and c.practice_id = ${practiceA.id}
             and c.deleted_at is null
            where p.practice_id = ${practiceA.id}
              and p.deleted_at is null
              and (
                p.name ilike ${"%lucy%"} escape '\\'
                or c.first_name ilike ${"%lucy%"} escape '\\'
                or c.last_name ilike ${"%lucy%"} escape '\\'
              )
            limit 10
          `;
          // Both indexes begin with the tenant key. The treatment-plan
          // evidence FK adds the wider patient/client identity index, which
          // PostgreSQL may prefer over the original practice/id index.
          expect(JSON.stringify(plan)).toMatch(
            /patients_practice_(?:id|client_id)_uq/,
          );
        } finally {
          await ownerSql`reset enable_seqscan`;
        }
      } finally {
        if (ownerSql) await ownerSql.end();
        await adminSql.unsafe(
          `drop database if exists "${databaseName}" with (force)`,
        );
        await adminSql.end();
      }
    }, 60_000);
  },
);
