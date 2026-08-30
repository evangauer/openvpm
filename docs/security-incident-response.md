# Security incident response and tabletop runbook

This runbook governs suspected confidentiality, integrity, availability,
credential, and provider incidents affecting OpenVPM. It does not authorize
access to clinic data or replace advice from the designated privacy/legal
reviewer. When facts are uncertain, protect patients and clinic continuity,
preserve evidence, and keep the release or affected workflow stopped.

## Required people and private contacts

Before a clinic pilot, assign three distinct people:

- **Incident commander:** owns severity, timeline, containment, delegation,
  recovery gates, and final operational closure.
- **Privacy/legal reviewer:** decides whether the event may involve protected,
  regulated, contractual, or notification-sensitive information.
- **Notification authority:** approves the audience, timing, and wording of any
  clinic, client, regulator, insurer, law-enforcement, or public notice.

The release evidence records only their GitHub handles. Telephone numbers,
personal email addresses, vendor support credentials, insurer details, and
legal contacts belong in an access-controlled contact system, not this public
repository. An unassigned role is an automatic release `NO_GO`.

## Severity

| Level | Definition                                                                                                                                                | Initial action                                                                                                                     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| SEV-0 | Confirmed or credible exposure/corruption across clinics; active privileged compromise; unsafe clinical record integrity; unrecoverable production outage | Page all three authorities immediately, stop deployments and affected writes, preserve evidence, begin a dedicated incident bridge |
| SEV-1 | Confirmed single-clinic security/integrity impact; provider compromise with material blast radius; recovery objective at risk                             | Name the commander within 15 minutes, contain the affected boundary, engage privacy/legal and the provider                         |
| SEV-2 | Suspicious activity or degraded control with bounded impact and no confirmed protected-data exposure                                                      | Assign an owner within one hour, preserve evidence, investigate and prepare containment                                            |
| SEV-3 | Control weakness, near miss, or rejected attack with no observed impact                                                                                   | Track remediation, validate detection, and include it in the next tabletop                                                         |

Severity can only move downward when the commander records the evidence basis
and the privacy/legal reviewer agrees that the data-impact assessment supports
it. Silence from a provider is not evidence of no impact.

## First response

1. Create a private incident record and assign an opaque incident ID. Do not
   put patient names, client details, credentials, raw provider payloads, local
   paths, or screenshots containing them in GitHub, chat, or release evidence.
2. Name the commander and record the initial severity, detection time, affected
   services, suspected time window, and current operational impact.
3. Stop releases. Disable only the smallest affected mutation/provider path;
   preserve read-only clinical continuity when its integrity is established.
4. Preserve provider audit references, immutable object/version identifiers,
   deployment SHAs, database transaction/audit identifiers, and timestamps in
   the private incident system. Never paste their sensitive payloads.
5. Rotate or revoke suspected credentials before relying on log review. Use
   provider consoles or approved secret managers, not shell history or issues.
6. The privacy/legal reviewer classifies the data and jurisdictions in scope.
   The notification authority records a notification decision even when the
   decision is “not required.”

## Scenario playbooks

### Database

- Block unsafe writes and releases; do not run ad-hoc destructive repair.
- Confirm tenant isolation, schema/migration state, audit continuity, backup
  freshness, and the earliest credible compromise/corruption time.
- Recover into an isolated target, enter recovery hold, reconcile affected
  records, run RLS and clinic-workflow smoke tests, and require explicit release
  of the hold. Production restore follows the backup/restore runbook.
- Engage the database provider for authoritative access, backup, and audit
  evidence. Record whether clinic operations need a downtime or integrity notice.

### Object store

- Disable affected upload/delete paths or credentials while preserving known-
  good read access when safe.
- Identify exact object versions and replication state without downloading or
  publishing patient content as tabletop evidence.
- Restore one independently versioned object and verify its checksum before any
  broad recovery. Reconcile database references and access controls.
- Coordinate with the object provider on access logs, retention, versioning,
  replication, and credential revocation.

### Stripe

- Stop new payment mutations if signing keys, API credentials, connected
  accounts, webhook integrity, or financial projection is uncertain.
- Rotate/revoke the affected credential, preserve provider event IDs privately,
  and reject replay or ambiguous clinic mapping.
- Reconcile authoritative Stripe state to immutable local billing events before
  reopening checkout, refunds, subscription changes, or payouts.
- Engage Stripe support and record clinic/client, contractual, and legal
  notification decisions without publishing payment data.

### Email provider

- Disable affected sending/webhook paths and rotate API/webhook credentials.
- Preserve provider message/event references privately; do not publish message
  bodies, recipients, unsubscribe identities, or raw webhook payloads.
- Reconcile suppression, delivery, authentication, invitation, and preference
  state before re-enabling mail.
- Engage the provider for account access, delivery, and audit evidence and
  record whether clinics or recipients require notice.

### Credential compromise

- Revoke first, then investigate. Enumerate the credential’s permissions,
  environments, repositories, providers, and observed use.
- Rotate dependent signing/encryption material in a controlled sequence; do not
  invalidate recovery evidence or destroy audit history.
- Review GitHub, deployment, database, object, billing, messaging, email, auth,
  and cloud identity logs for the credible window.
- Validate new credentials through least-privilege health and workflow tests.
  Never place old/new values or fingerprints derived from secret values in the
  public exercise packet.

## Recovery and closure gates

The commander may restore a workflow only when containment is effective, the
authoritative source has been reconciled, tenant and clinical-integrity checks
pass, monitoring is active, and privacy/legal plus notification decisions are
recorded. Restoration of service is not incident closure. Closure also requires
rotated credentials where relevant, follow-up issues for critical/high findings,
an evidence-retention decision, and a blameless review.

## Tabletop procedure and release evidence

At least every 180 days and before the first clinic pilot:

1. Copy `docs/templates/incident-response-tabletop.example.json` to a private,
   mode-`0600` working location. Generate the opaque eight-character suffix
   with `openssl rand -hex 4`; do not derive it from a clinic or person.
2. Assign three distinct real people and conduct a 15-minute-to-8-hour tabletop
   covering all five scenarios above.
3. For each scenario, exercise detection, containment, recovery, safe evidence
   handling, vendor coordination, and clinic/legal notification decisions.
4. Open GitHub issues for critical/high follow-ups using only PHI-, secret-,
   provider-payload-, and local-path-safe summaries.
5. Replace the deliberately failing template fields, have each role approve,
   and run:

   ```bash
   pnpm --filter @openpims/web incident:verify-evidence -- --input <private-evidence.json>
   ```

The evidence schema accepts no free-form notes. It contains only safe handles,
an opaque `tabletop-YYYY-MM-DD-<8-lowercase-hex>` exercise ID whose date matches
completion, timestamps, booleans, counts, and follow-up issue numbers. The
authoritative clinic-readiness
collector requires this file through `--incident-evidence` and format version 6
returns `NO_GO` when evidence is missing, stale, incomplete, unsafe,
placeholder-owned, self-overlapping, or unapproved.

Keep the detailed timeline and provider/legal material in the approved private
incident system. The release packet is a readiness attestation, not the incident
record itself.
