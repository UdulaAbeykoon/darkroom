import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultEditState } from "../defaults";
import type { ExportSettings } from "../types";
import { flipRgbaRows, ImageEngine, validateExportDimensions } from "./imageEngine";

const settings = (): ExportSettings => ({
  format: "image/png",
  quality: 100,
  resizeMode: "original",
  longEdge: 2048,
  width: 8256,
  height: 5504,
  fileName: "photo",
  includeMetadata: false,
  watermarkEnabled: false,
  watermarkText: "",
  watermarkOpacity: 50,
  watermarkPosition: "bottom-right",
});

const canvasStub = () => ({
  width: 1,
  height: 1,
  clientWidth: 1,
  clientHeight: 1,
  style: {},
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  getContext: vi.fn(() => null),
}) as unknown as HTMLCanvasElement;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("explicit export quality limits", () => {
  it("accepts the full 45-megapixel Nikon frame without reducing its size", () => {
    expect(() => validateExportDimensions(8256, 5504, 16_384)).not.toThrow();
    expect(() => validateExportDimensions(8000, 8000, 16_384)).not.toThrow();
  });

  it("rejects requested exports above the pixel budget instead of silently shrinking them", () => {
    expect(() => validateExportDimensions(10_000, 8_000, 16_384)).toThrow(/10,?000 × 8,?000|10000 × 8000/);
    expect(() => validateExportDimensions(10_000, 8_000, 16_384)).toThrow(/No reduced-resolution file/);
  });

  it("rejects requested exports above the renderer dimensions even below the pixel budget", () => {
    expect(() => validateExportDimensions(9000, 1000, 8192)).toThrow(/8192 pixels per side/);
    expect(() => validateExportDimensions(1000, 9000, 8192)).toThrow(/unchanged original/);
  });

  it("rejects invalid output dimensions", () => {
    for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() => validateExportDimensions(width, 1, 16_384)).toThrow(/invalid/);
    }
  });

  it("rejects full-resolution source loads above the GPU limit before resampling", async () => {
    class Bitmap {
      width = 8256;
      height = 5504;
      close = vi.fn();
    }
    const bitmap = new Bitmap();
    const decode = vi.fn().mockResolvedValue(bitmap);
    vi.stubGlobal("ImageBitmap", Bitmap);
    vi.stubGlobal("createImageBitmap", decode);
    const engine = new ImageEngine(canvasStub());
    Object.assign(engine, { gl: { MAX_TEXTURE_SIZE: 0x0d33, getParameter: () => 8192 } });
    try {
      await expect(engine.load(new Blob(["source"]), Number.POSITIVE_INFINITY)).rejects.toThrow(/GPU texture limit/);
      expect(decode).toHaveBeenCalledTimes(1);
      expect(bitmap.close).toHaveBeenCalledTimes(1);
    } finally {
      engine.destroy();
    }
  });

  it("still permits explicit browsing previews below the GPU limit", async () => {
    class Bitmap {
      constructor(public width: number, public height: number) {}
      close = vi.fn();
    }
    const source = new Bitmap(8256, 5504);
    const preview = new Bitmap(2048, 1365);
    const decode = vi.fn().mockResolvedValueOnce(source).mockResolvedValueOnce(preview);
    vi.stubGlobal("ImageBitmap", Bitmap);
    vi.stubGlobal("createImageBitmap", decode);
    const engine = new ImageEngine(canvasStub());
    Object.assign(engine, { gl: { MAX_TEXTURE_SIZE: 0x0d33, getParameter: () => 8192 } });
    try {
      expect(await engine.load(new Blob(["source"]), 2048)).toMatchObject({
        sourceWidth: 8256, sourceHeight: 5504,
        previewWidth: 2048, previewHeight: 1365,
      });
      expect(decode).toHaveBeenCalledTimes(2);
      expect(source.close).toHaveBeenCalledTimes(1);
    } finally {
      engine.destroy();
    }
    expect(preview.close).toHaveBeenCalledTimes(1);
  });

  it("exports the exact original blob without decoding, rendering, resize, or watermark", async () => {
    const engine = new ImageEngine(canvasStub());
    const original = new Blob([new Uint8Array([0, 255, 13, 10, 42])], { type: "image/x-nikon-nef" });
    const edited = createDefaultEditState();
    edited.global.exposure = 3;
    edited.crop.width = 0.5;
    try {
      const output = await engine.export(original, edited, {
        ...settings(), format: "original", resizeMode: "long-edge", longEdge: 1,
        watermarkEnabled: true, watermarkText: "Do not modify original",
      });
      expect(output).toBe(original);
      expect(new Uint8Array(await output.arrayBuffer())).toEqual(new Uint8Array([0, 255, 13, 10, 42]));
    } finally {
      engine.destroy();
    }
  });

  it("rejects a browser's fallback format instead of saving a mislabeled edited file", async () => {
    const context = { drawImage: vi.fn() };
    vi.stubGlobal("document", {
      createElement: () => ({
        ...canvasStub(),
        getContext: (kind: string) => kind === "2d" ? context : null,
        toBlob: (callback: (blob: Blob) => void) => callback(new Blob(["PNG fallback"], { type: "image/png" })),
      }),
    });
    vi.spyOn(ImageEngine.prototype, "load").mockResolvedValue({
      sourceWidth: 2, sourceHeight: 1, previewWidth: 2, previewHeight: 1, width: 2, height: 1,
    });
    vi.spyOn(ImageEngine.prototype, "render").mockImplementation(() => {});
    const engine = new ImageEngine(canvasStub());
    try {
      await expect(engine.export(new Blob(["source"]), createDefaultEditState(), {
        ...settings(), format: "image/webp",
      })).rejects.toThrow(/image\/png.*instead of image\/webp/);
    } finally {
      engine.destroy();
    }
  });
});

