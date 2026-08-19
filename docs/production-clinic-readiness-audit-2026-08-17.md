# OpenVPM production and clinic-readiness audit

Date: 2026-08-18 (updated after isolated launch walkthrough)
Production: `https://app.openvpm.com`
Deployed revision observed: `2f1fc833` (`origin/main`)
Scope: Francisco's latest workflow request, OpenVPM subscription billing,
clinic-owned client payments through Stripe Connect, and the controls expected
of a safe production PIMS.

## August 18 hosted verification — authoritative status

This section supersedes any older hosted-state statement later in this audit.
The older findings are retained to show how the decision changed and what has
not yet shipped.

The deployment decision remains **NO-GO for unrestricted clinic use**. The
stable preview is deployed and is suitable for a controlled synthetic/manual
verification session. Production traffic was not changed.

### What is now staged or proven

- Get Talky Inc. is the approved temporary Stripe platform while the dedicated
  OpenVPM account is created. The two existing trials remain untouched.
- Production Vercel configuration pins the approved Stripe platform and
  Connect model, requires a 25-basis-point application fee deducted from clinic
  proceeds, and retains clinics as merchant of record through direct charges.
  The Accounts v2 destination exists but remains disabled until the production
  hardening revision passes its launch gate.
- A private production object-replica store is provisioned. Replication remains
  disabled and non-required until the adapter is deployed, historical objects
  are backfilled, coverage is measured, and a restore drill passes. Provisioned
  storage is not recovery proof.
- The stable preview uses a separate Supabase project, Stripe test account,
  webhook destinations, subscription products, payment-method configuration,
  Billing Portal configuration, New York test tax registration, and private
  Vercel Blob primary store. Its core database, schema, RLS role, app URLs,
  billing, 25-basis-point fee, expected Stripe identity, subscription tax, and
  primary storage health checks are green.
- Preview health intentionally remains HTTP 503 because real hosted email, AI,
  operations, alerting, and cron-heartbeat values have not been supplied.
  Replica and SMS readiness are advisory in preview. This is fail-closed launch
  behavior, not a reason to weaken the health contract.
- The live preview CSP now uses a per-request nonce for Next.js and theme
  bootstrap scripts. Hosted verification found 28 script tags, 28 exact nonce
  matches, zero unmatched scripts, and no `unsafe-inline` in `script-src`.
- The private-file path round-tripped a patient photo through the authenticated
  file route. Tenant RLS was exercised with the least-privilege staging role;
  a second synthetic clinic could not see the first clinic's client, patient,
  practice, or billing data.

### Hosted workflow outcome

The final six-stage Playwright run produced four passes and two safe skips:

1. An existing synthetic trial clinic authenticated and exposed only its own
   practice through tenant RLS. A prior fresh registration, simulated
   verification-link click, plan selection, full automatic-tax address, and
   Stripe Checkout submission had reached Stripe successfully.
2. Stripe Checkout invoked hCaptcha. Provider initialization, tax, and form
   POSTs returned HTTP 200, but no subscription or payment/setup intent was
   created before human verification. This remains a manual browser action;
   it is not recorded as successful billing.
3. Stripe Accounts v2 onboarding was reached and produced a connected-account
   row. Stripe invoked its human verification immediately; the account remains
   disabled with charges and payouts off, as OpenVPM correctly reports.
4. The clinic created a client, patient, appointment, checked-in encounter,
   completed SOAP note, and draft invoice. The patient photo persisted and was
   served only through the authenticated file route.
5. Client card payment was skipped because the connected account is not
   charge-enabled. This is the required fail-closed behavior and means the
   gross/fee/net/refund/dispute/payout lifecycle is still unproven.
6. A second clinic logged in and saw none of the first clinic's data.

The repeated synthetic signups eventually hit the hosted registration limiter.
The limiter remained enabled; the test reused the already-created clinic rather
than weakening an abuse control.

### Final code and release evidence

- Optimized production build and TypeScript pass.
- ESLint reports zero errors and 240 existing warnings.
- 401 test files pass: 4,090 tests passed and six explicitly gated provider
  integration tests were skipped.
- Production dependency audit reports no known vulnerabilities.
- Open-source release verification passes across 1,355 tracked and
  non-ignored untracked files.
- Gitleaks scanned 1,288 commits / approximately 106 MB and reports no leaks.
  Twenty-one historical generic-key matches were reviewed as deterministic
  portal/auth test fixtures and suppressed by exact fingerprint in
  `.gitleaksignore`; no path-wide or rule-wide suppression was added.

### Remaining production P0 gates

- Complete a real-browser Stripe subscription Checkout and connected-clinic
  onboarding, then prove charges and payouts are enabled before any client
  payment.
- Deploy the hardening revision, backfill and enable the independent object
  replica, prove coverage, and run a timed restore. Supabase currently has
  daily physical backups but PITR is not enabled; enabling seven-day PITR has
  recurring cost and needs explicit approval. Database recovery does not
  recover stored objects.
- Add DMARC in monitored `p=none` mode after confirming the report mailbox,
  then run real Gmail, Outlook, and clinic-domain inbox/header/reply tests.
- Implement MFA/passkeys, privileged-action step-up, session/device revocation,
  and test the incident-response playbook. Complete launch-jurisdiction legal,
  privacy, retention, and clinic-contract review.
- Add end-of-day financial close, immutable gross/Stripe-fee/OpenVPM-fee/net
  and payout reconciliation, dispute/chargeback operations, and clinic
  statements. Until Stripe Terminal is implemented, formally scope the pilot
  to online/keyed payments only.
- Supply preview-specific email allowlisting/credentials plus AI, ops,
  alerting, and heartbeat endpoints before expecting preview health to turn
  green. Do not reuse production recipient delivery broadly in preview.

## Executive decision

OpenVPM is suitable for a controlled internal or design-partner pilot after the
production launch gates below are closed. It is **not ready for an unrestricted
clinic launch today**.

The core Stripe architecture is appropriate for the business. A clinic is the
merchant of record, a client payment is a direct charge on the clinic's
connected account, Stripe collects its fees and owns negative-balance risk,
and OpenVPM deducts an application fee from clinic proceeds. The current
payment code also has
good safeguards around tenant attribution, idempotency, stale invoice totals,
manual authorization capture, partial capture, and proportional application-fee
refunds.

Production is not yet capable of delivering that flow:

- The one observed connected clinic account cannot currently accept charges or
  receive payouts.
