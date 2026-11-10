# Prepared offline chart acceptance

This drill verifies one bounded workflow: prepare an existing in-exam visit
while connected, reopen its encrypted chart without networking, write SOAP
sections, reconnect, and explicitly save one draft to the correct visit. Review
and signing happen online. Both offline features remain default-off pilots;
passing this drill does not activate them or approve a production clinic.

## Run the automated drill

Use a clean checkout without root or web `.env`/development environment files,
an available local PostgreSQL administrator connection, and the password of the
local `openpims_app` role. The harness refuses remote database hosts and never
migrates, seeds, or resets the database supplied in the administrator URL.
It creates a randomly named `openvpm_offline_e2e_…` database, applies committed
migrations and RLS, and runs the server as the restricted application role.
No shared seed is used. Existing application data is untouched.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium webkit
# Set these through your local secret/environment mechanism:
# OFFLINE_E2E_ADMIN_DATABASE_URL: local database administrator connection
# OPENPIMS_APP_DB_PASSWORD: existing local restricted-role password
pnpm exec playwright test --config=playwright.offline.config.ts
```

The dedicated config always runs the tests; there is no opt-in skip. It owns
ports 3456–3458 and refuses to reuse an existing server. Do not build or run another
Next.js process from the same checkout during the drill. It supplies fresh auth
configuration, enables offline preparation only for its server, and excludes
inherited provider credentials. Hosted billing and messaging remain disabled.
The database and private fixture manifest are removed on ordinary shutdown or
test failure. A forced process termination may require an operator to remove
the uniquely named disposable database after confirming its identity.

Screenshots and failure traces are written to an invocation-specific temporary
directory, outside the checkout. `OFFLINE_E2E_ARTIFACT_DIRECTORY` can select a
different artifact destination. Artifacts contain synthetic fixtures only.

The `Offline browser recovery` CI job runs the same cases in desktop Chromium
and WebKit with an iPad viewport against an ephemeral PostgreSQL service:

- cold offline page reopening, unlock, exact recovery of all four SOAP
  sections, explicit save, one persisted note, and online editor readback;
- a server-committed save whose response is dropped, followed by reopening
  and retrying the identical request without a second note or revision;
- newer online drafts and signed notes, preserving both versions for review;
- stale tabs that cannot overwrite or submit another tab's encrypted draft;
- expired offline authorization and successful recovery after reconnection;
- account changes that lock the workspace without discarding the owner's work;
- failed IndexedDB writes retaining in-memory text and the prior durable copy;
  and unavailable storage refusing workspace creation.

The drill uses real browser storage, service workers, login, protected HTTP
routes, and PostgreSQL. Fault injection drops a response only after the server
commits, aborts a browser storage transaction, or disconnects the browser
context. It does not replace clinical save responses with mock successes.
Existing database contracts continue to cover tenant/role isolation, revocation,
recovery holds, audit atomicity, and concurrent server saves.

For Chromium, cold reopening and lease expiry use `context.setOffline(true)`.
For those WebKit cases, a token-protected loopback control cuts off the real
application origin instead: Playwright's WebKit offline emulation currently
[rejects even cached service-worker responses](https://github.com/microsoft/playwright/issues/42775).
The drill verifies origin requests fail and reopened pages come from the real
service worker. Browser networking can still report connected during an origin
outage; an attempted save must then fail without losing text. This workaround
does not establish physical airplane-mode behavior.

## Physical Safari/iPad acceptance

Automated WebKit is browser-engine coverage, not proof of Safari behavior on a
physical iPad. Before naming a device/browser as supported for a clinic pilot,
record the exact iPad model, iPadOS/Safari version, browsing mode, candidate
commit/deployment, operator, date, and result of each check below. Use only
synthetic records in isolated staging with the approved offline flags enabled.
Never infer a pass from a responsive desktop screenshot.

1. Prepare a synthetic existing visit and verify the chart snapshot time,
   allergy display, offline authorization expiry, and saved-device indicator.
2. Enable airplane mode and explicitly disable Wi-Fi and cellular connectivity.
   Close the workspace tab, reopen its saved URL, unlock, and check all SOAP
   sections. Background and reopen Safari, then repeat after locking the iPad.
3. Edit each SOAP section. Wait for **Encrypted device copy saved**, close and
   reopen, and confirm the exact text. Check keyboard/scrolling, portrait and
   landscape, and readable recovery/error controls.
4. Reconnect. Confirm there is no automatic submission. Explicitly save, open
   the online editor, and verify the correct patient/visit, exact text, and one
   draft. Review and sign online only after that check.
5. Repeat with a competing online edit and a signed note. Both local and server
   text must remain available; resolving a conflict must require review.
6. Check wrong passphrases, a second tab, account switching, expired access,
   and storage refusal using synthetic fixtures. A wrong passphrase or expired
   authorization must retain the encrypted draft. Document storage eviction
   limits; browser-cleared data and lost passphrases cannot be recovered.
7. Confirm that disabling new preparation preserves access to compatible
   recovery endpoints for already-prepared drafts. Recover all synthetic device
   drafts before retiring the candidate or clearing browser data.

Record failed and untested cases explicitly. Physical acceptance is pending
until an operator performs and records these checks; this document supplies
the procedure rather than claiming an observed result.

## Pilot decision

Agree on a trusted device, passphrase retention, reliable daily reconnection,
and a downtime/support owner before a small clinic pilot. The current workspace
holds up to 20 prepared charts and authorizes offline access for at most 24
hours. Chart snapshots may be stale; medication lists, attachments, lab results,
new visits, billing, and signing are outside this scope. Device copies are not
server backups or signed clinical records.

Pause the pilot for lost text, wrong-patient association, duplicate notes,
silent replacement of newer/signed work, unauthorized access, or false save
confirmation. Retain the prior clinical system and the agreed downtime
procedure. Follow the normal staging and production release controls; keep
compatible recovery available until every outstanding device draft is resolved.
