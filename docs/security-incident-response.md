# Security Incident Response Runbook
This runbook covers suspected unauthorized access, tenant isolation failures,
credential disclosure, malicious or accidental data changes, payment fraud,
and loss of database or attachment availability in hosted OpenVPM.

It is operational guidance, not legal advice. The incident commander must
involve qualified privacy counsel before deciding whether an event is a
reportable breach or making a notification commitment.

## Stop conditions and authority

- Anyone may report an incident and request containment.
- The incident commander may disable application writes, revoke sessions,
  rotate credentials, suspend a clinic payment account, and isolate affected
  infrastructure when evidence indicates active harm.
- Do not delete records, logs, objects, accounts, or disputed Stripe evidence.
  Preserve first; repair from a separately verified copy.
- Do not restore database backups over production or promote a deployment
  during an incident without two named operators confirming the target,
  recovery point, rollback path, and affected clinics.
- Do not describe an event as a legally reportable breach until counsel has
  reviewed the facts and the applicable jurisdictions.

## Roles

Assign names at the start of every incident. One person may cover multiple
roles for a small team, but the incident commander and evidence recorder must
both confirm destructive or production-wide actions.

| Role | Responsibility |
| --- | --- |
| Incident commander | Severity, priorities, approvals, and closure |
| Technical lead | Containment, diagnosis, repair, and validation |
| Evidence recorder | Immutable timeline, queries, logs, hashes, and decisions |
| Clinic liaison | Plain-language clinic updates and workflow alternatives |
| Privacy/legal lead | Jurisdiction, notification, retention, and regulator analysis |
| Payment lead | Stripe account, disputes, refunds, payouts, and PCI coordination |

Record current names and out-of-band contact methods in the private incident
system. Never put credentials, payment tokens, medical details, or client
contact lists in tickets or chat.

## Severity and first response

| Severity | Examples | Initial response target |
| --- | --- | --- |
| SEV-1 | Cross-clinic disclosure, active account takeover, destructive production access, payment diversion, unrecoverable outage | Acknowledge in 15 minutes; contain immediately |
| SEV-2 | Single-clinic unauthorized access, failed recovery, prolonged billing or clinical outage | Acknowledge in 30 minutes |
| SEV-3 | Suspicious event with no confirmed exposure or a contained availability defect | Same business day |

For every severity:

1. Open an incident record with an ID, UTC start time, reporter, and concise
   symptom. Do not copy PHI into the title.
2. Name the incident commander and evidence recorder.
3. Preserve Vercel, Supabase, authentication, audit, email, SMS, and Stripe
   evidence for the suspected time range. Export only the minimum necessary
   data into access-controlled incident storage.
4. Identify affected practice IDs, user IDs, object keys, deployments, and
   provider event IDs. Treat clinic boundaries as unproven until the RLS and
   application predicates have both been checked.
5. Choose containment from the playbooks below. Prefer reversible controls.
6. Establish an update interval and a safe clinic workflow if service is
   limited. For this launch, online payments may be disabled independently;
   Stripe Terminal is not an advertised fallback.

## Containment playbooks

### Suspected account takeover

1. Increment the affected user's `session_version` through the supported
   "Sign out everywhere" or administrator recovery flow.
2. Confirm the old browser session receives an authentication failure on a
   protected read and a protected mutation.
3. Reset the password using a single-use, newest-link-only recovery token.
4. Review audit entries, login rate-limit evidence, email changes, staff-role
   changes, exports, payment actions, and Stripe dashboard access.
5. Rotate any credential entered or exposed during the suspected session.
6. Do not restore access until identity is re-verified and MFA is confirmed.

### Suspected tenant isolation failure

1. Disable the affected endpoint or deploy the last known-good build; do not
   rely on UI hiding.
2. Run the RLS tenant-isolation suite and a direct restricted-role query using
   two synthetic practice IDs.
3. Preserve the exact request path, authenticated user/practice IDs, response
   metadata, deployment SHA, and relevant audit rows.
4. Determine every practice whose rows or objects could match the faulty
   predicate. Do not assume the originally reported clinic is the full scope.
5. Require both code-level tenant predicates and database RLS evidence before
   reopening the endpoint.

### Suspected Stripe or billing compromise

1. Disable new client Checkout creation while leaving invoice and audit reads
   available where safe.
2. Verify the platform account ID, deployment mode, connected account ID,
   webhook signature configuration, and destination of funds.
3. Reconcile gross, Stripe fee, OpenVPM fee, clinic net, refunds, disputes, and
   payouts from immutable processor identifiers. Never infer settlement from
   the invoice status alone.
4. Revoke or rotate affected API and webhook secrets, then replay only signed,
   idempotent events.
5. Coordinate disputes, payout holds, and client communication with Stripe and
   the affected clinic. Do not issue refunds merely to make ledgers balance.

### Database or attachment loss

1. Put affected practices into recovery hold before writes resume.
2. Follow [Database Backup and Restore](backup-restore-runbook.md) and
   [File and Object Recovery](file-object-recovery-runbook.md).
3. Remember that Supabase database backups do not restore Storage objects.
4. Restore into an isolated target first. Verify practice scoping, row counts,
   hashes, object sizes, and representative clinical/billing workflows.
5. Record achieved RPO/RTO and every missing or corrupt item before deciding
   whether production can reopen.

## Communication and privacy review

- Use UTC timestamps and clearly separate confirmed facts, hypotheses, and
  decisions.
- Provide clinics a safe operational workaround and the next update time.
- Do not email PHI, payment tokens, credentials, raw logs, or broad exports.
- Before notification, determine the clinic and client jurisdictions, data
  classes, contracts/BAAs/DPAs, veterinary record rules, applicable privacy
  laws, insurer obligations, and regulator or card-network timelines.
- Preserve copies of the approved message, recipient basis, delivery evidence,
  and decision authority.

## Recovery and closure gates

Service may return only when:

- the exploit or failure mode is understood and contained;
- affected credentials and sessions are revoked;
- tenant isolation and least-privilege tests pass;
- database and object integrity are verified independently;
- Stripe settlements and payouts reconcile when billing is involved;
- monitoring can detect recurrence;
- the incident commander, technical lead, and privacy/legal lead accept the
  remaining risk; and
- every temporary bypass has an owner and removal deadline.

Closure requires a UTC timeline, impact statement, evidence index, root cause,
corrective actions with owners/dates, notification decision, and a blameless
review. Never close solely because alerts stopped.

## Quarterly tabletop and technical drill

Run once per quarter and before unrestricted clinic launch. Use synthetic data
and Preview unless the drill explicitly needs production observation.

1. Simulate a stolen administrator session. Revoke all sessions and prove the
   old session fails on protected read, mutation, upload, and file download.
2. Simulate a cross-tenant request. Run application scoping and database RLS
   suites using two practices.
3. Simulate a leaked Stripe test secret. Prove Preview rejects live keys,
   Production rejects test keys, webhook replays remain idempotent, and the
   settlement identity still balances.
4. Restore a database backup and representative objects into isolated storage;
   record RPO, RTO, hashes, and any missing objects.
5. Exercise the private contact tree and have privacy counsel evaluate a
   fictional notification decision for the intended launch jurisdictions.

Attach evidence using this template:

| Field | Evidence |
| --- | --- |
| Drill ID and UTC date | |
| Participants and roles | |
| Synthetic scenario | |
| Controls exercised | |
| Expected result | |
| Actual result | |
| RPO / RTO | |
| Gaps and owners | |
| Incident commander approval | |