- No production application-fee rate is configured, so OpenVPM currently earns
  0% from client payments.
- The Accounts v2 implementation and thin-event webhook exist in the working
  hardening branch, but production lacks the v2 event destination, webhook
  secret, feature gate, and expected Stripe-account pin required for cutover.
- Production has emitted repeated subscription-webhook mapping errors. The
  working branch contains stronger mapping and recovery behavior, but it is not
  deployed.
- Monthly ($79) and annual ($790) billing are available during initial signup.
  The hardening tree now adds a provider-verified, idempotent same-workspace
  switch from monthly to annual at the next renewal, with no immediate charge
  or proration. Production still lacks this flow until the hardening revision
  is deployed and exercised in Stripe Sandbox.
- Production has repeated backup-verification failures. Its public health check
  also says independent object replication is not configured. That is a clinic
  safety launch blocker, independent of billing.
- The production invoice-email action is still a one-click send with no review
  step and no payment link. The working tree now adds an exact send review and
  a 30-day, invoice-scoped payment link that cannot open the broader client
  portal. Owners cannot use that hardened handoff until it is deployed.
- Francisco reported that AVG Web Shield blocked OpenVPM until he disabled it.
  The sign-in and recovery UI is straightforward once loaded, but endpoint
  reputation remains a real “can the clinic get in?” blocker for his setup.
- Francisco's structured nutrition workflow is designed in a draft contract,
  but not implemented. MCS, target weight, daily calorie target, diet/activity
  history, clinician review, and the ONES endpoints are not production
  capabilities.

### Current production go/no-go board

| Gate | Current evidence | Status / owner |
| --- | --- | --- |
| Hardened application revision | Local type/tests pass; production remains on the earlier revision | **BLOCKED** — engineering deploy + post-deploy verification |
| Dedicated OpenVPM Stripe platform | Legal/account model approved; current connector still reaches the Get Talky account, not a dedicated OpenVPM account | **BLOCKED** — owner/Stripe administrator |
| Stripe cutover configuration | Account pin, Accounts v2 destination/secret/gate, 25 bps fee, pinned payment/Portal configuration, tax code/registration are not in the required Vercel state | **BLOCKED** — Stripe + Vercel operator |
| Existing two trials | Remain on Get Talky by design; production has recurring unambiguous-mapping failures | **BLOCKED** — dry-run identity repair/rebind, then clean webhook window |
| Clinic client-payment account | No observed clinic connected account is charge- and payout-ready | **BLOCKED** — pilot clinic + Stripe onboarding |
| Primary and independent recovery | Restore-parent code defect fixed locally; production primary object read-back still fails and independent replica is absent | **BLOCKED** — Cloudflare/Vercel operator + timed restore drill |
| Authentication | Session capped to 12 hours locally; no MFA/passkeys, step-up auth, inactivity control, or device/session revocation | **BLOCKED** — product/security engineering |
| Invoice email delivery | Review + payment-only link implemented locally; DMARC and real-inbox/header proof remain | **BLOCKED** — deploy + DNS/email operator |
| SMS operations | Production driver defect identified and fixed; production-configured read-only computation is green with the patch | **BLOCKED** — deploy + clean monitor window |
| End-to-end money proof | Unit/integration coverage is green; Accounts v2 Sandbox lifecycle and low-value live canary have not run | **BLOCKED** — QA/Stripe operator; live canary needs action-time authorization |
| Security/legal readiness | App review, tenant-isolation exercise, incident tabletop, privacy/retention review, and PCI responsibility evidence remain | **BLOCKED** — security + counsel + owner |

Until every P0 row is green, keep the current clinics in a controlled pilot,
do not enable new live Connect account creation, and do not describe OpenVPM as
fully clinic-ready.

### August 18 isolated launch walkthrough

The current hardening candidate is reproducible and materially safer, but the
deployment decision remains **NO-GO**. No production deployment was performed,
no live payment was attempted, and neither existing Get Talky trial was
modified.

The serial browser walkthrough produced five passes and one intentional skip:

- A new clinic completed the current four-step, card-free signup, one-time
  email verification, Stripe test subscription Checkout, signed subscription
  webhook activation, and the existing-monthly-to-annual-at-renewal change.
  The annual change showed $790/year, preserved monthly access through the
  renewal date, and created no immediate charge or proration.
- A new Accounts v2 connected clinic and Stripe-hosted onboarding session were
  created in test mode. Stripe stopped at its human identity-verification
  challenge. The resulting account correctly remains action-required, with
  card payments disabled and payouts pending; OpenVPM exposes the approved
  0.25% clinic-funded fee and does not allow checkout while the account is
  disabled.
- The clinic-day path completed client, patient, appointment, check-in, exam,
  visit-linked SOAP, explicit clinician replacement of every template prompt,
  SOAP finalization, invoice creation, patient-photo object persistence, and
  authenticated file delivery. Cross-clinic isolation also passed.
- The client card-payment/refund/payout portion was skipped because Stripe had
  not enabled the connected account. This is the desired fail-closed result,
  not proof of the full money lifecycle. A human must finish Sandbox onboarding
  before the remaining lifecycle can run.
- The registration limiter blocked the sixth same-IP attempt, appointment
  conflicts returned 409, doctor-required visits without a provider returned
  412, and unresolved SOAP template prompts could not be finalized.

The local recovery drill also advanced from unit evidence to an executed
isolation drill. Twenty-seven synthetic practices produced verified primary
and versioned-replica artifacts. One downloaded artifact passed checksum,
catalog, version, canonical-section, and restore-contract validation; it was
then restored into a newly migrated database. Seventy-four rows were restored,
the expected client/patient/appointment/invoice counts matched, and the clinic
remained on the mandatory recovery hold. This proves the application path in
the sandbox. It does not replace an independent production provider, a timed
production-like drill, or clinic-owner acceptance.

Final code/security evidence for this candidate:

- Frozen workspace installation and the optimized production build pass.
- ESLint now runs non-interactively: zero errors and 240 recorded legacy
  warnings. The one Hooks-rule failure was corrected; explicit-any and unused
  fixture debt remain visible as warnings instead of being hidden.
- TypeScript passes; 401 test files pass (4,084 tests), with three integration
  files/six explicitly configured provider tests skipped.
- Database drift is clean; the RLS/tenant-isolation suite passes.
- The production dependency audit reports no known high-severity production
  vulnerability, and the open-source release verifier passes 1,353 tracked and
  non-ignored untracked files.
