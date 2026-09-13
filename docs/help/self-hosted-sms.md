# Set up SMS on a self-hosted clinic

OpenVPM has Telnyx and Twilio transports, signed inbound callbacks, delivery history, and client opt-out handling. Provider credentials alone do not activate texting for a clinic location. This guide explains the supported setup and its current boundaries so an operator can assess it before paying for numbers.

## 1. Check whether the setup fits your clinic

The built-in number purchase and carrier-registration workflow is for **Telnyx US local SMS numbers**. Existing-number text hosting is not currently enabled. The Twilio adapter can send and process callbacks, but there is no complete Twilio location-onboarding wizard. International and existing-number setups require additional implementation and validation; setting a global sender number is not a substitute.

The supported Telnyx path requires both a clinic administrator and the installation operator. The operator uses the platform administration console for carrier submission and activation. On a self-hosted installation, configure `PLATFORM_ADMIN_EMAILS` with the intended operator's sign-in email; this grants sensitive installation-wide access and is separate from the clinic admin role.

Provider number orders and carrier submissions may incur charges. Keep provisioning off until the provider account, country, consent wording, and expected charges have been reviewed.

## 2. Configure the installation

Keep `HOSTED_BILLING_ENABLED` unset for self-hosting. Set `NEXT_PUBLIC_APP_URL` to the public HTTPS origin used for callbacks. Store provider secrets in the deployment's secret store or protected environment, never source control.

For Telnyx, configure:

- `MESSAGING_PROVIDER=telnyx` to select Telnyx explicitly.
- `TELNYX_API_KEY` for provider API calls.
- `TELNYX_PUBLIC_KEY` for verifying signed callbacks.
- `MESSAGING_REGISTERED_DISPLAY_NAME` with the exact clinic identity approved for the active carrier campaign.
- `MESSAGING_REGISTRATION_ENCRYPTION_KEY` with a durable base64-encoded 32-byte key; generate it once with `openssl rand -base64 32`. Back it up securely because stored registration details depend on it.
- `MESSAGING_PROVISIONING_ENABLED=true` only when ready to authorize the number/carrier setup operations.

Restart after changing configuration. `MESSAGING_SENDING_ENABLED`, the sending allowlists, and `MESSAGING_INBOUND_ENABLED` are hosted rollout gates; they do not replace self-hosted location activation. Demo mode (`NEXT_PUBLIC_DEMO_MODE=true`) prevents actual sends.

`TELNYX_MESSAGING_PROFILE_ID` and `TELNYX_FROM_NUMBER` are global fallbacks for sends without a location. Normal clinic sends require a persisted, active, enabled sender belonging to the selected practice and location. OpenVPM deliberately does not fall back to a different location's number.

## 3. Provision and activate a Telnyx location

As a clinic admin, open **Settings → Messaging**, choose the location, and use the new-number setup. Review the quoted costs before ordering. The number starts with sending disabled. Complete the clinic's carrier registration form with its legal details and consent information.

As the installation operator, open **Admin** and review the messaging registration queue. Use **Submit brand**, then **Submit campaign** when the brand is ready. Refresh/reconcile provider status as the provider processes the registration. Carrier approval is external and is not completed merely by saving the form.

When approved, use **Assign numbers**, **Inspect profile**, and **Enable provider profile** as the console allows. Resolve reported configuration issues, then refresh registration readiness. In **Settings → Messaging**, enable sending only after the location shows an active registration. Do not force a database status to bypass provider readiness.

Configure the Telnyx messaging profile's webhook URL as `https://clinic.example.com/api/webhooks/telnyx` for incoming messages and delivery events. The setup code configures this URL when provisioning; verify it in Telnyx, especially after changing the app's domain. The endpoint validates the Telnyx signature and timestamp against `TELNYX_PUBLIC_KEY`.

## 4. If you already operate Twilio

The adapter uses `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`. For development or non-location sends it uses `TWILIO_MESSAGING_SERVICE_SID`, or `TWILIO_PHONE_NUMBER` when no service is supplied. Explicitly select `MESSAGING_PROVIDER=twilio` if both providers are configured.

Set the number or Messaging Service incoming-message webhook to `https://clinic.example.com/api/webhooks/twilio` using POST. Outbound sends attach a status callback to that same route automatically. Its signature validation uses the Twilio auth token and the request/canonical app URL, so a mismatched public origin can cause rejection.

A normal clinic workflow still needs a correctly scoped active Twilio location sender. The current UI does not provide that end-to-end setup. Treat this as an implementation requirement before adopting Twilio for production; do not assume the four environment values finish onboarding.

## 5. Verify sending, replies, and consent

Start with your own consenting staff number and synthetic client data. Use the self-hosted test-send action for the active location, then verify provider delivery. Provider acceptance and delivery are distinct states.

Next, record consent for a test client's current phone number and send through a normal client workflow. Reply from that phone and confirm the message appears against the correct client. Send STOP, confirm consent is revoked/sending suppressed, and verify the app will not send another routine message. Test the supported opt-in path before resuming. Keep the provider's own keyword configuration consistent with the clinic's consent process.

Use distinct numbers per location and test the correct location explicitly. Incoming messages with missing or ambiguous ownership must be investigated rather than attached to an arbitrary client. If a send has an unknown outcome, inspect provider history and the operational recovery queue before sending again; retries can otherwise duplicate a message that reached the recipient.

A complete acceptance check includes a received message, delivery status, a correctly routed reply, and a working opt-out. A successful test-send notification alone is insufficient.

## Related guides

- [Self-hosted Stripe payments](self-hosted-payments.md)
- [A solo veterinarian's workflow](solo-vet-workflow.md)
- [SMS concurrency and recovery drill](../sms-concurrency-drill.md)
