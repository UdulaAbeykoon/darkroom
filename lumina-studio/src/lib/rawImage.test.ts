import { describe, expect, it } from "vitest";
import type { LibRawImageData } from "libraw-wasm";
import {
  CAMERA_RAW_ACCEPT,
  cameraRawInfo,
  isCameraRawFile,
  rawPixelsToRgba,
  renderBlobForPhoto,
} from "./rawImage";

describe("camera RAW format recognition", () => {
  it.each([
    ["photo.DNG", "image/x-adobe-dng"],
    ["canon.CR2", "image/x-canon-cr2"],
    ["canon.cr3", "image/x-canon-cr3"],
    ["nikon.NEF", "image/x-nikon-nef"],
    ["sony.ARW", "image/x-sony-arw"],
    ["fuji.RAF", "image/x-fujifilm-raf"],
    ["olympus.ORF", "image/x-olympus-orf"],
    ["panasonic.RW2", "image/x-panasonic-rw2"],
    ["pentax.PEF", "image/x-pentax-pef"],
    ["samsung.SRW", "image/x-samsung-srw"],
  ])("recognizes %s when browsers provide no MIME", (name, mimeType) => {
    expect(cameraRawInfo(new File([new Uint8Array([1])], name))).toEqual({
      extension: name.split(".").pop()?.toLowerCase(),
      mimeType,
    });
  });

  it("recognizes an authoritative RAW MIME even without an extension", () => {
    const file = new File([new Uint8Array([1])], "camera-file", {
      type: "image/x-nikon-nef; charset=binary",
    });
    expect(cameraRawInfo(file)).toEqual({
      extension: "raw",
      mimeType: "image/x-nikon-nef",
    });
  });

  it("does not treat a generic binary file as RAW", () => {
    const file = new File([new Uint8Array([1])], "archive.bin", {
      type: "application/octet-stream",
    });
    expect(isCameraRawFile(file)).toBe(false);
  });

  it("advertises extension-based picker coverage", () => {
    expect(CAMERA_RAW_ACCEPT).toContain(".dng");
    expect(CAMERA_RAW_ACCEPT).toContain(".cr3");
    expect(CAMERA_RAW_ACCEPT).toContain(".nef");
    expect(CAMERA_RAW_ACCEPT).toContain(".arw");
    expect(CAMERA_RAW_ACCEPT).toContain(".raf");
  });
});

describe("RAW render source routing", () => {
  it("preserves the original while returning the renderable proxy", () => {
    const original = new Blob(["raw-original"], { type: "image/x-adobe-dng" });
    const renderBlob = new Blob(["jpeg-working-image"], { type: "image/jpeg" });
    expect(renderBlobForPhoto({ blob: original, renderBlob })).toBe(renderBlob);
    expect(renderBlobForPhoto({ blob: original })).toBe(original);
  });
});

describe("LibRaw pixel conversion", () => {
  it("converts packed 8-bit RGB to opaque browser pixels", () => {
    const image: LibRawImageData = {
      width: 2,
      height: 1,
      colors: 3,
      bits: 8,
      dataSize: 6,
      data: new Uint8Array([10, 20, 30, 200, 210, 220]),
    };
    expect(Array.from(rawPixelsToRgba(image))).toEqual([
      10, 20, 30, 255, 200, 210, 220, 255,
    ]);
  });

  it("scales 16-bit samples to 8-bit", () => {
    const image: LibRawImageData = {
      width: 1,
      height: 1,
      colors: 3,
      bits: 16,
      dataSize: 6,
      data: new Uint16Array([0, 32_768, 65_535]),
    };
    expect(Array.from(rawPixelsToRgba(image))).toEqual([0, 128, 255, 255]);
  });

  it("rejects incomplete decoder output", () => {
    expect(() =>
      rawPixelsToRgba({
        width: 2,
        height: 2,
        colors: 3,
        bits: 8,
        dataSize: 3,
        data: new Uint8Array([1, 2, 3]),
      }),
    ).toThrow(/incomplete pixel data/i);
  });
});
