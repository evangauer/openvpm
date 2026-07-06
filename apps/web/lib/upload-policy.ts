import { UPLOAD_FILE_MAX_BYTES } from "@/lib/upload-limits";
import { isAllowedImageUploadMimeType } from "@/lib/upload-security";

export const IMAGE_UPLOAD_POLICY_MESSAGE =
  "Images must be JPG, PNG, or WebP and 10 MB or less.";

export function isImageUploadFileValid(file: {
  size: number;
  type: string;
}): boolean {
  return (
    file.size <= UPLOAD_FILE_MAX_BYTES &&
    isAllowedImageUploadMimeType(file.type)
  );
}