- A secret scan of tracked and non-ignored untracked files found no production
  credential. Seven findings were short token-shaped values in test fixtures
  and were reviewed as false positives; no blanket test-file suppression was
  added.

Deployment is blocked by authoritative hosted state. The linked Vercel project
is correct, but production is missing the expected Stripe account pin, Accounts
v2 secret/gate, 25-basis-point fee, pinned subscription payment-method and
Billing Portal configurations, and tax classification/registration values.
Existing Stripe credentials also do not meet the required Sensitive/config
visibility policy, and a retired Cloud price variable remains. The independent
replica is absent. The preview environment is not a safe substitute: it lacks
storage credentials, signed Stripe webhook secrets, Resend, and email-preference
secrets. The connected Stripe workspace still identifies Get Talky Inc., not
the dedicated OpenVPM platform account. Deploying this candidate would make the
new health checks fail closed, so no preview or production deployment was made.

## Francisco workflow map

Francisco's latest email defines two related products:

1. OpenVPM is the clinical and operational system of record.
2. ONES is a tightly scoped nutrition calculation and recommendation engine.

The requested first release includes:

- A month-to-month $79 plan, followed by a same-workspace switch to $790/year.
- Clinic services, appointment types, and scheduling.
- Structured weight, 1–9 BCS, MCS, target weight, and daily calorie target with
  longitudinal history.
- A least-privilege ONES API that reads only necessary patient/appointment
  context and writes a reviewable nutrition result with a durable audit trail.

| Requested workflow | Production/current code | Readiness |
| --- | --- | --- |
| Configure services and prices | Present | Pilot-ready |
| Configure appointment types, hours, rooms, and scheduling | Present | Pilot-ready with clinic validation |
| Client and patient profiles | Present | Pilot-ready with migration validation |
| SOAP, vitals, prescriptions, vaccines, visit closeout | Present | Pilot-ready after recovery gates |
| Longitudinal weight and BCS | Present | Pilot-ready |
| MCS, target weight, calorie target, diet/activity history | Draft contract only | Not ready |
| ONES context/result API and clinician review | Draft contract only | Not ready |
| $79 monthly or $790 annual first activation | Present | Ready after Stripe production verification |
| Existing monthly subscriber switches to annual | Implemented at next renewal in hardening tree | Ready after deployment and Stripe Sandbox proof |
| Clinic connects Stripe and bills its clients | Correct code path; live account disabled | Not ready |
| OpenVPM collects a small percentage | Clinic-funded model confirmed; positive fee required in hardening tree; 0% live | Not ready |
| Staff can access the product on clinic devices | Sign-in/recovery are mobile-friendly; AVG blocked Francisco's device | Not ready for his clinic until reputation issue is cleared |

The draft nutrition contract at
`docs/integrations/nutrition-workflow-contract-v0.1.md` makes the right safety
choices: practice-derived scope, minimal data, an external draft rather than a
signed record, explicit veterinarian review, append-only correction history,
idempotency, and stale-context rejection. It should remain the implementation
contract rather than being described as a shipped feature.

## Stripe Connect architecture

### Recommended responsibility model

OpenVPM is a SaaS platform that lets independent clinics accept payments from
their own clients. The recommended model is:

| Decision | Selection |
| --- | --- |
| Merchant of record | Clinic |
| Charge type | Direct charge |
| Stripe Dashboard | Full Dashboard |
| Stripe processing-fee collector | Stripe/connected clinic |
| Negative-balance loss collector | Stripe |
| Requirement collection | Stripe-hosted onboarding |
| OpenVPM revenue | `application_fee_amount` on each client payment |
| Platform account | Dedicated OpenVPM Stripe account owned by Get Talky Inc. |
| Existing trial subscriptions | Stay on the current Get Talky account until controlled renewal migration |

This matches Stripe's current SaaS guidance and the working Accounts v2 account
creation code. Stripe describes direct charges as suited to SaaS platforms and
states that the connected merchant owns the payment, processing fees, refunds,
and disputes while the platform receives application fees:

- <https://docs.stripe.com/connect/saas>
- <https://docs.stripe.com/connect/direct-charges>
- <https://docs.stripe.com/connect/direct-charges-fee-payer-behavior>

### Research-backed launch fee

The approved launch rate is **0.25% (25 basis points)**, deducted from
clinic proceeds with no pet-owner surcharge. It is intentionally much lower
than the earlier 1% working assumption:

- Stripe's published US online-card rate starts at 2.9% + 30 cents.
- Digitail publicly advertises 2.79% + 25 cents for its integrated veterinary
  payments product.
- A 1% OpenVPM fee would put a standard $100 online payment near 3.9% + 30
  cents, an unnecessarily visible penalty.
- At 0.25%, a standard $100 online payment is approximately $3.45 total fees:
  $3.20 Stripe + $0.25 OpenVPM. The owner pays exactly $100 and the clinic nets
  approximately $96.55.

The $79 software subscription remains the primary revenue model. The payments
fee is a small convenience/operations fee and should be disclosed before
Connect onboarding, in commercial terms, and in monthly reconciliation. Stripe
also says eligible SaaS platforms can qualify for a revenue share when Stripe
sets and collects connected-account pricing; OpenVPM should ask Stripe whether
that can reduce or replace the explicit application fee as volume grows.

Sources: <https://stripe.com/pricing>,
<https://stripe.com/connect/pricing>,
<https://docs.stripe.com/connect/saas>, and
<https://digitail.com/blog/say-goodbye-to-missed-charges-digitail-announces-digitail-secure-payments/>.

The product owner approved 0.25% on August 17, 2026. Production policy now
rejects any value other than `25` basis points.

### “On top” must be resolved before launch

There are two materially different interpretations:

1. **Recommended:** deduct OpenVPM's platform fee from clinic proceeds. The pet
   owner pays the invoice amount and the clinic buys payment software from
   OpenVPM.
2. Add a card surcharge to the pet owner's invoice. This is not implemented and
   should not be the first launch model. Visa and Mastercard restrict
   surcharges to eligible credit transactions, prohibit them on debit/prepaid,
   require disclosures and receipt itemization, impose caps/notifications, and
   leave state-law compliance with the merchant. See
   <https://usa.visa.com/content/dam/VCOM/global/support-legal/documents/merchant-surcharging-qa-for-web.pdf>
   and
   <https://www.mastercard.us/en-us/business/overview/support/merchant-surcharge-rules.html>.

