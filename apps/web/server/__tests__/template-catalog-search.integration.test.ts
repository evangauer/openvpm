import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import * as schema from "../../../../packages/db/schema/index";
import { withTenant } from "@/lib/tenant-db";
import { TEMPLATE_CATALOG_RESULT_LIMIT } from "@/lib/templates/catalog-search";
import { templatesRouter } from "../routers/templates";

const repoRoot = resolve(process.cwd(), "../..");
const describeWithTemplateCatalogPostgres =
  process.env.TEMPLATE_CATALOG_DB_INTEGRATION === "1"
    ? describe
    : describe.skip;

describeWithTemplateCatalogPostgres(
  "template catalog PostgreSQL contract",
  () => {
    it("is literal, deterministic, bounded, active-only, and tenant isolated", async () => {
      const adminUrl = process.env.DATABASE_URL;
      if (!adminUrl) throw new Error("DATABASE_URL is required");

      const databaseName = `openpims_template_catalog_${randomUUID().replaceAll("-", "")}`;
      if (!/^openpims_template_catalog_[a-f0-9]+$/.test(databaseName)) {
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
            { name: "Synthetic Template Clinic A" },
            { name: "Synthetic Template Clinic B" },
          ])
          .returning({ id: schema.practices.id });
        if (!practiceA || !practiceB)
          throw new Error("failed to seed practices");

        const serviceRows = await ownerDb
          .insert(schema.services)
          .values([
            {
              practiceId: practiceA.id,
              name: "Exam",
              code: "EXACT",
              category: "Wellness",
              defaultPrice: "75.00",
            },
            {
              practiceId: practiceA.id,
              name: "Examination follow-up",
              code: "FOLLOW",
              category: "Wellness",
              defaultPrice: "45.00",
            },
            {
              practiceId: practiceA.id,
              name: "100%_care\\kit",
              code: "LITERAL",
              category: "Special",
              defaultPrice: "12.00",
            },
            {
              practiceId: practiceA.id,
              name: "100xxcare-kit",
              code: "DECOY",
              category: "Special",
              defaultPrice: "12.00",
            },
            ...Array.from({ length: 24 }, (_, index) => ({
              practiceId: practiceA.id,
              name: "General service",
              code: `GENERAL-${String(index).padStart(2, "0")}`,
              category: "General",
              defaultPrice: "10.00",
            })),
            {
              practiceId: practiceB.id,
              name: "Exam",
              code: "CROSS-TENANT",
              category: "Wellness",
              defaultPrice: "1.00",
            },
          ])
          .returning({
            id: schema.services.id,
            name: schema.services.name,
            code: schema.services.code,
          });
        const exactService = serviceRows.find(
          (service) => service.code === "EXACT",
        );
        const literalService = serviceRows.find(
          (service) => service.code === "LITERAL",
        );
        const decoyService = serviceRows.find(
          (service) => service.code === "DECOY",
        );
        if (!exactService || !literalService || !decoyService) {
          throw new Error("failed to seed services");
        }

        const [exactProduct, archivedProduct, crossTenantProduct] =
          await ownerDb
            .insert(schema.products)
            .values([
              {
                practiceId: practiceA.id,
                name: "Dental chews",
                sku: "DENTAL-1",
                category: "Dental",
                unitPrice: "12.00",
              },
              {
                practiceId: practiceA.id,
                name: "Archived dental chews",
                sku: "DENTAL-OLD",
                category: "Dental",
                unitPrice: "9.00",
                deletedAt: new Date(),
              },
              {
                practiceId: practiceB.id,
                name: "Dental chews",
                sku: "DENTAL-OTHER",
                category: "Dental",
                unitPrice: "1.00",
              },
            ])
            .returning({ id: schema.products.id });
        if (!exactProduct || !archivedProduct || !crossTenantProduct) {
          throw new Error("failed to seed products");
        }

        const session = (practiceId: string) => ({
          user: {
            id: randomUUID(),
            email: "synthetic-template@example.invalid",
            name: "Synthetic Template Admin",
            role: "admin",
            practiceId,
          },
        });
        const caller = (practiceId: string) =>
          templatesRouter.createCaller({
            db: ownerDb,
            session: session(practiceId),
          } as never);

        await ownerSql`set role openpims_app`;
        const [noContext] = await ownerSql<
          Array<{ services: number; products: number }>
        >`
          select
            (select count(*)::int from services) as services,
            (select count(*)::int from products) as products
        `;
        expect(noContext).toEqual({ services: 0, products: 0 });

        const initialServices = await caller(practiceA.id).searchCatalog({
          itemType: "service",
          search: "",
        });
        expect(initialServices).toHaveLength(TEMPLATE_CATALOG_RESULT_LIMIT);
        expect(initialServices.map((item) => item.name)).toEqual(
          [...initialServices.map((item) => item.name)].sort((left, right) =>
            left.localeCompare(right, undefined, { sensitivity: "base" }),
          ),
        );

        const initialProducts = await caller(practiceA.id).searchCatalog({
          itemType: "product",
          search: "",
        });
        expect(initialProducts.map((item) => item.id)).toEqual([
          exactProduct.id,
        ]);

        const exact = await caller(practiceA.id).searchCatalog({
          itemType: "service",
          search: "exam",
        });
        expect(exact[0]?.id).toBe(exactService.id);
        expect(exact.map((item) => item.code)).not.toContain("CROSS-TENANT");

        const literal = await caller(practiceA.id).searchCatalog({
          itemType: "service",
          search: "100%_care\\kit",
        });
        expect(literal.map((item) => item.id)).toEqual([literalService.id]);
        expect(literal.map((item) => item.id)).not.toContain(decoyService.id);

        const bounded = await caller(practiceA.id).searchCatalog({
          itemType: "service",
          search: "general",
        });
        expect(bounded).toHaveLength(TEMPLATE_CATALOG_RESULT_LIMIT);
        expect(bounded.map((item) => item.code)).toEqual(
          [...bounded.map((item) => item.code)].sort(),
        );

        const products = await caller(practiceA.id).searchCatalog({
          itemType: "product",
          search: "dental",
        });
        expect(products.map((item) => item.id)).toEqual([exactProduct.id]);
        expect(products.map((item) => item.id)).not.toContain(
          archivedProduct.id,
        );
        expect(products.map((item) => item.id)).not.toContain(
          crossTenantProduct.id,
        );

        const [crossTenantCount] = await withTenant(
          ownerDb,
          practiceA.id,
          async (tx) =>
            tx.execute<{ count: number }>(drizzleSql`
              select count(*)::int as count
              from ${schema.services}
              where ${schema.services.practiceId} = ${practiceB.id}
            `),
        );
        expect(crossTenantCount?.count).toBe(0);

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
            select id
            from services
            where practice_id = ${practiceA.id}
              and deleted_at is null
              and name ilike ${"%general%"} escape '\\'
            order by lower(name), id
            limit ${TEMPLATE_CATALOG_RESULT_LIMIT}
          `;
          // Both indexes begin with the tenant key. The treatment-plan
          // evidence FK adds a practice/service identity index, which the
          // planner may prefer for this leading-wildcard query.
          expect(JSON.stringify(plan)).toMatch(
            /services_practice_(?:name_idx|id_uq)/,
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
