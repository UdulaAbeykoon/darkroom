import { describe, expect, it, vi } from "vitest";
import { extractRawPreview } from "./rawPreview";

/** Synthetic TIFF with real directory offsets and a minimal JPEG SOF header. */
export function nefFixture({ little = true, orientation = 1, cycle = false, invalid = false } = {}): Blob {
  const buffer = new ArrayBuffer(512);
  const v = new DataView(buffer);
  v.setUint16(0, little ? 0x4949 : 0x4d4d);
  v.setUint16(2, 42, little); v.setUint32(4, 8, little);
  const tags = [[256, 4, 6000], [257, 4, 4000], [274, 3, orientation], [513, 4, invalid ? 99999 : 256], [514, 4, 19]];
  v.setUint16(8, tags.length, little);
  tags.forEach(([tag,type,value], i) => {
    const offset = 10+i*12;
    v.setUint16(offset,tag,little); v.setUint16(offset+2,type,little); v.setUint32(offset+4,1,little);
    if(type===3) v.setUint16(offset+8,value,little); else v.setUint32(offset+8,value,little);
  });
  v.setUint32(10+tags.length*12, cycle ? 8 : 0,little);
  new Uint8Array(buffer,256,19).set([255,216,255,192,0,11,8,4,0,6,0,1,1,17,0,255,217,0,0]);
  return new Blob([buffer,new Uint8Array(1024*1024)]);
}

describe("bounded RAW preview extraction", () => {
  it.each([true,false])("reads %s endian TIFF directories without reading sensor data", async little => {
    const blob=nefFixture({little});
    const wholeRead=vi.spyOn(blob,"arrayBuffer");
    const slice=vi.spyOn(blob,"slice");
    const preview=await extractRawPreview(blob);
    expect(preview).toMatchObject({width:6000,height:4000});
    expect(preview?.blob.type).toBe("image/jpeg");
    expect(wholeRead).not.toHaveBeenCalled();
    const requested = slice.mock.calls.reduce((sum,[start=0,end=blob.size])=>sum+(end-start),0);
    expect(requested).toBeLessThan(1024);
    // JPEG payload survives byte-for-byte after the inserted orientation APP1.
    expect(new Uint8Array(await preview!.blob.slice(38).arrayBuffer()))
      .toEqual(new Uint8Array(await blob.slice(258,275).arrayBuffer()));
  });
  it.each([5,6,7,8])("preserves portrait orientation %i without re-encoding", async orientation => {
    const preview=await extractRawPreview(nefFixture({orientation}));
    expect(preview).toMatchObject({width:4000,height:6000});
    expect(new Uint8Array(await preview!.blob.arrayBuffer())[30]).toBe(orientation);
  });
  it("terminates cyclic directories", async () => {
    expect(await extractRawPreview(nefFixture({cycle:true}))).toBeDefined();
  });
  it("falls back on out-of-range pointers, truncated files and non-TIFF formats", async () => {
    expect(await extractRawPreview(nefFixture({invalid:true}))).toBeUndefined();
    expect(await extractRawPreview(new Blob(["II"])) ).toBeUndefined();
    expect(await extractRawPreview(new Blob(["not TIFF at all"])) ).toBeUndefined();
  });
});
