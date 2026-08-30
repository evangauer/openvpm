# Administrator and operator account recovery

## Current release boundary

OpenVPM does not currently expose a lost-all-passkeys reset endpoint. That is
intentional: a password reset or access to the account email address is not
enough to replace a phishing-resistant administrator credential. Database
owner intervention is incident-only, must increment the account session
generation, retire every prior passkey, and receive independent review.

Migration `0104_majestic_electro.sql` now installs a dormant, system-only
recovery case and event ledger. The restricted database role can reach it only
inside the existing system context; ordinary tenant context cannot read or
mutate it. Database constraints and triggers enforce a 24-hour request, a
distinct approver, an immutable event for every transition, target-session
generation locking, retirement of all active passkeys/challenges/proofs,
15-minute hashed grants, one-winner consumption, current database time on
every transition, evidence-preserving expiry that frees a future request,
and no application-role deletion. A real-PostgreSQL contract exercises these
controls, including concurrency, replay, stale generations,
missing evidence, false revocation claims, and forged backdated consumption.
The bounded `expire_due_auth_recovery_cases` primitive uses row locks with
`SKIP LOCKED`, is invisible outside system context, and appends the required
expiry event in the same transaction; no scheduler or public route calls it
yet.

Migrations `0105_rich_mandroid.sql` and
`0106_recovery_two_passkey_closure.sql`, together with the dormant server
lifecycle, bind an already approved 32-byte grant to system-only
`recovery_registration` challenges. The first verified registration appends
immutable `reenrollment_started` evidence while the approved case continues to
block ordinary login. The next challenge is issued only after that credential
exists, so WebAuthn excludes it and requires another authenticator. PostgreSQL
refuses closure unless exactly two sequential recovery challenges and two
active replacement credentials exist. Grant expiry retires a partial
credential before releasing the recovery lock. A real Chromium CTAP2 ceremony
uses separate platform and roaming virtual authenticators, rejects a preissued
second challenge, closes after the second passkey, and rejects replay. No HTTP
or tRPC route imports the lifecycle module.

These migrations do **not** activate account recovery. There is no route that
can create a request, approve it, receive a raw grant, or invoke replacement
enrollment. Do not add such a route until the owner decisions below are
approved and the remaining activation controls are built.

Until the recovery transaction, one-use enrollment ceremony, and drill below
exist and pass, `hostedAuthRecovery` and the authoritative release packet must
remain unhealthy. A live-clinic release is `NO_GO`.

## Owner decisions required before implementation activation

The owner must approve one PHI-free policy artifact that names:

1. Two to five individual recovery authorities who are also configured
   platform operators. Shared accounts, aliases, and an unassigned role are
   prohibited.
2. The identity-proofing methods and evidence-retention period. Email access or
   knowledge of a password cannot be the only proof.
3. Who may request, who may approve, and the rule that one person cannot do
   both.
4. The maximum lifetime and delivery channel for a one-use recovery enrollment
   grant.
5. The incident-escalation, clinic-notification, and security-review rules.

Hash the approved artifact with SHA-256. Store the artifact outside the
repository in the controlled evidence system; configure only its hash and
approved version in the deployment.

## Required recovery transaction and remaining activation work

The database and dormant server foundation are not an approved end-user
implementation. They currently prove request/approval separation, locking,
revocation, append-only evidence, concurrency, expiry, replay, sequential
two-passkey reenrollment, and closure from an already approved grant. Authority
policy, identity proofing, and grant issuance/delivery remain unimplemented.
The two-passkey core remains dormant and still requires an approved entry point
and operator drill before activation. Activation must prove the complete flow:

- the request exists before approval and the requester differs from approver;
- both operators are named recovery authorities with current passkey sessions;
- identity proof is recorded using bounded references, never free-form PHI;
- the target account and session generation are locked before mutation;
- every active session is revoked by advancing the database session generation;
- every prior passkey is retired with attributable, append-only evidence;
- pending login, registration, and privileged-action challenges are consumed;
- exactly one short-lived recovery enrollment grant can win under concurrency;
- password-only and email-only attempts fail closed;
- the recovery grant permits enrollment only, not clinical-data access;
- two independent passkeys are enrolled before ordinary access is restored;
- expiry, cancellation, replay, and partial failure leave the account locked;
- the audit trail contains request, approval, execution, expiry/cancellation,
  reenrollment, and closure without tokens, emails, secrets, or PHI.

Do not manually edit credential counters, delete audit rows, reveal recovery
codes to operators, or temporarily change `WEBAUTHN_ADMIN_POLICY` to work
around these controls.

## Drill and release evidence

Copy `docs/templates/auth-recovery-drill.example.json` to a secure operator
location. Do not commit a completed artifact. Use opaque GitHub handles rather
than names or email addresses, keep every control `false` until observed, and
record all critical/high findings in GitHub issues.

The drill must last 15 minutes to four hours and be no older than 90 days. The
requester and approver must be distinct members of the approved authority list.
After the drill, hash the exact JSON artifact and configure:

```env
AUTH_RECOVERY_POLICY_VERSION=dual-control-v1
AUTH_RECOVERY_POLICY_SHA256=<approved-policy-sha256>
AUTH_RECOVERY_AUTHORITY_EMAILS=<two-to-five-distinct-platform-operators>
AUTH_RECOVERY_DRILL_COMPLETED_AT=<canonical-utc-completion-time>
AUTH_RECOVERY_DRILL_EVIDENCE_SHA256=<exact-drill-json-sha256>
```

The health response never returns authority identities. The clinic-readiness
collector independently parses the drill artifact, rejects extra/free-form
fields, validates timestamps, authority separation, every control assertion,
evidence-safety attestations, and tracked findings, then embeds it in evidence
format version 5. Both staging and production must report healthy recovery
configuration for the exact release SHA.
