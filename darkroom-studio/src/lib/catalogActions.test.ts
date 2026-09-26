import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createDefaultEditState } from "../defaults";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function seedPhoto() {
  const request = indexedDB.open("darkroom-catalog");
  const database = await requestResult(request);
  const transaction = database.transaction("photos", "readwrite");
  const completed = transactionComplete(transaction);
  transaction.objectStore("photos").put({
    id: "photo-source",
    name: "source.jpg",
    type: "image/jpeg",
    size: 8,
    width: 24,
    height: 16,
    importedAt: "2026-09-26T12:00:00.000Z",
    blob: new Blob(["original"], { type: "image/jpeg" }),
    thumbnailBlob: new Blob(["thumbnail"], { type: "image/jpeg" }),
    lastModified: 1_790_424_000_000,
    fingerprint: "fingerprint-source",
    contentFingerprint: "content-source",
    metadata: { camera: "Test Camera", caption: "Original caption" },
    rating: 4,
    flag: "pick",
    colorLabel: "green",
    keywords: ["source"],
    collectionIds: ["collection-1"],
    edits: createDefaultEditState(),
    snapshots: [],
  });
  await completed;
  database.close();
}

describe("catalog filmstrip actions", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: new IDBFactory(),
    });
  });

  it("creates a persistent virtual copy and batch-removes catalog records", async () => {
    const catalog = await import("./catalog");
    await catalog.initializeCatalog();
    await seedPhoto();

    const copy = await catalog.createVirtualCopy("photo-source");
    expect(copy.id).not.toBe("photo-source");
    expect(copy.name).toBe("source Copy.jpg");
    expect(copy.metadata).toEqual({
      camera: "Test Camera",
      caption: "Original caption",
    });
    expect(copy.rating).toBe(4);
    expect(copy.collectionIds).toEqual(["collection-1"]);

    const loaded = await catalog.loadPhotos();
    expect(loaded.map((photo) => photo.id).sort()).toEqual(
      ["photo-source", copy.id].sort(),
    );

    await catalog.deletePhotos(["photo-source", copy.id, copy.id]);
    await expect(catalog.loadPhotos()).resolves.toEqual([]);
  });
});
