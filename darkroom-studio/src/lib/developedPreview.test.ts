import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultEditState } from "../defaults";
import type { PhotoRecord } from "../types";
import { normalizeMask, updateMaskComponent } from "./maskMath";
import {
  developedPreviewDimensions,
  editRevision,
  previewDimensionBucket,
} from "./developedPreview";

describe("editRevision", () => {
  it("is stable for equivalent edit recipes", () => {
    const left = createDefaultEditState();
    const right = structuredClone(left);
    expect(editRevision(left)).toBe(editRevision(right));
  });

  it("changes when a nested adjustment or brush point changes", () => {
    const baseline = createDefaultEditState();
    const adjusted = structuredClone(baseline);
    adjusted.global.exposure = 0.35;
    expect(editRevision(adjusted)).not.toBe(editRevision(baseline));
  });

  it("changes for the expanded curve, point color, lens blur, and calibration recipe", () => {
    const baseline = createDefaultEditState();
    const recipes = [
      (state: ReturnType<typeof createDefaultEditState>) => { state.blueCurve[1].y = 0.31; },
      (state: ReturnType<typeof createDefaultEditState>) => { state.pointColor.enabled = true; },
      (state: ReturnType<typeof createDefaultEditState>) => { state.lensBlur.enabled = true; },
      (state: ReturnType<typeof createDefaultEditState>) => { state.calibration.redPrimaryHue = 20; },
    ];

    recipes.forEach((change) => {
      const adjusted = structuredClone(baseline);
      change(adjusted);
      expect(editRevision(adjusted)).not.toBe(editRevision(baseline));
    });
  });

  it("reuses unchanged structural sections while still tracking the changed section", () => {
    const baseline = createDefaultEditState();
    const adjusted = {
      ...baseline,
      global: { ...baseline.global, exposure: 0.75 },
    };
    expect(adjusted.masks).toBe(baseline.masks);
    expect(editRevision(adjusted)).not.toBe(editRevision(baseline));
    expect(editRevision(adjusted)).toBe(editRevision(structuredClone(adjusted)));
  });

  it("tracks local sliders and growing strokes while sharing immutable brush history", () => {
    const baseline = createDefaultEditState();
    const mask = normalizeMask({id: 'paint', kind: 'brush', strokes: [{size: 10, flow: 50, feather: 80, points: [{x: 0.2, y: 0.5}]}]});
    baseline.masks = [mask];
    const original = editRevision(baseline);
    const local = {...baseline, masks: [{...mask, adjustments: {...mask.adjustments, exposure: 1}}]};
    expect(editRevision(local)).not.toBe(original);
    expect(editRevision(local)).toBe(editRevision(structuredClone(local)));
    const component = mask.components![0];
    const grown = {...baseline, masks: [updateMaskComponent(mask, component.id, {strokes: [...component.strokes!, {...component.strokes![0], points: [{x: 0.9, y: 0.6}]}]})]};
    expect(editRevision(grown)).not.toBe(original);
    expect(editRevision(grown)).toBe(editRevision(structuredClone(grown)));
    expect(editRevision(baseline)).toBe(original);
  });
});

describe("previewDimensionBucket", () => {
  it("coalesces nearby layout requests into bounded reusable render sizes", () => {
    expect(previewDimensionBucket(128)).toBe(256);
    expect(previewDimensionBucket(220)).toBe(256);
    expect(previewDimensionBucket(257)).toBe(512);
    expect(previewDimensionBucket(900)).toBe(1_024);
    expect(previewDimensionBucket(10_000)).toBe(2_048);
  });
});

describe("developedPreviewDimensions", () => {
  it("caps the long edge and honors a crop", () => {
    const edits = createDefaultEditState();
    edits.crop.width = 0.5;
    expect(developedPreviewDimensions(6_000, 4_000, edits, 600)).toEqual({
      width: 450,
      height: 600,
    });
  });

  it("swaps orientation for a quarter turn", () => {
    const edits = createDefaultEditState();
    edits.geometry.rotate = 90;
    expect(developedPreviewDimensions(6_000, 4_000, edits, 600)).toEqual({
      width: 400,
      height: 600,
    });
  });

  it("includes crop straightening when sizing developed previews", () => {
    const edits = createDefaultEditState();
    edits.crop.angle = 90;
    expect(developedPreviewDimensions(6_000, 4_000, edits, 600)).toEqual({
      width: 400,
      height: 600,
    });
  });
});

