import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  open: vi.fn(), metadata: vi.fn(), thumbnailData: vi.fn(), imageData: vi.fn(), dispose: vi.fn(),
  encode: vi.fn(), putPixels: vi.fn(),
}));
vi.mock("libraw-wasm", () => ({default: class {
  open=mock.open; metadata=mock.metadata; thumbnailData=mock.thumbnailData;
  imageData=mock.imageData; dispose=mock.dispose;
}}));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  mock.metadata.mockResolvedValue({camera_make:"Nikon",width:2,height:1});
  mock.thumbnailData.mockResolvedValue(undefined);
  mock.imageData.mockResolvedValue({width:2,height:1,colors:3,bits:8,data:new Uint8Array([0,128,255,44,55,66])});
  mock.encode.mockResolvedValue(new Blob(["lossless pixels"],{type:"image/png"}));
  vi.stubGlobal("OffscreenCanvas",class {getContext(){return {putImageData:mock.putPixels}} convertToBlob=mock.encode;});
  vi.stubGlobal("ImageData",class {constructor(public data:Uint8ClampedArray,public width:number,public height:number){}});
});
afterEach(() => vi.unstubAllGlobals());

const photo = () => ({name:"test.NEF", type:"image/x-nikon-nef", blob:new Blob(["original sensor bytes"]),renderBlob:new Blob(["small lossy preview"],{type:"image/jpeg"})});

describe("quality-safe RAW routing", () => {
  it("fully decodes large RAWs without half-size or intermediate JPEG compression", async () => {
    const {fullRenderBlobForPhoto}=await import("./rawImage");
    const p=photo(); Object.defineProperty(p.blob,"size",{value:60*1024*1024});
    const result=await fullRenderBlobForPhoto(p);
    expect(mock.open).toHaveBeenCalledWith(expect.any(Uint8Array),expect.objectContaining({halfSize:false,userQual:3}));
    expect(mock.encode).toHaveBeenCalledWith({type:"image/png"});
    expect(result.type).toBe("image/png");
    expect([...mock.putPixels.mock.calls[0][0].data]).toEqual([0,128,255,255,44,55,66,255]);
    expect(mock.dispose).toHaveBeenCalledTimes(1);
  });
  it("coalesces concurrent requests and retains only the most recent decoded original", async () => {
    const {fullRenderBlobForPhoto}=await import("./rawImage");
    const p=photo();
    await Promise.all([fullRenderBlobForPhoto(p),fullRenderBlobForPhoto(p)]);
    expect(mock.open).toHaveBeenCalledTimes(1);
    await fullRenderBlobForPhoto(photo());
    await fullRenderBlobForPhoto(p);
    expect(mock.open).toHaveBeenCalledTimes(3);
  });
  it("extracts a LibRaw preview without demosaicing when TIFF fast path is unavailable", async () => {
    mock.thumbnailData.mockResolvedValue({format:"jpeg",width:500,height:300,data:new Uint8Array([255,216,255,217])});
    const {importCameraRaw}=await import("./rawImage");
    expect((await importCameraRaw(photo().blob)).renderKind).toBe("embedded-preview");
    expect(mock.imageData).not.toHaveBeenCalled();
    expect(mock.encode).not.toHaveBeenCalled();
    expect(mock.dispose).toHaveBeenCalledTimes(1);
  });
  it("releases failed decoders and retries instead of caching rejection", async () => {
    mock.imageData.mockRejectedValueOnce(new Error("broken RAW"));
    const {fullRenderBlobForPhoto}=await import("./rawImage");
    const p=photo();
    await expect(fullRenderBlobForPhoto(p)).rejects.toThrow("broken RAW");
    await expect(fullRenderBlobForPhoto(p)).resolves.toBeInstanceOf(Blob);
    expect(mock.dispose).toHaveBeenCalledTimes(2);
  });
  it("never silently exports a high-efficiency Nikon camera JPEG as decoded RAW", async () => {
    mock.metadata.mockResolvedValue({camera_make:"Nikon",width:6000,height:4000,nikon:{NEFCompression:13}});
    mock.thumbnailData.mockResolvedValue({format:"jpeg",width:6000,height:4000,data:new Uint8Array([255,216,255,217])});
    const {fullRenderBlobForPhoto}=await import("./rawImage");
    const p=photo();
    await expect(fullRenderBlobForPhoto(p)).rejects.toThrow(/Export the original/);
    await expect(fullRenderBlobForPhoto(p,true)).resolves.toBeInstanceOf(Blob);
    expect(mock.imageData).not.toHaveBeenCalled();
  });
  it("keeps JPEG originals and verified full-resolution proxies on their existing paths", async () => {
    const {fullRenderBlobForPhoto}=await import("./rawImage");
    const p=photo();
    expect(await fullRenderBlobForPhoto({...p,renderKind:"full-resolution"})).toBe(p.renderBlob);
    expect(await fullRenderBlobForPhoto({...p,name:"x.jpg",type:"image/jpeg",renderBlob:undefined})).toBe(p.blob);
    expect(mock.open).not.toHaveBeenCalled();
  });
});
