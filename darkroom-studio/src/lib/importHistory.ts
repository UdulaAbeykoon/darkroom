import type { ImportBatch, PhotoRecord } from "../types";

type ImportHistoryPhoto = Pick<PhotoRecord, "id" | "importedAt" | "importBatch">;

export interface ImportGroup {
  id: string;
  label: string;
  /** Exact batch timestamp, UTC calendar day for legacy groups, or null. */
  importedAt: string | null;
  legacy: boolean;
  photoIds: string[];
}

function validDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** Accepts optional history from older catalogs and untrusted backup metadata. */
export function normalizeImportBatch(value: unknown): ImportBatch | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const importedAt = validDate(candidate.importedAt);
  if (!id || id.length > 200 || !importedAt) return undefined;
  const label = typeof candidate.label === "string"
    ? candidate.label.trim().slice(0, 200)
    : "";
  return { id, importedAt, ...(label ? { label } : {}) };
}

function photoGroup(photo: ImportHistoryPhoto): Omit<ImportGroup, "photoIds"> {
  const batch = normalizeImportBatch(photo.importBatch);
  if (batch) {
    return {
      id: `batch:${batch.id}`,
      label: batch.label || "Import",
      importedAt: batch.importedAt,
      legacy: false,
    };
  }
  // Earlier catalogs recorded photo timestamps, but no import boundaries.
  // Group only by UTC day rather than presenting guessed batches as exact.
  const day = validDate(photo.importedAt)?.slice(0, 10) ?? null;
  return {
    id: `legacy:${day ?? "undated"}`,
    label: "Earlier imports",
    importedAt: day,
    legacy: true,
  };
}

export function getPhotoImportGroupId(photo: ImportHistoryPhoto): string {
  return photoGroup(photo).id;
}

/** Derives history from remaining catalog records, without empty phantom batches. */
export function getImportGroups(photos: readonly ImportHistoryPhoto[]): ImportGroup[] {
  const groups = new Map<string, ImportGroup>();
  const seenPhotos = new Set<string>();
  for (const photo of photos) {
    if (seenPhotos.has(photo.id)) continue;
    seenPhotos.add(photo.id);
    const group = photoGroup(photo);
    const existing = groups.get(group.id);
    if (existing) {
      existing.photoIds.push(photo.id);
    } else {
      groups.set(group.id, { ...group, photoIds: [photo.id] });
    }
  }
  return [...groups.values()].sort((left, right) =>
    (right.importedAt ?? "").localeCompare(left.importedAt ?? "") ||
    left.id.localeCompare(right.id),
  );
}