describe("zoom preview backing resolution", () => {
  it("reconciles a browser area cap without changing the CSS coordinate space", () => {
    const canvas = canvasStub();
    const engine = new ImageEngine(canvas);
    Object.assign(engine, { gl: {
      MAX_VIEWPORT_DIMS: 1,
      MAX_RENDERBUFFER_SIZE: 2,
      getParameter: (parameter: number) => parameter === 1 ? new Int32Array([16384, 16384]) : 16384,
      get drawingBufferWidth() { return Math.min(canvas.width, 6500); },
      get drawingBufferHeight() { return Math.min(canvas.height, 5120); },
    } });
    try {
      engine.resize(956, 752, 8);
      expect(canvas.width).toBe(6500);
      expect(canvas.height).toBe(5120);
      expect(canvas.style.width).toBe("956px");
      expect(canvas.style.height).toBe("752px");
    } finally {
      engine.destroy();
    }
  });

  it("renders Retina zoom above DPR 4 while preserving CSS dimensions", () => {
    const canvas = canvasStub();
    const engine = new ImageEngine(canvas);
    try {
      engine.resize(900, 600, 8);
      expect(canvas.width).toBe(7200);
      expect(canvas.height).toBe(4800);
      expect(canvas.style.width).toBe("900px");
      expect(canvas.style.height).toBe("600px");
    } finally {
      engine.destroy();
    }
  });

  it("bounds zoom backing pixels by GPU viewport and renderbuffer limits", () => {
    const canvas = canvasStub();
    const engine = new ImageEngine(canvas);
    Object.assign(engine, { gl: {
      MAX_VIEWPORT_DIMS: 1,
      MAX_RENDERBUFFER_SIZE: 2,
      getParameter: (parameter: number) => parameter === 1 ? new Int32Array([8192, 4096]) : 6000,
    } });
    try {
      engine.resize(1000, 800, 16);
      expect(canvas.width).toBe(5120);
      expect(canvas.height).toBe(4096);
      expect(canvas.style.width).toBe("1000px");
      expect(canvas.style.height).toBe("800px");
    } finally {
      engine.destroy();
    }
  });

  it("caps unusually large previews to the pixel budget", () => {
    const canvas = canvasStub();
    const engine = new ImageEngine(canvas);
    try {
      engine.resize(3000, 2000, 8);
      expect(canvas.width * canvas.height).toBeLessThanOrEqual(64_000_000);
      expect(canvas.width / canvas.height).toBeCloseTo(1.5, 3);
      expect(canvas.style.width).toBe("3000px");
    } finally {
      engine.destroy();
    }
  });

  it("keeps full-size export dimensions exact at DPR 1", () => {
    const canvas = canvasStub();
    const engine = new ImageEngine(canvas);
    try {
      engine.resize(8256, 5504, 1);
      expect(canvas.width).toBe(8256);
      expect(canvas.height).toBe(5504);
    } finally {
      engine.destroy();
    }
  });
});

