# OpenVPM revenue sweep — 27 July 2026

## Objective

Create three guided first-value moments and convert at least one real practice to paid within 14 days. The immediate base target is $79 in new MRR; the stretch target is the $299/month OreVet pilot without discounting either offer.

The constraint is not awareness. The latest funnel is 27 signups → 8 setup starts → 5 setup completions → 0 measured activations → 0 measured subscriptions. We are asking prospects to complete a generic PIMS setup before OpenVPM has earned a place in their practice.

## The operating decision

Sell a small outcome, not a migration.

The default buying path is:

1. Choose one gap in the current workflow.
2. See that workflow on a 20-minute founder-led call, including on iPad when relevant.
3. Bring only the first five real records needed for the workflow.
4. Reach a practice-specific first win with Evan.
5. Continue on the $79/location/month founding Cloud plan only if the workflow earns its place.

Self-hosting remains complete and free. Cloud is the paid convenience and support path, not a more capable edition.

## Revenue queue

### Founder conversations

| Priority | Practice | Signal | Next action | Commercial path |
|---|---|---|---|---|
| 1 | Hayley Grove, DVM | Unsolicited inbound with detailed questions about Rhapsody, iPad, controlled drugs, labs, Vetcove, and AI scribing | Answer now and offer a 20-minute iPad walkthrough around one Rhapsody-adjacent workflow | $79 founding Cloud membership |
| 2 | Dr. Jayne’s Veterinary Van | Loves OpenVPM, wants to leave Shepherd, and asked for the medical-history import that is now built | Offer to import the first five Shepherd records together and ask directly whether $79 works after the first win | $79 founding Cloud membership |
| 3 | OreVet / Francisco | Detailed workflow, pricing, and demo interest; follow-up already sent 27 July | Do not send again this week. If silent, make one concrete pilot-close request on 3 August | $299/month combined pilot, no setup fee |
| 4 | KattDoktorn Andrea AB | Strong mobile/feline and custom-integration fit | Correct the earlier SEK timing, state that Cloud is not yet represented as GDPR-ready, and request the top three Zoho workflows for a fictional-data design exercise | EU design partner; no production revenue promise yet |
| 5 | SPSF Community Vet Van | Direct Australia pricing inquiry | State $79 USD/location/month and ask whether currency or total budget is the concern | $79 founding Cloud membership |

### Cohorts

Send personal founder mail in batches no larger than five. Do not run an automated blast.

- Setup complete, no first value: offer to configure one workflow and import the first five records together.
- Setup started, then stopped: ask the single question “What got in the way?” and offer to remove it personally.
- Qualified signup, no setup: reframe the trial as one gap beside the current PIMS.
- Open-source contributors: invite roadmap and contribution activity; do not sell Cloud to people who explicitly chose self-hosting.
- Test accounts: exclude from every conversion calculation and outreach list.

## Activation must reflect intent

Capture one onboarding intent: `secondary`, `replace`, `explore`, or `self_host`. “Run alongside my current PIMS” should be the recommended default.

The existing definition—one real client plus one real appointment—is a useful signal for a replacement buyer but the wrong universal definition.

| Intent | First-value event | Follow-up offer |
|---|---|---|
| Secondary | Import at least five real clients/patients or complete one real workflow using non-demo data | Configure the next adjacent workflow |
| Replace | Create a real client and appointment, then complete either a medical note or invoice | Migration/import planning session |
| Explore | Complete one guided demo workflow and select the gap worth testing with real data | Founder-assisted five-record pilot |
| Self-host | Complete deployment health check and create the first admin practice | Configuration review or paid hosting fallback |

Report both intent-specific first value and the existing strict clinical activation metric. Never combine demo/test practices with prospects.

## Product work that directly supports revenue

### Ship first

1. Intent-led onboarding and pathway-specific next step.
2. Public booking after the logged-out route and global-slug/RLS blockers are fixed and tested.
3. A founder-visible list of real practices that have not reached their intent-specific first value.
4. Source attribution from marketing CTA through signup and first value.

### Release gate for public booking

Before PR #92 can merge:

- `/book/<slug>` works logged out while `/bookish` stays protected.
- Slug availability is global despite tenant RLS, and unique conflicts return a friendly message.
- Concurrent requests cannot create two appointments in the same slot, or the residual risk is explicitly held from release.
- Existing-client matching and pre-commit webhooks have an agreed security/reliability policy.
- Migration, RLS re-application, hosted billing, and self-hosted behavior are exercised in that order.

### Do not build yet

- No generic Rhapsody, Vetcove, or Zoetis connector without confirmed vendor access and a named design practice.
- No promise of ambient exam-room transcription; the current product accepts notes or transcripts and can draft SOAP records.
- No broad fork merge. Re-spec the fork’s best ideas—SOAP finalization/addenda, receiving, and mobile workflow—against current RLS and tests.
- No Secureframe purchase as a substitute for the legal, hosting, security, and operational work required for GDPR readiness.

## Sales truth standard

Use only these claims until the product changes:

- OpenVPM can operate as a primary PIMS and can also be used for selected workflows beside another PIMS.
- Client and patient CSV import works today.
- The external REST API supports selected client, patient, appointment, SOAP-note, and agent workflows; it is not a 150-endpoint third-party surface.
- Ongoing sync depends on usable API, webhook, or export access from the incumbent vendor and requires integration work.
- The browser UI is responsive and well suited to iPad for normal clinical and operational work; laptops provide more room for dense setup and reporting.
- The controlled-substance ledger has patient linkage, transaction types, lot tracking, waste-witness fields, running balances, users, and timestamps. Clinics must validate their jurisdiction and procedures.
- The built-in AI agent is text/transcript driven and approval gated; it is not currently a native ambient recorder.
- Founding Cloud membership is $79 per location per month with unlimited staff, managed hosting, backups, updates, and the published AI/SMS allowance.

## Content and conversion work

1. Make the homepage promise match the buyable path: one gap, one workflow, five records, then expand.
2. Track each trial CTA by placement and carry the source into signup.
3. Remove claims of an automatic live mirror, 150+ public REST endpoints, generic “AI scribe integration,” and unconditional DEA compliance.
4. Publish one proof-oriented page or short demo for each current wedge:
   - iPad-ready second-PIMS workflow
   - controlled-substance ledger
   - transcript-to-SOAP with explicit approval
   - public client booking after release
5. Replace passive lifecycle emails with a direct reply prompt: “What single task did you hope OpenVPM would make easier?”

## Daily CEO scorecard

Review this once each workday:

- Qualified practices contacted personally
- Replies and booked walkthroughs
- Walkthroughs completed
- Five-record pilots started
- Intent-specific first-value events
- Practices asked to pay
- New paid practices and MRR
- Top three objections, verbatim
- Product work started because of a named live opportunity

The weekly review should answer one question: which current workflow most reliably moves a real practice from curiosity to a $79 decision? Put engineering and content behind that workflow until the answer changes.