describe("deleteDevelopedPreviews", () => {
  type PreviewInfo = { sourceWidth: number; sourceHeight: number };
  const info: PreviewInfo = { sourceWidth: 600, sourceHeight: 400 };
  let deferLoads: boolean;
  let deferEncoding: boolean;
  let pendingLoads: Array<{ blob: Blob; resolve: (info: PreviewInfo) => void }>;
  let pendingEncodes: BlobCallback[];
  let engines: TestImageEngine[];

  class TestImageEngine {
    load = vi.fn((blob: Blob) => deferLoads
      ? new Promise<PreviewInfo>((resolve) => pendingLoads.push({ blob, resolve }))
      : Promise.resolve(info));
    resize = vi.fn();
    render = vi.fn();
    destroy = vi.fn();

    constructor(public canvas: HTMLCanvasElement) {
      engines.push(this);
    }
  }

  function photo(id: string): PhotoRecord {
    return {
      id,
      name: `${id}.jpg`,
      type: "image/jpeg",
      size: 8,
      width: 600,
      height: 400,
      importedAt: "2026-10-03T12:00:00.000Z",
      blob: new Blob([id], { type: "image/jpeg" }),
      objectUrl: `blob:source-${id}`,
      thumbnailUrl: `blob:thumbnail-${id}`,
      metadata: {},
      rating: 0,
      flag: "unflagged",
      colorLabel: "none",
      keywords: [],
      collectionIds: [],
      edits: createDefaultEditState(),
      snapshots: [],
    };
  }

  async function settleRendering() {
    // Drain the render promise's then/catch/finally chain without advancing
    // cache-release timers or resolving the deliberately blocked operations.
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  }

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    deferLoads = false;
    deferEncoding = false;
    pendingLoads = [];
    pendingEncodes = [];
    engines = [];
    let nextUrl = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:preview-${++nextUrl}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 600,
        height: 400,
        toBlob: (callback: BlobCallback) => {
          if (deferEncoding) pendingEncodes.push(callback);
          else callback(new Blob(["preview"], { type: "image/jpeg" }));
        },
      }),
    });
    vi.doMock("./imageEngine", async (importOriginal) => ({
      ...await importOriginal<typeof import("./imageEngine")>(),
      ImageEngine: TestImageEngine,
    }));
  });

  afterEach(() => {
    vi.doUnmock("./imageEngine");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("revokes only removed photos, clears their release timers, and rejects stale reacquisition", async () => {
    const { acquireDevelopedPreview, deleteDevelopedPreviews } = await import("./developedPreview");
    const removed = photo("removed");
    const retained = photo("retained");
    const removedLease = acquireDevelopedPreview(removed, 512);
    const retainedLease = acquireDevelopedPreview(retained, 512);
    const [removedUrl, retainedUrl] = await Promise.all([removedLease.promise, retainedLease.promise]);
    await settleRendering();
    removedLease.release();
    expect(vi.getTimerCount()).toBe(1);

    deleteDevelopedPreviews([removed.id, removed.id]);

    expect(URL.revokeObjectURL).toHaveBeenCalledWith(removedUrl);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(retainedUrl);
    expect(vi.getTimerCount()).toBe(0);
    expect(engines[0].destroy).toHaveBeenCalledOnce();
    expect(engines[0].canvas.width).toBe(1);
    expect(engines[1].destroy).not.toHaveBeenCalled();
    await expect(acquireDevelopedPreview(removed, 512).promise).resolves.toBeNull();
    const secondRetainedLease = acquireDevelopedPreview(retained, 512);
    await expect(secondRetainedLease.promise).resolves.toBe(retainedUrl);
    expect(engines).toHaveLength(2);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);

    deleteDevelopedPreviews([retained.id]);
    retainedLease.release();
    secondRetainedLease.release();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels queued and decoding work and never returns a deleted renderer to the pool", async () => {
    deferLoads = true;
    const { acquireDevelopedPreview, deleteDevelopedPreviews } = await import("./developedPreview");
    const decoding = photo("decoding");
    const retained = photo("retained");
    const queued = photo("queued");
    const decodingLease = acquireDevelopedPreview(decoding, 512);
    const retainedLease = acquireDevelopedPreview(retained, 512);
    const queuedLease = acquireDevelopedPreview(queued, 512);
    expect(engines).toHaveLength(2);

    deleteDevelopedPreviews([decoding.id, queued.id]);
    await expect(decodingLease.promise).resolves.toBeNull();
    await expect(queuedLease.promise).resolves.toBeNull();
    expect(engines[0].destroy).toHaveBeenCalledOnce();

    pendingLoads.find((pending) => pending.blob === retained.blob)!.resolve(info);
    await retainedLease.promise;
    await settleRendering();
    pendingLoads.find((pending) => pending.blob === decoding.blob)!.resolve(info);
    await settleRendering();
    expect(engines[0].render).not.toHaveBeenCalled();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(engines).toHaveLength(2);

    const next = photo("next");
    const nextLease = acquireDevelopedPreview(next, 512);
    expect(engines).toHaveLength(2);
    expect(engines[0].load).toHaveBeenCalledOnce();
    expect(engines[1].load).toHaveBeenCalledTimes(2);
    pendingLoads.find((pending) => pending.blob === next.blob)!.resolve(info);
    await nextLease.promise;
    await settleRendering();
    deleteDevelopedPreviews([retained.id, next.id]);
    [decodingLease, retainedLease, queuedLease, nextLease].forEach((lease) => lease.release());
  });

  it("disposes active encoding even after its view has released the cache entry", async () => {
    deferEncoding = true;
    const { acquireDevelopedPreview, deleteDevelopedPreviews } = await import("./developedPreview");
    const removed = photo("encoding");
    const lease = acquireDevelopedPreview(removed, 512);
    await settleRendering();
    expect(pendingEncodes).toHaveLength(1);
    lease.release();
    await vi.advanceTimersByTimeAsync(0);

    deleteDevelopedPreviews([removed.id]);
    await expect(lease.promise).resolves.toBeNull();
    expect(engines[0].destroy).toHaveBeenCalledOnce();
    pendingEncodes[0](new Blob(["late preview"]));
    await settleRendering();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(engines[0].destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases an idle renderer's source even when its preview already expired", async () => {
    const { acquireDevelopedPreview, deleteDevelopedPreviews } = await import("./developedPreview");
    const removed = photo("expired");
    const lease = acquireDevelopedPreview(removed, 512);
    await lease.promise;
    await settleRendering();
    lease.release();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(engines[0].destroy).not.toHaveBeenCalled();

    deleteDevelopedPreviews([removed.id]);
    expect(engines[0].destroy).toHaveBeenCalledOnce();
    expect(engines[0].canvas.width).toBe(1);
    expect(engines[0].canvas.height).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
