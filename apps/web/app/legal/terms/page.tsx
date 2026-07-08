export const metadata = {
  title: "Terms of Service - OpenVPM",
};

export default function TermsPage() {
  return (
    <>
      <h1>Terms of Service</h1>
      <p>Last updated: July 7, 2026</p>

      <p>
        These terms cover OpenVPM Cloud, the hosted veterinary practice
        management service at app.openvpm.com. By creating an account or using
        the service, you agree to them. If you self-host the open-source
        edition of OpenVPM, these terms do not apply; your use is governed by
        the software license in the code repository.
      </p>

      <h2>What OpenVPM is</h2>
      <p>
        OpenVPM is practice management software for veterinary clinics. It
        stores your practice&apos;s records, helps you schedule and bill, and
        sends messages to your clients. OpenVPM is a tool for your team. It is
        not a veterinarian and it does not give medical advice. Your team is
        responsible for all clinical decisions and for meeting the
        record-keeping rules that apply to your practice.
      </p>

      <h2>Your account</h2>
      <ul>
        <li>You must give accurate information when you sign up.</li>
        <li>
          You are responsible for what happens under your practice&apos;s
          accounts. Keep passwords private and remove staff access when people
          leave.
        </li>
        <li>You must be authorized to act for the practice you register.</li>
      </ul>

      <h2>Your data belongs to you</h2>
      <p>
        Your practice&apos;s records are yours. You can export your full data
        at any time from Settings. If you close your account, you can take
        your data with you. We do not sell your data and we do not use your
        clients&apos; information for advertising.
      </p>

      <h2>Fees and trials</h2>
      <ul>
        <li>
          New practices get a free trial. We tell you the length and terms
          when you sign up. Trials that end without a subscription lose access
          to paid features, but you can still export your data.
        </li>
        <li>
          Paid plans are billed through Stripe at the prices shown when you
          subscribe, per active location, plus any usage charges we describe
          in the product.
        </li>
        <li>
          Payments your clients make to your practice go to your own Stripe
          account. OpenVPM may charge a small platform fee on those payments,
          shown in the product.
        </li>
      </ul>

      <h2>Acceptable use</h2>
      <ul>
        <li>Follow the laws that apply to you, including messaging-consent rules for texts and emails.</li>
        <li>Do not try to break, overload, or probe the service.</li>
        <li>Do not use the service to store or send unlawful content.</li>
      </ul>

      <h2>Messaging</h2>
      <p>
        OpenVPM sends texts and emails on your behalf. You are the sender: you
        must have consent from your clients, honor opt-outs, and follow rules
        like the TCPA. OpenVPM enforces opt-outs automatically and blocks
        sends to suppressed contacts, but responsibility for lawful messaging
        stays with your practice.
      </p>

      <h2>Availability and support</h2>
      <p>
        We work hard to keep OpenVPM available and back up hosted data
        regularly. Like any online service, we cannot promise zero downtime.
        We announce planned maintenance ahead of time when we can.
      </p>

      <h2>Ending service</h2>
      <p>
        You can cancel at any time. After cancellation or trial expiry, we
        keep your data available to export for at least 60 days, then we may
        delete it. We can suspend or end accounts that break these terms or
        do not pay, with notice when reasonable.
      </p>

      <h2>Disclaimers and liability</h2>
      <p>
        The service is provided &quot;as is.&quot; To the extent the law
        allows, OpenVPM is not liable for indirect damages, and our total
        liability for any claim is limited to the fees you paid us in the 12
        months before the claim. Nothing in these terms limits liability that
        cannot be limited by law.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms. If a change matters, we will tell you by
        email or in the product before it takes effect. Continuing to use the
        service after a change means you accept it.
      </p>

      <h2>Contact and governing law</h2>
      <p>
        Questions? Email hello@openvpm.com. These terms are governed by the
        laws of the State of Delaware, USA, without regard to conflict-of-law
        rules.
      </p>
    </>
  );
}