Do not implement a client-facing surcharge until counsel and the acquirer have
approved the exact jurisdictions, card types, disclosures, receipts, and
clinic agreement.

### What the current payment path does well

- Requires an active, chargeable connected account before staff or portal
  checkout.
- Creates Checkout on the connected Stripe account, not the platform account.
- Uses manual capture so an invoice that changes or is paid elsewhere cannot be
  blindly overpaid by a stale Checkout session.
- Re-reads and locks the invoice/visit before capturing and recording payment.
- Validates the connected account against the webhook account and invoice's
  owning practice.
- Uses Stripe and database idempotency identities for payment/refund replay.
- Represents refunds as negative ledger payments and refunds the application
  fee, preventing the clinic from funding OpenVPM's retained fee on a refund.
- Restricts invoice/refund actions by role and keeps credits/write-offs
  auditable.
- Supports secure client portal checkout and rate-limits public checkout probes.

### Connect gaps

| Gap | Severity | Required control |
| --- | --- | --- |
| Live clinic account has charges/payouts disabled | P0 | Complete onboarding and verify both capabilities before any pilot payment |
| Fee configuration absent in production | P0 | Set the approved `STRIPE_CONNECT_APPLICATION_FEE_BPS=25`; the hardening tree discloses it, fails closed without it, verifies it on the PaymentIntent before capture, and rejects any different production value |
| Accounts v2 destination absent | P0 for v2 deploy | Create a production thin-event destination and set the matching secret before enabling v2 creation |
| Platform account is not pinned | P0 for hardening deploy | Set and verify `STRIPE_EXPECTED_ACCOUNT_ID`; fail closed on mismatch |
| Existing secrets use encrypted rather than sensitive storage | P1 | Recreate Stripe secret/webhook values using the provider's sensitive storage class |
| Full platform secret key used | P1 | Replace with the narrowest restricted key compatible with required Connect and Billing actions |
| No local dispute/payout/fee ledger | P1 | Ingest and reconcile balance transactions, fees, refunds, disputes, and payout failures |
| No operational account-health queue | P1 | Alert on due/past-due requirements, disabled capabilities, negative balances, and payout failures |
| Checkout webhook only handles completion | P1 | Reconcile expired/failed/cancelled authorizations and surface abandoned payment status |
| No card-present payment | P1 for full-service clinics | Add Stripe Terminal or explicitly limit the pilot to keyed/online collection |
| No stored card or autopay consent flow | P2 | Add SetupIntent/customer consent and MIT controls only when the product requires it |
| No deposits/prepayments | P2 | Add appointment deposits and unapplied-credit accounting before claiming full revenue-cycle coverage |

## Clinic-to-client invoice email

The clinic-ready workflow is:

1. Staff opens a sent or overdue invoice and selects **Email payment link**.
2. OpenVPM shows a review dialog with the exact recipient, From identity,
   Reply-To address, subject, live amount due, and due date.
3. The clinic confirms **Send email**. The server rechecks the invoice, visit
   closeout, recipient suppression, recovery hold, and live balance.
4. Resend delivers from `"Clinic name via OpenVPM"` on the verified
   `mail.openvpm.com` domain. Replies go to the clinic email configured in
   Settings; OpenVPM does not spoof an unverified clinic domain.
5. The message contains no line-item or clinical detail. Its button opens a
   signed payment-only credential scoped to one clinic, client, and invoice.
   The link expires after 30 days and does not reveal or create the permanent
   client-portal credential.
6. The page shows the current balance and redirects to Stripe-hosted Checkout.
   Card details never pass through OpenVPM. Stripe returns the client to the
   same payment-only page for a success/cancelled status.
7. The signed Connect webhook remains the financial source of truth for
   capture, ledger posting, invoice status, and receipt delivery.

The working tree implements steps 1–6. Production still has the earlier direct
send until this revision is deployed. Before enabling it, verify SPF, DKIM,
DMARC, Resend delivery/bounce callbacks, clinic Reply-To configuration, and a
real inbox test across Gmail, Outlook, and a clinic-managed domain.

## Existing Get Talky subscriptions

Read-only Stripe inventory found exactly two current OpenVPM clinic trials on
the Get Talky Inc. account. Both are $79/month, both have a payment method, and
their current trial end dates are August 31 and September 7, 2026. One separate
canceled OpenVPM annual trial should remain untouched.

Get Talky's only connected clinic account belongs to that canceled annual-trial
practice, not either current trial. It has never completed onboarding: charges
and payouts are disabled, details are not submitted, and 15 requirements are
past due. Do not migrate it or treat it as launch infrastructure. The two
current trials can be onboarded cleanly under the final OpenVPM platform.

The product owner approved the dedicated OpenVPM-under-Get-Talky account model
on August 17, 2026. Recommended transition:

- Do not cancel or recreate the two live trials today.
- Use the dedicated OpenVPM platform account under Get Talky Inc. and a Stripe
  Organization, then put all new OpenVPM signups and all Connect clinic
  accounts there. If the operating legal entity changes, stop and have
  Stripe/counsel approve the ownership and consent model before sharing any
  customer data.
- If customer/payment-method sharing is available and the clinics consent,
  share the two customers/payment methods into the OpenVPM account and create
  replacement subscriptions that start exactly when the old trials end.
- If that cannot be fully tested before August 31, let the existing Get Talky
  subscriptions convert normally rather than risking an interruption. Migrate
  them later at a clean renewal boundary after the OpenVPM account is proven.
- Otherwise use Stripe's account-to-account migration/support workflow. Never
  copy card data or ask a clinic to email payment details.
- Cancel the old subscription only after the replacement is scheduled and
  verified, preventing both a service gap and double billing.

Stripe documents organization sharing as an irreversible configuration that
requires customer consent, and its Billing migration guidance explicitly says
to create the replacement first and cancel the old subscription before it can
charge. Sources:
<https://docs.stripe.com/get-started/account/orgs/sharing/customers-payment-methods>,
<https://docs.stripe.com/get-started/data-migrations/overview>, and
<https://docs.stripe.com/billing/subscriptions/import-subscriptions-toolkit>.

Production cutover configuration still needed by the hardening branch includes:

