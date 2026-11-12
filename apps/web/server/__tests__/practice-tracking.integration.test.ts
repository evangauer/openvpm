import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as schema from "@openpims/db";
import { loadPracticeTracking } from "@/lib/admin/practice-tracking";
import { createRouter, protectedProcedure } from "@/server/trpc";

const integration = process.env.PRACTICE_TRACKING_DB_INTEGRATION === "1" ? describe : describe.skip;
integration("private tracking PostgreSQL contract", () => {
  it("includes registrations before checkout, excludes samples and internal tenants, and pages without leaking audit content", async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("This fixture requires a local database");
    const name="openpims_tracking_"+randomUUID().replaceAll("-","");
    const admin=postgres(url.toString(),{max:1});
    url.pathname="/"+name;url.search="";
    await admin.unsafe('create database "'+name+'"');
    let client: ReturnType<typeof postgres> | undefined;
    try {
      execFileSync("pnpm",["--filter","@openpims/db","db:migrate"],{
        cwd:resolve(process.cwd(),"../.."),env:{...process.env,DATABASE_URL:url.toString()},stdio:"pipe",
      });
      client=postgres(url.toString(),{max:1});
      const db=drizzle(client,{schema});
      const [p]=await db.insert(schema.practices).values({name:"Synthetic Tracking Clinic",billingStatus:"trialing",createdAt:new Date("2026-11-08T09:00:00Z")}).returning();
      await db.insert(schema.practices).values([
        {name:"Excluded",billingStatus:"trialing",settings:{analyticsExcluded:true},createdAt:new Date("2026-11-08T12:00:00Z")},
        {name:"Deleted registration",billingStatus:"none",deletedAt:new Date("2026-11-08T12:00:00Z"),createdAt:new Date("2026-11-08T11:00:00Z")},
        {name:"No subscription",billingStatus:"none",createdAt:new Date("2026-11-08T10:00:00Z")},
        {name:"After snapshot",billingStatus:"none",createdAt:new Date("2026-11-09T09:00:00Z")},
        {name:"Older tracked clinic",billingStatus:"active",createdAt:new Date("2026-11-07T09:00:00Z")},
      ]);
      const [sample,own]=await db.insert(schema.clients).values([
        {practiceId:p.id,firstName:"Sample",lastName:"Owner"},
        {practiceId:p.id,firstName:"Own",lastName:"Owner"},
      ]).returning();
      await db.insert(schema.patients).values({practiceId:p.id,clientId:sample.id,name:"Sample",species:"canine"});
      await db.update(schema.practices).set({settings:{demoData:{clientIds:[sample.id]}}}).where(eq(schema.practices.id,p.id));
      await db.insert(schema.auditLog).values([
        {practiceId:p.id,entityType:"agent",action:"run",createdAt:new Date("2026-11-08T10:00:00Z"),changes:{instruction:"DO_NOT_EXPORT_PROMPT"}},
        {practiceId:p.id,entityType:"agent",action:"run",createdAt:new Date("2026-11-07T10:00:00Z")},
        {practiceId:p.id,entityType:"settings",action:"updatePractice"},
      ]);
      await db.insert(schema.usageRecords).values({practiceId:p.id,kind:"ai_run",quantity:2,periodMonth:"2026-11"});
      const asOf=new Date("2026-11-08T17:00:00Z");
      // Counts come from product records; successful audit labels never expose inputs.
      const lead=await loadPracticeTracking(db,{limit:1,asOf});
      expect(lead.practices).toHaveLength(1);
      expect(lead.practices[0]).toMatchObject({
        businessName:"No subscription",billingStatus:"none",trialEndsAt:null,
        ownerName:null,ownerEmail:null,lastActionAt:null,activeDays7:0,activeDays30:0,actions:[],
      });
      expect(Object.values(lead.practices[0].usage)).toEqual(Array(9).fill(0));
      expect(lead.nextCursor).not.toBeNull();
      const first=await loadPracticeTracking(db,{limit:1,cursor:lead.nextCursor!,asOf});
      expect(first.practices).toHaveLength(1);
      expect(first.practices[0].practiceId).toBe(p.id);
      expect(first.practices[0].usage.clients).toBe(1);
      expect(first.practices[0].usage.aiRuns).toBe(2);
      expect(first.practices[0].actions[0]).toMatchObject({label:"AI run",count:2});
      expect(first.practices[0].acquisition).toEqual({signupSource:null,medium:null,campaign:null});
      expect(JSON.stringify(first)).not.toContain("DO_NOT_EXPORT_PROMPT");
      expect(first.nextCursor).not.toBeNull();
      const second=await loadPracticeTracking(db,{limit:1,cursor:first.nextCursor!,asOf});
      expect(second.practices[0].businessName).toBe("Older tracked clinic");
      expect(second.nextCursor).toBeNull();
      expect(own.id).toBeTruthy();

      // Real bounded pool: an unused outer tenant transaction must not hold
      // the only connection while an operator read opens its system scope.
      const limited=postgres(url.toString(),{max:1,prepare:false});
      const limitedDb=drizzle(limited,{schema});
      vi.stubEnv("PLATFORM_ADMIN_EMAILS","operator@example.test");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const tenantProbe=protectedProcedure.query(({ctx})=>ctx.db.execute(sql`select current_setting('app.current_practice_id',true) as practice`));
        const router=createRouter({
          operator:protectedProcedure.meta({platformAdminRead:true}).query(()=>loadPracticeTracking(limitedDb,{asOf})),
          tenant:tenantProbe,
          opted:protectedProcedure.meta({platformAdminRead:true}).query(({ctx})=>ctx.db.execute(sql`select current_setting('app.current_practice_id',true) as practice`)),
        });
        const context=(email:string)=>({db:limitedDb,session:{user:{id:randomUUID(),practiceId:p.id,email,role:"admin"},expires:"2099-01-01T00:00:00Z"}});
        const operator=router.createCaller(context("operator@example.test") as never);
        const pages=await Promise.race([
          Promise.all(Array.from({length:4},()=>operator.operator())),
          new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error("Operator reads exhausted a one-connection database pool")),5000);}),
        ]);
        expect(pages).toHaveLength(4);
        expect(pages[0].practices.some(r=>r.practiceId===p.id)).toBe(true);
        // Operator status alone cannot remove scope from a tenant procedure.
        expect((await operator.tenant() as unknown as {practice:string}[])[0].practice).toBe(p.id);
        // Metadata alone cannot remove scope from a non-operator caller.
        const clinic=router.createCaller(context("clinic@example.test") as never);
        expect((await clinic.opted() as unknown as {practice:string}[])[0].practice).toBe(p.id);
        const anonymous=router.createCaller({db:limitedDb,session:null} as never);
        await expect(anonymous.operator()).rejects.toMatchObject({code:"UNAUTHORIZED"});
        const [scope]=await limited`select current_setting('app.rls_bypass',true) as bypass`;
        expect([null,""]).toContain(scope.bypass);
      } finally {
        if(timer)clearTimeout(timer);
        vi.unstubAllEnvs();
        await limited.end({timeout:1});
      }
    } finally {
      if(client)await client.end();
      await admin.unsafe('drop database if exists "'+name+'" with (force)');
      await admin.end();
    }
  },120_000);
});
