import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("API reference docs", () => {
  it("documents the README API surface without overstating REST coverage", () => {
    const source = readFileSync("../../README.md", "utf8");

    expect(source).toContain("tRPC dashboard API + versioned `/api/v1` REST");
    expect(source).toContain(
      "External integrations use the smaller, scoped, API-key authenticated `/api/v1` REST surface",
    );
    expect(source).toContain("Versioned `/api/v1` REST API");
    expect(source).toContain("read clients/patients/appointments");
    expect(source).toContain("create SOAP notes");
    expect(source).toContain("GOOGLE_API_KEY");
    expect(source).toContain("GOOGLE_GENERATIVE_AI_API_KEY");
    expect(source).toContain("/api/v1/agent");
    expect(source).toContain(
      "external integrations use scoped `/api/v1` REST endpoints and signed webhooks",
    );
    expect(source).not.toContain("REST via trpc-openapi");
    expect(source).not.toContain("trpc-openapi");
    expect(source).not.toContain("OpenAPI/Swagger");
    expect(source).not.toContain(
      "Every feature accessible via a documented REST + WebSocket API",
    );
    expect(source).not.toContain(
      "Every action the UI performs goes through the same API available to third-party integrations",
    );
    expect(source).not.toContain(
      "Every endpoint includes Zod validation, role-based access control, and is also available as a standard REST endpoint",
    );
  });

  it("keeps README feature claims aligned with shipped workflows", () => {
    const source = readFileSync("../../README.md", "utf8");

    expect(source).toContain(
      "Supplier contact management for reorder workflows",
    );
    expect(source).toContain("Treatment templates can populate draft invoices");
    expect(source).toContain("inbound portal requests");
    expect(source).toContain(
      "Appointment and vaccination reminder workflows are administrator-controlled",
    );
    expect(source).toContain(
      "Communication history across calls, texts, emails, and inbound portal requests",
    );
    expect(source).toContain("pay online when Stripe checkout is configured");
    expect(source).toContain(
      "broader campaign APIs tracked as explicit roadmap work",
    );
    expect(source).not.toContain(
      "charges auto-populate as services are administered",
    );
    expect(source).not.toContain("Vaccination and wellness reminders");
    expect(source).not.toContain("Purchase order generation");
    expect(source).not.toContain("Bulk messaging campaigns");
    expect(source).not.toContain("WebSocket-powered");
    expect(source).not.toContain("WebSockets for live whiteboard updates");
    expect(source).not.toContain("submit prescription refill requests");
    expect(source).not.toContain("message the clinic securely");
    expect(source).not.toContain(
      "process refill requests, and complete forms via the API",
    );
    expect(source).not.toContain(
      "differential diagnosis, voice agent booking, and automated form completion",
    );
  });

  it("documents API rate limits as durable shared buckets", () => {
    const source = readFileSync("../../docs/api/README.md", "utf8");

    expect(source).toContain("600 requests/minute");
    expect(source).toContain("Retry-After");
    expect(source).toContain("rate_limit_buckets");
    expect(source).toContain("scheduled cleanup job");
    expect(source).not.toContain("currently in-memory");
    expect(source).not.toContain("per-instance");
    expect(source).not.toContain("shared (Redis) limiter is on");
  });

  it("keeps the standalone REST API README aligned with current v1 writes", () => {
    const source = readFileSync("../../docs/api/README.md", "utf8");

    expect(source).toMatch(
      /\| `appointments:read`\s+\| List\/read appointments\s+\|/,
    );
    expect(source).toContain("### `GET /api/v1/appointments`");
    expect(source).toContain("Scope `appointments:read`");
    expect(source).toContain("optional `client_id`,\n`patient_id`, `status`");
    expect(source).toContain(
      "valid ISO dates (`YYYY-MM-DD`) or timezone-qualified ISO",
    );
    expect(source).toContain(
      "`start_time`/`end_time` are required timezone-qualified ISO-8601 timestamps",
    );
    expect(source).toContain("Date-only filters are interpreted");
    expect(source).toContain("23:59:59.999Z");
    expect(source).toContain("### `GET /api/v1/appointments/:id`");
    expect(source).toContain("| `records:write` |");
    expect(source).toContain("| `agent:write` |");
    expect(source).toContain(
      "API key creation rejects `agent:write` unless the key also includes `agent:run`",
    );
    expect(source).toContain("### `POST /api/v1/soap-notes`");
    expect(source).toContain("Scope `records:write`");
    expect(source).toContain("`soap_note.created` webhook");
    expect(source).toContain("active in-exam appointment");
    expect(source).toContain(
      "`instruction` must contain non-whitespace text and is trimmed",
    );
    expect(source).toContain("also require `agent:write`");
    expect(source).toContain(
      "the key must also carry that tool's resource scope",
    );
    expect(source).toContain(
      "`GOOGLE_API_KEY` or legacy\n`GOOGLE_GENERATIVE_AI_API_KEY` for Gemini",
    );
    expect(source).not.toContain(
      "Returns `503` if the server has no\n`ANTHROPIC_API_KEY` configured",
    );
  });

  it("documents both dashboard tRPC and API-key REST surfaces", () => {
    const source = readFileSync("app/api-docs/page.tsx", "utf8");

    expect(source).toContain('id: "apiKeys"');
    expect(source).toContain(
      "The agent:write scope must be paired with agent:run or *.",
    );
    expect(source).toContain('id: "restApi"');
    expect(source).toContain("POST /api/v1/agent");
    expect(source).toContain("POST /api/v1/soap-notes");
    expect(source).toContain("Authorization: Bearer <api-key>");
    expect(source).toContain("API key: records:write");
    expect(source).toContain("GET /api/v1/appointments");
    expect(source).toContain("GET /api/v1/appointments/:id");
    expect(source).toContain("status=scheduled");
    expect(source).toContain("from=YYYY-MM-DD-or-ISO-timestamp");
    expect(source).toContain("Date-only filters use UTC day bounds");
    expect(source).toContain(
      "start_time: string, // timezone-qualified ISO timestamp",
    );
    expect(source).toContain(
      "end_time: string,   // timezone-qualified ISO timestamp",
    );
    expect(source).toContain("API key: appointments:read");
    expect(source).toContain("API key: agent:run");
    expect(source).toContain(
      "agent:write plus resource write scopes when allow_writes=true",
    );
    expect(source).toContain(
      "Write-enabled runs require agent:write plus each write tool's resource scope",
    );
    expect(source).toContain(
      "Instruction text is trimmed and must be nonblank",
    );
    expect(source).toContain("/api/trpc/ + /api/v1/");
    expect(source).not.toContain("All endpoints are available via tRPC");
    expect(source).not.toContain("All endpoints use tRPC");
  });

  it("keeps appointment status docs aligned with the live lifecycle", () => {
    const source = readFileSync("app/api-docs/page.tsx", "utf8");
    const appointmentSection = source.slice(
      source.indexOf('id: "appointments"'),
      source.indexOf('id: "records"'),
    );

    expect(appointmentSection).toContain(
      'status: "scheduled" | "confirmed" | "checked_in" | "in_exam" | "checked_out" | "no_show" | "cancelled"',
    );
    expect(appointmentSection).not.toContain('"in_progress"');
    expect(appointmentSection).not.toContain('"completed"');
  });

  it("documents paid invoices as payment-derived", () => {
    const source = readFileSync("app/api-docs/page.tsx", "utf8");
    const billingSection = source.slice(
      source.indexOf('id: "billing"'),
      source.indexOf('id: "inventory"'),
    );

    expect(billingSection).toContain(
      "Paid is derived from recorded payments or adjustments and cannot be set directly.",
    );
    expect(billingSection).toContain(
      'status: "draft" | "sent" | "overdue" | "void"',
    );
    expect(billingSection).not.toContain(
      'status: "draft" | "sent" | "paid" | "overdue" | "void"',
    );
  });

  it("keeps inventory docs aligned to the live router contract", () => {
    const source = readFileSync("app/api-docs/page.tsx", "utf8");
    const inventorySection = source.slice(
      source.indexOf('id: "inventory"'),
      source.indexOf('id: "communications"'),
    );

    expect(inventorySection).toContain(
      'alert?: "all" | "attention" | "low_stock" | "expired" | "expiring_soon"',
    );
    expect(inventorySection).toContain("stockQuantity?: number");
    expect(inventorySection).toContain("reorderPoint?: number");
    expect(inventorySection).toContain("costPrice?: string");
    expect(inventorySection).toContain('expirationDate?: "YYYY-MM-DD"');
    expect(inventorySection).toContain("alertCounts");
    expect(inventorySection).toContain("reason: string");
    const inventoryUpdateSection = inventorySection.slice(
      inventorySection.indexOf('name: "inventory.update"'),
      inventorySection.indexOf('name: "inventory.adjustStock"'),
    );
    expect(inventoryUpdateSection).toContain(
      "Use inventory.adjustStock for stock quantity changes",
    );
    expect(inventoryUpdateSection).not.toContain("stockQuantity?: number");
    expect(inventorySection).not.toContain("lowStock?: boolean");
    expect(inventorySection).not.toContain("quantity: number");
    expect(inventorySection).not.toContain("minQuantity?: number");
    expect(inventorySection).not.toContain("unitCost?: number");
    expect(inventorySection).not.toContain("supplierId?: string");
    expect(inventorySection).not.toContain("reason?: string");
  });

  it("documents communications status updates as read-only inbox actions", () => {
    const source = readFileSync("app/api-docs/page.tsx", "utf8");

    expect(source).toContain('name: "communications.listConversations"');
    expect(source).toContain("with unread counts derived server-side");
    expect(source).toContain(
      "The sent inbox filter includes sent, delivered, and read outbound messages.",
    );
    expect(source).toContain(
      "The sent inbox filter includes sent, delivered, and read outbound conversations.",
    );

    const updateStatusSection = source.slice(
      source.indexOf('name: "communications.updateStatus"'),
      source.indexOf(
        "];",
        source.indexOf('name: "communications.updateStatus"'),
      ),
    );

    expect(updateStatusSection).toContain('status: "read"');
    expect(updateStatusSection).toContain(
      "Delivery lifecycle statuses are managed by send and provider webhook handlers.",
    );
    expect(updateStatusSection).not.toContain(
      'status: "pending" | "sent" | "delivered" | "read" | "failed"',
    );
  });

  it("documents communications create as send-capable with internal portal delivery", () => {
    const source = readFileSync("app/api-docs/page.tsx", "utf8");
    const createSection = source.slice(
      source.indexOf('name: "communications.create"'),
      source.indexOf(
        'name: "communications.updateStatus"',
        source.indexOf('name: "communications.create"'),
      ),
    );

    expect(createSection).toContain("Send outbound SMS/email from the inbox");
    expect(createSection).toContain(
      "send/log internal portal communications visible in the client portal",
    );
    expect(createSection).not.toContain(
      "Outbound portal delivery is not available",
    );
    expect(createSection).not.toContain("portal may only be logged inbound");
    expect(createSection).not.toContain('description: "Log a communication."');
    expect(createSection).toContain("Required UUID for outbound SMS/email");
    expect(createSection).toContain("reuse for retries of the same send");
  });

  it("documents portal message read and reply endpoints", () => {
    const source = readFileSync("app/api-docs/page.tsx", "utf8");
    const portalSection = source.slice(
      source.indexOf('id: "portal"'),
      source.indexOf('id: "apiKeys"'),
    );

    expect(portalSection).toContain('name: "portal.getMessages"');
    expect(portalSection).toContain('name: "portal.createMessage"');
    expect(portalSection).toContain('name: "portal.markMessagesRead"');
    expect(portalSection).toContain(
      "Send a portal message from the client into the shared inbox.",
    );
    expect(portalSection).toContain(
      "Mark outbound clinic portal messages as read after the client opens the thread.",
    );
  });

  it("documents the shared inbox assignment conflict guard", () => {
    const source = readFileSync("app/api-docs/page.tsx", "utf8");
    const assignSection = source.slice(
      source.indexOf('name: "communications.assignClient"'),
      source.indexOf(
        'name: "communications.linkCommunicationToClient"',
        source.indexOf('name: "communications.assignClient"'),
      ),
    );

    expect(assignSection).toContain("expectedAssignedTo: string | null");
  });
});
