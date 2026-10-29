import { test, expect } from '@playwright/test';
import { isApprovedRehearsalDatabase } from '../test-support/rehearsal-database';
import { createRequire } from 'node:module';
import path from 'node:path';
import { seedImportedRecords, SYNTHETIC_DOCUMENT } from '../apps/web/server/__tests__/fixtures/imported-records';
const enabled=process.env.IMPORTED_RECORDS_E2E==='1';
const appUrl=new URL(process.env.PLAYWRIGHT_BASE_URL??'http://127.0.0.1:3000').origin;
if(enabled&&!['127.0.0.1','localhost','[::1]'].includes(new URL(appUrl).hostname))throw Error('Imported-record browser tests require loopback');
test.skip(!enabled,'Opt in with the synthetic loopback database and local preview');
test.describe.configure({mode:'serial'});
let pg:any, f:Awaited<ReturnType<typeof seedImportedRecords>>;
test.beforeAll(async()=>{
 if(!enabled)return;
 const url=process.env.IMPORTED_TEST_DATABASE_URL!;
 if(url!==process.env.DATABASE_URL||new URL(url).hostname!=='127.0.0.1'||(!/^\/openvpm_(imported|followup)_test_[A-Za-z0-9_]+$/.test(new URL(url).pathname)&&!isApprovedRehearsalDatabase(decodeURIComponent(new URL(url).pathname.slice(1)))))throw Error('Unexpected test database');
 const req=createRequire(path.resolve('packages/db/package.json'));pg=req('postgres')(url,{max:1});f=await seedImportedRecords(pg);
});
test.afterAll(async()=>{await pg?.end()});
test('patient imported history is scoped, read-only, accessible and resilient',async({page,context},info)=>{
 let fault=false, listFail=false, detailFail=false, listDelay=false, detailDelay=false;
 const unexpected:string[]=[],injected:string[]=[];
 page.on('pageerror',e=>unexpected.push(e.message));
 page.on('console',m=>{if(m.type()==='error')(fault?injected:unexpected).push(m.text())});
 await context.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/_vercel/insights/script.js')return route.fulfill({status:200,contentType:'application/javascript',body:'/* synthetic analytics stub */'});
   if(url.origin!==appUrl||url.pathname==='/api/funnel-event')return route.fulfill({status:204});
   // Storage is a synthetic local stub. Existing download authorization has
   // its own route test suite; no storage-provider calls are made here.
   if(url.pathname.startsWith('/api/files/'))return route.fulfill({status:200,contentType:'application/pdf',body:SYNTHETIC_DOCUMENT});
   const list=url.pathname.includes('migrationArchive.list'),detail=url.pathname.includes('migrationArchive.detail');
   if((list&&listFail)||(detail&&detailFail)){
     const error={error:{json:{message:'Synthetic local read failure',code:-32603,data:{code:'INTERNAL_SERVER_ERROR',httpStatus:500}}}};
     return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify(url.searchParams.get('batch')?[error]:error)});
   }
   if((list&&listDelay)||(detail&&detailDelay))await new Promise(r=>setTimeout(r,600));
   return route.continue();
 });
 await page.addInitScript(()=>{localStorage.setItem('openvpm.cookie-consent.v1','essential');sessionStorage.setItem('ovpm_verify_email_dismissed','1')});
 await page.goto('/login',{waitUntil:'networkidle'});await page.getByLabel('Email').fill(f.email);await page.getByLabel('Password').fill(f.password);
 await Promise.all([page.waitForURL(u=>u.pathname!=='/login',{timeout:60000}),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
 for(const name of [/skip for now/i,/finish later/i,/hide for now/i]){const b=page.getByRole('button',{name}).first();if(await b.isVisible())await b.click()}
 await page.goto(`/patients/${f.patient}`,{waitUntil:'networkidle'});
 const later=page.getByRole('button',{name:"I'll finish later",exact:true});if(await later.isVisible())await later.click();
 await expect(page.getByRole('heading',{name:'Synthetic Same Name',exact:true})).toBeVisible();
 listDelay=true;await page.getByRole('tab',{name:'Medical Records',exact:true}).click();
 const card=page.getByRole('heading',{name:'Imported records',exact:true}).locator('../..');
 await expect(card.getByText('Loading imported records…',{exact:true})).toBeVisible();
 await expect(card.getByText('Page 1 of 2',{exact:true})).toBeVisible();listDelay=false;
 await expect(card).toContainText('not active prescriptions');await expect(card).toContainText('Source date unavailable');
 await expect(card.getByRole('listitem')).toHaveCount(20);
 await card.getByRole('button',{name:'Next',exact:true}).click();await expect(card.getByText('Page 2 of 2',{exact:true})).toBeVisible();await expect(card.getByRole('listitem')).toHaveCount(1);
 await card.getByRole('button',{name:'Previous',exact:true}).click();await expect(card.getByRole('listitem')).toHaveCount(20);
 detailDelay=true;await card.getByRole('button',{name:'View details',exact:true}).first().click();await expect(card.getByText('Loading detail…',{exact:true})).toBeVisible();
 const region=card.getByRole('region',{name:'Imported record source detail'});await expect(region).toContainText('No fills in the source export.');detailDelay=false;
 await expect(region).toContainText('LongSourceDirection');
 await expect(card).not.toContainText('same-name');await expect(card).not.toContainText('other-clinic');await expect(card).not.toContainText('deleted');
 // Keyboard switches tabs and resets selected detail/pagination.
 await card.getByRole('tab',{name:'Medications',exact:true}).focus();await page.keyboard.press('ArrowRight');await expect(card.getByRole('tab',{name:'Labs',exact:true})).toBeFocused();await expect(card.getByRole('tab',{name:'Labs',exact:true})).toHaveAttribute('aria-selected','true');
 await expect(card.getByRole('listitem')).toHaveCount(20);
 await card.getByRole('button',{name:'View details',exact:true}).first().click();await expect(region).toContainText('LongObservation');
 await expect.poll(()=>card.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await region.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('imported-lab-detail.png')});
 await card.getByRole('tab',{name:'Labs',exact:true}).focus();await page.keyboard.press('End');await expect(card.getByRole('tab',{name:'Documents',exact:true})).toBeFocused();await expect(card.getByRole('link',{name:'Open document',exact:true})).toHaveCount(20);
 const doc=card.getByRole('link',{name:'Open document',exact:true}).first();await expect(doc).toHaveAttribute('href',new RegExp(`^/api/files/${f.practice}/documents/`));
 const href=await doc.getAttribute('href');const documentRequest=context.waitForEvent('request',r=>r.url()===`${appUrl}${href}`);const popupPromise=page.waitForEvent('popup');await doc.click();const popup=await popupPromise;expect((await documentRequest).url()).toBe(`${appUrl}${href}`);await popup.close();
 // New page query keys make injected list failure and retry deterministic.
 fault=true;listFail=true;await page.goto(`/patients/${f.empty}`,{waitUntil:'networkidle'});await page.getByRole('tab',{name:'Medical Records',exact:true}).click();
 await expect(card.getByText('Could not load imported records.',{exact:true})).toBeVisible({timeout:30000});listFail=false;await card.getByRole('button',{name:'Retry',exact:true}).click();await expect(card).toContainText('No imported medications are linked to this patient.');fault=false;
 for(const name of ['Labs','Documents']){await card.getByRole('tab',{name,exact:true}).click();await expect(card).toContainText(`No imported ${name.toLowerCase()} are linked to this patient.`)}
 await page.goto(`/patients/${f.patient}`,{waitUntil:'networkidle'});await page.getByRole('tab',{name:'Medical Records',exact:true}).click();await expect(card.getByRole('listitem')).toHaveCount(20);
 // A fresh detail read is forced to fail, then restored through Retry details.
 fault=true;detailFail=true;await card.getByRole('button',{name:'View details',exact:true}).nth(1).click();await expect(card.getByText('Could not load source details.',{exact:true})).toBeVisible({timeout:30000});detailFail=false;await card.getByRole('button',{name:'Retry details',exact:true}).click();await expect(region).toContainText('No fills in the source export.');fault=false;
 await card.getByRole('heading',{name:'Imported records',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('imported-records.png')});
 await expect(page.locator('nextjs-error-overlay')).toHaveCount(0);expect(unexpected).toEqual([]);
 const [rx]=await pg`select count(*)::int as n from prescriptions where practice_id=${f.practice} and patient_id=${f.patient}`;expect(rx.n).toBe(0);
 await info.attach('injected-failure-console',{body:JSON.stringify(injected),contentType:'application/json'});
});
