import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source-level UI-state assertions for the consult companion (QR photo
 * capture + AI visit-note draft), mirroring onboarding-ui-states.test.ts.
 */

describe("consult companion UI states", () => {
  const patientPage = readFileSync(
    "app/(dashboard)/patients/[id]/page.tsx",
    "utf8"
  );
  const soapPage = readFileSync(
    "app/(dashboard)/records/new-soap/[patientId]/page.tsx",
    "utf8"
  );
  const capturePage = readFileSync("app/capture/[token]/page.tsx", "utf8");
  const captureClient = readFileSync(
    "app/capture/[token]/capture-client.tsx",
    "utf8"
  );
  const captureLayout = readFileSync("app/capture/layout.tsx", "utf8");
  const captureModal = readFileSync(
    "components/records/capture-photos.tsx",
    "utf8"
  );
  const middleware = readFileSync("middleware.ts", "utf8");
  const recordsRouter = readFileSync("server/routers/records.ts", "utf8");

  it("gates the capture button on the patient page behind patient management", () => {
    expect(patientPage).toContain(
      'import { CapturePhotos } from "@/components/records/capture-photos"'
    );
    expect(patientPage).toMatch(
      /\{canManagePatientDetail && \(\s*<CapturePhotos patientId=\{patient\.id\} \/>\s*\)\}/
    );
  });

  it("allows the no-login capture page through the middleware allowlist", () => {
    expect(middleware).toContain('"/capture",');
    // Regression guard: the allowlist must stay inside PUBLIC_PATH_PREFIXES.
    const allowlist = middleware.slice(
      middleware.indexOf("PUBLIC_PATH_PREFIXES"),
      middleware.indexOf("];")
    );
    expect(allowlist).toContain('"/capture"');
  });

  it("opens the phone camera from the capture page", () => {
    expect(captureClient).toContain('accept="image/*"');
    expect(captureClient).toContain('capture="environment"');
    expect(captureClient).toContain("multiple");
    expect(capturePage).toContain("CaptureClient");
  });

  it("keeps the capture page PHI-minimal and failure-friendly", () => {
    expect(captureClient).toContain("Add photos to the visit record");
    expect(captureClient).toContain(
      "This link has expired. Ask the front desk for a new code."
    );
    // No patient identity ever reaches the no-login page.
    expect(captureClient).not.toContain("patientName");
    expect(capturePage).not.toContain("patientName");
    expect(captureLayout).not.toContain("patientName");
  });

  it("mints capture links with the shared 30-minute token helper", () => {
    expect(recordsRouter).toContain("createCaptureSession");
    expect(recordsRouter).toContain("generateCaptureToken()");
    expect(recordsRouter).toContain("CAPTURE_TOKEN_TTL_MS");
    expect(recordsRouter).toMatch(
      /createCaptureSession: protectedProcedure\s*\.use\(\s*requireRole\("admin", "veterinarian", "technician", "front_desk"\)\s*\)/
    );
  });

  it("polls for arriving photos while the QR modal is open", () => {
    expect(captureModal).toContain("listCaptureFiles.useQuery");
    expect(captureModal).toContain("refetchInterval");
    expect(captureModal).toContain(
      "Scan with any phone. The code works for 30 minutes."
    );
    expect(captureModal).toContain("photos added");
  });

  it("wires Draft with AI on the SOAP page without auto-saving", () => {
    expect(soapPage).toContain("Draft with AI");
    expect(soapPage).toContain("trpc.ai.draftSoapNote.useMutation");
    expect(soapPage).toContain("trpc.agent.status.useQuery");
    // The draft only fills the editors; saving stays behind the Save button.
    expect(soapPage).toContain("setSubjective(draftTextToHtml(draft.subjective))");
    expect(soapPage).toContain("setPlan(draftTextToHtml(draft.plan))");
    const draftSuccessHandler = soapPage.slice(
      soapPage.indexOf("trpc.ai.draftSoapNote.useMutation"),
      soapPage.indexOf("function handleDraftWithAi")
    );
    expect(draftSuccessHandler).not.toContain("createNote.mutate");
    expect(soapPage).toContain(
      "Draft ready. Please review and edit before you save."
    );
  });

  it("hides the AI draft affordance behind configuration with a gentle note", () => {
    expect(soapPage).toContain("agentStatus.data?.configured ?? false");
    expect(soapPage).toContain("disabled={!aiConfigured || draftWithAi.isPending}");
    expect(soapPage).toContain(
      "AI is not set up yet. Ask your admin to add an AI key."
    );
  });

  it("keeps consult companion copy free of em dashes", () => {
    for (const source of [captureClient, captureModal, captureLayout]) {
      expect(source).not.toContain("—");
    }
  });
});
