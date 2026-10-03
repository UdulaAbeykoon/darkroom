import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { getImportGroups, getPhotoImportGroupId } from "./importHistory";

vi.mock("exifr", () => ({ parse: vi.fn(async () => ({})) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function imageFile(name: string, content = name) {
  return new File([content], name, { type: "image/jpeg", lastModified: 1 });
}

function bitmap() {
  return { width: 24, height: 16, close: vi.fn() } as unknown as ImageBitmap;
}

async function changeStoredPhoto(
  database: IDBDatabase,
  id: string,
  change: (record: Record<string, unknown>) => void,
) {
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("photos", "readwrite");
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    const store = transaction.objectStore("photos");
    const request = store.get(id);
    request.onsuccess = () => {
      change(request.result);
      store.put(request.result);
    };
  });
}

describe("persisted import history and catalog removal", () => {
  let database: IDBDatabase | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap()));
    vi.stubGlobal("OffscreenCanvas", class {
      getContext() { return { drawImage() {} }; }
      async convertToBlob() { return new Blob(["thumbnail"], { type: "image/jpeg" }); }
    });
  });

  afterEach(() => {
    database?.close();
    database = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("persists one batch per invocation through edits, virtual copies, reloads and backups", async () => {
    const catalog = await import("./catalog");
    database = await catalog.initializeCatalog();
    const result = await catalog.importFiles([
      imageFile("one.jpg"), imageFile("two.jpg"), imageFile("empty.jpg", ""),
    ]);
    expect(result.photos).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    const [first, second] = result.photos;
    expect(first.importBatch).toEqual(second.importBatch);
    expect(first.importedAt).toBe(second.importedAt);
    expect(first.importBatch?.importedAt).toBe(first.importedAt);

    await catalog.savePhoto({ ...first, rating: 5, importBatch: undefined });
    const copy = await catalog.createVirtualCopy(first.id);
    expect(copy.importBatch).toEqual(first.importBatch);
    expect(copy.importedAt).toBe(first.importedAt);
    const next = await catalog.importFiles([imageFile("three.jpg")]);
    expect(next.photos[0].importBatch?.id).not.toBe(first.importBatch?.id);
    const duplicate = await catalog.importFiles([imageFile("one.jpg")]);
    expect(duplicate.photos).toEqual([]);
    expect(getImportGroups(await catalog.loadPhotos())).toHaveLength(2);

    const backup = JSON.parse(await catalog.exportCatalog());
    expect(backup.photos.find((photo: { id: string }) => photo.id === first.id).importBatch).toEqual(first.importBatch);
    await changeStoredPhoto(database, first.id, (stored) => { delete stored.importBatch; });
    await catalog.importCatalog(backup);
    const restored = (await catalog.loadPhotos()).find((photo) => photo.id === first.id)!;
    expect(restored.importBatch).toEqual(first.importBatch);
    expect(restored.rating).toBe(5);

    backup.photos.forEach((photo: Record<string, unknown>) => { delete photo.importBatch; });
    await catalog.importCatalog(backup);
    expect((await catalog.loadPhotos()).find((photo) => photo.id === first.id)?.importBatch).toEqual(first.importBatch);
  });

  it("keeps legacy virtual copies in their source's earlier-import date", async () => {
    const catalog = await import("./catalog");
    database = await catalog.initializeCatalog();
    const { photos: [photo] } = await catalog.importFiles([imageFile("legacy.jpg")]);
    await changeStoredPhoto(database, photo.id, (stored) => {
      delete stored.importBatch;
      stored.importedAt = "2025-06-15T12:30:00Z";
    });
    const copy = await catalog.createVirtualCopy(photo.id);
    expect(copy.importBatch).toBeUndefined();
    expect(getPhotoImportGroupId(copy)).toBe("legacy:2025-06-15");
    expect(getImportGroups(await catalog.loadPhotos())[0].photoIds).toHaveLength(2);
  });

  it("removes an entire batch's stored images and preview URLs while preserving other imports and source files", async () => {
    const catalog = await import("./catalog");
    database = await catalog.initializeCatalog();
    const source = imageFile("source.jpg", "source pixels");
    const first = await catalog.importFiles([source, imageFile("other.jpg")]);
    const remaining = await catalog.importFiles([imageFile("remain.jpg")]);
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const group = getImportGroups(first.photos)[0];
    await catalog.deletePhotos(group.photoIds);
    for (const photo of first.photos) {
      expect(revoke).toHaveBeenCalledWith(photo.objectUrl);
      expect(revoke).toHaveBeenCalledWith(photo.thumbnailUrl);
    }
    const loaded = await catalog.loadPhotos();
    expect(loaded.map((photo) => photo.id)).toEqual([remaining.photos[0].id]);
    expect(getImportGroups(loaded)).toHaveLength(1);
    expect(await source.text()).toBe("source pixels");
  });

  it("does not resurrect deleted records from coalesced, in-flight or later stale saves", async () => {
    const catalog = await import("./catalog");
    database = await catalog.initializeCatalog();
    const { photos: [photo] } = await catalog.importFiles([imageFile("race.jpg")]);
    const entered = deferred<void>();
    const release = deferred<void>();
    let firstLock = true;
    vi.stubGlobal("navigator", {
      locks: {
        async request(_name: string, operation: () => Promise<unknown>) {
          if (firstLock) {
            firstLock = false;
            entered.resolve();
            await release.promise;
          }
          return operation();
        },
      },
    });
    const saving = catalog.savePhotos([{ ...photo, rating: 2 }]);
    await entered.promise;
    const removing = catalog.deletePhotos([photo.id]);
    const coalesced = catalog.savePhoto({ ...photo, rating: 3 });
    release.resolve();
    await Promise.all([saving, removing, coalesced]);
    await catalog.savePhoto({ ...photo, rating: 4 });
    await catalog.savePhotos([{ ...photo, rating: 5 }]);
    await expect(catalog.loadPhotos()).resolves.toEqual([]);
  });

  it("empties photos and collections and prevents a decoding import from repopulating them", async () => {
    const catalog = await import("./catalog");
    database = await catalog.initializeCatalog();
    const { photos: [photo] } = await catalog.importFiles([imageFile("existing.jpg")]);
    await catalog.createCollection("Album");
    const entered = deferred<void>();
    const release = deferred<ImageBitmap>();
    vi.mocked(createImageBitmap).mockImplementationOnce(async () => {
      entered.resolve();
      return release.promise;
    });
    const importing = catalog.importFiles([imageFile("inflight.jpg"), imageFile("later.jpg")]);
    await entered.promise;
    await catalog.clearCatalog();
    release.resolve(bitmap());
    expect((await importing).photos).toEqual([]);
    await catalog.savePhotos([photo]);
    await expect(catalog.loadPhotos()).resolves.toEqual([]);
    await expect(catalog.loadCollections()).resolves.toEqual([]);
    expect(getImportGroups(await catalog.loadPhotos())).toEqual([]);
    const next = await catalog.importFiles([imageFile("new.jpg")]);
    expect(next.photos).toHaveLength(1);
  });

  it("does not recreate a photo deleted by another tab during thumbnail regeneration", async () => {
    const catalog = await import("./catalog");
    database = await catalog.initializeCatalog();
    const { photos: [photo] } = await catalog.importFiles([imageFile("cross-tab.jpg")]);
    await changeStoredPhoto(database, photo.id, (stored) => { delete stored.thumbnailBlob; });
    const entered = deferred<void>();
    const release = deferred<ImageBitmap>();
    vi.mocked(createImageBitmap).mockImplementationOnce(async () => {
      entered.resolve();
      return release.promise;
    });
    const saving = catalog.savePhotos([{ ...photo, rating: 5 }]);
    await entered.promise;
    await new Promise<void>((resolve, reject) => {
      const transaction = database!.transaction("photos", "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.objectStore("photos").delete(photo.id);
    });
    release.resolve(bitmap());
    await saving;
    await expect(catalog.loadPhotos()).resolves.toEqual([]);
  });

  it("cancels a virtual copy queued before the library is emptied", async () => {
    const catalog = await import("./catalog");
    database = await catalog.initializeCatalog();
    const { photos: [photo] } = await catalog.importFiles([imageFile("copy-race.jpg")]);
    const copying = catalog.createVirtualCopy(photo.id);
    const rejected = expect(copying).rejects.toThrow("no longer in the catalog");
    await catalog.clearCatalog();
    await rejected;
    await expect(catalog.loadPhotos()).resolves.toEqual([]);
  });

  it("cancels a backup restore waiting on file contents when the library is emptied", async () => {
    const catalog = await import("./catalog");
    database = await catalog.initializeCatalog();
    await catalog.importFiles([imageFile("restore.jpg")]);
    await catalog.createCollection("Old album");
    const backup = await catalog.exportCatalog();
    const entered = deferred<void>();
    const contents = deferred<string>();
    const file = new Blob([backup]);
    vi.spyOn(file, "text").mockImplementation(async () => {
      entered.resolve();
      return contents.promise;
    });
    const restoring = catalog.importCatalog(file);
    const rejected = expect(restoring).rejects.toThrow("catalog was emptied");
    await entered.promise;
    await catalog.clearCatalog();
    contents.resolve(backup);
    await rejected;
    await expect(catalog.loadPhotos()).resolves.toEqual([]);
    await expect(catalog.loadCollections()).resolves.toEqual([]);
  });
});
