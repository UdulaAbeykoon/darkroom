import type { EditState, PhotoRecord } from "../types";
import { ImageEngine, orientedFrameDimensions } from "./imageEngine";
import { renderBlobForPhoto } from "./rawImage";

const MAX_CONCURRENT_RENDERS = 2;
const MAX_CACHE_ENTRIES = 48;
const RELEASE_DELAY_MS = 30_000;
const SUPERSEDED_RELEASE_DELAY_MS = 1_000;

type PreviewStatus = "queued" | "rendering" | "ready" | "failed";

type PreviewEntry = {
  key: string;
  photo: PhotoRecord;
  maxDimension: number;
  status: PreviewStatus;
  references: number;
  lastUsed: number;
  cancelled: boolean;
  url: string | null;
  promise: Promise<string | null>;
  resolve: (url: string | null) => void;
  releaseTimer: ReturnType<typeof setTimeout> | null;
};

type PreviewRenderer = {
  canvas: HTMLCanvasElement;
  engine: ImageEngine;
  sourceBlob: Blob | null;
  sourceLimit: number;
  sourceInfo: {
    sourceWidth: number;
    sourceHeight: number;
  } | null;
};

export type DevelopedPreviewLease = {
  key: string;
  promise: Promise<string | null>;
  release: () => void;
};

const revisionMemo = new WeakMap<object, string>();
const structuralRevisionMemo = new WeakMap<object, string>();
const previewEntries = new Map<string, PreviewEntry>();
const renderQueue: PreviewEntry[] = [];
const availableRenderers: PreviewRenderer[] = [];
let activeRenders = 0;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

