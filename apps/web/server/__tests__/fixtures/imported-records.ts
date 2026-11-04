import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import bcrypt from "bcryptjs";
import { isApprovedRehearsalDatabase } from "../../../../../test-support/rehearsal-database";

export const IMPORTED_ROLES = ["admin", "veterinarian", "technician", "front_desk", "viewer"] as const;
export const SYNTHETIC_DOCUMENT = Buffer.from("%PDF-1.4\n% Synthetic imported record fixture only\n%%EOF\n");
export async function seedImportedRecords(pg: Sql) {
  const [target] = await pg`select current_database() as name,host(inet_server_addr()) as host`;
  if ((!/^openvpm_(imported|followup)_test_[A-Za-z0-9_]+$/.test(target?.name ?? "") && !isApprovedRehearsalDatabase(target?.name ?? "")) || target?.host !== "127.0.0.1") throw new Error("Unexpected disposable database");
  const run = randomUUID().slice(0, 8), a = randomUUID(), b = randomUUID();
  const patient = randomUUID(), sameName = randomUUID(), foreign = randomUUID(), empty = randomUUID(), deletedPatient = randomUUID();
  const password = randomBytes(18).toString("base64url");
  const users = Object.fromEntries(IMPORTED_ROLES.map(role => [role, randomUUID()])) as Record<typeof IMPORTED_ROLES[number], string>;
  const otherUser = randomUUID();
  const clientA = randomUUID(), clientB = randomUUID();
  const email = `imported-${run}@example.invalid`;
  const source = "synthetic_archive";
  const fingerprint = (value: string) => createHash("sha256").update(`${run}:${value}`).digest("hex");
  const records: Record<string, string[]> = { medications: [], labs: [], documents: [] };
  const excluded: Record<string, string[]> = { medications: [], labs: [], documents: [] };
  const fileKeys: string[] = [];
  await pg.begin(async transaction => {
    // postgres TransactionSql omits the callable signature in its mapped type.
    const tx = transaction as unknown as Sql;
    await tx`insert into practices(id,name,timezone) values (${a},${`Synthetic Imported Clinic ${run}`},'America/New_York'),(${b},${`Other Synthetic Imported Clinic ${run}`},'America/New_York')`;
    await tx`insert into locations(practice_id,name,is_primary) values (${a},'Main',true),(${b},'Main',true)`;
    const hash = await bcrypt.hash(password, 10);
    for (const role of IMPORTED_ROLES) await tx`insert into users(id,practice_id,name,email,password_hash,role,email_verified_at) values (${users[role]},${a},'Synthetic Archive Staff',${role==='admin'?email:`${role}-${email}`},${hash},${role},now())`;
    await tx`insert into users(id,practice_id,name,email,password_hash,role,email_verified_at) values (${otherUser},${b},'Other Synthetic Staff',${`other-${email}`},${hash},'admin',now())`;
    await tx`insert into clients(id,practice_id,first_name,last_name) values (${clientA},${a},'Synthetic','Owner'),(${clientB},${b},'Other Synthetic','Owner')`;
    for (const [id,practice,client] of [[patient,a,clientA],[sameName,a,clientA],[foreign,b,clientB],[empty,a,clientA],[deletedPatient,a,clientA]]) await tx`insert into patients(id,practice_id,client_id,name,species,deleted_at) values (${id},${practice},${client},${id===empty?'Synthetic Empty':'Synthetic Same Name'},'canine',${id===deletedPatient?new Date().toISOString():null})`;
    const fixtureRows: {practice:string;patient:string|null;index:number;tag:string;deleted:boolean;deletedFile:boolean}[] = Array.from({length:21},(_,i)=>({practice:a,patient,index:i,tag:`linked-${i}`,deleted:false,deletedFile:false}));
    fixtureRows.push(...[
      {practice:a,patient:sameName,tag:'same-name'}, {practice:b,patient:foreign,tag:'other-clinic'},
      {practice:a,patient:null,tag:'unlinked'}, {practice:a,patient,tag:'deleted',deleted:true},
      {practice:a,patient,tag:'deleted-file',deletedFile:true}, {practice:a,patient:deletedPatient,tag:'deleted-patient'},
    ].map(x=>({index:50,deleted:false,deletedFile:false,...x})));
    for (const f of fixtureRows) {
      const stamp = f.index===0 ? null : new Date(`2020-04-${String((f.index%20)+1).padStart(2,'0')}T01:00:00Z`).toISOString();
      const dead = f.deleted ? new Date().toISOString() : null;
      const med = randomUUID(), lab = randomUUID(), doc = randomUUID(), file = randomUUID();
      const linked = f.tag.startsWith('linked-');
      if (f.patient) {
        await tx`insert into external_prescriptions(id,practice_id,patient_id,medication_name,directions,prescribed_at,status,external_source,external_id,import_fingerprint,deleted_at) values (${med},${f.practice},${f.patient},${`Historical medication ${f.tag}`},${f.index===0?'LongSourceDirection'.repeat(100):'Historical directions only'},${stamp},'active',${source},${`${run}-med-${f.tag}`},${fingerprint(`med-${f.tag}`)},${dead})`;
        // The deleted-file row is relevant only to document visibility.
        if (f.deletedFile) await tx`update external_prescriptions set deleted_at=now() where id=${med}`;
        (linked?records:excluded).medications.push(med);
      }
      await tx`insert into external_lab_reports(id,practice_id,patient_id,attribution_status,order_name,lab_name,resulted_at,status,summary,external_source,external_id,import_fingerprint,deleted_at) values (${lab},${f.practice},${f.patient},${f.patient?'matched':'needs_review'},${`Historical lab ${f.tag}`},'Synthetic Lab',${stamp},'final',${f.index===0?'LongSourceSummary'.repeat(100):'Synthetic historical result'},${source},${`${run}-lab-${f.tag}`},${fingerprint(`lab-${f.tag}`)},${dead})`;
      if (f.deletedFile) await tx`update external_lab_reports set deleted_at=now() where id=${lab}`;
      await tx`insert into external_lab_observations(practice_id,report_id,name,value,unit,external_source,external_id,import_fingerprint) values (${f.practice},${lab},${f.index===0?'LongObservation'.repeat(12):'Synthetic observation'},${f.index===0?'LongValue'.repeat(14):'4.2'},'unit',${source},${`${run}-obs-${f.tag}`},${fingerprint(`obs-${f.tag}`)})`;
      (linked?records:excluded).labs.push(lab);
      const key = `${f.practice}/documents/${file}.pdf`;fileKeys.push(key);
      await tx`insert into files(id,practice_id,uploaded_by,file_name,file_key,file_url,mime_type,file_size_bytes,checksum_sha256,storage_status,storage_verified_at,category,patient_id,deleted_at) values (${file},${f.practice},${f.practice===a?users.admin:otherUser},'Synthetic historical document.pdf',${key},${`/api/files/${key}`},'application/pdf',${SYNTHETIC_DOCUMENT.length},${createHash('sha256').update(SYNTHETIC_DOCUMENT).digest('hex')},'available',now(),'documents',${f.patient},${f.deletedFile?new Date().toISOString():null})`;
      await tx`insert into historical_documents(id,practice_id,file_id,patient_id,kind,link_status,title,document_date,external_source,external_id,import_fingerprint,deleted_at) values (${doc},${f.practice},${file},${f.patient},'patient_record',${f.patient?'linked':'needs_review'},${`Historical document ${f.tag}`},${stamp?'2020-04-03':null},${source},${`${run}-doc-${f.tag}`},${fingerprint(`doc-${f.tag}`)},${dead})`;
      (linked?records:excluded).documents.push(doc);
    }
  });
  return { practice:a, otherPractice:b, patient, sameName, foreign, empty, deletedPatient, users, otherUser, email, password, records, excluded, fileKeys };
}
