import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source-level UI-state assertions for the consult companion (QR photo
 * capture + AI visit-note draft), mirroring onboarding-ui-states.test.ts.
 */

describe("consult companion UI states", () => {
  const patientPage = readFileSync(
    "app/(dashboard)/patients/[id]/page.tsx",
    "utf8",
  );
  const soapPage = readFileSync(
    "app/(dashboard)/records/new-soap/[patientId]/page.tsx",
    "utf8",
  );
  const capturePage = readFileSync("app/capture/[token]/page.tsx", "utf8");
  const captureClient = readFileSync(
    "app/capture/[token]/capture-client.tsx",
    "utf8",
  );
  const captureLayout = readFileSync("app/capture/layout.tsx", "utf8");
  const captureModal = readFileSync(
    "components/records/capture-photos.tsx",
    "utf8",
  );
  const middleware = readFileSync("middleware.ts", "utf8");
  const recordsRouter = readFileSync("server/routers/records.ts", "utf8");

  it("gates the capture button on the patient page behind patient management", () => {
    expect(patientPage).toContain(
      'import { CapturePhotos } from "@/components/records/capture-photos"',
    );
    expect(patientPage).toMatch(
      /\{canManagePatientDetail && \(\s*<>\s*<CapturePhotos patientId=\{patient\.id\} \/>\s*<ConsentSign patientId=\{patient\.id\} \/>\s*<\/>\s*\)\}/,
    );
  });

  it("allows the no-login capture page through the middleware allowlist", () => {
    expect(middleware).toContain('"/capture",');
    // Regression guards: the route stays public while receiving the stricter
    // capability-page privacy headers before the generic public-path branch.
    const capabilityStart = middleware.indexOf("CAPABILITY_PATH_PREFIXES");
    const capabilityAllowlist = middleware.slice(
      capabilityStart,
      middleware.indexOf("];", capabilityStart),
    );
    expect(capabilityAllowlist).toContain('"/capture"');
    const publicStart = middleware.indexOf("PUBLIC_PATH_PREFIXES");
    const allowlist = middleware.slice(
      publicStart,
      middleware.indexOf("];", publicStart),
    );
    expect(allowlist).toContain('"/capture"');
  });

  it("opens the phone camera from the capture page", () => {
    expect(captureClient).toContain('accept="image/*"');
    expect(captureClient).toContain('capture="environment"');
    expect(captureClient).toContain("multiple");
    expect(capturePage).toContain("CaptureClient");
  });

  it("keeps one client-generated idempotency key across upload retries", () => {
    expect(captureClient).toContain("crypto.randomUUID()");
    expect(captureClient).toContain(
      'xhr.setRequestHeader("Idempotency-Key", idempotencyKey)',
    );
    expect(captureClient).toContain("performUpload(item)");
    expect(captureClient).toContain("Try again");
  });

  it("keeps the capture page PHI-minimal and failure-friendly", () => {
    expect(captureClient).toContain("Add photos to the visit record");
    expect(captureClient).toContain(
      "This link has expired. Ask the front desk for a new code.",
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
      /createCaptureSession: protectedProcedure\s*\.use\(\s*requireRole\("admin", "veterinarian", "technician", "front_desk"\)\s*\)/,
    );
  });

  it("polls for arriving photos while the QR modal is open", () => {
    expect(captureModal).toContain("listCaptureFiles.useQuery");
    expect(captureModal).toContain("refetchInterval");
    expect(captureModal).toContain(
      "Scan with any phone. The code works for 30 minutes.",
    );
    expect(captureModal).toContain("photos added");
  });

  it("wires Draft with AI on the SOAP page without auto-saving", () => {
    expect(soapPage).toContain("Draft with AI");
    expect(soapPage).toContain("trpc.ai.draftSoapNote.useMutation");
    expect(soapPage).toContain("trpc.agent.status.useQuery");
    // The draft only fills the editors; saving stays behind the Save button.
    expect(soapPage).toContain(
      "setSubjective(draftTextToHtml(draft.subjective))",
    );
    expect(soapPage).toContain("setPlan(draftTextToHtml(draft.plan))");
    const draftSuccessHandler = soapPage.slice(
      soapPage.indexOf("trpc.ai.draftSoapNote.useMutation"),
      soapPage.indexOf("function handleDraftWithAi"),
    );
    expect(draftSuccessHandler).not.toContain("createNote.mutate");
    expect(soapPage).toContain(
      "Draft ready. Please review and edit before you save.",
    );
  });

  it("hides the AI draft affordance behind configuration with a gentle note", () => {
    expect(soapPage).toContain("agentStatus.data?.canUseAi ?? false");
    expect(soapPage).toContain("!canUseAi ||");
    expect(soapPage).toContain("Add a card to your trial to try AI");
    expect(soapPage).toContain('router.push("/settings?tab=billing")');
  });

  it("keeps consult companion copy free of em dashes", () => {
    for (const source of [captureClient, captureModal, captureLayout]) {
      expect(source).not.toContain("—");
    }
  });
});

