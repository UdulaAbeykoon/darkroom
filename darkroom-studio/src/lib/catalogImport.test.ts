import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";

const mocks = vi.hoisted(() => ({ preview:vi.fn(), full:vi.fn() }));
vi.mock("./rawImage", async importOriginal => ({
  ...await importOriginal<typeof import("./rawImage")>(),
  importCameraRaw:mocks.preview, decodeCameraRaw:mocks.full,
}));
vi.mock("exifr", () => ({parse:async () => ({Make:"Nikon",Model:"Test"})}));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubGlobal("indexedDB",new IDBFactory());
  vi.stubGlobal("createImageBitmap",vi.fn(async () => ({width:600,height:400,close:vi.fn()})));
  vi.stubGlobal("OffscreenCanvas",class {getContext(){return {drawImage:vi.fn()}} async convertToBlob(){return new Blob(["thumb"],{type:"image/jpeg"});}});
  mocks.preview.mockResolvedValue({blob:new Blob(["preview"],{type:"image/jpeg"}),width:6000,height:4000,metadata:{},renderKind:"embedded-preview"});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const file = (name:string,contents=name) => new File([contents],name,{type:"image/x-nikon-nef"});

describe("incremental card import", () => {
  it("persists exact source bytes and preview provenance across saves and reloads", async () => {
    const catalog=await import("./catalog");
    const original=file("one.NEF","unchanged raw pixels");
    const updates: string[]=[];
    const result=await catalog.importFiles([original],{},p=>updates.push(p.phase!));
    expect(result.rejected).toEqual([]);
    expect(await result.photos[0].blob.text()).toBe(await original.text());
    expect(result.photos[0].renderKind).toBe("embedded-preview");
    await catalog.savePhoto({...result.photos[0],rating:5});
    const loaded=await catalog.loadPhotos();
    expect(loaded[0].rating).toBe(5);
    expect(loaded[0].renderKind).toBe("embedded-preview");
    expect(await loaded[0].blob.text()).toBe(await original.text());
    expect(updates).toEqual(["Opening catalog","Checking original and duplicates","Reading preview and metadata","Saving original to catalog","Saved"]);
    expect(mocks.full).not.toHaveBeenCalled();
  });
  it("checks full content for duplicates, including renamed files, before decoding", async () => {
    const {importFiles}=await import("./catalog");
    const result=await importFiles([file("one.NEF","same"),file("renamed.NEF","same"),file("two.NEF","different")]);
    expect(result.photos).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    expect(mocks.preview).toHaveBeenCalledTimes(2);
    const included=await importFiles([file("again.NEF","same")],{duplicateHandling:"include"});
    expect(included.photos).toHaveLength(1);
  });
  it("stops between files and delivers each committed photo exactly once", async () => {
    const {importFiles,loadPhotos}=await import("./catalog");
    const abort=new AbortController();
    const onPhotos=vi.fn();
    const result=await importFiles([file("one.NEF"),file("two.NEF")],{},p=>{
      if(p.status==="imported") abort.abort();
    },{signal:abort.signal,onPhotos});
    expect(result.photos).toHaveLength(1);
    expect(await loadPhotos()).toHaveLength(1);
    expect(onPhotos.mock.calls.flatMap(([photos])=>photos)).toEqual(result.photos);
    expect(mocks.preview).toHaveBeenCalledTimes(1);
  });
  it("continues after a failed file and does not claim it was saved", async () => {
    mocks.preview.mockRejectedValueOnce(new Error("unreadable card file"));
    const {importFiles}=await import("./catalog");
    const progress=vi.fn();
    const result=await importFiles([file("broken.NEF"),file("good.NEF")],{},progress);
    expect(result.photos).toHaveLength(1);
    expect(result.rejected[0].reason).toContain("unreadable card file");
    expect(progress.mock.lastCall?.[0]).toMatchObject({completed:2,imported:1,rejected:1});
  });
  it("stops reading the card when browser storage fills up", async () => {
    vi.spyOn(IDBObjectStore.prototype,"put").mockImplementationOnce(() => { throw new DOMException("quota", "QuotaExceededError"); });
    const {importFiles}=await import("./catalog");
    const result=await importFiles([file("one.NEF"),file("two.NEF")]);
    expect(result.photos).toHaveLength(0);
    expect(result.rejected[0].reason).toContain("1 remaining files were not attempted");
    expect(mocks.preview).toHaveBeenCalledTimes(1);
  });
  it("falls back to full decoding when an embedded JPEG is corrupt", async () => {
    vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error("bad preview")).mockRejectedValueOnce(new Error("bad preview"));
    mocks.full.mockResolvedValue({blob:new Blob(["full"],{type:"image/png"}),width:6000,height:4000,metadata:{},renderKind:"full-resolution"});
    const {importFiles}=await import("./catalog");
    const result=await importFiles([file("one.NEF")]);
    expect(result.photos[0].renderKind).toBe("full-resolution");
    expect(mocks.full).toHaveBeenCalledTimes(1);
  });
});
