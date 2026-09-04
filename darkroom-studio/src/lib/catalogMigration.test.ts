import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDBDatabase as FakeIDBDatabase,
  IDBFactory,
  IDBObjectStore as FakeIDBObjectStore,
} from "fake-indexeddb";
import { createDefaultEditState } from "../defaults";
import { RETIRED_CATALOG_NAME } from "./retiredIdentity";

const EXPECTED_RETIRED_CATALOG_NAME = atob(
  "bHVtaW5hLXN0dWRpby1jYXRhbG9n",
);
const CURRENT_CATALOG_NAME = "darkroom-catalog";

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

function storedPhoto(id: string) {
  const edits = createDefaultEditState();
  edits.global.exposure = 1.25;
  return {
    id,
    name: `${id}.raw`,
    type: "image/x-camera-raw",
    size: 12,
    width: 48,
    height: 32,
    importedAt: "2026-08-01T12:00:00.000Z",
    importMethod: "add" as const,
    blob: new Blob([`original-${id}`], { type: "image/x-camera-raw" }),
    renderBlob: new Blob([`render-${id}`], { type: "image/jpeg" }),
    thumbnailBlob: new Blob([`thumb-${id}`], { type: "image/jpeg" }),
    lastModified: 1_754_046_000_000,
    fingerprint: `fingerprint-${id}`,
    contentFingerprint: `content-${id}`,
    metadata: { camera: "Test Camera", iso: 200 },
    rating: 4,
    flag: "pick" as const,
    colorLabel: "green" as const,
    keywords: ["migration"],
    collectionIds: ["collection-1"],
    edits,
    snapshots: [],
  };
}

const collection = {
  id: "collection-1",
  name: "Favorites",
  createdAt: "2026-08-01T12:00:00.000Z",
};