describe("e-sign consent UI states", () => {
  const patientPage = readFileSync(
    "app/(dashboard)/patients/[id]/page.tsx",
    "utf8",
  );
  const signPage = readFileSync("app/sign/[token]/page.tsx", "utf8");
  const signClient = readFileSync("app/sign/[token]/sign-client.tsx", "utf8");
  const signLayout = readFileSync("app/sign/layout.tsx", "utf8");
  const consentModal = readFileSync(
    "components/records/consent-sign.tsx",
    "utf8",
  );
  const middleware = readFileSync("middleware.ts", "utf8");
  const recordsRouter = readFileSync("server/routers/records.ts", "utf8");

  it("gates the signature button behind patient management", () => {
    expect(patientPage).toContain(
      'import { ConsentSign } from "@/components/records/consent-sign"',
    );
  });

  it("allows the no-login sign page through the middleware allowlist", () => {
    const capabilityStart = middleware.indexOf("CAPABILITY_PATH_PREFIXES");
    const capabilityAllowlist = middleware.slice(
      capabilityStart,
      middleware.indexOf("];", capabilityStart),
    );
    expect(capabilityAllowlist).toContain('"/sign"');
    const publicStart = middleware.indexOf("PUBLIC_PATH_PREFIXES");
    const allowlist = middleware.slice(
      publicStart,
      middleware.indexOf("];", publicStart),
    );
    expect(allowlist).toContain('"/sign"');
  });

  it("binds every dispatch to a form from the practice library", () => {
    expect(consentModal).toContain("listConsentForms.useQuery");
    expect(consentModal).toContain("handleFormChange");
    expect(recordsRouter).toContain("formId: z.string().uuid()");
  });

  it("lets staff edit the consent copy before minting the code", () => {
    expect(consentModal).toContain('id="consent-title"');
    expect(consentModal).toContain('id="consent-body"');
    expect(consentModal).toContain("createConsentRequest.useMutation");
    expect(consentModal).toContain("Make the code");
  });

  it("shows the signed state with a link to the PDF", () => {
    expect(consentModal).toContain("listConsents.useQuery");
    expect(consentModal).toContain("Signed by");
    expect(consentModal).toContain("Open the signed PDF");
  });

  it("requires a name, drawn ink, and signer authority acknowledgement", () => {
    const canSubmit = signClient.slice(
      signClient.indexOf("const canSubmit ="),
      signClient.indexOf("return (", signClient.indexOf("const canSubmit =")),
    );
    expect(canSubmit).toContain("Boolean(signature)");
    expect(canSubmit).toContain("signerName.trim().length > 0");
    expect(canSubmit).toContain("signerAuthorityAccepted");
    expect(signClient).toContain("signerAuthorityAccepted: true");
    expect(signClient).toContain("Agree and sign");
    expect(signClient).toContain('toDataURL("image/png")');
  });

  it("lets a refreshed in-progress signing page finish from persisted evidence", () => {
    expect(signClient).toContain('state.consent.status === "signing"');
    expect(signClient).toContain("Your signature is safe");
    const resumeHandler = signClient.slice(
      signClient.indexOf("async function handleResume"),
      signClient.indexOf(
        "if (state.kind",
        signClient.indexOf("async function handleResume"),
      ),
    );
    expect(resumeHandler).toContain("resume: true");
    expect(resumeHandler).toContain("signerAuthorityAccepted: true");
    expect(signClient).toContain("Finish saving");
  });

  it("shows the friendly expired copy on dead links", () => {
    expect(signClient).toContain(
      "This link has expired. Ask the front desk for a new code.",
    );
  });

  it("keeps the sign page from widening the token oracle", () => {
    // The server component renders the same shell for every token; content
    // comes only from the rate-limited API.
    expect(signPage).not.toContain("withSystem");
    expect(signPage).toContain('export const dynamic = "force-dynamic"');
  });

  it("snapshots consent copy server-side so edits never rewrite signed forms", () => {
    expect(recordsRouter).toContain("createConsentRequest");
    const createConsentSource = recordsRouter.slice(
      recordsRouter.indexOf("createConsentRequest"),
      recordsRouter.indexOf(
        "listConsents",
        recordsRouter.indexOf("createConsentRequest"),
      ),
    );
    expect(createConsentSource).toContain(
      "const title = input.title ?? form.title",
    );
    expect(createConsentSource).toContain(
      "const bodyText = input.bodyText ?? form.body",
    );
    expect(createConsentSource).toMatch(
      /\.values\(\{[\s\S]*?title,\s*bodyText,/,
    );
  });

  it("keeps e-sign copy free of em dashes", () => {
    for (const source of [signClient, signLayout, consentModal]) {
      expect(source).not.toContain("—");
    }
  });
});
