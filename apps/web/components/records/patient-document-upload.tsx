"use client";

import { useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { CLIENT_UPLOAD_TIMEOUT_MS, fetchWithClientTimeout } from "@/lib/client-fetch";
import { PATIENT_DOCUMENT_MAX_BYTES } from "@/lib/upload-limits";
import { isAllowedUploadMimeType } from "@/lib/upload-security";
import {
  selectManagedUploadFile,
  settleManagedUploadAttempt,
  type ManagedUploadAttempt,
} from "@/lib/managed-upload-attempt";

type DocumentCategory = "documents" | "lab-results";
type DocumentAttempt = ManagedUploadAttempt & { category: DocumentCategory };

export function PatientDocumentUpload({ patientId }: { patientId: string }) {
  const { data: session } = useSession();
  const utils = trpc.useUtils();
  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const [category, setCategory] = useState<DocumentCategory>("documents");
  const [file, setFile] = useState<File | null>(null);
  const [attempt, setAttempt] = useState<DocumentAttempt | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!session?.user || session.user.role === "viewer") return null;

  async function upload() {
    if (!file || busyRef.current) return;
    if (!isAllowedUploadMimeType(file.type) || file.size > PATIENT_DOCUMENT_MAX_BYTES || file.size === 0) {
      setError("Choose a PDF, JPG, PNG, or WebP file up to 4 MB. Compress or split large records into smaller PDFs.");
      return;
    }
    const current = attempt ?? { ...selectManagedUploadFile(null, file), category };
    busyRef.current = true;
    setUploading(true);
    setAttempt(current);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", current.file);
      body.append("category", current.category);
      body.append("patientId", patientId);
      const response = await fetchWithClientTimeout("/api/upload", {
        method: "POST",
        headers: { "Idempotency-Key": current.idempotencyKey },
        body,
      }, CLIENT_UPLOAD_TIMEOUT_MS);
      if (!response.ok) {
        const next = settleManagedUploadAttempt(current, { kind: "response", status: response.status });
        setAttempt(next ? current : null);
        const detail = await response.json().catch(() => null);
        setError(typeof detail?.error === "string" ? detail.error : "Upload failed. Please try again.");
        return;
      }
      setAttempt(null);
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      toast.success(current.category === "lab-results" ? "Lab report attached" : "Document uploaded");
      // The upload has succeeded even if refreshing the list subsequently fails.
      void utils.records.listPatientFiles.invalidate({ patientId });
    } catch {
      setAttempt(current);
      setError("The upload could not be confirmed. Retry to safely check and finish the same upload.");
    } finally {
      busyRef.current = false;
      setUploading(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-medium">Add a patient document</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Attach previous records, referrals, scans, or external lab reports. PDF, JPG, PNG, or WebP; up to 4 MB per file. Compress or split larger files.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-xs font-medium">
          <span className="block">Document category</span>
          <select
            aria-label="Document category"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={category}
            disabled={uploading || !!attempt}
            onChange={(event) => setCategory(event.target.value as DocumentCategory)}
          >
            <option value="documents">External record</option>
            <option value="lab-results">Lab report</option>
          </select>
        </label>
        <label className="min-w-0 flex-1 space-y-1 text-xs font-medium">
          <span className="block">File</span>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            disabled={uploading || !!attempt}
            className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-2"
            onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(null); }}
          />
        </label>
        <Button type="button" size="sm" onClick={() => void upload()} disabled={!file || uploading}>
          {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
          {uploading ? "Uploading…" : attempt ? "Retry upload" : "Upload document"}
        </Button>
      </div>
      {category === "lab-results" && <p className="mt-2 text-xs text-muted-foreground">The original report is saved in Documents. Results are not automatically entered into lab values.</p>}
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  );
}