describe("full-resolution framebuffer export", () => {
  it("reverses complete RGBA rows in place and preserves an odd middle row", () => {
    const pixels = new Uint8ClampedArray([
      1, 2, 3, 4, 5, 6, 7, 8,
      9, 10, 11, 12, 13, 14, 15, 16,
      17, 18, 19, 20, 21, 22, 23, 24,
    ]);
    flipRgbaRows(pixels, 2, 3);
    expect([...pixels]).toEqual([
      17, 18, 19, 20, 21, 22, 23, 24,
      9, 10, 11, 12, 13, 14, 15, 16,
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  function setupFramebufferExport(complete = true, readbackError = false) {
    const context = { putImageData: vi.fn(), drawImage: vi.fn() };
    const texture = {};
    const framebuffer = {};
    const gl = {
      MAX_VIEWPORT_DIMS: 1, MAX_TEXTURE_SIZE: 2, FRAMEBUFFER_BINDING: 3,
      FRAMEBUFFER: 4, FRAMEBUFFER_COMPLETE: 5, TEXTURE_2D: 6, RGBA8: 7,
      RGBA: 8, UNSIGNED_BYTE: 9, COLOR_ATTACHMENT0: 10, NO_ERROR: 0,
      drawingBufferWidth: 1, drawingBufferHeight: 1,
      getParameter: (parameter: number) => parameter === 1 ? new Int32Array([16384, 16384]) : parameter === 2 ? 16384 : null,
      createTexture: () => texture,
      createFramebuffer: () => framebuffer,
      isContextLost: () => false,
      bindTexture: vi.fn(), texParameteri: vi.fn(), texImage2D: vi.fn(),
      bindFramebuffer: vi.fn(), framebufferTexture2D: vi.fn(),
      checkFramebufferStatus: () => complete ? 5 : 0,
      getError: () => readbackError ? 0x0505 : 0,
      readPixels: vi.fn((_x, _y, _w, _h, _format, _type, data: Uint8Array) => {
        // Bottom row is blue/white; top row is red/green.
        data.set([0, 0, 255, 255, 255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255]);
      }),
      deleteTexture: vi.fn(), deleteFramebuffer: vi.fn(),
    };
    const canvases: HTMLCanvasElement[] = [];
    vi.stubGlobal("document", {
      createElement: () => {
        const canvas = Object.assign(canvasStub(), {
          getContext: (kind: string) => kind === "2d" ? context : null,
          toBlob: (callback: (blob: Blob) => void) => callback(new Blob(["PNG"], { type: "image/png" })),
        });
        canvases.push(canvas);
        return canvas;
      },
    });
    vi.stubGlobal("ImageData", class {
      constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    vi.spyOn(ImageEngine.prototype, "load").mockImplementation(async function (this: ImageEngine) {
      Object.assign(this, { gl });
      return { sourceWidth: 2, sourceHeight: 2, previewWidth: 2, previewHeight: 2, width: 2, height: 2 };
    });
    const render = vi.spyOn(ImageEngine.prototype, "render").mockImplementation(() => {});
    return { context, gl, canvases, texture, framebuffer, render };
  }

  it("renders to the requested texture size despite a smaller default buffer and keeps top-left orientation", async () => {
    const { context, gl, canvases, texture, framebuffer, render } = setupFramebufferExport();
    const engine = new ImageEngine(canvasStub());
    const edited = createDefaultEditState();
    edited.global.exposure = 1;
    try {
      expect((await engine.export(new Blob(["source"]), edited, settings())).type).toBe("image/png");
      expect(gl.texImage2D).toHaveBeenCalledWith(gl.TEXTURE_2D, 0, gl.RGBA8, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      expect(render).toHaveBeenCalledWith(edited);
      expect(canvases[0].width).toBe(1);
      expect(canvases[1].width).toBe(2);
      expect(context.drawImage).not.toHaveBeenCalled();
      expect([...context.putImageData.mock.calls[0][0].data]).toEqual([
        255, 0, 0, 255, 0, 255, 0, 255,
        0, 0, 255, 255, 255, 255, 255, 255,
      ]);
      expect(gl.bindFramebuffer).toHaveBeenLastCalledWith(gl.FRAMEBUFFER, null);
      expect(gl.deleteFramebuffer).toHaveBeenCalledWith(framebuffer);
      expect(gl.deleteTexture).toHaveBeenCalledWith(texture);
    } finally {
      engine.destroy();
    }
  });

  it.each([[false, false], [true, true]])("rejects framebuffer/readback failure and releases its GPU allocations (%s, %s)", async (complete, readbackError) => {
    const { context, gl, texture, framebuffer } = setupFramebufferExport(complete, readbackError);
    const engine = new ImageEngine(canvasStub());
    try {
      await expect(engine.export(new Blob(["source"]), createDefaultEditState(), settings())).rejects.toThrow(/No reduced-resolution file/);
      expect(context.putImageData).not.toHaveBeenCalled();
      expect(gl.deleteFramebuffer).toHaveBeenCalledWith(framebuffer);
      expect(gl.deleteTexture).toHaveBeenCalledWith(texture);
    } finally {
      engine.destroy();
    }
  });
});
