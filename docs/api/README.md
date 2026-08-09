# OpenVPM REST API (v1)

A versioned, public REST API over OpenVPM's core records. It is intended for
third-party integrators (booking, reminders, client comms, AI agents) that read
and write practice data without using the internal tRPC client.

> **Compatibility layer.** The `v1` surface is OpenVPM's own clean contract and
> doubles as the reference implementation for vendor-compatible APIs. Each
> response shape is owned by an explicit schema and frozen independently of the
> internal database — internal columns can change without breaking you. A
> vendor-specific "identical-twin" surface (so an existing integration can point
> at OpenVPM with zero changes) is added as a sibling namespace; see
> [Adding a compatibility target](../../CONTRIBUTING.md#adding-a-compatibility-endpoint-or-target).

## Authentication

Every request requires a scoped API key. A practice admin creates one from
**Settings → API Keys** (backed by the `apiKeys` tRPC router). The raw key is
shown **once** at creation — store it securely.

Send it on every request as a bearer token (preferred) or `X-API-Key`:

```bash
curl https://demo.openvpm.com/api/v1/clients \
  -H "Authorization: Bearer ovpm_xxxxxxxxxxxxxxxxxxxxxxxx"

# equivalent
curl https://demo.openvpm.com/api/v1/clients \
  -H "X-API-Key: ovpm_xxxxxxxxxxxxxxxxxxxxxxxx"
```

Keys are stored as bcrypt hashes (never in plaintext) and are scoped to a single
practice — a key can only ever read or write its own practice's data.

### Scopes

| Scope | Grants |
|---|---|
| `clients:read` | List/read clients |
| `patients:read` | List/read patients |
| `appointments:read` | List/read appointments |
| `appointments:write` | Create appointments |
| `records:write` | Create clinical record entries such as SOAP notes |
| `agent:run` | Run the OpenVPM Agent over the API |
| `agent:write` | Allow write-enabled agent runs when paired with `agent:run`; write tools still require their resource scopes |
| `*` | All of the above |

A request missing the required scope returns `403`.
API key creation rejects `agent:write` unless the key also includes `agent:run`
or `*`, because `agent:write` only enables write mode for agent runs.

## Rate limits

Each key is limited to **600 requests/minute**. Over the limit returns `429`
with `Retry-After` and `X-RateLimit-*` headers.

Rate limits are enforced through the shared `rate_limit_buckets` table, so the
budget follows the key across serverless instances and process restarts. Expired
buckets are removed by the scheduled cleanup job.

## Error format

All errors use a single envelope:

```json
{ "error": { "message": "API key missing required scope: appointments:write" } }
```

Validation errors (`400`) include field detail:

```json
{ "error": { "message": "Validation failed", "fields": { "end_time": ["end_time must be after start_time"] } } }
```

| Status | Meaning |
|---|---|
| `400` | Malformed JSON or failed validation |
| `401` | Missing or invalid API key |
| `403` | Key lacks the required scope |
| `404` | Resource not found (or not in your practice) |
| `429` | Rate limit exceeded |

## Endpoints

List responses use a `{ data, pagination }` envelope; single-resource responses
use `{ data }`.

### `GET /api/v1/clients`
Scope `clients:read`. Query: `limit` (default 25, max 100), `offset`.

```json
{
  "data": [
    {
      "id": "…", "first_name": "Jane", "last_name": "Doe",
      "email": "jane@example.com", "phone": "555-0100",
      "address": "1 Main St", "city": "Tampa", "state": "FL", "zip": "33601",
      "preferred_contact_method": "email", "notes": null,
      "created_at": "2026-01-02T03:04:05.000Z", "updated_at": "2026-01-02T03:04:05.000Z"
    }
  ],
  "pagination": { "limit": 25, "offset": 0, "total": 1 }
}
```

### `GET /api/v1/clients/:id`
Scope `clients:read`. Returns `{ data: <client> }` or `404`.

### `GET /api/v1/patients`
Scope `patients:read`. Query: `limit`, `offset`, optional `client_id`.
Species are normalized to integrator-friendly values (`dog`, `cat`, `bird`,
`rabbit`, `reptile`, `horse`, `other`) and the internal sex enum is split into
`sex` (`male`/`female`/`unknown`) + `neutered` (boolean | null).

### `GET /api/v1/patients/:id`
Scope `patients:read`. Returns `{ data: <patient> }` or `404`.

### `GET /api/v1/appointments`
Scope `appointments:read`. Query: `limit`, `offset`, optional `client_id`,
`patient_id`, `status`, `from`, and `to`. `status` must be one of `scheduled`,
`confirmed`, `checked_in`, `in_exam`, `checked_out`, `no_show`, or `cancelled`.
Date filters must be valid ISO dates (`YYYY-MM-DD`) or timezone-qualified ISO
timestamps and match appointment `start_time`. Date-only filters are interpreted
as UTC calendar-day bounds (`from` starts at `00:00:00.000Z`; `to` ends at
`23:59:59.999Z`).

```json
{
  "data": [
    {
      "id": "…",
      "start_time": "2026-03-01T09:00:00.000Z",
      "end_time": "2026-03-01T09:30:00.000Z",
      "status": "scheduled",
      "client_id": "…",
      "patient_id": "…",
      "doctor_id": "…",
      "type_id": "…",
      "room_id": "…",
      "notes": "Annual exam",
      "created_at": "2026-01-02T03:04:05.000Z",
      "updated_at": "2026-01-02T03:04:05.000Z"
    }
  ],
  "pagination": { "limit": 25, "offset": 0, "total": 1 }
}
```

### `GET /api/v1/appointments/:id`
Scope `appointments:read`. Returns `{ data: <appointment> }` or `404`.

### `POST /api/v1/appointments`
Scope `appointments:write`. Body:

```json
{
  "start_time": "2026-03-01T09:00:00.000Z",
  "end_time": "2026-03-01T09:30:00.000Z",
  "client_id": "…",
  "patient_id": "…",
  "doctor_id": "…",
  "type_id": "…",
  "room_id": "…",
  "notes": "Annual exam"
}
```

`start_time`/`end_time` are required timezone-qualified ISO-8601 timestamps
(`end_time` must be after `start_time`); all ids and `notes` are optional. Returns `201` with
`{ data: <appointment> }` and fires the `appointment.created` webhook to any
subscribed endpoints with camelCase appointment fields (see the
[Webhooks](../../README.md#webhooks) section).

### `POST /api/v1/soap-notes`

Scope `records:write`. Create an immediately finalized, immutable SOAP note
from an external AI scribe. The clinician should review the content before the
integration submits it. Body:

```json
{
  "patient_id": "…",
  "appointment_id": "…",
  "author_id": "…",
  "subjective": "Owner reports decreased appetite x3 days.",
  "objective": "T: 101.5F, HR: 120, RR: 24. Mild dehydration.",
  "assessment": "Suspect early-stage renal disease.",
  "plan": "CBC/Chem panel, urinalysis. Recheck in 2 weeks.",
  "source": "scribenote"
}
```

`patient_id`, `appointment_id`, and `source` are required. The appointment must
belong to the same patient/practice and be an active in-exam appointment whose
clinical closeout has not been finalized. `author_id` is optional when the
appointment has an assigned doctor; otherwise it must identify an active admin
or veterinarian in the authenticated practice. At least one SOAP section must
contain clinical text. Returns `201` with `{ data: <soap_note> }` and fires the
`soap_note.created` webhook. Returns `409` if the encounter already has a saved
SOAP draft or an effective finalized SOAP note; integrations must not treat
this endpoint as an editable draft workflow.

### `POST /api/v1/agent`
Scope `agent:run`. Run the OpenVPM Agent over the API, scoped to the key's
practice. Body:

```json
{ "instruction": "Which patients are overdue for vaccinations?", "allow_writes": false }
```

`instruction` must contain non-whitespace text and is trimmed before the agent
runs. `allow_writes` (default `false`) gates write tools such as booking
appointments and recording vitals. Requests with
`allow_writes: true` also require `agent:write`; when the agent invokes a write
tool, the key must also carry that tool's resource scope, such as
`appointments:write` for booking or `records:write` for vitals. Returns
`{ data: { text, toolCalls, iterations, stopReason } }`, where `toolCalls`
traces every tool the agent invoked. Returns `503` if the configured model
provider is missing its key (`GOOGLE_API_KEY` or legacy
`GOOGLE_GENERATIVE_AI_API_KEY` for Gemini, or `ANTHROPIC_API_KEY` for Claude).