- `STRIPE_EXPECTED_ACCOUNT_ID`
- `STRIPE_CONNECT_V2_ENABLED`
- `STRIPE_CONNECT_V2_WEBHOOK_SECRET`
- `STRIPE_CONNECT_APPLICATION_FEE_BPS`
- `STRIPE_SUBSCRIPTION_PAYMENT_METHOD_CONFIGURATION`
- `STRIPE_BILLING_PORTAL_CONFIGURATION`
- `STRIPE_CLOUD_PRODUCT_TAX_CODE`
- `STRIPE_REQUIRED_TAX_REGISTRATIONS`

The v2 gate must remain off until its event destination and secret are verified.
The new expected-account check will intentionally make Stripe calls fail closed
if deployed before its value is present.

## Billing workflow assessment

### OpenVPM subscription

The subscription implementation supports monthly and annual initial Checkout,
practice/customer attribution, a card-free trial policy, webhook idempotency,
quantity sync, tax configuration, past-due/read-only behavior, and a Stripe
Billing Portal. The working branch also adds stricter subscription mapping and
a controlled rebind tool.

Required before launch:

1. Rebind or classify every production Stripe subscription/customer so one
   external subscription maps to exactly one active practice.
2. Replay/verify the previously failing webhook events and show a clean error
   window.
3. Deploy the explicit, idempotent monthly-to-annual change operation now in
   the hardening tree. It uses a Stripe Subscription Schedule to take effect at
   renewal, creates no immediate charge/proration, verifies subscription,
   customer, and practice ownership, and keeps both the live and scheduled
   location quantities synchronized.
4. Exercise the change against Stripe Sandbox fixtures for an existing trial,
   active monthly account, past-due account, annual account, and an account with
   a conflicting schedule. Confirm the practice ID and workspace never change.

### Clinic invoices and payments

Present:

- Estimates and invoices, service/product lines, tax snapshotting, PDF/email,
  partial payments, cash/card/check/online/other tender recording, portal/card
  checkout, refunds, credits, write-offs, voids, due dates, and AR summaries.
- Visit-linked invoice integrity and performed-work reconciliation.
- Wellness plans that generate scheduled invoices (not automatic card charges).

Missing from a mature PIMS revenue cycle:

- A financial transaction ledger that stores gross, Stripe fee, OpenVPM fee,
  net, balance transaction, refund state, dispute state, and payout identity.
- End-of-day tender close, deposit/batch reconciliation, cash-drawer variance,
  and accounting export.
- Client statements/aging workflow beyond top-level AR totals.
- Card-present terminal, stored cards, deposits, payment plans, and reliable
  recurring client autopay.
- Dispute/chargeback intake, evidence deadlines, payout-failure alerts, and an
  operations queue.
- Clear clinic-facing disclosure of payment pricing and expected net proceeds.

## Visual workflow pass

### Clinic administrator

- Sign-in and password recovery are clear, centered, and usable at a 390 px
  mobile viewport. Labels, recovery navigation, and primary actions are plain
  language.
- Invitation and reset links with a nonempty but expired/invalid token show the
  password form before the server reports the error. This is safe but wastes a
  nontechnical user's effort; add a read-only token preflight or a clearer
  recovery action after the failed submit.
- Plan selection clearly presents $79 monthly and $790 annual pricing. The
  annual option was selected by default in the observed production state;
  selecting the monthly card correctly updates the summary to $79 billed
  monthly.
- Client payment setup is below subscription billing, reports cards disabled
  and payouts pending, and offers setup/refresh actions. The working tree now
  also discloses the clinic-funded OpenVPM fee and shows a short “have these
  ready” checklist for Stripe's business, identity, and bank requirements.
- On narrow screens, Settings tabs are horizontally scrollable but later tabs
  are initially offscreen. This is functional, though a sticky active-tab
  label or grouped navigation would be easier for first-time users.

### Clinic invoice send

- Expanding an invoice exposes PDF download, the recipient email, payment
  history, and payment controls without console-visible failures.
- Production labels the action “Email Invoice” and sends immediately, without
  a preview or confirmation. More importantly, the email helper supports a
  portal URL but the production mutation does not pass one, so the client has
  no direct route from the email to online payment.
- The working tree now labels the action **Email payment link** and opens a
  review dialog instead of sending immediately. It shows the exact To, From,
  Reply-To, subject, live balance, and due date before the staff member confirms
  the external send. The August 18 visual pass verified this dialog against a
  synthetic sent invoice; **Send email** was deliberately not selected.
- The prior hardening attempt reused the permanent client-portal credential.
  That has been replaced: invoice email now creates a cryptographically signed,
  30-day credential scoped to exactly one clinic, client, and invoice. It
  cannot open pets, messages, appointments, or other invoices.

### Pet owner

- An invalid or expired portal link fails closed with a clear mobile state:
  “Unable to load invoices” and guidance to refresh or contact the clinic.
- The working tree adds a separate mobile-first payment page with a full-width
  48 px primary action, plain-language amount/due-date summary, clinic contact
  information, link-expiry disclosure, and Stripe attribution. It contains no
  portal navigation or clinical line items.
- Both the full portal and payment-only page gate Checkout to sent/overdue
  invoices with a positive live balance and a ready connected account.
- The August 18 visual pass opened a signed synthetic payment-only link. It
  required no account or password, showed only the invoice balance/dates and
  clinic contact, disclosed the 30-day expiry, and correctly reported online
  payment unavailable because Connect was not charge-ready. Stripe Checkout
  remains blocked until human Sandbox onboarding is complete. No production
  token or live Checkout was opened during this audit.

## PIMS benchmark

OpenVPM already covers a meaningful clinical core: clients/patients,
scheduling, whiteboard, SOAP/vitals, prescriptions, vaccines, manual labs,
estimates/invoices, inventory, reminders, a client portal, audit trails,
role-based access, signed-record correction behavior, and visit closeout.

A mature PIMS connects those features into one low-error clinic loop. Shepherd,
for example, describes SOAP completion updating the medical record and invoice,
automatic charge capture, discharge instructions, online/terminal/stored-card
payments, end-of-day reporting, inventory, scheduling, communications, and
wellness billing as one workflow:
<https://www.shepherd.vet/features/>. Covetrus similarly emphasizes appointment
deposits, integrated payment reconciliation, prescriptions/diagnostics in the
record, online pharmacy, inventory, scheduling, and client communications:
<https://covetrus.com/covetrus-platform/workflow-and-productivity-tools/covetrus-pulse/>.

