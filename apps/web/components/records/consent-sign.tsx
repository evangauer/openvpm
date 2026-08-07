"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { CheckCircle2, FileSignature, Loader2, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  CONSENT_BODY_MAX_LENGTH,
  CONSENT_TITLE_MAX_LENGTH,
} from "@/lib/consult/consent-template";

const CONSENT_POLL_INTERVAL_MS = 5_000;

/**
 * "Get signature" button + consent dispatch modal. Staff pick a form from
 * the practice library ("what are they signing?"), review and optionally
 * edit the text, then a QR appears; the client signs on their own phone or
 * a handed-over tablet via the no-login /sign/[token] page. The signed
 * status shows here live. Mount only for roles that can manage the patient.
 */
export function ConsentSign({
  patientId,
  appointmentId,
}: {
  patientId: string;
  appointmentId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [formId, setFormId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const forms = trpc.records.listConsentForms.useQuery(undefined, {
    enabled: open,
  });

  const createRequest = trpc.records.createConsentRequest.useMutation({
    onError: (err) => toast.error(err.message),
  });

  const request = createRequest.data;

  // Default to the first form (the library's plain consent-to-treatment)
  // once the list arrives.
  useEffect(() => {
    if (!open || formId !== null) return;
    const first = forms.data?.[0];
    if (first) {
      setFormId(first.id);
      setTitle(first.title);
      setBodyText(first.body);
    }
  }, [open, formId, forms.data]);

  function handleFormChange(nextId: string) {
    const form = forms.data?.find((row) => row.id === nextId);
    if (!form) return;
    setFormId(form.id);
    setTitle(form.title);
    setBodyText(form.body);
  }

  const consents = trpc.records.listConsents.useQuery(
    { patientId },
    {
      enabled: open && Boolean(request),
      refetchInterval: open && request ? CONSENT_POLL_INTERVAL_MS : false,
    }
  );

  useEffect(() => {
    let cancelled = false;
    if (!request?.url) {
      setQrDataUrl(null);
      return;
    }
    QRCode.toDataURL(request.url, { width: 240, margin: 1 })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [request?.url]);

  function handleClose() {
    setOpen(false);
    createRequest.reset();
    setQrDataUrl(null);
    setFormId(null);
    setTitle("");
    setBodyText("");
  }

  const activeConsent = request
    ? consents.data?.find((row) => row.id === request.id)
    : undefined;
  const isSigned = activeConsent?.status === "signed";

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <FileSignature className="mr-2 h-4 w-4" />
        Get signature
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-[90] overflow-y-auto bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Get signature"
        >
          <div className="flex min-h-full items-center justify-center">
            <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-xl">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-heading text-base font-semibold">
                    Get signature
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {request
                      ? "Scan with any phone. The code works for 60 minutes."
                      : "Check the consent text, then make the code."}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleClose}
                  aria-label="Close"
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {!request ? (
                <div className="mt-4 space-y-3">
                  <div>
                    <label
                      htmlFor="consent-form"
                      className="mb-1 block text-sm font-medium"
                    >
                      Form
                    </label>
                    {forms.isLoading || !forms.data ? (
                      <div className="flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Loading forms...
                      </div>
                    ) : (
                      <select
                        id="consent-form"
                        value={formId ?? ""}
                        onChange={(e) => handleFormChange(e.target.value)}
                        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                      >
                        {forms.data.map((form) => (
                          <option key={form.id} value={form.id}>
                            {form.title}
                          </option>
                        ))}
                      </select>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      Starter templates. Have your attorney look them over,
                      and fill in any blanks before you send.
                    </p>
                  </div>
                  <div>
                    <label
                      htmlFor="consent-title"
                      className="mb-1 block text-sm font-medium"
                    >
                      Title
                    </label>
                    <input
                      id="consent-title"
                      type="text"
                      maxLength={CONSENT_TITLE_MAX_LENGTH}
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="consent-body"
                      className="mb-1 block text-sm font-medium"
                    >
                      Consent text
                    </label>
                    <textarea
                      id="consent-body"
                      rows={8}
                      maxLength={CONSENT_BODY_MAX_LENGTH}
                      value={bodyText}
                      onChange={(e) => setBodyText(e.target.value)}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm leading-6"
                    />
                  </div>
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      disabled={
                        createRequest.isPending ||
                        !formId ||
                        title.trim().length === 0 ||
                        bodyText.trim().length === 0
                      }
                      onClick={() =>
                        createRequest.mutate({
                          patientId,
                          appointmentId,
                          formId: formId!,
                          title: title.trim(),
                          bodyText: bodyText.trim(),
                        })
                      }
                    >
                      {createRequest.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <FileSignature className="mr-2 h-4 w-4" />
                      )}
                      Make the code
                    </Button>
                  </div>
                  {createRequest.isError && (
                    <div className="flex justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!formId}
                        onClick={() =>
                          createRequest.mutate({
                            patientId,
                            appointmentId,
                            formId: formId!,
                            title: title.trim(),
                            bodyText: bodyText.trim(),
                          })
                        }
                      >
                        <RefreshCw className="mr-2 h-4 w-4" />
                        Try again
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="mt-4 flex flex-col items-center gap-3">
                  {isSigned ? (
                    <div className="flex w-full flex-col items-center gap-3 rounded-lg border border-border bg-muted/30 p-6 text-center">
                      <CheckCircle2 className="h-10 w-10 text-primary" />
                      <p className="text-sm font-medium">
                        Signed by {activeConsent?.signerName}
                      </p>
                      {activeConsent?.fileUrl && (
                        <a
                          href={activeConsent.fileUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sm font-medium text-primary underline underline-offset-4"
                        >
                          Open the signed PDF
                        </a>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Saved on this patient under Documents.
                      </p>
                    </div>
                  ) : (
                    <>
                      {qrDataUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={qrDataUrl}
                          alt="QR code for the consent signing link"
                          className="h-60 w-60 rounded-lg border border-border bg-white p-2"
                        />
                      ) : (
                        <div className="flex h-60 w-60 items-center justify-center rounded-lg border border-border bg-muted/30">
                          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                        </div>
                      )}
                      <p className="w-full break-all text-center text-xs text-muted-foreground">
                        {request.url}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Waiting for a signature…
                      </p>
                    </>
                  )}
                </div>
              )}

              <div className="mt-5 flex justify-end">
                <Button variant="outline" size="sm" onClick={handleClose}>
                  Done
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
