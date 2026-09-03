import type {
  LibRawImageData,
  LibRawMetadata,
} from "libraw-wasm";
import type { PhotoMetadata, PhotoRecord } from "../types";

const MEBIBYTE = 1024 * 1024;
const HALF_SIZE_THRESHOLD_BYTES = 48 * MEBIBYTE;
const MAX_DECODED_PIXELS = 50_000_000;

const RAW_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  "3fr": "image/x-hasselblad-3fr",
  arw: "image/x-sony-arw",
  cr2: "image/x-canon-cr2",
  cr3: "image/x-canon-cr3",
  crw: "image/x-canon-crw",
  dcr: "image/x-kodak-dcr",
  dng: "image/x-adobe-dng",
  erf: "image/x-epson-erf",
  fff: "image/x-hasselblad-fff",
  iiq: "image/x-phaseone-iiq",
  kdc: "image/x-kodak-kdc",
  mef: "image/x-mamiya-mef",
  mos: "image/x-leaf-mos",
  mrw: "image/x-minolta-mrw",
  nef: "image/x-nikon-nef",
  nrw: "image/x-nikon-nrw",
  orf: "image/x-olympus-orf",
  pef: "image/x-pentax-pef",
  ptx: "image/x-pentax-ptx",
  raf: "image/x-fujifilm-raf",
  raw: "image/x-camera-raw",
  rw2: "image/x-panasonic-rw2",
  rwl: "image/x-leica-rwl",
  sr2: "image/x-sony-sr2",
  srf: "image/x-sony-srf",
  srw: "image/x-samsung-srw",
  x3f: "image/x-sigma-x3f",
};

export const CAMERA_RAW_EXTENSIONS = new Set(
  Object.keys(RAW_MIME_BY_EXTENSION),
);

export const CAMERA_RAW_MIME_TYPES = new Set([
  ...Object.values(RAW_MIME_BY_EXTENSION),
  "image/x-dcraw",
  "image/x-raw",
]);

export const CAMERA_RAW_ACCEPT = [
  ...Array.from(CAMERA_RAW_EXTENSIONS, (extension) => `.${extension}`),
  ...CAMERA_RAW_MIME_TYPES,
].join(",");

export interface CameraRawInfo {
  extension: string;
  mimeType: string;
}

export interface DecodedCameraRaw {
  blob: Blob;
  width: number;
  height: number;
  metadata: PhotoMetadata;
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1).toLowerCase() : "";
}

export function cameraRawInfo(
  file: Pick<File, "name" | "type">,
): CameraRawInfo | undefined {
  const extension = extensionOf(file.name);
  const mime = file.type.toLowerCase().split(";")[0].trim();
  const extensionMime = RAW_MIME_BY_EXTENSION[extension];

  if (extensionMime) {
    return { extension, mimeType: extensionMime };
  }
  if (CAMERA_RAW_MIME_TYPES.has(mime)) {
    return { extension: extension || "raw", mimeType: mime };
  }
  return undefined;
}

export function isCameraRawFile(
  file: Pick<File, "name" | "type">,
): boolean {
  return Boolean(cameraRawInfo(file));
}

/** The exact selected source stays in `blob`; renderers consume this proxy. */
export function renderBlobForPhoto(
  photo: Pick<PhotoRecord, "blob" | "renderBlob">,
): Blob {
  return photo.renderBlob instanceof Blob ? photo.renderBlob : photo.blob;
}

function validText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function cameraLabel(metadata: LibRawMetadata): string | undefined {
  const make = validText(metadata.camera_make);
  const model = validText(metadata.camera_model);
  if (!make) return model;
  if (!model || model.toLowerCase().startsWith(make.toLowerCase())) {
    return model ?? make;
  }
  return `${make} ${model}`;
}

function exposureLabel(seconds: number | undefined): string | undefined {
  if (!seconds) return undefined;
  if (seconds < 1) return `1/${Math.max(1, Math.round(1 / seconds))}s`;
  return `${Number(seconds.toFixed(2))}s`;
}

function gpsCoordinate(
  parts: [number, number, number] | undefined,
  reference: string | null | undefined,
): number | undefined {
  if (!parts || parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
    return undefined;
  }
  const decimal = Math.abs(parts[0]) + parts[1] / 60 + parts[2] / 3600;
  return reference === "S" || reference === "W" ? -decimal : decimal;
}

