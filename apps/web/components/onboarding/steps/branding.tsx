"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ImageIcon, Loader2, Upload } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { AccentColorPicker } from "@/components/brand/accent-color-picker";
import {
  CLIENT_UPLOAD_TIMEOUT_MS,
  fetchWithClientTimeout,
} from "@/lib/client-fetch";
import {
  IMAGE_UPLOAD_POLICY_MESSAGE,
  isImageUploadFileValid,
} from "@/lib/upload-policy";
import { toast } from "sonner";
import type { StepHandle } from "../journey-types";

/** Brand default accent, pre-highlighted so the step never arrives blank. */
const SUGGESTED_ACCENT = "#0d9488";

/**
 * Step 2: optional logo upload and accent color. Both save right away through
 * updatePractice, so Continue has nothing extra to do.
 */
export function BrandingStep({ register }: { register: (h: StepHandle) => void }) {
  const {
    data: practice,
    error: practiceError,
    refetch: refetchPractice,
  } = trpc.settings.getPractice.useQuery();
  const utils = trpc.useUtils();
  const updatePractice = trpc.settings.updatePractice.useMutation({
    onSuccess: () => {
      utils.settings.getPractice.invalidate();
      utils.settings.getBranding.invalidate();
    },
  });

  const savedColor =
    (practice?.settings as { brandColor?: string } | null)?.brandColor ?? null;
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const currentLogo = logoUrl ?? practice?.logoUrl ?? null;

  useEffect(() => {
    // Both pickers save on click, so Continue is a no-op here.
    register({ onContinue: async () => true });
  }, [register]);

  async function handleFile(file: File) {
    if (!isImageUploadFileValid(file)) {
      toast.error(IMAGE_UPLOAD_POLICY_MESSAGE);
      return;
    }

    setUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("category", "branding");
      const res = await fetchWithClientTimeout(
        "/api/upload",
        { method: "POST", body },
        CLIENT_UPLOAD_TIMEOUT_MS
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Upload failed");
      setLogoUrl(json.url);
      await updatePractice.mutateAsync({ logoUrl: json.url });
      toast.success("Logo saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function pickColor(color: string) {
    updatePractice.mutate(
      { brandColor: color },
      { onSuccess: () => toast.success("Color saved") }
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm leading-6 text-slate-600">
        Add your logo and pick a color. This is just for looks, so feel free to
        skip it and come back later.
      </p>

      {practiceError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div>
              <p className="font-medium text-destructive">
                Saved branding could not load
              </p>
              <p className="mt-1 text-slate-600">{practiceError.message}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void refetchPractice()}
                className="mt-3"
              >
                Retry
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Logo */}
      <div className="space-y-2">
        <span className="text-sm font-medium text-slate-700">Your logo</span>
        <div className="flex items-center gap-4">
          {currentLogo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={currentLogo}
              alt="Practice logo"
              className="h-16 w-16 rounded-lg border border-slate-200 object-cover"
            />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-dashed border-slate-300 text-slate-400">
              <ImageIcon className="h-6 w-6" />
            </div>
          )}
          <div>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
                e.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-2 h-4 w-4" />
              )}
              {currentLogo ? "Replace logo" : "Upload logo"}
            </Button>
            <p className="mt-1.5 text-xs text-slate-500">
              PNG, JPG, or WebP. Square images look best.
            </p>
          </div>
        </div>
      </div>

      {/* Accent color */}
      <div className="space-y-2">
        <span className="text-sm font-medium text-slate-700">Accent color</span>
        <AccentColorPicker
          value={savedColor ?? SUGGESTED_ACCENT}
          onChange={pickColor}
          disabled={updatePractice.isPending}
        />
        {!savedColor ? (
          <p className="text-xs text-slate-500">
            We picked a color to start. Tap another if you like.
          </p>
        ) : null}
      </div>
    </div>
  );
}
