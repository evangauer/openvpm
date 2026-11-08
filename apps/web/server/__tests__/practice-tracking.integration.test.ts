import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "@openpims/db";
import { loadPracticeTracking } from "@/lib/admin/practice-tracking";

const integration = process.env.PRACTICE_TRACKING_DB_INTEGRATION === "1" ? describe : describe.skip;
integration("private tracking PostgreSQL contract", () => {
  it("excludes samples and internal tenants, preserves unknown attribution and pages without leaking audit content", async () => {
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
        {name:"Excluded",billingStatus:"trialing",settings:{analyticsExcluded:true}},
        {name:"No subscription",billingStatus:"none"},
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
      const asOf=new Date(Date.now()+1000);
      // Counts come from product records; successful audit labels never expose inputs.
      const first=await loadPracticeTracking(db,{limit:1,asOf});
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
    } finally {
      if(client)await client.end();
      await admin.unsafe('drop database if exists "'+name+'" with (force)');
      await admin.end();
    }
  },120_000);
});
