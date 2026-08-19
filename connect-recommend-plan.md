# OpenVPM Stripe Connect recommendation

Status: the 0.25% OpenVPM application fee is approved. Get Talky Inc. is the
temporary platform account so clinic testing is not blocked. A later move to a
dedicated OpenVPM account remains a controlled cutover; it must not move or
recreate the two current trial subscriptions without a separate migration.

## Confirmed operating model

| Decision | OpenVPM configuration |
| --- | --- |
| Platform type | SaaS platform for veterinary clinics |
| Connected merchant | The clinic |
| Charge pattern | Direct charges on the clinic's connected account |
| Client statement/receipt merchant | The clinic |
| OpenVPM revenue | Application fee deducted from clinic proceeds |
| Stripe processing fees | Paid by the clinic |
| Negative-balance liability | Stripe |
| Connected-account Dashboard | Full Stripe Dashboard |
| Onboarding and requirements | Stripe-hosted onboarding; OpenVPM shows status and routes the clinic back to Stripe |
| Account model | Accounts v2 merchant configuration |
| Platform account | Get Talky Inc. temporarily; OpenVPM-specific prices, portal, webhooks, and account pinning |
| Existing trial subscriptions | Remain unchanged on Get Talky until a controlled renewal migration |

The pet owner pays the OpenVPM invoice total. OpenVPM does not add its platform
fee to that total. Stripe settles the direct charge in the clinic account,
deducts Stripe processing fees, and transfers OpenVPM's configured application
fee to the platform. The implementation creates Checkout using the connected
clinic account as the Stripe request context; it does not use a platform-owned
destination charge that would make OpenVPM absorb the clinic's processing fee.

## Product experience

1. A clinic administrator opens **Settings → Plan & Billing**.
2. OpenVPM discloses the application-fee percentage as a deduction from clinic
   proceeds before setup.
3. The administrator starts Stripe-hosted onboarding.
4. Stripe collects business, representative, bank, and compliance information.
5. On return, OpenVPM refreshes the account automatically and enables payments
   only when both card payments and payouts are active.
6. Staff can take a card payment from an invoice, or a pet owner can pay the
   same invoice in the client portal.
7. Checkout is created directly on the clinic's connected account with an
   OpenVPM application fee.
8. OpenVPM manually captures only the invoice's still-valid balance. Before
   capture, it verifies that the connected PaymentIntent contains the exact
   application fee written into the signed Checkout metadata.
9. The signed, idempotent Connect webhook records the payment, closes the
   invoice when appropriate, sends the receipt, and updates the visit closeout.
10. Refunds are issued on the connected account and refund the proportional
    OpenVPM application fee.

## Fail-closed readiness rules

Hosted client card payments remain disabled when any of these is true:

- the platform Stripe credential is absent or belongs to the wrong account;
- the application fee is absent, fractional, zero, negative, or 100% or more;
- the clinic has not completed Connect onboarding;
- card-payment capability or payouts are not active;
- the Checkout event cannot be attributed to the expected clinic and invoice;
- the PaymentIntent lacks the expected application fee;
- the invoice is a draft, estimate, void, paid, overpaid, or no longer matches
  the visit closeout;
- the clinic is under a recovery hold; or
- Stripe returns an unsafe redirect URL.

## Stripe and deployment configuration

Required production variables:

```text
STRIPE_SECRET_KEY
STRIPE_EXPECTED_ACCOUNT_ID
STRIPE_WEBHOOK_SECRET
STRIPE_CONNECT_WEBHOOK_SECRET
STRIPE_CONNECT_V2_WEBHOOK_SECRET
STRIPE_CONNECT_V2_ENABLED=true
STRIPE_CONNECT_APPLICATION_FEE_BPS=25
```

`STRIPE_CONNECT_APPLICATION_FEE_BPS` is stored as plain, verifiable deployment
configuration. Stripe credentials and webhook signing secrets are stored as
sensitive values. The production readiness endpoint and Vercel environment
policy both reject a missing or malformed fee.

Connect event destinations:

- `/api/webhooks/stripe-connect` receives connected-account
  `checkout.session.completed` snapshot events.
- `/api/webhooks/stripe-connect-v2` receives Accounts v2 thin events for
  account, requirements, and merchant-capability changes.

## Production cutover checklist

- [x] Confirm the exact application fee: 25 basis points (0.25%).
- [x] Use Get Talky Inc. temporarily and leave the two existing trials
  unchanged until a controlled renewal migration.
- [ ] Confirm clinic-facing commercial terms and support/refund policy for the
  selected rate.
- [ ] Deploy the hardened code before enabling client card payments.
- [ ] Store all Stripe credentials and signing secrets as sensitive production
  environment variables.
- [ ] Create and verify both Connect event destinations.
- [ ] Complete one test-mode lifecycle: onboarding, direct charge, application
  fee, partial capture, webhook replay, refund, payout, and requirement change.
- [ ] Complete one controlled live clinic canary and reconcile the charge,
  Stripe fee, OpenVPM application fee, clinic net, refund behavior, and payout.
- [ ] Keep client card payments disabled until every launch gate passes.

## Subscription cadence decision

Monthly-to-annual changes take effect at the next renewal with no immediate
charge or proration. The hardening tree implements this using a verified,
idempotent Stripe Subscription Schedule while preserving the same OpenVPM
workspace and clinic data.
