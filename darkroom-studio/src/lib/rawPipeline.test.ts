import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  open: vi.fn(),
  metadata: vi.fn(),
  thumbnailData: vi.fn(),
  imageData: vi.fn(),
  dispose: vi.fn(),
  encode: vi.fn(),
  putPixels: vi.fn(),
}));
vi.mock("libraw-wasm", () => ({
  default: class {
    open = mock.open;
    metadata = mock.metadata;
    thumbnailData = mock.thumbnailData;
    imageData = mock.imageData;
    dispose = mock.dispose;
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mock.metadata.mockResolvedValue({ camera_make: "Nikon", width: 2, height: 1 });
  mock.thumbnailData.mockResolvedValue(undefined);
  mock.imageData.mockResolvedValue({
    width: 2, height: 1, colors: 3, bits: 8,
    data: new Uint8Array([0, 128, 255, 44, 55, 66]),
  });
  mock.encode.mockResolvedValue(new Blob(["lossless pixels"], { type: "image/png" }));
  vi.stubGlobal("OffscreenCanvas", class {
    getContext() { return { putImageData: mock.putPixels }; }
    convertToBlob = mock.encode;
  });
  vi.stubGlobal("ImageData", class {
    constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
  });
});
afterEach(() => vi.unstubAllGlobals());

const photo = () => ({
  name: "test.NEF",
  type: "image/x-nikon-nef",
  blob: new Blob(["original sensor bytes"]),
  renderBlob: new Blob(["small lossy preview"], { type: "image/jpeg" }),
  width: 1,
  height: 1,
  metadata: {},
});

describe("quality-safe RAW routing", () => {
  it("fully decodes large RAWs without half-size or intermediate JPEG compression", async () => {
    const { fullRenderForPhoto } = await import("./rawImage");
    const source = photo();
    Object.defineProperty(source.blob, "size", { value: 60 * 1024 * 1024 });
    const result = await fullRenderForPhoto(source);
    expect(mock.open).toHaveBeenCalledWith(
      new TextEncoder().encode("original sensor bytes"),
      expect.objectContaining({ halfSize: false, userQual: 3, outputBps: 8 }),
    );
    expect(mock.encode).toHaveBeenCalledWith({ type: "image/png" });
    expect(result).toMatchObject({ width: 2, height: 1, renderKind: "full-resolution" });
    expect(result.blob.type).toBe("image/png");
    expect([...mock.putPixels.mock.calls[0][0].data]).toEqual([0, 128, 255, 255, 44, 55, 66, 255]);
    expect(await source.blob.text()).toBe("original sensor bytes");
    expect(mock.dispose).toHaveBeenCalledTimes(1);
    expect(mock.dispose.mock.invocationCallOrder[0]).toBeLessThan(mock.encode.mock.invocationCallOrder[0]);
  });

  it("coalesces concurrent requests and retains only the most recent decoded original", async () => {
    const { fullRenderBlobForPhoto } = await import("./rawImage");
    const source = photo();
    const [first, second] = await Promise.all([
      fullRenderBlobForPhoto(source), fullRenderBlobForPhoto(source),
    ]);
    expect(first).toBe(second);
    expect(mock.open).toHaveBeenCalledTimes(1);
    await fullRenderBlobForPhoto(photo());
    await fullRenderBlobForPhoto(source);
    expect(mock.open).toHaveBeenCalledTimes(3);
  });

  it("serializes different RAW files to keep only one decoder heap active", async () => {
    const { decodeCameraRaw } = await import("./rawImage");
    let release: (() => void) | undefined;
    mock.imageData.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ width: 1, height: 1, colors: 3, bits: 8, data: new Uint8Array([1, 2, 3]) });
    }));
    const first = decodeCameraRaw(photo().blob);
    const second = decodeCameraRaw(photo().blob);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(mock.open).toHaveBeenCalledTimes(1);
    release!();
    await Promise.all([first, second]);
    expect(mock.open).toHaveBeenCalledTimes(2);
    expect(mock.dispose.mock.invocationCallOrder[0]).toBeLessThan(mock.open.mock.invocationCallOrder[1]);
  });

  it("releases failed decoders and retries without silently using the legacy JPEG", async () => {
    mock.imageData.mockRejectedValueOnce(new Error("broken RAW"));
    const { fullRenderBlobForPhoto } = await import("./rawImage");
    const source = photo();
    await expect(fullRenderBlobForPhoto(source)).rejects.toThrow("broken RAW");
    await expect(fullRenderBlobForPhoto(source)).resolves.toBeInstanceOf(Blob);
    expect(mock.dispose).toHaveBeenCalledTimes(2);
  });

  it("rejects oversized RAWs before demosaicing instead of quietly halving their dimensions", async () => {
    mock.metadata.mockResolvedValue({ camera_make: "Nikon", width: 10_000, height: 8_000 });
    const { decodeCameraRaw } = await import("./rawImage");
    await expect(decodeCameraRaw(photo().blob)).rejects.toThrow(/50-megapixel/);
    expect(mock.imageData).not.toHaveBeenCalled();
    expect(mock.dispose).toHaveBeenCalledTimes(1);
  });

  it("never presents a high-efficiency Nikon camera JPEG as a full-quality edited export", async () => {
    mock.metadata.mockResolvedValue({ camera_make: "Nikon", width: 6000, height: 4000, nikon: { NEFCompression: 13 } });
    mock.thumbnailData.mockResolvedValue({ format: "jpeg", width: 6000, height: 4000, data: new Uint8Array([255, 216, 255, 217]) });
    const { fullRenderForPhoto } = await import("./rawImage");
    const source = photo();
    await expect(fullRenderForPhoto(source)).rejects.toThrow(/unchanged original/);
    const preview = await fullRenderForPhoto(source, true);
    expect(preview.renderKind).toBe("camera-jpeg");
    expect(preview.blob.type).toBe("image/jpeg");
    expect(mock.imageData).not.toHaveBeenCalled();
  });

  it("fails clearly for unsupported Nikon compression without a full-size camera preview", async () => {
    mock.metadata.mockResolvedValue({ camera_make: "Nikon", width: 6000, height: 4000, nikon: { NEFCompression: 14 } });
    const { decodeCameraRaw } = await import("./rawImage");
    await expect(decodeCameraRaw(photo().blob)).rejects.toThrow(/no usable full-size camera JPEG/);
    expect(mock.imageData).not.toHaveBeenCalled();
    expect(mock.dispose).toHaveBeenCalledTimes(1);
  });

  it("reuses verified full-resolution PNGs but rebuilds JPEGs even with an incorrect quality marker", async () => {
    const { fullRenderBlobForPhoto } = await import("./rawImage");
    const source = photo();
    const png = new Blob(["full-size pixels"], { type: "image/png" });
    expect(await fullRenderBlobForPhoto({ ...source, renderKind: "full-resolution", renderBlob: png })).toBe(png);
    expect(mock.open).not.toHaveBeenCalled();
    expect((await fullRenderBlobForPhoto({ ...source, renderKind: "full-resolution" })).type).toBe("image/png");
    expect(mock.open).toHaveBeenCalledTimes(1);
  });

  it("keeps JPEG originals on their existing render path", async () => {
    const { fullRenderBlobForPhoto } = await import("./rawImage");
    const source = photo();
    expect(await fullRenderBlobForPhoto({ ...source, name: "x.jpg", type: "image/jpeg", renderBlob: undefined })).toBe(source.blob);
    expect(mock.open).not.toHaveBeenCalled();
  });

  it("rejects a browser encoder that substitutes a lossy format", async () => {
    mock.encode.mockResolvedValue(new Blob(["jpeg"], { type: "image/jpeg" }));
    const { decodeCameraRaw } = await import("./rawImage");
    await expect(decodeCameraRaw(photo().blob)).rejects.toThrow(/lossless PNG/);
  });
});
