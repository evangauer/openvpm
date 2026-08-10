export const metadata = {
  title: "Privacy Policy - OpenVPM",
};

export default function PrivacyPage() {
  return (
    <>
      <h1>Privacy Policy</h1>
      <p>Last updated: August 9, 2026</p>

      <p>
        This policy explains what OpenVPM Cloud collects, why, and the choices
        you have. In short: your practice&apos;s data belongs to your
        practice. We use it to run the service, not to sell or advertise.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Account data:</strong> names, emails, and roles for your
          staff accounts, plus your practice&apos;s name and settings.
        </li>
        <li>
          <strong>Practice records:</strong> the clients, patients,
          appointments, medical records, messages, and invoices your team
          enters. We process this data on your behalf; your practice controls
          it.
        </li>
        <li>
          <strong>Billing data:</strong> subscription status and usage counts.
          Card details go directly to Stripe; we never see full card numbers.
        </li>
        <li>
          <strong>Service logs:</strong> technical logs and error reports that
          help us keep the service reliable and secure.
        </li>
        <li>
          <strong>Email preference data:</strong> a keyed recipient identifier,
          optional-email choices, and delivery and audit events used to honor
          opt-outs without placing the raw address in the global preference
          ledger.
        </li>
        <li>
          <strong>Optional analytics:</strong> only if you choose &quot;Allow
          Analytics&quot; in the cookie banner. Essential cookies for secure
          sign-in are always on; advertising cookies are never used.
        </li>
      </ul>

      <h2>How we use data</h2>
      <ul>
        <li>To provide, secure, and improve the service.</li>
        <li>
          To send messages you ask us to send (appointment reminders, client
          messages, receipts) and account emails.
        </li>
        <li>
          To power optional AI features. AI requests are processed by our AI
          provider to answer the request; we do not let providers train their
          models on your practice data.
        </li>
        <li>We do not sell personal data. We do not run ads.</li>
      </ul>

      <h2>Who helps us run the service</h2>
      <p>
        We use a small set of service providers to operate OpenVPM: cloud
        hosting and databases, file storage, Stripe for payments, an email
        delivery provider, an SMS carrier, and an AI provider for the
        assistant. Each processes data only to provide their service to us.
      </p>

      <h2>Retention and deletion</h2>
      <ul>
        <li>
          Practice records stay as long as your account is active. Your
          practice controls its own retention duties for medical records.
        </li>
        <li>
          You can export everything at any time from Settings, and an admin
          can request account deletion in the product. After closure we keep
          data exportable for at least 60 days, then delete it from live
          systems and let backups age out.
        </li>
        <li>
          We retain email opt-out and delivery evidence as needed to keep
          honoring recipient choices and prevent unwanted email.
        </li>
      </ul>

      <h2>Security</h2>
      <p>
        Data is encrypted in transit, access is role-based, every practice is
        isolated at the database layer with row-level security, and hosted
        data is backed up regularly. No system is perfectly secure, but we
        treat your records like the medical data they are. If a breach ever
        affects your data, we will notify you as the law requires.
      </p>

      <h2>Your choices</h2>
      <ul>
        <li>Export your data at any time.</li>
        <li>Request deletion of your account and data.</li>
        <li>
          Turn optional OpenVPM product, trial, research, and feedback email off
          from any such email or from Practice Info in Settings. This choice
          does not apply to required security, billing, and service notices.
        </li>
        <li>Change the analytics cookie choice from the cookie preferences link.</li>
        <li>
          Pet owners: your vet&apos;s practice controls your records. Contact
          the practice for questions, corrections, or deletion.
        </li>
      </ul>

      <h2>Changes and contact</h2>
      <p>
        If we change this policy in a way that matters, we will tell you by
        email or in the product first. Questions or requests:
        hello@openvpm.com.
      </p>
    </>
  );
}