| PIMS domain | OpenVPM assessment | Highest-value next step |
| --- | --- | --- |
| Scheduling/intake | Good core | Validate real clinic exception cases, deposits, waitlist conversion, and no-show handling |
| Clinical record | Strong core | Implement structured nutrition assessments/results and validate complete continuity-of-care export |
| Charge capture | Safe but manual | Convert reviewed performed work into an explicit approve-to-invoice flow |
| Client communication | Good core, production SMS advisory | Close SMS readiness and prove reminder/opt-out delivery operations |
| Revenue cycle | Basic-to-moderate | Add reconciliation ledger, terminal, statements, deposits, and disputes |
| Inventory/pharmacy | Moderate | Validate lots/expiry/controlled-substance and purchasing workflows in real clinic use |
| Integrations | Early | Ship the narrow ONES contract; later add labs, eRx, distributor, and accounting integrations |
| Reporting | Basic-to-moderate | End-of-day financial close, production/doctor reporting, tax/fee exports |
| Migration | Thoughtful safeguards | Complete clinic-owned dry run, reconciliation, acceptance, rollback, and export proof |
| Reliability/recovery | Not launch-ready | Independent replica, successful backup evidence, and a timed restore drill |

AAHA says veterinary records should be clear, secure, thoroughly documented,
and usable by another veterinarian for continuity of care. Its security guidance
also calls out privacy for client, patient, and financial information:
<https://www.aaha.org/resources/aaha-standards/>,
<https://www.aaha.org/vcpr/>, and
<https://www.aaha.org/resources/2021-aaha-avma-telehealth-guidelines-for-small-animal-practice/security/>.
OpenVPM's tenant/RBAC/audit/correction design is aligned with that direction;
the unresolved recovery evidence is the largest mismatch.

## Security and regulated-industry baseline

Veterinary software should not be described as HIPAA-regulated merely because
it contains medical records; applicability depends on the data and business.
OpenVPM still holds sensitive client identity, communications, financial, and
veterinary-record data and must meet payment-card obligations, state privacy
and veterinary-record rules, contracts, and incident-notification duties.
State-specific counsel must review each launch jurisdiction.

Controls already present include tenant-scoped queries plus Postgres RLS,
role-based permissions, immutable clinical correction/event ledgers, signed
webhooks, checkout/idempotency checks, recovery holds, rate limits, security
headers, email suppression callbacks, and audit events for material financial
actions. `pnpm audit --prod` reported no known dependency vulnerabilities on
August 17, 2026.

Required security work before production clinics rely on OpenVPM:

- Add phishing-resistant MFA/passkeys for clinic admins and all privileged
  staff, plus step-up authentication for staff invites, refunds, exports, API
  keys, and other high-impact actions.
- The hardening tree now caps the encrypted JWT and clinic session at 12 hours
  instead of NextAuth's 30-day default. Add a shorter inactivity timeout,
  device/session inventory and revocation, password-reset/global revocation,
  and a clinic offboarding workflow before broad rollout.
- Remove production `unsafe-inline` script from CSP using per-request nonces or
  hashes, while retaining Stripe Checkout requirements.
- Keep all card entry on Stripe-hosted Checkout. OpenVPM must never log or store
  PAN/CVC. PCI SSC says outsourcing reduces scope but does not remove the
  merchant's annual validation and third-party responsibility obligations.
- Make independent backups/replication and restore evidence green; encrypt and
  classify all secrets; require least-privilege production database and Stripe
  credentials; and complete incident-response/tabletop exercises.
- Add continuous secret, dependency, SAST, and infrastructure scanning to CI,
  plus operational alerts for authentication anomalies, webhook failures,
  disabled payments/payouts, and unusual exports.

CISA's Secure by Design guidance emphasizes MFA by default and high-quality
logging. Stripe and PCI SSC recommend hosted payment collection to reduce card
data exposure while retaining shared-responsibility validation:
<https://www.cisa.gov/securebydesign>,
<https://docs.stripe.com/security/guide>,
<https://www.pcisecuritystandards.org/faqs/1588/>, and
<https://www.pcisecuritystandards.org/faqs/does-pci-dss-apply-to-merchants-who-outsource-all-payment-processing-operations-and-never-store-process-or-transmit-cardholder-data/>.

## Production evidence collected

Read-only checks were used against production; no live payment, refund,
subscription change, email, or database write was performed.

- Production UI loaded authenticated Settings, Billing, invoice detail, and new
  invoice workflows without browser console errors.
- Desktop and 390 px mobile passes covered sign-in, password recovery, invalid
  invite/reset URLs, invalid client portal URLs, Settings billing, and invoice
  detail.
- Settings showed Stripe configured, but card payments disabled and payouts
  pending.
- Billing correctly disabled Take Card and explained that the clinic must
  complete payment setup.
- The Stripe platform was reachable and had separate enabled webhook endpoints
  for platform Checkout, connected-account Checkout, and subscriptions.
- Public DNS exposes Resend/SES SPF and DKIM records for the
  `mail.openvpm.com` sending subdomain. No DMARC record was found for
  `openvpm.com` or `mail.openvpm.com`; publish and monitor DMARC before broad
  clinic sending.
- One connected account was observed; none were charge/payout ready.
- The production fee variable was absent.
- The public health endpoint reported healthy database/schema/RLS/core billing,
  but an unconfigured independent object replica and a hosted SMS advisory.
- Seven-day production logs contained repeated subscription attribution errors,
  primary backup-verification failures, and some file-replica heartbeat aborts.
- The backup failures have two distinct causes. One exported practice could not
  pass restore validation because soft-deleted users/locations referenced by
  retained financial, closeout, and audit rows were omitted; the hardening tree
  now retains every user/location needed by the restore rules and has 68 passing
  backup-export regression tests. Separately, primary object read-back is still
  failing for nearly every active practice even though the bucket-level health
  probe succeeds. Verify the production R2 token has Object Read and Write on
  the exact bucket and prove an exact write/read/checksum cycle before launch.
- Seven-day runtime evidence also showed a persistent SMS operations provider-
  event queue failure, occasional operations-alert aborts, and replica
  heartbeat timeouts. A production-configured read-only reproduction isolated
  the SMS failure: raw SQL received JavaScript `Date` objects that the hosted
  driver rejected before PostgreSQL execution. The hardening tree now sends ISO
  timestamps with explicit `timestamptz` casts; the exact provider-event query
  and the complete database-side SMS health computation both returned healthy
  against production after the change. Deployment and a clean monitoring
  window are still required; a green public health response alone is not
  sufficient.
