"use client";

import { useRef, useState } from "react";
import { AlertCircle, Camera, CheckCircle2, Loader2 } from "lucide-react";
import {
  IMAGE_UPLOAD_POLICY_MESSAGE,
  isImageUploadFileValid,
} from "@/lib/upload-policy";
import { isRetryableUploadStatus } from "@/lib/managed-upload-attempt";

const EXPIRED_MESSAGE =
  "This link has expired. Ask the front desk for a new code.";

type UploadStatus = "uploading" | "done" | "error";

interface UploadItem {
  id: string;
  idempotencyKey: string;
  file: File;
  name: string;
  progress: number;
  status: UploadStatus;
  retryable: boolean;
  message?: string;
}

function errorMessageForStatus(status: number): string {
  if (status === 404) return EXPIRED_MESSAGE;
  if (status === 429)
    return "Too many uploads right now. Wait a minute and try again.";
  if (status === 409)
    return "This capture link cannot accept another photo. Ask the clinic for a new link.";
  if (status === 400 || status === 413) return IMAGE_UPLOAD_POLICY_MESSAGE;
  return "The upload failed. Please try again.";
}

/** Upload one file with progress via XHR (fetch has no upload progress). */
function uploadWithProgress(
  url: string,
  file: File,
  idempotencyKey: string,
  onProgress: (percent: number) => void,
): Promise<{ ok: boolean; status: number }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Idempotency-Key", idempotencyKey);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () =>
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
      });
    xhr.onerror = () => resolve({ ok: false, status: 0 });
    const formData = new FormData();
    formData.append("file", file);
    xhr.send(formData);
  });
}

export function CaptureClient({ token }: { token: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [linkExpired, setLinkExpired] = useState(false);
  const nextIdRef = useRef(0);

  const uploadingCount = items.filter((i) => i.status === "uploading").length;
  const doneCount = items.filter((i) => i.status === "done").length;
  const allSettled = items.length > 0 && uploadingCount === 0;

  function updateItem(id: string, patch: Partial<UploadItem>) {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }

  async function performUpload(item: UploadItem) {
    updateItem(item.id, {
      progress: 0,
      status: "uploading",
      message: undefined,
    });
    const result = await uploadWithProgress(
      `/api/capture/${encodeURIComponent(token)}`,
      item.file,
      item.idempotencyKey,
      (percent) => updateItem(item.id, { progress: percent }),
    );

    if (result.ok) {
      updateItem(item.id, { status: "done", progress: 100 });
      return;
    }

    if (result.status === 404) {
      setLinkExpired(true);
    }
    updateItem(item.id, {
      status: "error",
      retryable: isRetryableUploadStatus(result.status),
      message: errorMessageForStatus(result.status),
    });
  }

  async function uploadOne(file: File) {
    const id = `upload-${nextIdRef.current++}`;
    const idempotencyKey = crypto.randomUUID();
    if (!isImageUploadFileValid(file)) {
      setItems((prev) => [
        ...prev,
        {
          id,
          idempotencyKey,
          file,
          name: file.name,
          progress: 0,
          status: "error",
          retryable: false,
          message: IMAGE_UPLOAD_POLICY_MESSAGE,
        },
      ]);
      return;
    }

    const item: UploadItem = {
      id,
      idempotencyKey,
      file,
      name: file.name,
      progress: 0,
      status: "uploading",
      retryable: true,
    };
    setItems((prev) => [...prev, item]);
    await performUpload(item);
  }

  function handleFilesSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    for (const file of selected) {
      void uploadOne(file);
    }
  }

  return (
    <div className="space-y-4">
      <div className="text-center">
        <h1 className="text-lg font-semibold text-gray-900">
          Add photos to the visit record
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Take a photo or pick one from your phone. It goes straight to the
          clinic.
        </p>
      </div>

      {linkExpired ? (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <p className="text-sm text-amber-800">{EXPIRED_MESSAGE}</p>
        </div>
      ) : (
        <>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            onChange={handleFilesSelected}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-teal-300 bg-teal-50 px-4 py-10 text-teal-700 transition-colors hover:bg-teal-100"
          >
            <Camera className="h-8 w-8" />
            <span className="text-sm font-medium">
              {items.length > 0 ? "Add more photos" : "Take or choose photos"}
            </span>
          </button>
        </>
      )}

      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="rounded-lg border border-gray-200 bg-white p-3"
            >
              <div className="flex items-center gap-3">
                {item.status === "uploading" && (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-teal-600" />
                )}
                {item.status === "done" && (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                )}
                {item.status === "error" && (
                  <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm text-gray-700">
                  {item.name}
                </span>
                {item.status === "uploading" && (
                  <span className="text-xs tabular-nums text-gray-400">
                    {item.progress}%
                  </span>
                )}
              </div>
              {item.status === "uploading" && (
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                  <div
                    className="h-full rounded-full bg-teal-500 transition-all"
                    style={{ width: `${item.progress}%` }}
                  />
                </div>
              )}
              {item.status === "error" && item.message && (
                <div className="mt-1 flex items-center justify-between gap-3">
                  <p className="text-xs text-red-600">{item.message}</p>
                  {item.retryable && !linkExpired && (
                    <button
                      type="button"
                      onClick={() => void performUpload(item)}
                      className="shrink-0 text-xs font-medium text-teal-700 hover:text-teal-800"
                    >
                      Try again
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {allSettled && doneCount > 0 && !linkExpired && (
        <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
          <div>
            <p className="text-sm font-medium text-emerald-800">All set.</p>
            <p className="text-sm text-emerald-700">
              {doneCount === 1
                ? "Your photo was added to the visit record."
                : `Your ${doneCount} photos were added to the visit record.`}{" "}
              You can close this page or add more.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
