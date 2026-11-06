/**
 * Turn an uploaded logo into a small PNG for previews, and pick the color
 * that best represents it. Browser-only; nothing leaves the device here.
 */

export const BUILD_LOGO_MAX_BYTES = 5 * 1024 * 1024;
const LOGO_EDGE_PX = 256;
const SAMPLE_EDGE_PX = 48;

export interface ProcessedLogo {
  dataUrl: string;
  /** The logo's most characteristic color, or null for monochrome logos. */
  color: string | null;
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file isn't an image we can read."));
    };
    image.src = url;
  });
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((v) => Math.round(v).toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * The dominant saturated color: pixels are grouped into coarse buckets and
 * weighted by saturation, ignoring transparency, white, black, and greys.
 */
export function dominantColor(data: Uint8ClampedArray): string | null {
  const buckets = new Map<
    number,
    { weight: number; r: number; g: number; b: number }
  >();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const a = data[i + 3]!;
    if (a < 200) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min < 40 || max < 40 || min > 225) continue;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const weight = (max - min) / 255;
    const bucket = buckets.get(key) ?? { weight: 0, r: 0, g: 0, b: 0 };
    bucket.weight += weight;
    bucket.r += r * weight;
    bucket.g += g * weight;
    bucket.b += b * weight;
    buckets.set(key, bucket);
  }
  let best: { weight: number; r: number; g: number; b: number } | null = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.weight > best.weight) best = bucket;
  }
  if (!best || best.weight < 1) return null;
  return toHex(best.r / best.weight, best.g / best.weight, best.b / best.weight);
}

export async function processLogo(file: File): Promise<ProcessedLogo> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Choose a PNG, JPG, SVG, or WebP image.");
  }
  if (file.size > BUILD_LOGO_MAX_BYTES) {
    throw new Error("Choose an image under 5 MB.");
  }
  const image = await loadImage(file);
  const scale = Math.min(
    1,
    LOGO_EDGE_PX / Math.max(image.naturalWidth || 1, image.naturalHeight || 1),
  );
  const width = Math.max(1, Math.round((image.naturalWidth || LOGO_EDGE_PX) * scale));
  const height = Math.max(1, Math.round((image.naturalHeight || LOGO_EDGE_PX) * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Your browser couldn't read that image.");
  context.drawImage(image, 0, 0, width, height);
  const dataUrl = canvas.toDataURL("image/png");

  const sample = document.createElement("canvas");
  sample.width = SAMPLE_EDGE_PX;
  sample.height = SAMPLE_EDGE_PX;
  const sampleContext = sample.getContext("2d");
  let color: string | null = null;
  if (sampleContext) {
    sampleContext.drawImage(image, 0, 0, SAMPLE_EDGE_PX, SAMPLE_EDGE_PX);
    color = dominantColor(
      sampleContext.getImageData(0, 0, SAMPLE_EDGE_PX, SAMPLE_EDGE_PX).data,
    );
  }
  return { dataUrl, color };
}

/** A data URL back into a File for the regular logo upload after signup. */
export function dataUrlToFile(dataUrl: string, name: string): File | null {
  const match = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) return null;
  const bytes = Uint8Array.from(atob(match[2]!), (c) => c.charCodeAt(0));
  return new File([bytes], name, { type: match[1] });
}
