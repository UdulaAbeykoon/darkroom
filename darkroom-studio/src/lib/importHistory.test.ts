import { describe, expect, it } from "vitest";
import { getImportGroups, getPhotoImportGroupId, normalizeImportBatch } from "./importHistory";
import type { PhotoRecord } from "../types";

type HistoryPhoto = Pick<PhotoRecord, "id" | "importedAt" | "importBatch">;

describe("import history", () => {
  it("keeps distinct imports on the same day separate and groups a shared batch", () => {
    const earlier = { id: "first", importedAt: "2026-10-03T10:00:00Z" };
    const later = { id: "second", importedAt: "2026-10-03T11:00:00Z", label: "Walk" };
    const photos: HistoryPhoto[] = [
      { id: "a", importedAt: earlier.importedAt, importBatch: earlier },
      { id: "b", importedAt: earlier.importedAt, importBatch: earlier },
      { id: "c", importedAt: later.importedAt, importBatch: later },
    ];
    expect(getImportGroups(photos)).toEqual([
      { id: "batch:second", label: "Walk", importedAt: "2026-10-03T11:00:00.000Z", legacy: false, photoIds: ["c"] },
      { id: "batch:first", label: "Import", importedAt: "2026-10-03T10:00:00.000Z", legacy: false, photoIds: ["a", "b"] },
    ]);
    expect(getPhotoImportGroupId(photos[1])).toBe("batch:first");
    expect(getImportGroups(photos.slice(2))).toHaveLength(1);
    expect(getImportGroups([])).toEqual([]);
  });

  it("labels legacy records as earlier imports using stable UTC dates and an undated fallback", () => {
    const photos: HistoryPhoto[] = [
      { id: "old-a", importedAt: "2026-10-02T23:30:00-04:00" },
      { id: "old-b", importedAt: "2026-10-03T15:00:00Z" },
      { id: "older", importedAt: "2026-10-01T12:00:00Z" },
      { id: "unknown", importedAt: "not a date" },
      { id: "missing", importedAt: undefined as unknown as string },
    ];
    expect(getImportGroups(photos)).toEqual([
      { id: "legacy:2026-10-03", label: "Earlier imports", importedAt: "2026-10-03", legacy: true, photoIds: ["old-a", "old-b"] },
      { id: "legacy:2026-10-01", label: "Earlier imports", importedAt: "2026-10-01", legacy: true, photoIds: ["older"] },
      { id: "legacy:undated", label: "Earlier imports", importedAt: null, legacy: true, photoIds: ["unknown", "missing"] },
    ]);
    expect(getPhotoImportGroupId(photos[0])).toBe("legacy:2026-10-03");
  });

  it("rejects malformed batch metadata and bounds optional labels", () => {
    expect(normalizeImportBatch({ id: "", importedAt: "2026-10-03" })).toBeUndefined();
    expect(normalizeImportBatch({ id: "batch", importedAt: "invalid" })).toBeUndefined();
    expect(normalizeImportBatch(null)).toBeUndefined();
    expect(normalizeImportBatch({ id: " batch ", importedAt: "2026-10-03T12:00:00Z", label: "x".repeat(300) })).toEqual({
      id: "batch", importedAt: "2026-10-03T12:00:00.000Z", label: "x".repeat(200),
    });
  });
});