- The connected Stripe tool in this workspace points at the existing Get Talky
  account and contains the two current OpenVPM trials. The dedicated
  OpenVPM-under-Get-Talky platform model is approved, but that account is not
  connected to this workspace and its live settings have not been read back.
  No Stripe mutations were attempted through the existing account.
- The production Vercel environment policy check failed: expected platform
  account pin, Accounts v2 webhook/feature gate, positive application fee,
  pinned subscription payment-method and Portal configurations, product tax
  code/registrations, and several required storage classifications are not in
  the required cutover state.
- Production Supabase security advisories were clean on August 18. The
  `openpims_app` role is login-capable but neither superuser nor `BYPASSRLS`.
  All tenant/data tables have RLS; the three public auth/session token tables
  without RLS grant no SELECT access to `anon`, `authenticated`, or `PUBLIC`.
  Three public `SECURITY DEFINER` functions exist, but none is executable by
  `PUBLIC`. Performance advisories reported 205 unindexed foreign keys, 88
  unused indexes, 32 multiple-permissive RLS-policy cases, one auth-policy
  init-plan case, and a fixed Auth connection allocation. These are P1
  scale/latency work rather than evidence of current cross-tenant exposure.
  See Supabase's [database advisor remediation](https://supabase.com/docs/guides/database/database-advisors)
  and [production checklist](https://supabase.com/docs/guides/deployment/going-into-prod).
  The project is healthy on Postgres 17 and the organization is on Pro, but the
  PITR setting still needs explicit read-back; database backups do not restore
  stored objects, so PITR does not replace the independent object replica.

Local verification of the current hardening tree:

- `pnpm test`: 401 files passed, 4,084 tests passed;
  three integration files/six tests were skipped because they require explicit
  database/provider drill configuration.
- `pnpm type-check`, `pnpm build`, schema drift, RLS isolation, production
  dependency audit, and open-source release verification: passed.
- `pnpm --filter @openpims/web lint`: passed with zero errors and 240 recorded
  legacy warnings.
- Fresh-clinic serial E2E: five passed and one skipped. Signup, verification,
  test subscription, annual-at-renewal, Accounts v2 onboarding launch,
  clinic-day clinical/invoice work, object storage, and tenant isolation
  passed. Client card payment/refund/payout remains blocked on Stripe's human
  connected-account verification.
- Versioned local replica backup, offline artifact verification, application
  restore dry run, and executed restore into a fresh database: passed; the
  restored clinic remained held for reconciliation as designed.

The full monetary E2E remains outstanding only at the real connected-account
boundary. The current fresh-clinic test now exercises the real Next.js workflow,
Stripe test Checkout, signed webhook forwarding, and Accounts v2 hosted
onboarding. Stripe's human verification must be completed in Sandbox before the
client charge, application-fee reconciliation, refund, and payout checks can
run.

## Launch gates

All P0 gates are release blockers.

### P0 — before any clinic handles real client money or depends on OpenVPM records

- [x] Confirm the OpenVPM fee is deducted from clinic proceeds.
- [x] Confirm the exact OpenVPM application fee: 0.25% / 25 basis points.
- [x] Confirm the dedicated OpenVPM Stripe platform account is owned by Get
  Talky Inc.; keep the two current trial subscriptions on the existing account
  until controlled renewal migration.
- [x] Replace permanent-portal invoice links with 30-day, invoice-scoped
  payment links in the hardening tree.
- [ ] Deploy and inbox-test the review/send/payment-only email workflow without
  sending clinical detail.
- [ ] Publish DMARC, confirm alignment with the Resend From domain, and verify
  SPF/DKIM/DMARC results in Gmail, Outlook, and clinic-domain message headers.
- [ ] Complete a clinic connected account and prove `card_payments` and payouts
  active.
- [ ] Install and verify the Accounts v2 event destination, secret, feature
  gate, and expected platform-account pin.
- [ ] Run a Stripe Sandbox lifecycle: new clinic → interrupted onboarding →
  resume → account update → online invoice → application fee → webhook replay →
  partial payment → partial refund → full refund.
  - Automated work through hosted onboarding now passes; charge/refund/payout
    remain blocked on Stripe's human verification.
- [ ] Run one explicitly authorized low-value production canary and reconcile
  the client receipt, invoice ledger, connected account, application fee,
  platform balance, and clinic payout.
- [ ] Rebind/repair subscription mappings and observe a clean webhook window.
- [x] Implement and unit-test the same-workspace monthly-to-annual change in
  the hardening tree; production deployment and Sandbox lifecycle proof remain
  covered by the deployment/Sandbox gates above.
- [ ] Restore independent file replication, make backup verification green, and
  complete a timed restore drill with clinic-owned acceptance evidence.
  - The isolated versioned-replica artifact and executed restore drill pass;
    production independence and clinic-owned acceptance remain open.
- [ ] Require phishing-resistant MFA for clinic admins/platform operators and
  step-up authentication for refunds, staff administration, exports, and API
  key changes; define session expiry and revocation behavior.
- [ ] Complete a scoped application-security review, tenant-isolation test,
  incident-response tabletop, and state-specific privacy/record-retention
  review for the first launch clinics.
- [ ] Keep nutrition/ONES claims out of sales/onboarding until the draft-review-
  approve loop is implemented and tested.

### P1 — before broad clinic rollout

- [ ] Require MFA for all clinic roles and add suspicious-login/session alerts.
- [ ] Replace production CSP `unsafe-inline` script handling with nonce/hash
  controls and keep automated dependency/secret/SAST scanning green.
- [ ] Add gross/fees/net/refund/dispute/payout reconciliation and an operator
  queue.
- [ ] Add alerts for Connect requirements, disabled charges/payouts, webhook
  drift, disputes, and payout failures.
- [ ] Decide and implement card-present collection or explicitly constrain the
  supported clinic profile.
- [ ] Add end-of-day close, tender reconciliation, statements, and accounting
  export.
- [ ] Complete hosted SMS readiness and clinic-specific communication drills.
- [ ] Run migration, role, signing/correction, prescribing, controlled
  substance, inventory, client-portal, and outage drills with actual clinic
  staff.

### P2 — product depth

- [ ] Appointment deposits, stored-card consent, payment plans, and wellness
  autopay.
- [ ] Lab, eRx, distributor, and accounting integrations.
- [ ] Deeper production/doctor/client retention and nutrition outcome reporting.

## Recommended rollout

1. Close recovery and Stripe production configuration without enabling new v2
   account creation.
2. Reconcile existing subscriptions and the existing connected account.
3. Run the full Stripe Sandbox matrix and automate it in CI with isolated test
   data.
4. Enable v2 for one internal clinic, then one design partner behind an explicit
   allowlist.
5. Require a daily billing/recovery review during the pilot and maintain a
   kill switch for new card checkouts while preserving manual payment entry.
6. Only broaden the pilot after two clean billing cycles, a successful restore
   drill, and signed clinic workflow acceptance.

## Changes made during this audit

The Settings billing tab now performs one automatic server refresh when Stripe
returns from connected-account onboarding. Previously, the clinic could land on
stale card/payout status until it manually found and clicked Refresh. A focused
test was added.

The client collection handoff now includes a 30-day, invoice-scoped payment
link in every manual invoice email. It does not create or reveal the permanent
client-portal token. The staff member reviews the recipient, sender identity,
reply destination, subject, balance, and due date before sending. The email is
clinic-branded through the verified OpenVPM sending domain, replies route to
the configured clinic email, content is HTML-escaped, and the send is recorded
in both communications and the attributed audit log.

The client payment page is deliberately separate from the broader portal. It
shows the current balance, clinic contact, 30-day expiry, a full-width mobile
payment action, and Stripe attribution before redirecting to hosted Checkout.
Payment credentials are HMAC-signed, purpose-separated, tamper-evident, scoped
to one invoice/client/practice, rate-limited, and excluded from client error
report paths.

Stripe setup now tells a clinic administrator which business, identity, and
bank details to have ready before leaving OpenVPM. Focused notification, email,
portal, billing, and Settings UI tests pass, and TypeScript passes.

Existing monthly subscribers can now schedule annual billing at renewal from
Plan & Billing. The clinic sees the annual total and explicit “no charge today”
language before confirming. The server verifies the configured Stripe platform
identity plus the subscription's customer/practice ownership, accepts only an
active or trialing OpenVPM monthly plan, rejects unrelated/custom schedules,
and uses idempotent Stripe Subscription Schedule operations. The current
monthly phase remains unchanged; the annual phase begins at renewal and its
location quantity stays synchronized with later clinic location changes.

Clinic JWT sessions are now explicitly capped at 12 hours (one long shift)
instead of inheriting NextAuth's 30-day default. MFA/passkeys, inactivity
expiry, device/session revocation, and privileged-action step-up remain launch
gates rather than being implied by this shorter lifetime.

The backup exporter now retains soft-deleted user and location parents for all
restorable rows that reference them, including payments, adjustments, visit
closeouts, procedures, prescriptions, files, communications, controlled-
substance events, and audit entries. This closes the restore-validation defect
observed in production, but does not close the separate production R2 read-back
or independent-replica gates.

The SMS operations monitor now serializes queue timestamps before they cross
the raw-SQL driver boundary. This closes the repeatedly observed
`sms_operations_provider_event_queue_failed` cause. The fix was verified with
the production configuration and read-only production data path; no provider
or messaging state was changed.

## 2026-08-18 Preview hardening evidence

This section supersedes earlier statements in this audit that describe MFA,
session revocation, privileged-action confirmation, or financial close as
entirely absent. It records deployed Preview evidence only; it does not approve
a Production promotion.

- Authenticator-app MFA is available to every clinic role. Seeds are encrypted
  with a dedicated AES-256-GCM key, recovery codes are one-way protected and
  single-use, and accepted TOTP counters cannot be replayed. The stable Preview
  flow advanced from a valid password to a clear MFA challenge, rejected a
  replayed code, and accepted the next fresh code.
- Password reset, invitation acceptance, MFA enrollment/change, and "sign out
  everywhere" increment the user's session version. Protected requests reject
  stale sessions, providing immediate server-side revocation independent of
  the 12-hour JWT maximum.
- Refunds, Connect account changes, staff access changes, bulk exports,
  credential/API-key changes, subscription changes, destructive demo actions,
  and account deletion require a separate current-password plus fresh-MFA
  confirmation. The proof is HttpOnly, SameSite Strict, bound to user,
  practice, and session version, expires after 10 minutes, and can be ended
  immediately. The deployed Preview UI passed confirmation and explicit
  revocation checks.
- This is strong TOTP MFA, not phishing-resistant passkey/WebAuthn support.
  Passkeys therefore remain an open hardening item where the launch standard
  requires phishing resistance.
- The stable Preview response uses per-response nonces for scripts and style
  elements; the nonce rotated across requests. HSTS, frame denial,
  `nosniff`, a restrictive permissions policy, and strict-origin referrer
  handling were present. Inline style attributes retain the narrowly scoped
  `style-src-attr 'unsafe-inline'` exception; scripts do not.
- The Stripe test connected account has card payments and payouts enabled. A
  hosted $108.00 test collection reconciled to $3.43 Stripe processing fee,
  $0.27 OpenVPM fee (25 basis points deducted from clinic proceeds), and
  $104.30 clinic net, with no unexplained amount. No live charge was created.
- End-of-day close, gross/Stripe-fee/OpenVPM-fee/net/payout reconciliation,
  refund/adjustment/void evidence, disputes, statements, and an operator close
  workflow now exist in the hardening tree and passed the automated suite.
  Stripe Terminal remains out of scope; the initial clinic offer must continue
  to say **online client payments only** until card-present collection is
  implemented and separately validated.
- Preview schema migrations through `0095` are applied. The deployed health
  gate confirms schema parity, RLS-safe database credentials, the dedicated
  MFA key, HTTPS application origins, test-mode Stripe identity, the 25-basis-
  point fee, automatic subscription tax, and reachable primary object storage.
- The full automated suite passed with 4,141 tests passing and 6 skipped across
  410 passing and 3 skipped files. TypeScript, build, whitespace validation,
  and open-source release verification also passed.

The Preview health gate intentionally remains failing. Independent attachment
replica coverage is 1/5 with a backlog of 4; a valid email provider/webhook
configuration, AI provider key, operations alert destination, and external
cron heartbeat destinations are absent. Supabase PITR is explicitly disabled,
and database backups do not recover Storage objects. These are real launch
gates, not test noise.

The dedicated MFA key is staged as a sensitive Production environment value,
but the current deployment does not use it. Production has not received
migrations `0091`-`0095` or this application release. Promote only after the
external gates are closed, Production configuration is re-read without
exposing secrets, migration-only preflight passes, and a named reviewer
approves the controlled release.
