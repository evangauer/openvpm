"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Eraser, Loader2 } from "lucide-react";

const EXPIRED_MESSAGE =
  "This link has expired. Ask the front desk for a new code.";

type ConsentView =
  | {
      status: "pending";
      title: string;
      bodyText: string;
      patientName: string;
      practiceName: string;
    }
  | { status: "signing" }
  | { status: "signed" };

type PageState =
  | { kind: "loading" }
  | { kind: "expired" }
  | { kind: "error"; message: string }
  | { kind: "ready"; consent: ConsentView }
  | { kind: "submitted"; consent: ConsentView };

/**
 * Signature pad: a plain canvas with pointer events. Scaled for
 * devicePixelRatio so the exported PNG stays crisp.
 */
function SignaturePad({
  onChange,
}: {
  onChange: (dataUrl: string | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const hasInkRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }, []);

  const pointFromEvent = useCallback((event: React.PointerEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, []);

  function handleDown(event: React.PointerEvent) {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    canvas.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    const { x, y } = pointFromEvent(event);
    ctx.beginPath();
    ctx.moveTo(x, y);
    // A dot counts as ink (some people sign with initials or a mark).
    ctx.lineTo(x + 0.1, y + 0.1);
    ctx.stroke();
    hasInkRef.current = true;
  }

  function handleMove(event: React.PointerEvent) {
    if (!drawingRef.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const { x, y } = pointFromEvent(event);
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  function handleUp() {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const canvas = canvasRef.current;
    if (canvas && hasInkRef.current) {
      onChange(canvas.toDataURL("image/png"));
    }
  }

  function handleClear() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, rect.width, rect.height);
    hasInkRef.current = false;
    onChange(null);
  }

  return (
    <div>
      <canvas
        ref={canvasRef}
        className="h-40 w-full touch-none rounded-lg border border-gray-300 bg-white"
        aria-label="Signature area. Draw your signature here."
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
      />
      <div className="mt-2 flex items-center justify-between">
        <p className="text-xs text-gray-500">Sign above with your finger.</p>
        <button
          type="button"
          onClick={handleClear}
          className="inline-flex items-center gap-1 text-xs font-medium text-teal-700"
        >
          <Eraser className="h-3.5 w-3.5" />
          Clear
        </button>
      </div>
    </div>
  );
}

export function SignClient({ token }: { token: string }) {
  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [signerName, setSignerName] = useState("");
  const [signature, setSignature] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sign/${token}`)
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) {
          setState({ kind: "expired" });
          return;
        }
        if (!res.ok) {
          setState({
            kind: "error",
            message: "Something went wrong. Please try again.",
          });
          return;
        }
        const consent = (await res.json()) as ConsentView;
        setState({ kind: "ready", consent });
      })
      .catch(() => {
        if (!cancelled) {
          setState({
            kind: "error",
            message: "Something went wrong. Please try again.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function submitSigningPayload(payload: Record<string, unknown>) {
    if (state.kind !== "ready") return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/sign/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.status === 404) {
        setState({ kind: "expired" });
        return;
      }
      if (res.status === 429) {
        setSubmitError(
          "Too many tries right now. Wait a minute and try again.",
        );
        return;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setSubmitError(data?.error ?? "Signing failed. Please try again.");
        return;
      }
      setState({ kind: "submitted", consent: state.consent });
    } catch {
      setSubmitError(
        "Signing failed. Please check your connection and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit() {
    if (!signature || !signerName.trim()) return;
    await submitSigningPayload({
      signerName: signerName.trim(),
      signaturePngDataUrl: signature,
    });
  }

  async function handleResume() {
    await submitSigningPayload({ resume: true });
  }

  if (state.kind === "loading") {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-gray-500">
        <Loader2 className="h-6 w-6 animate-spin" />
        <p className="text-sm">Loading the form…</p>
      </div>
    );
  }

  if (state.kind === "expired") {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <AlertCircle className="h-8 w-8 text-amber-500" />
        <p className="text-sm text-gray-600">{EXPIRED_MESSAGE}</p>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <AlertCircle className="h-8 w-8 text-amber-500" />
        <p className="text-sm text-gray-600">{state.message}</p>
      </div>
    );
  }

  if (state.kind === "submitted" || state.consent.status === "signed") {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <CheckCircle2 className="h-10 w-10 text-teal-600" />
        <h1 className="text-lg font-semibold text-gray-900">All signed</h1>
        <p className="text-sm text-gray-600">
          Thank you. The clinic has your signed form. You can close this page.
        </p>
      </div>
    );
  }

  if (state.consent.status === "signing") {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <CheckCircle2 className="h-10 w-10 text-teal-600" />
        <h1 className="text-lg font-semibold text-gray-900">
          Your signature is safe
        </h1>
        <p className="max-w-sm text-sm text-gray-600">
          The clinic has your exact signature. Finish saving the signed document
          without drawing it again.
        </p>
        {submitError && (
          <p className="flex items-center gap-2 text-sm text-red-600">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {submitError}
          </p>
        )}
        <button
          type="button"
          disabled={submitting}
          onClick={() => void handleResume()}
          className="w-full max-w-sm rounded-lg bg-teal-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "Finishing…" : "Finish saving"}
        </button>
      </div>
    );
  }

  const { consent } = state;
  const canSubmit = Boolean(signature) && signerName.trim().length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">{consent.title}</h1>
        <p className="mt-1 text-sm text-gray-500">
          {consent.practiceName} · For {consent.patientName}
        </p>
      </div>

      <div className="whitespace-pre-wrap rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm leading-6 text-gray-800">
        {consent.bodyText}
      </div>

      <div>
        <label
          htmlFor="signer-name"
          className="mb-1 block text-sm font-medium text-gray-700"
        >
          Your full name
        </label>
        <input
          id="signer-name"
          type="text"
          autoComplete="name"
          maxLength={120}
          value={signerName}
          onChange={(e) => setSignerName(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
          placeholder="First and last name"
        />
      </div>

      <SignaturePad onChange={setSignature} />

      {submitError && (
        <p className="flex items-center gap-2 text-sm text-red-600">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {submitError}
        </p>
      )}

      <button
        type="button"
        disabled={!canSubmit || submitting}
        onClick={handleSubmit}
        className="w-full rounded-lg bg-teal-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? (
          <span className="inline-flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Signing…
          </span>
        ) : (
          "Agree and sign"
        )}
      </button>

      <p className="text-center text-xs text-gray-400">
        Signing here has the same effect as signing on paper.
      </p>
    </div>
  );
}
