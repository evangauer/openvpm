import { WEBHOOK_EVENT_DEFINITIONS } from "@/lib/webhook-events";

export default function AIIntegrationDocs() {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-4xl px-6 py-16">
        {/* Header */}
        <div className="mb-12">
          <p className="mb-2 text-sm font-semibold uppercase tracking-wider text-teal-600">
            Developer Documentation
          </p>
          <h1 className="mb-4 text-4xl font-bold text-gray-900">
            AI Integration Guide
          </h1>
          <p className="text-lg text-gray-600">
            Connect AI tools to OpenVPM for automated clinical workflows,
            intelligent queries, and real-time event processing.
          </p>
        </div>

        {/* Overview */}
        <Section id="overview" title="Overview">
          <p className="mb-4 text-gray-700">
            OpenVPM is designed to be <strong>AI-first</strong>. Every clinical
            action &mdash; creating SOAP notes, querying patient records,
            tracking vaccinations &mdash; is available via a structured API. This
            means AI scribes, voice agents, and dashboard assistants can
            integrate directly with your practice management system.
          </p>
          <p className="text-gray-700">
            Dashboard workflows use <strong>tRPC</strong> over HTTP with the
            signed-in user&apos;s session. External integrations can use API keys
            for <strong>/api/v1</strong> endpoints, including the agent endpoint
            with the <strong>agent:run</strong> scope. Write-enabled agent runs
            also require <strong>agent:write</strong> plus each write
            tool&apos;s underlying resource scope. All requests are scoped to the
            authenticated practice; clinical record writes such as SOAP note
            creation require <strong>records:write</strong>.
          </p>
        </Section>

        {/* API Key Agent Endpoint */}
        <Section id="api-key-agent" title="API Key Agent Endpoint">
          <p className="mb-4 text-gray-700">
            For server-to-server automations, create an API key in Settings with
            the <strong>agent:run</strong> scope and call the REST agent
            endpoint. Use <code>allow_writes: false</code> for read-only
            summaries. To set <code>allow_writes: true</code>, grant
            <strong>agent:write</strong> as well as the resource scopes the
            trusted workflow may mutate, such as
            <strong>appointments:write</strong> or
            <strong>records:write</strong>.
          </p>

          <CodeBlock>
            {`curl -X POST https://your-practice.openvpm.com/api/v1/agent \\
  -H "Authorization: Bearer ovpm_<key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "instruction": "Summarize today's checked-in appointments and flag overdue vaccines.",
    "allow_writes": false
  }'`}
          </CodeBlock>
        </Section>

        {/* SOAP Note Integration */}
        <Section id="soap-notes" title="SOAP Note Integration">
          <p className="mb-4 text-gray-700">
            Connect an AI scribe &mdash; such as <strong>Scribenote</strong>,{" "}
            <strong>VetRec</strong>, or <strong>HappyDoc</strong> &mdash; to
            automatically populate SOAP notes during an active visit. This
            endpoint creates an immediately finalized, immutable clinical
            record; use it only after the clinician has reviewed the generated
            content.
          </p>

          <h3 className="mb-2 mt-6 text-sm font-semibold uppercase tracking-wider text-gray-500">
            Endpoint
          </h3>
          <CodeBlock>
            {`POST /api/v1/soap-notes

Authorization: Bearer ovpm_<key>
Content-Type: application/json`}
          </CodeBlock>

          <h3 className="mb-2 mt-6 text-sm font-semibold uppercase tracking-wider text-gray-500">
            Input Schema
          </h3>
          <CodeBlock>
            {`{
  "patient_id": "uuid",          // Required - the patient record
  "appointment_id": "uuid",      // Required - active in-exam appointment
  "author_id": "uuid",           // Optional if appointment has a doctor
  "subjective": "string",        // Patient history, owner complaints
  "objective": "string",         // Physical exam findings, vitals
  "assessment": "string",        // Diagnosis, differential list
  "plan": "string",              // Treatment plan, follow-up
  "source": "string"             // Required - e.g. "scribenote", "vetrec"
}`}
          </CodeBlock>
          <p className="mt-3 text-sm text-gray-500">
            Create the key with the <strong>records:write</strong> scope.
            OpenVPM validates the patient, active in-exam appointment, and
            author against the authenticated practice. A saved draft or
            effective finalized SOAP note for the encounter returns a conflict
            so an integration cannot silently replace clinical documentation.
          </p>

          <h3 className="mb-2 mt-6 text-sm font-semibold uppercase tracking-wider text-gray-500">
            Example (cURL)
          </h3>
          <CodeBlock>
            {`curl -X POST https://your-practice.openvpm.com/api/v1/soap-notes \\
  -H "Authorization: Bearer ovpm_<key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "patient_id": "a1b2c3d4-...",
    "appointment_id": "b2c3d4e5-...",
    "subjective": "Owner reports decreased appetite x3 days...",
    "objective": "T: 101.5F, HR: 120, RR: 24. Mild dehydration...",
    "assessment": "Suspect early-stage renal disease...",
    "plan": "CBC/Chem panel, urinalysis. Recheck in 2 weeks.",
    "source": "scribenote"
  }'`}
          </CodeBlock>
        </Section>

        {/* Dashboard Query Helpers */}
        <Section id="dashboard-query-helpers" title="Dashboard Query Helpers">
          <p className="mb-6 text-gray-700">
            Signed-in dashboard experiences can use these tRPC procedures for
            actionable clinical insights. They require a session cookie and are
            not API-key REST endpoints; server-to-server integrations should use
            the <strong>/api/v1</strong> REST surface and signed webhooks.
          </p>

          <QueryCard
            name="Overdue Vaccinations"
            endpoint="tRPC: ai.patientsOverdueVaccinations (session cookie)"
            description="Returns patients whose vaccinations are past due. Useful for automated reminder campaigns or AI-powered outreach."
            response={`[
  {
    "patientId": "uuid",
    "patientName": "Bella",
    "species": "canine",
    "clientName": "Jane Smith",
    "vaccineName": "Rabies",
    "nextDueDate": "2025-11-15",
    "daysOverdue": 42
  }
]`}
          />

          <QueryCard
            name="Patients Needing Follow-Up"
            endpoint="tRPC: ai.patientsNeedingFollowUp (session cookie)"
            description="Identifies patients seen in the last 7 days (checked out) who do not have a future appointment scheduled. Ideal for proactive care workflows."
            response={`[
  {
    "appointmentId": "uuid",
    "patientId": "uuid",
    "patientName": "Max",
    "species": "feline",
    "clientName": "John Doe",
    "lastVisit": "2026-03-14T15:30:00Z"
  }
]`}
          />

          <QueryCard
            name="Daily Practice Summary"
            endpoint="tRPC: ai.dailySummary (session cookie)"
            description="Returns an aggregate view of today's practice activity. Perfect for AI dashboard widgets, morning briefings, or end-of-day reports."
            response={`{
  "date": "2026-03-17",
  "appointments": {
    "total": 24,
    "byStatus": {
      "scheduled": 5,
      "checked_in": 3,
      "in_exam": 2,
      "checked_out": 12,
      "no_show": 1,
      "cancelled": 1
    }
  },
  "patientsSeen": 14,
  "soapNotesCreated": 11,
  "invoicesPaid": 8
}`}
          />
        </Section>

        {/* Webhook Events */}
        <Section id="webhooks" title="Webhook Events">
          <p className="mb-4 text-gray-700">
            Subscribe to real-time events for reactive AI workflows. When
            something happens in OpenVPM, your AI system gets notified
            instantly.
          </p>

          <div className="mb-6 rounded-lg border border-gray-200 bg-white p-6">
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-500">
              Available Events
            </h3>
            <div className="space-y-3">
              {WEBHOOK_EVENT_DEFINITIONS.map((definition) => (
                <EventRow
                  key={definition.event}
                  event={definition.event}
                  description={definition.description}
                />
              ))}
            </div>
          </div>

          <CodeBlock>
            {`// Webhook payload format
{
  "event": "appointment.created",
  "timestamp": "2026-03-17T09:15:00Z",
  "data": {
    "appointmentId": "uuid",
    "patientId": "uuid",
    "patientName": "Bella",
    "clientId": "uuid",
    "source": "dashboard"
  }
}`}
          </CodeBlock>

          <p className="mt-4 text-sm text-gray-500">
            Admins can create webhook subscriptions in Settings or through the
            <code>webhooks.create</code> API. The signing secret is returned once
            at creation time.
          </p>
        </Section>

        {/* Footer */}
        <div className="mt-16 border-t border-gray-200 pt-8 text-center text-sm text-gray-500">
          <p>
            OpenVPM AI Integration API &mdash; Built for the next generation of
            veterinary care.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Reusable components                                                 */
/* ------------------------------------------------------------------ */

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mb-12">
      <h2 className="mb-4 text-2xl font-bold text-gray-900">{title}</h2>
      {children}
    </section>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-gray-200 bg-gray-900 p-4 text-sm leading-relaxed text-gray-100">
      <code>{children}</code>
    </pre>
  );
}

function QueryCard({
  name,
  endpoint,
  description,
  response,
}: {
  name: string;
  endpoint: string;
  description: string;
  response: string;
}) {
  return (
    <div className="mb-6 rounded-lg border border-gray-200 bg-white p-6">
      <h3 className="mb-1 text-lg font-semibold text-gray-900">{name}</h3>
      <code className="mb-3 block text-sm text-teal-600">{endpoint}</code>
      <p className="mb-4 text-sm text-gray-600">{description}</p>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
        Response
      </p>
      <CodeBlock>{response}</CodeBlock>
    </div>
  );
}

function EventRow({
  event,
  description,
}: {
  event: string;
  description: string;
}) {
  return (
    <div className="flex items-center gap-4">
      <code className="shrink-0 rounded bg-teal-50 px-2 py-1 text-sm font-medium text-teal-700">
        {event}
      </code>
      <span className="text-sm text-gray-600">{description}</span>
    </div>
  );
}
