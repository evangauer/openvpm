"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Camera, Loader2, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

const CAPTURE_POLL_INTERVAL_MS = 5_000;

/**
 * "Capture photos" button + QR modal. Staff open it during a consult; anyone
 * scans the QR with a phone and lands on the no-login /capture/[token] page.
 * Photos attach to this patient and appear here as thumbnails while the
 * modal is open. Mount only for roles that can manage the patient.
 */
export function CapturePhotos({
  patientId,
  appointmentId,
}: {
  patientId: string;
  appointmentId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const baselineCountRef = useRef<number | null>(null);

  const createSession = trpc.records.createCaptureSession.useMutation({
    onError: (err) => toast.error(err.message),
  });

  const captureFiles = trpc.records.listCaptureFiles.useQuery(
    { patientId },
    {
      enabled: open,
      refetchInterval: open ? CAPTURE_POLL_INTERVAL_MS : false,
    }
  );

  const session = createSession.data;

  useEffect(() => {
    let cancelled = false;
    if (!session?.url) {
      setQrDataUrl(null);
      return;
    }
    QRCode.toDataURL(session.url, { width: 240, margin: 1 })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.url]);

  // Photo count baseline: the first list we see after opening. Anything above
  // it arrived through this capture session.
  useEffect(() => {
    if (!open) {
      baselineCountRef.current = null;
      return;
    }
    if (baselineCountRef.current === null && captureFiles.data) {
      baselineCountRef.current = captureFiles.data.length;
    }
  }, [open, captureFiles.data]);

  function handleOpen() {
    setOpen(true);
    createSession.mutate({ patientId, appointmentId });
  }

  function handleClose() {
    setOpen(false);
    createSession.reset();
    setQrDataUrl(null);
  }

  const files = captureFiles.data ?? [];
  const addedCount = Math.max(
    0,
    files.length - (baselineCountRef.current ?? files.length)
  );
  const recentFiles = files.slice(0, addedCount > 0 ? addedCount : 0);

  return (
    <>
      <Button variant="outline" size="sm" onClick={handleOpen}>
        <Camera className="mr-2 h-4 w-4" />
        Capture photos
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-[90] overflow-y-auto bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Capture photos"
        >
          <div className="flex min-h-full items-center justify-center">
            <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-xl">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-heading text-base font-semibold">
                    Capture photos
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Scan with any phone. The code works for 30 minutes.
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

              <div className="mt-4 flex flex-col items-center gap-3">
                {createSession.isPending ? (
                  <div className="flex h-60 w-60 items-center justify-center rounded-lg border border-border bg-muted/30">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : createSession.isError ? (
                  <div className="flex h-60 w-full flex-col items-center justify-center gap-3 rounded-lg border border-border bg-muted/30 p-4 text-center">
                    <p className="text-sm text-muted-foreground">
                      Could not make a code. Please try again.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        createSession.mutate({ patientId, appointmentId })
                      }
                    >
                      <RefreshCw className="mr-2 h-4 w-4" />
                      Try again
                    </Button>
                  </div>
                ) : (
                  <>
                    {qrDataUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={qrDataUrl}
                        alt="QR code for the photo capture link"
                        className="h-60 w-60 rounded-lg border border-border bg-white p-2"
                      />
                    ) : (
                      <div className="flex h-60 w-60 items-center justify-center rounded-lg border border-border bg-muted/30">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                      </div>
                    )}
                    {session?.url && (
                      <p className="w-full break-all text-center text-xs text-muted-foreground">
                        {session.url}
                      </p>
                    )}
                  </>
                )}
              </div>

              <div className="mt-5 border-t border-border pt-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">
                    {addedCount === 0
                      ? "No photos yet"
                      : addedCount === 1
                        ? "1 photo added"
                        : `${addedCount} photos added`}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    New photos show up here.
                  </p>
                </div>
                {recentFiles.length > 0 && (
                  <div className="mt-3 grid grid-cols-4 gap-2">
                    {recentFiles.map((file) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={file.id}
                        src={file.fileUrl}
                        alt={file.fileName}
                        className="aspect-square w-full rounded-md border border-border object-cover"
                      />
                    ))}
                  </div>
                )}
              </div>

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