async function createCatalog(
  name: string,
  version: number,
  photos = [storedPhoto("photo-1")],
  collections = [collection],
  includeMetadataStore = false,
): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => {
      const photoStore = request.result.createObjectStore("photos", {
        keyPath: "id",
      });
      photoStore.createIndex("fingerprint", "fingerprint", { unique: true });
      if (version >= 2) {
        photoStore.createIndex("contentFingerprint", "contentFingerprint");
      }
      request.result.createObjectStore("collections", { keyPath: "id" });
      if (includeMetadataStore) {
        request.result.createObjectStore("metadata", { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const transaction = database.transaction(
    ["photos", "collections"],
    "readwrite",
  );
  const completed = transactionComplete(transaction);
  for (const photo of photos) transaction.objectStore("photos").put(photo);
  for (const item of collections) {
    transaction.objectStore("collections").put(item);
  }
  await completed;
  database.close();
}

function openDatabase(name: string, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version
      ? indexedDB.open(name, version)
      : indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readRecord<T>(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
): Promise<T | undefined> {
  const transaction = database.transaction(storeName, "readonly");
  const completed = transactionComplete(transaction);
  const value = await requestResult<T | undefined>(
    transaction.objectStore(storeName).get(key),
  );
  await completed;
  return value;
}

async function countRecords(
  database: IDBDatabase,
  storeName: string,
): Promise<number> {
  const transaction = database.transaction(storeName, "readonly");
  const completed = transactionComplete(transaction);
  const count = await requestResult(transaction.objectStore(storeName).count());
  await completed;
  return count;
}

describe("catalog identity cutover", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: new IDBFactory(),
    });
    expect(RETIRED_CATALOG_NAME).toBe(EXPECTED_RETIRED_CATALOG_NAME);
  });

  it.each([1, 2])(
    "moves every field from a version %s previous catalog",
    async (version) => {
      await createCatalog(EXPECTED_RETIRED_CATALOG_NAME, version);
      const { initializeCatalog } = await import("./catalog");

      const database = await initializeCatalog();
      const photo = await readRecord<ReturnType<typeof storedPhoto>>(
        database,
        "photos",
        "photo-1",
      );
      const migratedCollection = await readRecord<typeof collection>(
        database,
        "collections",
        "collection-1",
      );

      expect(await photo?.blob.text()).toBe("original-photo-1");
      expect(photo?.blob.type).toBe("image/x-camera-raw");
      expect(await photo?.renderBlob.text()).toBe("render-photo-1");
      expect(photo?.renderBlob.type).toBe("image/jpeg");
      expect(await photo?.thumbnailBlob.text()).toBe("thumb-photo-1");
      expect(photo?.metadata).toEqual({ camera: "Test Camera", iso: 200 });
      expect(photo?.edits.global.exposure).toBe(1.25);
      expect(photo?.keywords).toEqual(["migration"]);
      expect(migratedCollection).toEqual(collection);

      const retired = await openDatabase(EXPECTED_RETIRED_CATALOG_NAME);
      expect(retired.version).toBe(3);
      expect(await countRecords(retired, "photos")).toBe(0);
      expect(await countRecords(retired, "collections")).toBe(0);
      retired.close();
      database.close();
    },
  );

  it("does not depend on database enumeration support", async () => {
    await createCatalog(EXPECTED_RETIRED_CATALOG_NAME, 2);
    Object.defineProperty(indexedDB, "databases", {
      configurable: true,
      value: undefined,
    });
    const { initializeCatalog } = await import("./catalog");

    const database = await initializeCatalog();
    expect(await readRecord(database, "photos", "photo-1")).toBeTruthy();
    database.close();
  });

  it("does not read image payloads back after a fresh migration write", async () => {
    const largePhoto = storedPhoto("photo-large");
    largePhoto.blob = new Blob([new Uint8Array(2 * 1024 * 1024 + 17)], {
      type: largePhoto.blob.type,
    });
    largePhoto.size = largePhoto.blob.size;
    await createCatalog(EXPECTED_RETIRED_CATALOG_NAME, 2, [largePhoto]);
    const payloadRead = vi.spyOn(Blob.prototype, "arrayBuffer");
    const { initializeCatalog } = await import("./catalog");

    try {
      const database = await initializeCatalog();
      expect(payloadRead).not.toHaveBeenCalled();
      database.close();
    } finally {
      payloadRead.mockRestore();
    }
  });

  it("uses insert-only strict writes before retiring source records", async () => {
    await createCatalog(EXPECTED_RETIRED_CATALOG_NAME, 2);
    const addRecord = vi.spyOn(FakeIDBObjectStore.prototype, "add");
    const openTransaction = vi.spyOn(FakeIDBDatabase.prototype, "transaction");
    const { initializeCatalog } = await import("./catalog");

    try {
      const database = await initializeCatalog();
      expect(addRecord).toHaveBeenCalled();
      expect(
        openTransaction.mock.calls.some(
          ([, mode, options]) =>
            mode === "readwrite" && options?.durability === "strict",
        ),
      ).toBe(true);
      database.close();
    } finally {
      addRecord.mockRestore();
      openTransaction.mockRestore();
    }
  });

  it("keeps the frozen source recoverable when a target write runs out of space", async () => {
    await createCatalog(EXPECTED_RETIRED_CATALOG_NAME, 2);
    const addRecord = vi
      .spyOn(FakeIDBObjectStore.prototype, "add")
      .mockImplementationOnce(() => {
        throw new DOMException("Storage full", "QuotaExceededError");
      });
    const module = await import("./catalog");

    try {
      await expect(module.initializeCatalog()).rejects.toThrow("remains safe");
      (await module.openCatalog()).close();
      const retired = await openDatabase(EXPECTED_RETIRED_CATALOG_NAME);
      expect(retired.version).toBe(3);
      expect(await readRecord(retired, "photos", "photo-1")).toBeTruthy();
      retired.close();
    } finally {
      addRecord.mockRestore();
    }
  });

  it("leaves a schema-identical unrelated database untouched", async () => {
    await createCatalog("unrelated-catalog", 2);
    const { initializeCatalog } = await import("./catalog");

    const database = await initializeCatalog();
    const unrelated = await openDatabase("unrelated-catalog");
    expect(await readRecord(unrelated, "photos", "photo-1")).toBeTruthy();
    unrelated.close();
    database.close();
  });

  it("resumes safely when an earlier cutover already copied some records", async () => {
    await createCatalog(EXPECTED_RETIRED_CATALOG_NAME, 2, [
      storedPhoto("photo-1"),
      storedPhoto("photo-2"),
    ]);
    await createCatalog(
      CURRENT_CATALOG_NAME,
      3,
      [storedPhoto("photo-1"), storedPhoto("photo-current")],
      [],
      true,
    );
    const { initializeCatalog } = await import("./catalog");

    const database = await initializeCatalog();
    const transaction = database.transaction("photos", "readonly");
    const completed = transactionComplete(transaction);
    const keys = await requestResult(transaction.objectStore("photos").getAllKeys());
    await completed;
    expect(keys.sort()).toEqual(["photo-1", "photo-2", "photo-current"]);

    const retired = await openDatabase(EXPECTED_RETIRED_CATALOG_NAME);
    expect(await countRecords(retired, "photos")).toBe(0);
    retired.close();
    database.close();
  });

  it("preserves both versions when an existing photo conflicts", async () => {
    const previousPhoto = storedPhoto("photo-1");
    const currentPhoto = storedPhoto("photo-1");
    currentPhoto.edits.global.exposure = -2.5;
    await createCatalog(EXPECTED_RETIRED_CATALOG_NAME, 2, [previousPhoto]);
    await createCatalog(
      CURRENT_CATALOG_NAME,
      3,
      [currentPhoto],
      [collection],
      true,
    );
    const module = await import("./catalog");

    await expect(module.initializeCatalog()).rejects.toThrow(
      "stopped before overwriting",
    );

    const current = await module.openCatalog();
    expect(
      (
        await readRecord<ReturnType<typeof storedPhoto>>(
          current,
          "photos",
          "photo-1",
        )
      )?.edits.global.exposure,
    ).toBe(-2.5);
    const retired = await openDatabase(EXPECTED_RETIRED_CATALOG_NAME);
    expect(await readRecord(retired, "photos", "photo-1")).toBeTruthy();
    retired.close();
    current.close();
  });

  it("detects same-size Blob conflicts before retiring the source record", async () => {
    const previousPhoto = storedPhoto("photo-1");
    const currentPhoto = storedPhoto("photo-1");
    currentPhoto.blob = new Blob(["x".repeat(previousPhoto.blob.size)], {
      type: previousPhoto.blob.type,
    });
    await createCatalog(EXPECTED_RETIRED_CATALOG_NAME, 2, [previousPhoto]);
    await createCatalog(
      CURRENT_CATALOG_NAME,
      3,
      [currentPhoto],
      [collection],
      true,
    );
    const module = await import("./catalog");
    const payloadRead = vi.spyOn(Blob.prototype, "arrayBuffer");

    try {
      await expect(module.initializeCatalog()).rejects.toThrow(
        "stopped before overwriting",
      );
      expect(payloadRead.mock.calls.length).toBeGreaterThanOrEqual(2);
      const retired = await openDatabase(EXPECTED_RETIRED_CATALOG_NAME);
      expect(
        await (
          await readRecord<ReturnType<typeof storedPhoto>>(
            retired,
            "photos",
            "photo-1",
          )
        )?.blob.text(),
      ).toBe("original-photo-1");
      retired.close();
      (await module.openCatalog()).close();
    } finally {
      payloadRead.mockRestore();
    }
  });

  it("keeps both records when only their fingerprint collides", async () => {
    const previousPhoto = storedPhoto("photo-previous");
    const currentPhoto = storedPhoto("photo-current");
    currentPhoto.fingerprint = previousPhoto.fingerprint;
    await createCatalog(EXPECTED_RETIRED_CATALOG_NAME, 2, [previousPhoto]);
    await createCatalog(
      CURRENT_CATALOG_NAME,
      3,
      [currentPhoto],
      [collection],
      true,
    );
    const { initializeCatalog } = await import("./catalog");

    const database = await initializeCatalog();
    expect(await readRecord(database, "photos", "photo-previous")).toBeTruthy();
    expect(await readRecord(database, "photos", "photo-current")).toBeTruthy();
    database.close();
  });

  it("resumes a moved collision record after its original collider is removed", async () => {
    const previousPhoto = storedPhoto("photo-previous");
    const movedPhoto = {
      ...previousPhoto,
      fingerprint: `${previousPhoto.fingerprint}:catalog-migration:${previousPhoto.id}`,
    };
    await createCatalog(EXPECTED_RETIRED_CATALOG_NAME, 2, [previousPhoto]);
    await createCatalog(
      CURRENT_CATALOG_NAME,
      3,
      [movedPhoto],
      [collection],
      true,
    );
    const { initializeCatalog } = await import("./catalog");

    const database = await initializeCatalog();
    expect(
      (
        await readRecord<ReturnType<typeof storedPhoto>>(
          database,
          "photos",
          previousPhoto.id,
        )
      )?.fingerprint,
    ).toBe(movedPhoto.fingerprint);
    const retired = await openDatabase(EXPECTED_RETIRED_CATALOG_NAME);
    expect(await countRecords(retired, "photos")).toBe(0);
    retired.close();
    database.close();
  });

  it("waits for an open previous-build tab without scheduling deletion", async () => {
    await createCatalog(EXPECTED_RETIRED_CATALOG_NAME, 2);
    const blocker = await openDatabase(EXPECTED_RETIRED_CATALOG_NAME, 2);
    const firstModule = await import("./catalog");

    await expect(firstModule.initializeCatalog()).rejects.toThrow(
      "open in another tab",
    );
    (await firstModule.openCatalog()).close();
    blocker.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    vi.resetModules();
    const secondModule = await import("./catalog");
    const database = await secondModule.initializeCatalog();
    expect(await readRecord(database, "photos", "photo-1")).toBeTruthy();
    const retired = await openDatabase(EXPECTED_RETIRED_CATALOG_NAME);
    expect(retired.version).toBe(3);
    expect(await countRecords(retired, "photos")).toBe(0);
    retired.close();
    database.close();
  });

  it("prevents a previous build from reopening the retired sentinel", async () => {
    await createCatalog(EXPECTED_RETIRED_CATALOG_NAME, 2);
    const { initializeCatalog } = await import("./catalog");
    const database = await initializeCatalog();

    await expect(
      openDatabase(EXPECTED_RETIRED_CATALOG_NAME, 2),
    ).rejects.toMatchObject({ name: "VersionError" });
    database.close();
  });

  it("rejects an unexpected previous schema without upgrading it", async () => {
    const malformed = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(EXPECTED_RETIRED_CATALOG_NAME, 2);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("unexpected");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    malformed.close();
    const { initializeCatalog, openCatalog } = await import("./catalog");

    await expect(initializeCatalog()).rejects.toThrow("unexpected schema");
    (await openCatalog()).close();
    const previous = await openDatabase(EXPECTED_RETIRED_CATALOG_NAME);
    expect(previous.version).toBe(2);
    previous.close();
  });

  it("accepts only current and exact previous backup formats", async () => {
    const { importCatalog } = await import("./catalog");
    const backup = {
      version: 1,
      exportedAt: "2026-08-01T12:00:00.000Z",
      photos: [],
      collections: [],
    };

    await expect(
      importCatalog({ ...backup, format: EXPECTED_RETIRED_CATALOG_NAME }),
    ).resolves.toMatchObject({ updatedPhotos: 0, skippedPhotos: 0 });
    await expect(
      importCatalog({ ...backup, format: CURRENT_CATALOG_NAME }),
    ).resolves.toMatchObject({ updatedPhotos: 0, skippedPhotos: 0 });
    await expect(
      importCatalog({ ...backup, format: "unrelated-catalog" }),
    ).rejects.toThrow("not a compatible");
  });

  it("clears both the current catalog and the retired sentinel explicitly", async () => {
    await createCatalog(EXPECTED_RETIRED_CATALOG_NAME, 2);
    const { clearCatalog, initializeCatalog } = await import("./catalog");
    const database = await initializeCatalog();
    const retired = await openDatabase(EXPECTED_RETIRED_CATALOG_NAME, 3);
    const transaction = retired.transaction("photos", "readwrite");
    const completed = transactionComplete(transaction);
    transaction.objectStore("photos").put(storedPhoto("photo-late"));
    await completed;
    retired.close();

    await clearCatalog();

    expect(await countRecords(database, "photos")).toBe(0);
    expect(await countRecords(database, "collections")).toBe(0);
    const clearedRetired = await openDatabase(EXPECTED_RETIRED_CATALOG_NAME);
    expect(await countRecords(clearedRetired, "photos")).toBe(0);
    expect(await countRecords(clearedRetired, "collections")).toBe(0);
    clearedRetired.close();
    database.close();
  });
});