function hashString(value: string): string {
  // Two independent 32-bit accumulators make accidental cache collisions
  // vanishingly unlikely while keeping DOM-facing keys compact.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(
    second >>> 0
  )
    .toString(16)
    .padStart(8, "0")}`;
}

/**
 * A deterministic revision for the complete non-destructive edit recipe.
 * Photo records replace `edits` immutably, so the WeakMap avoids repeatedly
 * serializing large brush masks during unrelated React renders.
 */
export function editRevision(edits: EditState): string {
  const reference = edits as object;
  const memoized = revisionMemo.get(reference);
  if (memoized) return memoized;

  // Share tokens recursively: changing a mask's exposure or gradient must not
  // serialize all its saved brush points for navigator / filmstrip previews.
  const structuralToken = (value: unknown): string => {
    if (!value || typeof value !== "object") {
      return `${typeof value}:${String(value)}`;
    }
    const object = value as object;
    const cached = structuralRevisionMemo.get(object);
    if (cached) return cached;
    const serialized = Array.isArray(value)
      ? `array:${JSON.stringify(value.map(structuralToken))}`
      : `object:${JSON.stringify(Object.keys(value).sort()
          .filter(key => (value as Record<string, unknown>)[key] !== undefined)
          .map(key => [key, structuralToken((value as Record<string, unknown>)[key])]))}`;
    const token = `${hashString(serialized)}-${serialized.length.toString(36)}`;
    structuralRevisionMemo.set(object, token);
    return token;
  };
  const serialized = Object.keys(edits)
    .sort()
    .map((key) => `${key}=${structuralToken(edits[key as keyof EditState])}`)
    .join("|");
  const revision = `${hashString(serialized)}-${serialized.length.toString(36)}`;
  revisionMemo.set(reference, revision);
  return revision;
}

/** Buckets nearby layout sizes so one developed render can serve several views. */
export function previewDimensionBucket(requestedMaxDimension: number): number {
  const requested = clamp(Math.round(requestedMaxDimension), 128, 2_048);
  if (requested <= 256) return 256;
  if (requested <= 512) return 512;
  if (requested <= 1_024) return 1_024;
  return 2_048;
}

export function developedPreviewDimensions(
  sourceWidth: number,
  sourceHeight: number,
  edits: EditState,
  maxDimension: number,
): { width: number; height: number } {
  const cropWidth =
    Math.max(1, sourceWidth) * clamp(edits.crop.width, 0.000001, 1);
  const cropHeight =
    Math.max(1, sourceHeight) * clamp(edits.crop.height, 0.000001, 1);
  const aspectScale = Math.max(
    0.05,
    1 + (Number.isFinite(edits.geometry.aspect) ? edits.geometry.aspect : 0) / 100,
  );
  const oriented = orientedFrameDimensions(
    cropWidth * aspectScale,
    cropHeight,
    edits.geometry.rotate + edits.crop.angle,
  );
  const safeMaximum = clamp(Math.round(maxDimension), 128, 2_048);
  const scale = Math.min(
    1,
    safeMaximum / Math.max(oriented.width, oriented.height),
  );
  return {
    width: Math.max(1, Math.round(oriented.width * scale)),
    height: Math.max(1, Math.round(oriented.height * scale)),
  };
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("The browser could not encode the developed preview."));
      },
      "image/jpeg",
      0.86,
    );
  });
}

function acquireRenderer(): PreviewRenderer {
  const existing = availableRenderers.pop();
  if (existing) return existing;
  const canvas = document.createElement("canvas");
  return {
    canvas,
    engine: new ImageEngine(canvas),
    sourceBlob: null,
    sourceLimit: 0,
    sourceInfo: null,
  };
}

function releaseRenderer(renderer: PreviewRenderer, broken = false): void {
  if (broken) {
    renderer.engine.destroy();
    return;
  }
  availableRenderers.push(renderer);
}

async function renderPreview(
  entry: PreviewEntry,
  renderer: PreviewRenderer,
): Promise<string> {
  if (typeof document === "undefined") {
    throw new Error("Developed previews require a browser document.");
  }

  const { photo, maxDimension } = entry;
  const renderBlob = renderBlobForPhoto(photo);
  // Loading at roughly twice the output resolution keeps crop and mask edges
  // clean without decoding every original at full camera resolution.
  const sourceLimit = Math.min(4_096, Math.max(512, maxDimension * 2));
  let info = renderer.sourceInfo;
  if (
    renderer.sourceBlob !== renderBlob ||
    renderer.sourceLimit !== sourceLimit ||
    !info
  ) {
    info = await renderer.engine.load(renderBlob, sourceLimit);
    renderer.sourceBlob = renderBlob;
    renderer.sourceLimit = sourceLimit;
    renderer.sourceInfo = {
      sourceWidth: info.sourceWidth,
      sourceHeight: info.sourceHeight,
    };
  }
  if (entry.cancelled) throw new Error("Developed preview superseded.");
  const dimensions = developedPreviewDimensions(
    info.sourceWidth,
    info.sourceHeight,
    photo.edits,
    maxDimension,
  );
  renderer.engine.resize(dimensions.width, dimensions.height, 1);
  renderer.engine.render(photo.edits);
  if (entry.cancelled) throw new Error("Developed preview superseded.");
  const blob = await canvasToBlob(renderer.canvas);
  return URL.createObjectURL(blob);
}

function removeEntry(entry: PreviewEntry): void {
  if (previewEntries.get(entry.key) === entry) {
    previewEntries.delete(entry.key);
  }
  if (entry.releaseTimer) {
    clearTimeout(entry.releaseTimer);
    entry.releaseTimer = null;
  }
  if (entry.url) {
    URL.revokeObjectURL(entry.url);
    entry.url = null;
  }
}

function pruneCache(): void {
  if (previewEntries.size <= MAX_CACHE_ENTRIES) return;
  const disposable = [...previewEntries.values()]
    .filter((entry) => entry.references === 0 && entry.status === "ready")
    .sort((left, right) => left.lastUsed - right.lastUsed);
  while (
    previewEntries.size > MAX_CACHE_ENTRIES &&
    disposable.length
  ) {
    removeEntry(disposable.shift()!);
  }
}

function retireSupersededEntries(current: PreviewEntry): void {
  for (const candidate of previewEntries.values()) {
    if (
      candidate === current ||
      candidate.photo.id !== current.photo.id ||
      candidate.maxDimension !== current.maxDimension ||
      candidate.references > 0 ||
      candidate.status !== "ready"
    ) {
      continue;
    }
    if (candidate.releaseTimer) clearTimeout(candidate.releaseTimer);
    candidate.releaseTimer = setTimeout(() => {
      candidate.releaseTimer = null;
      if (candidate.references === 0) removeEntry(candidate);
    }, SUPERSEDED_RELEASE_DELAY_MS);
  }
}

function pumpQueue(): void {
  while (activeRenders < MAX_CONCURRENT_RENDERS && renderQueue.length) {
    const entry = renderQueue.shift()!;
    if (entry.cancelled || previewEntries.get(entry.key) !== entry) {
      entry.status = "failed";
      entry.resolve(null);
      continue;
    }

    activeRenders += 1;
    entry.status = "rendering";
    const renderer = acquireRenderer();
    let rendererBroken = false;
    void renderPreview(entry, renderer)
      .then((url) => {
        if (entry.cancelled || previewEntries.get(entry.key) !== entry) {
          URL.revokeObjectURL(url);
          entry.status = "failed";
          entry.resolve(null);
          return;
        }
        entry.url = url;
        entry.status = "ready";
        entry.lastUsed = Date.now();
        entry.resolve(url);
        retireSupersededEntries(entry);
        pruneCache();
      })
      .catch(() => {
        rendererBroken = !entry.cancelled;
        entry.status = "failed";
        entry.resolve(null);
        if (previewEntries.get(entry.key) === entry) {
          previewEntries.delete(entry.key);
        }
      })
      .finally(() => {
        releaseRenderer(renderer, rendererBroken);
        activeRenders -= 1;
        pumpQueue();
      });
  }
}

function createEntry(
  key: string,
  photo: PhotoRecord,
  maxDimension: number,
): PreviewEntry {
  let resolve!: (url: string | null) => void;
  const promise = new Promise<string | null>((settle) => {
    resolve = settle;
  });
  const entry: PreviewEntry = {
    key,
    photo,
    maxDimension,
    status: "queued",
    references: 0,
    lastUsed: Date.now(),
    cancelled: false,
    url: null,
    promise,
    resolve,
    releaseTimer: null,
  };
  previewEntries.set(key, entry);
  renderQueue.push(entry);
  pumpQueue();
  return entry;
}

function releaseEntry(entry: PreviewEntry): void {
  entry.references = Math.max(0, entry.references - 1);
  entry.lastUsed = Date.now();
  if (entry.references > 0 || entry.releaseTimer) return;

  const releaseDelay =
    entry.status === "queued" || entry.status === "rendering"
      ? 0
      : RELEASE_DELAY_MS;
  entry.releaseTimer = setTimeout(() => {
    entry.releaseTimer = null;
    if (entry.references > 0) return;
    if (entry.status === "queued" || entry.status === "rendering") {
      entry.cancelled = true;
      if (previewEntries.get(entry.key) === entry) {
        previewEntries.delete(entry.key);
      }
      return;
    }
    removeEntry(entry);
  }, releaseDelay);
}

export function acquireDevelopedPreview(
  photo: PhotoRecord,
  requestedMaxDimension: number,
): DevelopedPreviewLease {
  const maxDimension = previewDimensionBucket(requestedMaxDimension);
  const key = [
    photo.id,
    photo.size,
    photo.type,
    editRevision(photo.edits),
    maxDimension,
  ].join(":");
  let entry = previewEntries.get(key);
  if (!entry || entry.cancelled || entry.status === "failed") {
    entry = createEntry(key, photo, maxDimension);
  }
  if (entry.releaseTimer) {
    clearTimeout(entry.releaseTimer);
    entry.releaseTimer = null;
  }
  entry.references += 1;
  entry.lastUsed = Date.now();

  let released = false;
  return {
    key,
    promise: entry.promise,
    release: () => {
      if (released) return;
      released = true;
      releaseEntry(entry);
    },
  };
}
