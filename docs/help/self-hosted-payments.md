# Set up Stripe payments on a self-hosted clinic

This guide covers client invoice payments on your own OpenVPM installation. Cash, checks, and payments taken on an external terminal can be recorded without Stripe. It does not configure an OpenVPM Cloud subscription or a Stripe Connect platform.

## 1. Configure a test installation

Keep `HOSTED_BILLING_ENABLED` unset for the self-hosted edition. Set `NEXT_PUBLIC_APP_URL` to the application's public HTTPS origin, such as `https://clinic.example.com`. A local development server can use its localhost origin; Stripe must still be able to reach its webhook through a development forwarding session.

Set `STRIPE_SECRET_KEY` in your deployment's secret store or protected environment. Start with a test-mode credential from the clinic's Stripe account. Prefer a restricted key and validate its permissions through the entire workflow: Checkout Sessions, PaymentIntents (including capture and cancellation), Charges, and Refunds. A credential that can create Checkout but cannot capture a PaymentIntent is insufficient. Never commit the key or put it in a `NEXT_PUBLIC_` variable.

Self-hosted payments go directly to the Stripe account associated with this key. The current self-hosted runtime does not enforce test versus live mode for you: verify the account and mode in Stripe before every environment change. Stripe Connect secrets, subscription price IDs, and subscription webhook secrets are not needed for this path. Restart the application after changing credentials.

See Stripe's [API key documentation](https://docs.stripe.com/keys) for test/live separation and restricted keys.

## 2. Connect the invoice webhook

Create a Stripe event destination for **your account**, with the endpoint `https://clinic.example.com/api/webhooks/stripe` and event **checkout.session.completed**. Use the account and mode that match the API credential. Copy this endpoint's signing secret into `STRIPE_WEBHOOK_SECRET`, then restart the app. The current code uses Stripe API version `2026-07-29.dahlia`.

For local development, authenticate the Stripe CLI against the intended test account and run:

```sh
stripe listen --events checkout.session.completed --forward-to localhost:3000/api/webhooks/stripe
```

Use the signing secret printed by that listener for the local app only. A CLI listener and a deployed endpoint have different secrets. A generic generated Stripe test event does not contain a real OpenVPM invoice ID; create a checkout from an actual test invoice to verify the full integration.

The route validates Stripe signatures. Keep this endpoint reachable without an interactive login, and preserve the request body through your reverse proxy. Follow Stripe's [webhook setup documentation](https://docs.stripe.com/webhooks).

## 3. Run the whole invoice flow

Sign in as a clinic admin or front desk user. Create a test client and invoice, review the charges, and send the invoice so it is collectible. Visit-linked invoices also require charge reconciliation before collection. Open the invoice in Billing and choose **Take Card**. Finish Checkout using Stripe's test payment details.

OpenVPM first authorizes the payment. Its webhook rechecks the current invoice balance, captures the permitted amount, and records the payment. The browser's success page alone is not proof that this completed. Verify a successful webhook delivery in Stripe, a captured payment, and exactly one payment in OpenVPM with the correct invoice balance.

Also test cancellation, a declined card, and replaying the same completed event from Stripe. Cancellation and declines must not mark the invoice paid; replay must not create a duplicate payment. Test the client portal separately. To email payment links, outbound email must also be configured.

## 4. Check partial payments and refunds

**Record Payment** can record a partial amount received by cash, check, or another external tender. It does not itself charge a card. After recording a partial payment, **Take Card** requests the remaining balance; this checkout does not offer an arbitrary partial-card amount selector. Verify the recorded payment and remaining balance before charging again.

Use the invoice's refund action as an admin to refund a Stripe payment, including a partial refund where appropriate. Provide a reason, then confirm both the Stripe refund and OpenVPM history. The current refund action allows one refund record per original payment, so it does not support several successive partial refunds against the same payment. A credit or write-off adjusts the invoice; it does not return money through Stripe.

This self-hosted invoice webhook processes checkout completion, not general Stripe Dashboard refund or dispute synchronization. Initiate routine refunds in OpenVPM. If someone refunds directly in Stripe, investigate and reconcile the records before further collection; do not issue a second refund to make the screens match.

## 5. Enable live collection

After the test cases pass, activate the clinic's Stripe account and confirm payout details there. Replace the test API credential and webhook signing secret with the matching live-account values, create the live endpoint at the production URL, and restart the app. Keep the test environment separate. Verify one authorized live payment and its invoice record before relying on the integration throughout the clinic day.

If Checkout opens but payment remains unrecorded, inspect the completed event's delivery attempt, app logs, signing secret, and capture permissions. An authorization can exist while capture is still pending. Do not mark it paid manually or retry a new charge until the Stripe status is understood.

## Related guides

- [Self-hosted SMS](self-hosted-sms.md)
- [A solo veterinarian's workflow](solo-vet-workflow.md)