function metadataFromRaw(metadata: LibRawMetadata | undefined): PhotoMetadata {
  if (!metadata) return {};
  const capturedAt =
    metadata.timestamp instanceof Date &&
    Number.isFinite(metadata.timestamp.getTime()) &&
    metadata.timestamp.getUTCFullYear() > 1970
      ? metadata.timestamp.toISOString()
      : undefined;
  const gps = metadata.gps_data?.gpsparsed ? metadata.gps_data : undefined;

  return {
    camera: cameraLabel(metadata),
    lens: validText(metadata.lens?.Lens),
    iso: finitePositive(metadata.iso_speed),
    aperture: finitePositive(metadata.aperture),
    shutter: exposureLabel(finitePositive(metadata.shutter)),
    focalLength: finitePositive(metadata.focal_len),
    capturedAt,
    latitude: gpsCoordinate(gps?.latitude, gps?.latref),
    longitude: gpsCoordinate(gps?.longitude, gps?.longref),
    copyright: validText(metadata.artist),
    caption: validText(metadata.desc),
  };
}

function rawSampleToByte(
  sample: number,
  bits: number,
  sixteenBit: boolean,
): number {
  if (!sixteenBit) return sample;
  const maximum = Math.min(65_535, Math.max(255, 2 ** Math.min(16, bits) - 1));
  return Math.round((sample / maximum) * 255);
}

/** Converts LibRaw's packed RGB/RGBG output to browser ImageData pixels. */
export function rawPixelsToRgba(
  image: LibRawImageData,
): Uint8ClampedArray<ArrayBuffer> {
  const { width, height, colors, bits, data } = image;
  const pixelCount = width * height;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    pixelCount > MAX_DECODED_PIXELS
  ) {
    throw new Error("The decoded RAW dimensions exceed the browser safety limit.");
  }
  if (!Number.isInteger(colors) || colors < 1 || colors > 4) {
    throw new Error("The RAW decoder returned an unsupported color layout.");
  }
  if (data.length < pixelCount * colors) {
    throw new Error("The RAW decoder returned incomplete pixel data.");
  }

  const output = new Uint8ClampedArray(new ArrayBuffer(pixelCount * 4));
  const sixteenBit = data instanceof Uint16Array || bits > 8;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const source = pixel * colors;
    const target = pixel * 4;
    const red = rawSampleToByte(data[source], bits, sixteenBit);
    const green = rawSampleToByte(
      data[source + Math.min(1, colors - 1)],
      bits,
      sixteenBit,
    );
    const blue = rawSampleToByte(
      data[source + Math.min(2, colors - 1)],
      bits,
      sixteenBit,
    );
    output[target] = red;
    output[target + 1] = green;
    output[target + 2] = blue;
    output[target + 3] = 255;
  }
  return output;
}

function canvasToJpeg(
  width: number,
  height: number,
  pixels: Uint8ClampedArray<ArrayBuffer>,
): Promise<Blob> {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("The browser could not create a RAW canvas.");
    const image = new ImageData(pixels, width, height);
    context.putImageData(image, 0, 0);
    return canvas.convertToBlob({ type: "image/jpeg", quality: 0.96 });
  }

  if (typeof document === "undefined") {
    throw new Error("The browser has no canvas encoder for RAW images.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("The browser could not create a RAW canvas.");
  const image = new ImageData(pixels, width, height);
  context.putImageData(image, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("The browser could not encode the decoded RAW image.")),
      "image/jpeg",
      0.96,
    );
  });
}

function rawDecodeError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const isolationHint =
    typeof crossOriginIsolated === "boolean" && !crossOriginIsolated
      ? " This deployment must serve COOP/COEP headers for the local RAW worker."
      : "";
  return new Error(
    `This camera RAW could not be decoded locally${detail ? ` (${detail})` : ""}.${isolationHint}`,
  );
}

/**
 * Demosaics one camera RAW locally. The decoder and its 1.4 MB WASM runtime are
 * loaded only after a RAW file is selected, and the worker is always released.
 */
export async function decodeCameraRaw(file: Blob): Promise<DecodedCameraRaw> {
  let decoder: InstanceType<(typeof import("libraw-wasm"))["default"]> | undefined;
  try {
    const { default: LibRaw } = await import("libraw-wasm");
    decoder = new LibRaw();
    const bytes = new Uint8Array(await file.arrayBuffer());
    await decoder.open(bytes, {
      halfSize: file.size > HALF_SIZE_THRESHOLD_BYTES,
      useCameraWb: true,
      useCameraMatrix: 3,
      outputColor: 1,
      outputBps: 8,
      userFlip: -1,
      userQual: 3,
    });

    const metadata = await decoder.metadata(false).catch(() => undefined);
    const image = await decoder.imageData();
    if (!image) throw new Error("The RAW decoder returned no image pixels.");
    const pixels = rawPixelsToRgba(image);
    // The WASM runtime starts with a large shared heap. Release it before the
    // browser allocates its canvas backing store and JPEG encoder buffers.
    decoder.dispose();
    decoder = undefined;
    const blob = await canvasToJpeg(image.width, image.height, pixels);
    return {
      blob,
      width: image.width,
      height: image.height,
      metadata: metadataFromRaw(metadata),
    };
  } catch (error) {
    throw rawDecodeError(error);
  } finally {
    decoder?.dispose();
  }
}
