import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@openpims/db";
import { appRouter } from "../routers/_app";
import { IMPORTED_ROLES, seedImportedRecords } from "./fixtures/imported-records";

// Opt-in, synthetic, loopback owner-role SQL contract. Does not configure RLS.
const url = process.env.IMPORTED_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite("patient imported records PostgreSQL contract", () => {
  let pg: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let f: Awaited<ReturnType<typeof seedImportedRecords>>;
  const caller = (role: typeof IMPORTED_ROLES[number] = 'admin', other = false) => appRouter.createCaller({ db, session: { user: { id:other?f.otherUser:f.users[role], practiceId:other?f.otherPractice:f.practice, name:'Synthetic Archive Staff',email:'synthetic@example.invalid',role } } } as never);
  beforeAll(async () => {
    const parsed=new URL(url!);
    if(parsed.hostname!=='127.0.0.1'||!/^\/openvpm_(imported|followup)_test_[A-Za-z0-9_]+$/.test(parsed.pathname))throw Error('Unexpected disposable DB URL');
    pg=postgres(url!,{max:2});db=drizzle(pg,{schema});f=await seedImportedRecords(pg);
  },60_000);
  afterAll(async()=>{await pg?.end()});
  it.each(IMPORTED_ROLES)("allows %s to read exact patient sections with stable 20+1 pagination",async role=>{
    for(const section of ['medications','labs','documents'] as const){
      const first=await caller(role).migrationArchive.list({section,patientId:f.patient,limit:20,offset:0});
      const last=await caller(role).migrationArchive.list({section,patientId:f.patient,limit:20,offset:20});
      expect(first.total).toBe(21);expect(last.total).toBe(21);expect(first.items).toHaveLength(20);expect(last.items).toHaveLength(1);
      expect(new Set([...first.items,...last.items].map(x=>x.id))).toEqual(new Set(f.records[section]));
      expect(first.items.every(x=>x.patientId===f.patient)).toBe(true);
      expect(first.items.some(x=>'sourceDate' in x&&x.sourceDate===null)).toBe(true);
      if(section!=='documents')expect((await caller(role).migrationArchive.detail({section,id:first.items[0]!.id,patientId:f.patient})).kind).toBe(section);
    }
  });
  it("rejects mismatched patient/tenant and deleted records on scoped detail",async()=>{
    for(const section of ['medications','labs'] as const){
      for(const id of f.excluded[section])await expect(caller().migrationArchive.detail({section,id,patientId:f.patient})).rejects.toMatchObject({code:'NOT_FOUND'});
      await expect(caller().migrationArchive.detail({section,id:f.records[section][0]!,patientId:f.sameName})).rejects.toMatchObject({code:'NOT_FOUND'});
      await expect(caller('admin',true).migrationArchive.detail({section,id:f.records[section][0]!,patientId:f.patient})).rejects.toMatchObject({code:'NOT_FOUND'});
    }
    for(const section of ['medications','labs','documents'] as const){
      expect((await caller().migrationArchive.list({section,patientId:f.deletedPatient})).total).toBe(0);
      expect((await caller('admin',true).migrationArchive.list({section,patientId:f.patient})).total).toBe(0);
      expect((await caller().migrationArchive.list({section,patientId:f.empty})).total).toBe(0);
    }
  });
  it("preserves broad archive access to unlinked labs and documents when no patient filter is supplied",async()=>{
    for(const section of ['medications','labs','documents'] as const){
      const broad=await caller().migrationArchive.list({section,limit:100});
      if(section!=='medications')expect(broad.items.some(x=>x.patientId===null)).toBe(true);
      expect(broad.items.some(x=>x.patientId===f.sameName)).toBe(true);
      expect(broad.items.every(x=>x.patientId!==f.foreign)).toBe(true);
      expect(broad.total).toBe(broad.items.length);
    }
  });
  it("rejects unauthenticated reads and unsupported patient-filter sections",async()=>{
    const anonymous=appRouter.createCaller({db,session:null} as never);
    await expect(anonymous.migrationArchive.list({section:'labs',patientId:f.patient})).rejects.toMatchObject({code:'UNAUTHORIZED'});
    await expect(anonymous.migrationArchive.detail({section:'labs',patientId:f.patient,id:f.records.labs[0]!})).rejects.toMatchObject({code:'UNAUTHORIZED'});
    await expect(caller().migrationArchive.list({section:'contacts',patientId:f.patient})).rejects.toMatchObject({code:'BAD_REQUEST'});
  });
  it("leaves active prescriptions unchanged",async()=>{
    const [row]=await pg`select count(*)::int as n from prescriptions where practice_id=${f.practice} and patient_id=${f.patient}`;
    expect(row!.n).toBe(0);
  });
});
