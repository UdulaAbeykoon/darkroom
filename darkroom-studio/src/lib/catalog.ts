import { canonicalProfileName, createDefaultEditState } from "../defaults";
import { normalizeMasks } from "./maskMath";
import {
  cameraRawInfo,
  decodeCameraRaw,
  renderBlobForPhoto,
} from "./rawImage";
import { RETIRED_CATALOG_NAME } from "./retiredIdentity";
import type {
  Collection,
  ColorLabel,
  EditState,
  FlagState,
  ImportOptions,
  PhotoMetadata,
  PhotoRecord,
} from "../types";

const DATABASE_NAME = "darkroom-catalog";
const DATABASE_VERSION = 3;
const RETIRED_DATABASE_VERSION = 3;
const PHOTO_STORE = "photos";
const COLLECTION_STORE = "collections";
const CONTENT_FINGERPRINT_INDEX = "contentFingerprint";
const THUMBNAIL_LONG_EDGE = 512;
const CATALOG_FORMAT = "darkroom-catalog";
const CATALOG_EXPORT_VERSION = 1;
const MAX_CATALOG_BACKUP_BYTES = 32 * 1024 * 1024;

type StoredPhoto = Omit<PhotoRecord, "objectUrl" | "thumbnailUrl"> & {
  thumbnailBlob: Blob;
  lastModified: number;
  fingerprint: string;
  contentFingerprint?: string;
};

interface ExportedPhoto {
  id: string;
  name: string;
  type: string;
  size: number;
  width: number;
  height: number;
  importedAt: string;
  lastEditedAt?: string;
  lastModified: number;
  fingerprint: string;
  metadata: Omit<PhotoMetadata, "latitude" | "longitude"> & {
    latitude: null;
    longitude: null;
  };
  rating: number;
  flag: FlagState;
  colorLabel: ColorLabel;
  keywords: string[];
  collectionIds: string[];
  edits: EditState;
  snapshots: PhotoRecord["snapshots"];
}

interface CatalogExport {
  format: typeof CATALOG_FORMAT;
  version: typeof CATALOG_EXPORT_VERSION;
  exportedAt: string;
  collections: Collection[];
  photos: ExportedPhoto[];
}

export interface ImportProgress {
  completed: number;
  total: number;
  fileName: string;
  status: "processing" | "imported" | "rejected";
  reason?: string;
}

export type ImportProgressCallback = (progress: ImportProgress) => void;

export interface FileImportResult {
  photos: PhotoRecord[];
  rejected: Array<{ name: string; reason: string }>;
}

export function normalizeImportKeywords(
  values: readonly string[] | undefined,
): string[] {
  if (!Array.isArray(values)) return [];

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const keyword = value.trim().replace(/\s+/g, " ").slice(0, 100);
    const key = keyword.toLocaleLowerCase();
    if (!keyword || seen.has(key)) continue;
    seen.add(key);
    normalized.push(keyword);
    if (normalized.length >= 100) break;
  }
  return normalized;
}

export function normalizeImportOptions(
  options: Partial<ImportOptions> = {},
): ImportOptions {
  const collectionId =
    typeof options.collectionId === "string"
      ? options.collectionId.trim().slice(0, 200)
      : "";
  return {
    method: options.method === "copy" ? "copy" : "add",
    duplicateHandling:
      options.duplicateHandling === "include" ? "include" : "skip",
    keywords: normalizeImportKeywords(options.keywords),
    collectionId: collectionId || null,
  };
}

export interface CatalogImportResult {
  updatedPhotos: number;
  importedCollections: number;
  skippedPhotos: number;
  warnings: string[];
}

interface ClassifiedImage {
  format:
    | "jpeg"
    | "png"
    | "webp"
    | "gif"
    | "bmp"
    | "tiff"
    | "heic"
    | "raw";
  mimeType: string;
  bestEffort: boolean;
}

interface DecodedImage {
  width: number;
  height: number;
  thumbnailBlob: Blob;
  renderBlob?: Blob;
  metadata?: PhotoMetadata;
}

const FLAG_STATES = new Set<FlagState>(["pick", "reject", "unflagged"]);
const COLOR_LABELS = new Set<ColorLabel>([
  "red",
  "yellow",
  "green",
  "blue",
  "purple",
  "none",
]);

let databasePromise: Promise<IDBDatabase> | undefined;
let catalogMigrationPromise: Promise<void> | undefined;
let persistenceRequest: Promise<boolean> | undefined;
let catalogWriteQueue: Promise<void> = Promise.resolve();
let pendingSaveTimer: ReturnType<typeof setTimeout> | undefined;
const pendingPhotoSaves = new Map<
  string,
  {
    photo: PhotoRecord;
    waiters: Array<{
      resolve: () => void;
      reject: (error: unknown) => void;
    }>;
  }
>();
const activeObjectUrls = new Map<
  string,
  { objectUrl: string; thumbnailUrl: string }
>();

async function withCatalogWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  const lockManager = (
    globalThis.navigator as
      | (Navigator & {
          locks?: {
            request: <Result>(
              name: string,
              callback: () => Promise<Result>,
            ) => Promise<Result>;
          };
        })
      | undefined
  )?.locks;
  if (!lockManager?.request) return operation();

  const lockNames = [
    `${DATABASE_NAME}-write`,
    `${RETIRED_CATALOG_NAME}-write`,
  ].sort();
  const requestLock = (index: number): Promise<T> =>
    index >= lockNames.length
      ? operation()
      : lockManager.request(lockNames[index], () => requestLock(index + 1));
  return requestLock(0);
}

function enqueueCatalogWrite<T>(operation: () => Promise<T>): Promise<T> {
  const run = () => withCatalogWriteLock(operation);
  const result = catalogWriteQueue.then(run, run);
  catalogWriteQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Unknown browser storage error";
}

function catalogError(action: string, error: unknown): Error {
  return new Error(`${action}: ${errorMessage(error)}`);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction was aborted"));
  });
}

/**
 * Opens Darkroom's private IndexedDB catalog. This database stores copies of
 * imported files; it never receives or retains a writable filesystem handle.
 */
export function openCatalog(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;

  if (typeof indexedDB === "undefined") {
    return Promise.reject(
      new Error(
        "This browser does not provide IndexedDB, so the local photo catalog cannot be opened.",
      ),
    );
  }

  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      let photoStore: IDBObjectStore;

      if (!database.objectStoreNames.contains(PHOTO_STORE)) {
        photoStore = database.createObjectStore(PHOTO_STORE, { keyPath: "id" });
      } else {
        photoStore = request.transaction!.objectStore(PHOTO_STORE);
      }

      if (!photoStore.indexNames.contains("fingerprint")) {
        photoStore.createIndex("fingerprint", "fingerprint", { unique: true });
      }
      if (!photoStore.indexNames.contains(CONTENT_FINGERPRINT_INDEX)) {
        photoStore.createIndex(
          CONTENT_FINGERPRINT_INDEX,
          CONTENT_FINGERPRINT_INDEX,
          { unique: false },
        );
      }

      if (!database.objectStoreNames.contains(COLLECTION_STORE)) {
        database.createObjectStore(COLLECTION_STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }

      settled = true;
      database.onversionchange = () => {
        database.close();
        databasePromise = undefined;
      };
      resolve(database);
    };

    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(
        catalogError(
          "Could not open the local photo catalog",
          request.error ?? new Error("IndexedDB open request failed"),
        ),
      );
    };

    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          "Could not upgrade the local photo catalog because it is open in another tab. Close other Lightroom workspace tabs and try again.",
        ),
      );
    };
  });

  void databasePromise.then(undefined, () => {
    databasePromise = undefined;
  });

  return databasePromise;
}

function hasPreviousCatalogSchema(
  database: IDBDatabase,
  transaction?: IDBTransaction,
): boolean {
  if (
    database.objectStoreNames.length !== 2 ||
    !database.objectStoreNames.contains(PHOTO_STORE) ||
    !database.objectStoreNames.contains(COLLECTION_STORE)
  ) {
    return false;
  }

  const inspection =
    transaction ??
    database.transaction([PHOTO_STORE, COLLECTION_STORE], "readonly");
  const photoStore = inspection.objectStore(PHOTO_STORE);
  const collectionStore = inspection.objectStore(COLLECTION_STORE);
  return (
    photoStore.keyPath === "id" &&
    collectionStore.keyPath === "id" &&
    photoStore.indexNames.contains("fingerprint")
  );
}

/**
 * Raises the retired catalog to a sentinel version before moving any records.
 * Older builds open an exact lower version, so they can no longer write while
 * this resumable one-way cutover is in progress.
 */
function openPreviousCatalogForCutover(): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(
      RETIRED_CATALOG_NAME,
      RETIRED_DATABASE_VERSION,
    );
    let created = false;
    let invalidSchema = false;
    let settled = false;

    request.onupgradeneeded = (event) => {
      if (event.oldVersion === 0) {
        created = true;
        request.transaction?.abort();
        return;
      }
      if (
        !request.transaction ||
        !hasPreviousCatalogSchema(request.result, request.transaction)
      ) {
        invalidSchema = true;
        request.transaction?.abort();
      }
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      if (!hasPreviousCatalogSchema(request.result)) {
        request.result.close();
        reject(new Error("The previous local catalog has an unexpected schema."));
        return;
      }
      resolve(request.result);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      if (created && request.error?.name === "AbortError") {
        resolve(null);
        return;
      }
      if (invalidSchema) {
        reject(new Error("The previous local catalog has an unexpected schema."));
        return;
      }
      reject(
        catalogError(
          "Could not prepare the previous local photo catalog",
          request.error ?? new Error("IndexedDB open request failed"),
        ),
      );
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          "Could not prepare the previous local catalog because it is open in another tab. Close other Lightroom workspace tabs and reload.",
        ),
      );
    };
  });
}

async function storeKeys(
  database: IDBDatabase,
  storeName: string,
): Promise<IDBValidKey[]> {
  const transaction = database.transaction(storeName, "readonly");
  const completed = transactionComplete(transaction);
  const keys = await requestResult(transaction.objectStore(storeName).getAllKeys());
  await completed;
  return keys;
}

async function storeRecord<T>(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
): Promise<T | undefined> {
  const transaction = database.transaction(storeName, "readonly");
  const completed = transactionComplete(transaction);
  const record = await requestResult<T | undefined>(
    transaction.objectStore(storeName).get(key),
  );
  await completed;
  return record;
}

function isStoredPhotoForMigration(value: unknown): value is StoredPhoto {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.type === "string" &&
    typeof value.size === "number" &&
    typeof value.width === "number" &&
    typeof value.height === "number" &&
    typeof value.importedAt === "string" &&
    typeof value.lastModified === "number" &&
    typeof value.fingerprint === "string" &&
    value.blob instanceof Blob &&
    value.thumbnailBlob instanceof Blob &&
    (value.renderBlob === undefined || value.renderBlob instanceof Blob) &&
    isObject(value.metadata) &&
    typeof value.rating === "number" &&
    FLAG_STATES.has(value.flag as FlagState) &&
    COLOR_LABELS.has(value.colorLabel as ColorLabel) &&
    Array.isArray(value.keywords) &&
    Array.isArray(value.collectionIds) &&
    isObject(value.edits) &&
    Array.isArray(value.snapshots)
  );
}

function isCollectionForMigration(value: unknown): value is Collection {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.createdAt === "string"
  );
}

interface StoredPhotoMatches {
  byId?: StoredPhoto;
  byFingerprint?: StoredPhoto;
}

async function storedPhotoMatches(
  database: IDBDatabase,
  photo: StoredPhoto,
): Promise<StoredPhotoMatches> {
  const transaction = database.transaction(PHOTO_STORE, "readonly");
  const completed = transactionComplete(transaction);
  const store = transaction.objectStore(PHOTO_STORE);
  const [byId, byFingerprint] = await Promise.all([
    requestResult<StoredPhoto | undefined>(store.get(photo.id)),
    requestResult<StoredPhoto | undefined>(
      store.index("fingerprint").get(photo.fingerprint),
    ),
  ]);
  await completed;
  return { byId, byFingerprint };
}

function sameBlobShape(left: Blob | undefined, right: Blob | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.size === right.size && left.type === right.type;
}

async function sameBlobContent(
  left: Blob | undefined,
  right: Blob | undefined,
): Promise<boolean> {
  if (!sameBlobShape(left, right)) return false;
  if (!left || !right) return true;
  const chunkSize = 1024 * 1024;
  for (let offset = 0; offset < left.size; offset += chunkSize) {
    const end = Math.min(left.size, offset + chunkSize);
    const [leftChunk, rightChunk] = await Promise.all([
      left.slice(offset, end).arrayBuffer(),
      right.slice(offset, end).arrayBuffer(),
    ]);
    const leftBytes = new Uint8Array(leftChunk);
    const rightBytes = new Uint8Array(rightChunk);
    for (let index = 0; index < leftBytes.length; index += 1) {
      if (leftBytes[index] !== rightBytes[index]) return false;
    }
  }
  return true;
}

function storedPhotoMetadataJson(photo: StoredPhoto): string {
  const {
    blob: _blob,
    renderBlob: _renderBlob,
    thumbnailBlob: _thumbnailBlob,
    ...metadata
  } = photo;
  return JSON.stringify(metadata);
}

async function sameStoredPhoto(
  left: StoredPhoto,
  right: StoredPhoto,
): Promise<boolean> {
  return (
    sameStoredPhotoShape(left, right) &&
    (await sameBlobContent(left.blob, right.blob)) &&
    (await sameBlobContent(left.renderBlob, right.renderBlob)) &&
    (await sameBlobContent(left.thumbnailBlob, right.thumbnailBlob))
  );
}

function sameStoredPhotoShape(left: StoredPhoto, right: StoredPhoto): boolean {
  return (
    storedPhotoMetadataJson(left) === storedPhotoMetadataJson(right) &&
    sameBlobShape(left.blob, right.blob) &&
    sameBlobShape(left.renderBlob, right.renderBlob) &&
    sameBlobShape(left.thumbnailBlob, right.thumbnailBlob)
  );
}

function migratedDuplicateFingerprint(photo: StoredPhoto): string {
  return `${photo.fingerprint}:catalog-migration:${photo.id}`;
}

async function copyPreviousPhoto(
  database: IDBDatabase,
  photo: StoredPhoto,
): Promise<void> {
  const matches = await storedPhotoMatches(database, photo);
  const collidesWithAnotherPhoto =
    matches.byFingerprint !== undefined &&
    matches.byFingerprint.id !== photo.id;
  const migratedFingerprint = migratedDuplicateFingerprint(photo);
  const needsMigratedFingerprint =
    collidesWithAnotherPhoto ||
    matches.byId?.fingerprint === migratedFingerprint;
  const candidate = needsMigratedFingerprint
    ? { ...photo, fingerprint: migratedFingerprint }
    : photo;

  if (matches.byId) {
    if (await sameStoredPhoto(matches.byId, candidate)) return;
    throw new Error(
      `Migration stopped before overwriting either catalog version of “${photo.name}”.`,
    );
  }

  const transaction = database.transaction(PHOTO_STORE, "readwrite");
  const completed = transactionComplete(transaction);
  transaction.objectStore(PHOTO_STORE).put(candidate);
  await completed;

  const copied = await storeRecord<StoredPhoto>(database, PHOTO_STORE, photo.id);
  if (!copied || !sameStoredPhotoShape(copied, candidate)) {
    throw new Error(`Could not verify the migrated copy of “${photo.name}”.`);
  }
}

async function copyPreviousCollection(
  database: IDBDatabase,
  collection: Collection,
): Promise<void> {
  const existing = await storeRecord<Collection>(
    database,
    COLLECTION_STORE,
    collection.id,
  );
  if (existing) {
    if (JSON.stringify(existing) === JSON.stringify(collection)) return;
    throw new Error(
      `Migration stopped before overwriting either catalog version of “${collection.name}”.`,
    );
  }

  const transaction = database.transaction(COLLECTION_STORE, "readwrite");
  const completed = transactionComplete(transaction);
  transaction.objectStore(COLLECTION_STORE).put(collection);
  await completed;

  if (
    !(await storeRecord<Collection>(database, COLLECTION_STORE, collection.id))
  ) {
    throw new Error(`Could not verify the migrated collection “${collection.name}”.`);
  }
}

async function deleteStoreRecord(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
): Promise<void> {
  const transaction = database.transaction(storeName, "readwrite");
  const completed = transactionComplete(transaction);
  transaction.objectStore(storeName).delete(key);
  await completed;
  if ((await storeRecord(database, storeName, key)) !== undefined) {
    throw new Error("Could not retire a migrated catalog record.");
  }
}

async function migratePreviousCatalog(database: IDBDatabase): Promise<void> {
  const previous = await openPreviousCatalogForCutover();
  if (!previous) return;

  try {
    for (const key of await storeKeys(previous, PHOTO_STORE)) {
      const photo = await storeRecord<unknown>(previous, PHOTO_STORE, key);
      if (!isStoredPhotoForMigration(photo)) {
        throw new Error("The previous local catalog contains a damaged photo record.");
      }
      await copyPreviousPhoto(database, photo);
      await deleteStoreRecord(previous, PHOTO_STORE, key);
    }

    for (const key of await storeKeys(previous, COLLECTION_STORE)) {
      const collection = await storeRecord<unknown>(
        previous,
        COLLECTION_STORE,
        key,
      );
      if (!isCollectionForMigration(collection)) {
        throw new Error(
          "The previous local catalog contains a damaged collection record.",
        );
      }
      await copyPreviousCollection(database, collection);
      await deleteStoreRecord(previous, COLLECTION_STORE, key);
    }
  } finally {
    previous.close();
  }
}

async function clearPreviousCatalogRecords(): Promise<void> {
  const previous = await openPreviousCatalogForCutover();
  if (!previous) return;
  try {
    const transaction = previous.transaction(
      [PHOTO_STORE, COLLECTION_STORE],
      "readwrite",
    );
    const completed = transactionComplete(transaction);
    transaction.objectStore(PHOTO_STORE).clear();
    transaction.objectStore(COLLECTION_STORE).clear();
    await completed;
  } finally {
    previous.close();
  }
}

/**
 * Asks the browser not to evict the catalog under storage pressure. Browsers
 * may decline this request; a declined request does not prevent local editing.
 */
export function requestPersistentStorage(): Promise<boolean> {
  if (persistenceRequest) return persistenceRequest;

  persistenceRequest = (async () => {
    try {
      const storage = globalThis.navigator?.storage;
      if (!storage?.persist) return false;
      if (storage.persisted && (await storage.persisted())) return true;
      return await storage.persist();
    } catch {
      return false;
    }
  })();

  return persistenceRequest;
}

export async function initialize(): Promise<IDBDatabase> {
  const database = await openCatalog();
  if (!catalogMigrationPromise) {
    catalogMigrationPromise = withCatalogWriteLock(() =>
      migratePreviousCatalog(database),
    );
  }
  await catalogMigrationPromise;
  await requestPersistentStorage();
  return database;
}

export const initializeCatalog = initialize;

function makeId(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }

  const random = Math.random().toString(36).slice(2);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function makeFingerprint(
  name: string,
  size: number,
  lastModified: number,
): string {
  return JSON.stringify([name, size, lastModified]);
}

async function contentFingerprint(blob: Blob): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    const file = blob as File;
    return makeFingerprint(
      file.name || "blob",
      blob.size,
      Number.isFinite(file.lastModified) ? file.lastModified : 0,
    );
  }
  const digest = await subtle.digest("SHA-256", await blob.arrayBuffer());
  const bytes = new Uint8Array(digest);
  return `sha256:${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

async function getStoredPhotos(): Promise<StoredPhoto[]> {
  try {
    const database = await openCatalog();
    const transaction = database.transaction(PHOTO_STORE, "readonly");
    const completed = transactionComplete(transaction);
    const records = await requestResult(
      transaction.objectStore(PHOTO_STORE).getAll() as IDBRequest<StoredPhoto[]>,
    );
    await completed;
    return records;
  } catch (error) {
    throw catalogError("Could not read photos from the local catalog", error);
  }
}

async function getStoredPhotosByIds(
  ids: readonly string[],
): Promise<Map<string, StoredPhoto>> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();

  try {
    const database = await openCatalog();
    const transaction = database.transaction(PHOTO_STORE, "readonly");
    const completed = transactionComplete(transaction);
    const store = transaction.objectStore(PHOTO_STORE);
    const records = await Promise.all(
      uniqueIds.map((id) =>
        requestResult(
          store.get(id) as IDBRequest<StoredPhoto | undefined>,
        ),
      ),
    );
    await completed;
    return new Map(
      records
        .filter((record): record is StoredPhoto => Boolean(record))
        .map((record) => [record.id, record]),
    );
  } catch (error) {
    throw catalogError("Could not read photos from the local catalog", error);
  }
}

function indexKeys(
  index: IDBIndex,
  target: Set<string>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = index.openKeyCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      if (typeof cursor.key === "string") target.add(cursor.key);
      cursor.continue();
    };
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB index scan failed"));
  });
}

/** Reads duplicate signatures through key-only indexes, without loading image blobs. */
async function getStoredContentFingerprints(): Promise<Set<string>> {
  try {
    const database = await openCatalog();
    const transaction = database.transaction(PHOTO_STORE, "readonly");
    const completed = transactionComplete(transaction);
    const store = transaction.objectStore(PHOTO_STORE);
    const fingerprints = new Set<string>();
    const scans = [indexKeys(store.index("fingerprint"), fingerprints)];
    if (store.indexNames.contains(CONTENT_FINGERPRINT_INDEX)) {
      scans.push(
        indexKeys(store.index(CONTENT_FINGERPRINT_INDEX), fingerprints),
      );
    }
    await Promise.all(scans);
    await completed;
    return fingerprints;
  } catch (error) {
    throw catalogError(
      "Could not read duplicate signatures from the local catalog",
      error,
    );
  }
}

async function putStoredPhotos(records: StoredPhoto[]): Promise<void> {
  if (records.length === 0) return;

  try {
    const database = await openCatalog();
    const transaction = database.transaction(PHOTO_STORE, "readwrite");
    const completed = transactionComplete(transaction);
    const store = transaction.objectStore(PHOTO_STORE);

    for (const record of records) store.put(record);
    await completed;
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "QuotaExceededError" || error.name === "UnknownError")
    ) {
      throw new Error(
        "The photo could not be saved because browser storage is full. Export any edits you need before clearing space.",
      );
    }
    if (error instanceof DOMException && error.name === "ConstraintError") {
      throw new Error(
        "This image content is already in the catalog. Turn off “Don’t Import Suspected Duplicates” to include another copy.",
      );
    }
    throw catalogError("Could not save the photo to the local catalog", error);
  }
}

function revokePhotoUrls(id: string): void {
  const urls = activeObjectUrls.get(id);
  if (!urls) return;

  URL.revokeObjectURL(urls.objectUrl);
  if (urls.thumbnailUrl !== urls.objectUrl) {
    URL.revokeObjectURL(urls.thumbnailUrl);
  }
  activeObjectUrls.delete(id);
}

function materializePhoto(stored: StoredPhoto): PhotoRecord {
  if (typeof URL?.createObjectURL !== "function") {
    throw new Error(
      "This browser cannot create local image URLs for the catalog.",
    );
  }
  if (!(stored.blob instanceof Blob)) {
    throw new Error(`The stored copy of “${stored.name}” is damaged.`);
  }

  revokePhotoUrls(stored.id);

  const renderBlob =
    stored.renderBlob instanceof Blob ? stored.renderBlob : stored.blob;
  const objectUrl = URL.createObjectURL(renderBlob);
  let thumbnailUrl = objectUrl;
  try {
    thumbnailUrl = URL.createObjectURL(
      stored.thumbnailBlob instanceof Blob ? stored.thumbnailBlob : renderBlob,
    );
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }

  activeObjectUrls.set(stored.id, { objectUrl, thumbnailUrl });
  const {
    thumbnailBlob: _thumbnailBlob,
    lastModified: _lastModified,
    fingerprint: _fingerprint,
    contentFingerprint: _contentFingerprint,
    ...photo
  } = stored;

  const edits = importedEditState(photo.edits, createDefaultEditState());
  const snapshots = importedSnapshots(photo.snapshots, [], edits);

  return { ...photo, edits, snapshots, objectUrl, thumbnailUrl };
}

export async function loadPhotos(): Promise<PhotoRecord[]> {
  const stored = await getStoredPhotos();
  const photos: PhotoRecord[] = [];

  for (const record of stored) {
    try {
      photos.push(materializePhoto(record));
    } catch (error) {
      throw catalogError(
        `Could not load the stored copy of “${record.name || "unnamed photo"}”`,
        error,
      );
    }
  }

  return photos;
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1).toLowerCase() : "";
}

function classifyImage(file: File): ClassifiedImage | undefined {
  const extension = extensionOf(file.name);
  const mime = file.type.toLowerCase().split(";")[0].trim();
  const raw = cameraRawInfo(file);

  if (raw) {
    return { format: "raw", mimeType: raw.mimeType, bestEffort: false };
  }

  if (
    mime === "image/jpeg" ||
    mime === "image/jpg" ||
    mime === "image/pjpeg" ||
    extension === "jpg" ||
    extension === "jpeg" ||
    extension === "jfif"
  ) {
    return { format: "jpeg", mimeType: "image/jpeg", bestEffort: false };
  }
  if (mime === "image/png" || extension === "png") {
    return { format: "png", mimeType: "image/png", bestEffort: false };
  }
  if (mime === "image/webp" || extension === "webp") {
    return { format: "webp", mimeType: "image/webp", bestEffort: false };
  }
  if (mime === "image/gif" || extension === "gif") {
    return { format: "gif", mimeType: "image/gif", bestEffort: false };
  }
  if (
    mime === "image/bmp" ||
    mime === "image/x-bmp" ||
    mime === "image/x-ms-bmp" ||
    extension === "bmp" ||
    extension === "dib"
  ) {
    return { format: "bmp", mimeType: "image/bmp", bestEffort: false };
  }
  if (
    mime === "image/tiff" ||
    mime === "image/tif" ||
    extension === "tif" ||
    extension === "tiff"
  ) {
    return { format: "tiff", mimeType: "image/tiff", bestEffort: true };
  }
  if (
    mime === "image/heic" ||
    mime === "image/heif" ||
    mime === "image/heic-sequence" ||
    mime === "image/heif-sequence" ||
    extension === "heic" ||
    extension === "heif" ||
    extension === "hif"
  ) {
    return { format: "heic", mimeType: mime || "image/heic", bestEffort: true };
  }

  return undefined;
}

function canvasDimensions(
  width: number,
  height: number,
): { width: number; height: number } {
  const scale = Math.min(1, THUMBNAIL_LONG_EDGE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function thumbnailFromDrawable(
  drawable: CanvasImageSource,
  width: number,
  height: number,
): Promise<Blob> {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error("The image has invalid pixel dimensions.");
  }

  const output = canvasDimensions(width, height);

  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(output.width, output.height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("The browser could not create a 2D canvas.");
    context.drawImage(drawable, 0, 0, output.width, output.height);
    return canvas.convertToBlob({ type: "image/jpeg", quality: 0.84 });
  }

  if (typeof document === "undefined") {
    throw new Error(
      "The browser has no canvas implementation for thumbnail generation.",
    );
  }

  const canvas = document.createElement("canvas");
  canvas.width = output.width;
  canvas.height = output.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("The browser could not create a 2D canvas.");
  context.drawImage(drawable, 0, 0, output.width, output.height);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("The browser could not encode the thumbnail."));
      },
      "image/jpeg",
      0.84,
    );
  });
}

async function decodeWithImageBitmap(file: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap !== "function") {
    throw new Error("createImageBitmap is unavailable");
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    bitmap = await createImageBitmap(file);
  }

  try {
    return {
      width: bitmap.width,
      height: bitmap.height,
      thumbnailBlob: await thumbnailFromDrawable(
        bitmap,
        bitmap.width,
        bitmap.height,
      ),
    };
  } finally {
    bitmap.close();
  }
}

async function decodeWithImageElement(file: Blob): Promise<DecodedImage> {
  if (typeof document === "undefined" || typeof URL?.createObjectURL !== "function") {
    throw new Error("HTML image decoding is unavailable");
  }

  const url = URL.createObjectURL(file);
  const image = document.createElement("img");
  image.decoding = "async";

  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () =>
        reject(new Error("The browser's image decoder rejected this file."));
      image.src = url;
    });

    const width = image.naturalWidth;
    const height = image.naturalHeight;
    return {
      width,
      height,
      thumbnailBlob: await thumbnailFromDrawable(image, width, height),
    };
  } finally {
    image.onload = null;
    image.onerror = null;
    image.removeAttribute("src");
    URL.revokeObjectURL(url);
  }
}

async function decodeImage(
  file: Blob,
  classification: ClassifiedImage,
): Promise<DecodedImage> {
  const failures: string[] = [];

  if (classification.format === "raw") {
    const raw = await decodeCameraRaw(file);
    let decoded: DecodedImage;
    try {
      decoded = await decodeWithImageBitmap(raw.blob);
    } catch (error) {
      failures.push(errorMessage(error));
      try {
        decoded = await decodeWithImageElement(raw.blob);
      } catch (fallbackError) {
        failures.push(errorMessage(fallbackError));
        throw new Error(
          `The camera RAW was decoded, but its working image could not be opened (${failures.join("; ")}).`,
        );
      }
    }
    return {
      ...decoded,
      renderBlob: raw.blob,
      metadata: raw.metadata,
    };
  }

  try {
    return await decodeWithImageBitmap(file);
  } catch (error) {
    failures.push(errorMessage(error));
  }

  try {
    return await decodeWithImageElement(file);
  } catch (error) {
    failures.push(errorMessage(error));
  }

  if (classification.format === "heic") {
    throw new Error(
      "This browser cannot decode this HEIC/HEIF file. The original was not changed; convert a copy to JPEG, PNG, or WebP and import that copy.",
    );
  }
  if (classification.format === "tiff") {
    throw new Error(
      "This browser cannot decode this TIFF file. The original was not changed; export a JPEG, PNG, or WebP copy and import that copy.",
    );
  }

  const diagnostic = failures.filter(Boolean).join("; ");
  throw new Error(
    `The file is labelled as ${classification.format.toUpperCase()}, but the browser could not decode it${diagnostic ? ` (${diagnostic})` : ""}.`,
  );
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function exifDate(value: unknown): string | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }

  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }

  return undefined;
}

function shutterLabel(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const seconds = numberValue(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  if (seconds < 1) return `1/${Math.max(1, Math.round(1 / seconds))}s`;
  return `${Number(seconds.toFixed(2))}s`;
}

function makeCameraLabel(make: unknown, model: unknown): string | undefined {
  const makeText = stringValue(make);
  const modelText = stringValue(model);
  if (!makeText) return modelText;
  if (!modelText) return makeText;
  if (modelText.toLowerCase().startsWith(makeText.toLowerCase())) return modelText;
  return `${makeText} ${modelText}`;
}

async function readMetadata(file: File): Promise<PhotoMetadata> {
  try {
    // EXIF parsing is only needed during import. Keeping it out of the startup
    // graph makes the editor interactive sooner without changing import data.
    const exifr = await import("exifr");
    const parsed: unknown = await exifr.parse(file, {
      tiff: true,
      exif: true,
      gps: true,
      xmp: true,
      iptc: true,
      mergeOutput: true,
      sanitize: true,
    });

    if (!parsed || typeof parsed !== "object") return {};
    const raw = parsed as Record<string, unknown>;
    const latitude = numberValue(raw.latitude ?? raw.Latitude);
    const longitude = numberValue(raw.longitude ?? raw.Longitude);

    return {
      camera: makeCameraLabel(raw.Make, raw.Model),
      lens: stringValue(raw.LensModel ?? raw.Lens ?? raw.LensInfo),
      iso: numberValue(raw.ISO ?? raw.ISOSpeedRatings ?? raw.PhotographicSensitivity),
      aperture: numberValue(raw.FNumber ?? raw.ApertureValue),
      shutter: shutterLabel(raw.ExposureTime ?? raw.ShutterSpeedValue),
      focalLength: numberValue(raw.FocalLength),
      capturedAt: exifDate(
        raw.DateTimeOriginal ?? raw.CreateDate ?? raw.DateTimeDigitized,
      ),
      latitude,
      longitude,
      copyright: stringValue(raw.Copyright ?? raw.CopyrightNotice),
      caption: stringValue(
        raw.CaptionAbstract ??
          raw.Description ??
          raw.ImageDescription ??
          raw.ObjectName,
      ),
    };
  } catch {
    // EXIF is optional. A damaged or unsupported metadata block should never
    // make an otherwise decodable photograph impossible to import.
    return {};
  }
}

function mergeDefinedMetadata(
  fallback: PhotoMetadata | undefined,
  preferred: PhotoMetadata,
): PhotoMetadata {
  const definedPreferred = Object.fromEntries(
    Object.entries(preferred).filter(([, value]) => value !== undefined),
  ) as PhotoMetadata;
  return { ...fallback, ...definedPreferred };
}

function reportProgress(
  callback: ImportProgressCallback | undefined,
  progress: ImportProgress,
): void {
  if (!callback) return;
  try {
    callback(progress);
  } catch {
    // Progress is advisory; application callback failures must not roll back a
    // successfully decoded and persisted photograph.
  }
}

export async function importFiles(
  files: File[],
  optionsOrProgress: Partial<ImportOptions> | ImportProgressCallback = {},
  progressCallback?: ImportProgressCallback,
): Promise<FileImportResult> {
  await initialize();

  const options = normalizeImportOptions(
    typeof optionsOrProgress === "function" ? {} : optionsOrProgress,
  );
  const onProgress =
    typeof optionsOrProgress === "function"
      ? optionsOrProgress
      : progressCallback;
  const contentFingerprints = await getStoredContentFingerprints();
  const imported: PhotoRecord[] = [];
  const rejected: FileImportResult["rejected"] = [];
  const total = files.length;

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    reportProgress(onProgress, {
      completed: index,
      total,
      fileName: file.name,
      status: "processing",
    });

    let rejectionReason: string | undefined;

    try {
      if (!(file instanceof File)) {
        throw new Error("The selected item is not a browser File object.");
      }
      if (file.size <= 0) {
        throw new Error("The file is empty.");
      }
      if (file.size > 256 * 1024 * 1024) {
        throw new Error(
          "This file is larger than the 256 MB browser-safety limit.",
        );
      }

      const classification = classifyImage(file);
      if (!classification) {
        throw new Error(
          "Unsupported file type. Import JPEG, PNG, WebP, GIF, BMP, or a supported camera RAW; TIFF and HEIC/HEIF are accepted when this browser can decode them.",
        );
      }

      const sourceFingerprint = await contentFingerprint(file);
      const duplicate = contentFingerprints.has(sourceFingerprint);
      if (duplicate && options.duplicateHandling === "skip") {
        throw new Error("Already in the catalog (matching image content).");
      }

      const [decoded, parsedMetadata] = await Promise.all([
        decodeImage(file, classification),
        readMetadata(file),
      ]);
      const metadata = mergeDefinedMetadata(decoded.metadata, parsedMetadata);
      const importedAt = new Date().toISOString();
      const id = makeId("photo");
      const fingerprint = duplicate
        ? `${sourceFingerprint}:included-duplicate:${id}`
        : sourceFingerprint;
      const catalogBlob =
        options.method === "copy"
          ? file.slice(0, file.size, classification.mimeType)
          : file;
      const storedPhoto: StoredPhoto = {
        id,
        name: file.name,
        type: classification.mimeType,
        size: file.size,
        width: decoded.width,
        height: decoded.height,
        importedAt,
        importMethod: options.method,
        blob: catalogBlob,
        renderBlob: decoded.renderBlob,
        thumbnailBlob: decoded.thumbnailBlob,
        lastModified: file.lastModified,
        fingerprint,
        contentFingerprint: sourceFingerprint,
        metadata,
        rating: 0,
        flag: "unflagged",
        colorLabel: "none",
        keywords: [...options.keywords],
        collectionIds: options.collectionId ? [options.collectionId] : [],
        edits: createDefaultEditState(),
        snapshots: [],
      };

      await enqueueCatalogWrite(() => putStoredPhotos([storedPhoto]));
      contentFingerprints.add(sourceFingerprint);
      imported.push(materializePhoto(storedPhoto));
    } catch (error) {
      rejectionReason = errorMessage(error);
      rejected.push({ name: file?.name || "Unnamed file", reason: rejectionReason });
    }

    reportProgress(onProgress, {
      completed: index + 1,
      total,
      fileName: file?.name || "Unnamed file",
      status: rejectionReason ? "rejected" : "imported",
      reason: rejectionReason,
    });
  }

  return { photos: imported, rejected };
}

async function storedPhotoFromPublic(
  photo: PhotoRecord,
  existing?: StoredPhoto,
): Promise<StoredPhoto> {
  if (!photo.id?.trim()) throw new Error("A photo must have an id before it can be saved.");
  if (!(photo.blob instanceof Blob)) {
    throw new Error(`“${photo.name || "Unnamed photo"}” has no readable image blob.`);
  }

  let thumbnailBlob = existing?.thumbnailBlob;
  if (!(thumbnailBlob instanceof Blob)) {
    const renderingBlob = renderBlobForPhoto(photo);
    const classification = photo.renderBlob
      ? {
          format: "jpeg" as const,
          mimeType: renderingBlob.type || "image/jpeg",
          bestEffort: false,
        }
      : (classifyImage(
          new File([renderingBlob], photo.name, {
            type: photo.type || renderingBlob.type,
            lastModified: 0,
          }),
        ) ?? {
          format: "jpeg" as const,
          mimeType: photo.type || renderingBlob.type || "image/jpeg",
          bestEffort: false,
        });
    thumbnailBlob = (await decodeImage(renderingBlob, classification)).thumbnailBlob;
  }

  const lastModified = existing?.lastModified ?? 0;
  return {
    id: photo.id,
    name: photo.name,
    type: photo.type || photo.blob.type || "application/octet-stream",
    size: photo.size || photo.blob.size,
    width: photo.width,
    height: photo.height,
    importedAt: photo.importedAt,
    lastEditedAt: photo.lastEditedAt,
    importMethod: photo.importMethod ?? existing?.importMethod,
    blob: photo.blob,
    renderBlob:
      photo.renderBlob instanceof Blob ? photo.renderBlob : existing?.renderBlob,
    thumbnailBlob,
    lastModified,
    fingerprint:
      existing?.fingerprint ??
      makeFingerprint(photo.name, photo.size || photo.blob.size, lastModified),
    contentFingerprint:
      existing?.contentFingerprint ??
      existing?.fingerprint ??
      makeFingerprint(photo.name, photo.size || photo.blob.size, lastModified),
    metadata: structuredClone(photo.metadata),
    rating: photo.rating,
    flag: photo.flag,
    colorLabel: photo.colorLabel,
    keywords: [...photo.keywords],
    collectionIds: [...photo.collectionIds],
    edits: structuredClone(photo.edits),
    snapshots: structuredClone(photo.snapshots),
  };
}

async function writePhotosNow(photos: readonly PhotoRecord[]): Promise<void> {
  if (photos.length === 0) return;
  const latestById = new Map(photos.map((photo) => [photo.id, photo]));

  await enqueueCatalogWrite(async () => {
    // A normal edit now reads only the record being changed. The previous
    // implementation loaded every full-resolution Blob on every slider commit.
    const existing = await getStoredPhotosByIds([...latestById.keys()]);
    const records: StoredPhoto[] = [];
    for (const photo of latestById.values()) {
      records.push(await storedPhotoFromPublic(photo, existing.get(photo.id)));
    }
    await putStoredPhotos(records);
  });
}

function takePendingPhotoSaves(): Array<{
  photo: PhotoRecord;
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
}> {
  if (pendingSaveTimer !== undefined) {
    clearTimeout(pendingSaveTimer);
    pendingSaveTimer = undefined;
  }
  const pending = [...pendingPhotoSaves.values()];
  pendingPhotoSaves.clear();
  return pending;
}

async function drainPendingPhotoSaves(
  additionalPhotos: readonly PhotoRecord[] = [],
): Promise<void> {
  const pending = takePendingPhotoSaves();
  const latestById = new Map(
    pending.map(({ photo }) => [photo.id, photo] as const),
  );
  // Explicit multi-photo saves are newer than any coalesced single-photo save.
  for (const photo of additionalPhotos) latestById.set(photo.id, photo);

  try {
    await writePhotosNow([...latestById.values()]);
    pending.forEach(({ waiters }) =>
      waiters.forEach(({ resolve }) => resolve()),
    );
  } catch (error) {
    pending.forEach(({ waiters }) =>
      waiters.forEach(({ reject }) => reject(error)),
    );
    throw error;
  }
}

/**
 * Coalesces bursts of commits for the same photo into one IndexedDB
 * transaction. The returned promise still resolves only after the newest
 * recipe in that burst has been durably written.
 */
export function savePhoto(photo: PhotoRecord): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const pending = pendingPhotoSaves.get(photo.id);
    if (pending) {
      pending.photo = photo;
      pending.waiters.push({ resolve, reject });
    } else {
      pendingPhotoSaves.set(photo.id, {
        photo,
        waiters: [{ resolve, reject }],
      });
    }

    if (pendingSaveTimer === undefined) {
      pendingSaveTimer = setTimeout(() => {
        pendingSaveTimer = undefined;
        void drainPendingPhotoSaves().catch(() => {
          // Each caller receives the rejection through its own waiter.
        });
      }, 24);
    }
  });
}

export async function savePhotos(photos: PhotoRecord[]): Promise<void> {
  if (photos.length === 0 && pendingPhotoSaves.size === 0) return;
  await drainPendingPhotoSaves(photos);
}

/** Waits for coalesced saves and all already-enqueued catalog writes. */
export async function flushCatalogWrites(): Promise<void> {
  await drainPendingPhotoSaves();
  await catalogWriteQueue;
}

/**
 * Deletes only Darkroom's IndexedDB copy. The source file selected during import
 * is never moved, renamed, overwritten, or deleted.
 */
export async function deletePhoto(id: string): Promise<void> {
  if (!id.trim()) throw new Error("A photo id is required.");

  try {
    await flushCatalogWrites();
    const database = await openCatalog();
    const transaction = database.transaction(PHOTO_STORE, "readwrite");
    const completed = transactionComplete(transaction);
    transaction.objectStore(PHOTO_STORE).delete(id);
    await completed;
    revokePhotoUrls(id);
  } catch (error) {
    throw catalogError("Could not remove the photo from the local catalog", error);
  }
}

/**
 * Explicitly clears Darkroom-owned IndexedDB records. It never touches source
 * files. Nothing calls this automatically.
 */
export async function clearCatalog(): Promise<void> {
  try {
    await flushCatalogWrites();
    await withCatalogWriteLock(async () => {
      const database = await openCatalog();
      const transaction = database.transaction(
        [PHOTO_STORE, COLLECTION_STORE],
        "readwrite",
      );
      const completed = transactionComplete(transaction);
      transaction.objectStore(PHOTO_STORE).clear();
      transaction.objectStore(COLLECTION_STORE).clear();
      await completed;
      await clearPreviousCatalogRecords();
    });

    for (const id of [...activeObjectUrls.keys()]) revokePhotoUrls(id);
  } catch (error) {
    throw catalogError("Could not clear the local catalog", error);
  }
}

function validCollection(collection: Collection): Collection {
  const name = collection.name?.trim();
  if (!collection.id?.trim()) throw new Error("A collection must have an id.");
  if (!name) throw new Error("A collection name cannot be empty.");

  return {
    id: collection.id,
    name,
    createdAt: collection.createdAt || new Date().toISOString(),
    smartRule: collection.smartRule
      ? structuredClone(collection.smartRule)
      : undefined,
  };
}

export async function loadCollections(): Promise<Collection[]> {
  try {
    const database = await openCatalog();
    const transaction = database.transaction(COLLECTION_STORE, "readonly");
    const completed = transactionComplete(transaction);
    const collections = await requestResult(
      transaction
        .objectStore(COLLECTION_STORE)
        .getAll() as IDBRequest<Collection[]>,
    );
    await completed;
    return collections.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch (error) {
    throw catalogError("Could not load collections", error);
  }
}

export const getCollections = loadCollections;

export async function getCollection(id: string): Promise<Collection | undefined> {
  if (!id.trim()) return undefined;

  try {
    const database = await openCatalog();
    const transaction = database.transaction(COLLECTION_STORE, "readonly");
    const completed = transactionComplete(transaction);
    const collection = await requestResult(
      transaction
        .objectStore(COLLECTION_STORE)
        .get(id) as IDBRequest<Collection | undefined>,
    );
    await completed;
    return collection;
  } catch (error) {
    throw catalogError("Could not load the collection", error);
  }
}

export async function saveCollection(
  collection: Collection,
): Promise<Collection> {
  const normalized = validCollection(collection);

  try {
    const database = await openCatalog();
    const transaction = database.transaction(COLLECTION_STORE, "readwrite");
    const completed = transactionComplete(transaction);
    transaction.objectStore(COLLECTION_STORE).put(normalized);
    await completed;
    return normalized;
  } catch (error) {
    throw catalogError("Could not save the collection", error);
  }
}

export async function createCollection(
  name: string,
  smartRule?: Collection["smartRule"],
): Promise<Collection> {
  return saveCollection({
    id: makeId("collection"),
    name,
    createdAt: new Date().toISOString(),
    smartRule,
  });
}

export async function updateCollection(
  collection: Collection,
): Promise<Collection> {
  return saveCollection(collection);
}

export async function deleteCollection(id: string): Promise<void> {
  if (!id.trim()) throw new Error("A collection id is required.");

  try {
    const photos = await getStoredPhotos();
    const changed = photos
      .filter((photo) => photo.collectionIds.includes(id))
      .map((photo) => ({
        ...photo,
        collectionIds: photo.collectionIds.filter(
          (collectionId) => collectionId !== id,
        ),
      }));

    const database = await openCatalog();
    const stores =
      changed.length > 0
        ? [COLLECTION_STORE, PHOTO_STORE]
        : [COLLECTION_STORE];
    const transaction = database.transaction(stores, "readwrite");
    const completed = transactionComplete(transaction);
    transaction.objectStore(COLLECTION_STORE).delete(id);

    if (changed.length > 0) {
      const photoStore = transaction.objectStore(PHOTO_STORE);
      for (const photo of changed) photoStore.put(photo);
    }

    await completed;
  } catch (error) {
    throw catalogError("Could not delete the collection", error);
  }
}

function exportedPhoto(photo: StoredPhoto): ExportedPhoto {
  const metadataWithoutLocation = structuredClone(photo.metadata);
  delete metadataWithoutLocation.latitude;
  delete metadataWithoutLocation.longitude;
  return {
    id: photo.id,
    name: photo.name,
    type: photo.type,
    size: photo.size,
    width: photo.width,
    height: photo.height,
    importedAt: photo.importedAt,
    lastEditedAt: photo.lastEditedAt,
    lastModified: photo.lastModified,
    fingerprint: photo.fingerprint,
    metadata: {
      ...metadataWithoutLocation,
      latitude: null,
      longitude: null,
    },
    rating: photo.rating,
    flag: photo.flag,
    colorLabel: photo.colorLabel,
    keywords: [...photo.keywords],
    collectionIds: [...photo.collectionIds],
    edits: structuredClone(photo.edits),
    snapshots: structuredClone(photo.snapshots),
  };
}

/**
 * Exports portable catalog metadata and non-destructive edits as JSON. Image
 * blobs are deliberately omitted so normal-sized catalogs remain practical.
 */
export async function exportCatalog(): Promise<string> {
  await flushCatalogWrites();
  return withCatalogWriteLock(async () => {
    const [photos, collections] = await Promise.all([
      getStoredPhotos(),
      loadCollections(),
    ]);
    const payload: CatalogExport = {
      format: CATALOG_FORMAT,
      version: CATALOG_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      collections,
      photos: photos.map(exportedPhoto),
    };
    const serialized = JSON.stringify(payload, null, 2);
    if (new Blob([serialized]).size > MAX_CATALOG_BACKUP_BYTES) {
      throw new Error(
        "This catalog is too large for the 32 MB browser backup format.",
      );
    }
    return serialized;
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, 200))
        .filter(Boolean),
    ),
  ].slice(0, 500);
}

function importedMetadata(
  value: unknown,
  fallback: PhotoMetadata,
): PhotoMetadata {
  if (!isObject(value)) return fallback;

  const metadata: PhotoMetadata = { ...fallback };
  const textKeys = [
    "camera",
    "lens",
    "shutter",
    "capturedAt",
    "copyright",
    "caption",
  ] as const;
  const numberKeys = [
    "iso",
    "aperture",
    "focalLength",
    "latitude",
    "longitude",
  ] as const;

  for (const key of textKeys) {
    if (value[key] === null) delete metadata[key];
    else {
      const next = stringValue(value[key]);
      if (next !== undefined) {
        metadata[key] = next.slice(0, key === "caption" ? 10_000 : 1_000);
      }
    }
  }
  for (const key of numberKeys) {
    if (value[key] === null) delete metadata[key];
    else {
      const next = numberValue(value[key]);
      if (next !== undefined) {
        if (key === "latitude") {
          metadata[key] = Math.max(-90, Math.min(90, next));
        } else if (key === "longitude") {
          metadata[key] = Math.max(-180, Math.min(180, next));
        } else {
          metadata[key] = next;
        }
      }
    }
  }

  return metadata;
}

function importedEditState(value: unknown, fallback: EditState): EditState {
  if (!isObject(value)) return fallback;
  if (
    typeof value.profile !== "string" ||
    !isObject(value.global) ||
    !Array.isArray(value.curve) ||
    !isObject(value.hsl) ||
    !isObject(value.colorGrading) ||
    !isObject(value.geometry) ||
    !isObject(value.crop) ||
    !Array.isArray(value.masks) ||
    !Array.isArray(value.healSpots)
  ) {
    return fallback;
  }
  if (
    value.curve.length > 64 ||
    value.masks.length > 8 ||
    value.healSpots.length > 16
  ) {
    return fallback;
  }

  let brushPointCount = 0;
  for (const candidate of value.masks) {
    if (!isObject(candidate)) return fallback;
    if (
      typeof candidate.name === "string" &&
      candidate.name.length > 200
    ) {
      return fallback;
    }
    const componentCandidates =
      candidate.components === undefined
        ? [candidate]
        : Array.isArray(candidate.components) && candidate.components.length <= 32
          ? candidate.components
          : null;
    if (!componentCandidates) return fallback;
    for (const component of componentCandidates) {
      if (!isObject(component)) return fallback;
      if (component.strokes !== undefined) {
        if (!Array.isArray(component.strokes) || component.strokes.length > 2_000) {
          return fallback;
        }
        for (const stroke of component.strokes) {
          if (!isObject(stroke) || !Array.isArray(stroke.points)) return fallback;
          brushPointCount += stroke.points.length;
          if (stroke.points.length > 50_000 || brushPointCount > 250_000) {
            return fallback;
          }
        }
      }
    }
  }

  const mergeKnownShape = (base: unknown, candidate: unknown): unknown => {
    if (typeof base === "number") {
      return typeof candidate === "number" && Number.isFinite(candidate)
        ? Math.max(-10_000, Math.min(10_000, candidate))
        : base;
    }
    if (typeof base === "boolean") {
      return typeof candidate === "boolean" ? candidate : base;
    }
    if (typeof base === "string") {
      return typeof candidate === "string" ? candidate.slice(0, 200) : base;
    }
    if (Array.isArray(base)) return structuredClone(base);
    if (!isObject(base)) return structuredClone(base);
    const source = isObject(candidate) ? candidate : {};
    return Object.fromEntries(
      Object.entries(base).map(([key, baseValue]) => [
        key,
        mergeKnownShape(baseValue, source[key]),
      ]),
    );
  };

  const next = mergeKnownShape(fallback, value) as EditState;
  next.profile = canonicalProfileName(value.profile).slice(0, 200);
  const restoreCurve = (candidate: unknown, fallbackCurve: EditState["curve"]) => {
    if (!Array.isArray(candidate)) return structuredClone(fallbackCurve);
    const restored = candidate
      .filter(isObject)
      .map((point) => ({
        x: Math.max(0, Math.min(1, numberValue(point.x) ?? 0)),
        y: Math.max(0, Math.min(1, numberValue(point.y) ?? 0)),
      }))
      .sort((a, b) => a.x - b.x)
      .slice(0, 16);
    return restored.length >= 2 ? restored : structuredClone(fallbackCurve);
  };
  next.curve = restoreCurve(value.curve, fallback.curve);
  next.redCurve = restoreCurve(value.redCurve, fallback.redCurve);
  next.greenCurve = restoreCurve(value.greenCurve, fallback.greenCurve);
  next.blueCurve = restoreCurve(value.blueCurve, fallback.blueCurve);
  const restoredGuides = Array.isArray(value.geometry.guides)
    ? value.geometry.guides
        .filter(isObject)
        .flatMap((guide) => {
          if (
            (guide.orientation !== "horizontal" &&
              guide.orientation !== "vertical") ||
            !isObject(guide.start) ||
            !isObject(guide.end)
          ) {
            return [];
          }
          const startX = numberValue(guide.start.x);
          const startY = numberValue(guide.start.y);
          const endX = numberValue(guide.end.x);
          const endY = numberValue(guide.end.y);
          if (
            startX === undefined ||
            startY === undefined ||
            endX === undefined ||
            endY === undefined
          ) {
            return [];
          }
          const unit = (coordinate: number) =>
            Math.max(0, Math.min(1, coordinate));
          return [{
            orientation: guide.orientation as "horizontal" | "vertical",
            start: { x: unit(startX), y: unit(startY) },
            end: { x: unit(endX), y: unit(endY) },
          }];
        })
        .slice(0, 4)
    : structuredClone(fallback.geometry.guides);
  next.geometry.guides = restoredGuides;
  next.masks = normalizeMasks(value.masks).slice(0, 8);
  next.healSpots = value.healSpots
    .filter(isObject)
    .map((spot, index) => {
      const destination = isObject(spot.destination) ? spot.destination : {};
      const source = isObject(spot.source) ? spot.source : {};
      const unit = (candidate: unknown, defaultValue: number) =>
        Math.max(0, Math.min(1, numberValue(candidate) ?? defaultValue));
      const path = Array.isArray(spot.path)
        ? spot.path
            .filter(isObject)
            .map((point) => ({
              x: unit(point.x, 0.5),
              y: unit(point.y, 0.5),
              pressure: Math.max(
                0.05,
                Math.min(1, numberValue(point.pressure) ?? 1),
              ),
            }))
            .slice(0, 256)
        : undefined;
      return {
        id: stringValue(spot.id)?.slice(0, 200) ?? `restored-heal-${index + 1}`,
        mode:
          spot.mode === "clone"
            ? "clone" as const
            : spot.mode === "remove"
              ? "remove" as const
              : "heal" as const,
        destination: {
          x: unit(destination.x, 0.5),
          y: unit(destination.y, 0.5),
        },
        source: {
          x: unit(source.x, 0.4),
          y: unit(source.y, 0.4),
        },
        size: Math.max(0.1, Math.min(500, numberValue(spot.size) ?? 10)),
        feather: Math.max(0, Math.min(100, numberValue(spot.feather) ?? 50)),
        opacity: Math.max(0, Math.min(100, numberValue(spot.opacity) ?? 100)),
        ...(path?.length ? { path } : {}),
      };
    })
    .slice(0, 16);
  return next;
}

/** Normalizes saved recipes from earlier catalog versions into the current schema. */
export function normalizeCatalogEditState(
  value: unknown,
  fallback: EditState = createDefaultEditState(),
): EditState {
  return importedEditState(value, fallback);
}

function importedSnapshots(
  value: unknown,
  fallback: PhotoRecord["snapshots"],
  fallbackState: EditState,
): PhotoRecord["snapshots"] {
  if (!Array.isArray(value) || value.length > 100) return fallback;
  const snapshots: PhotoRecord["snapshots"] = [];
  for (const candidate of value) {
    if (!isObject(candidate)) continue;
    const id = stringValue(candidate.id);
    const label = stringValue(candidate.label);
    const createdAt = stringValue(candidate.createdAt);
    if (!id || !label || !createdAt) continue;
    snapshots.push({
      id: id.slice(0, 200),
      label: label.slice(0, 200),
      createdAt: createdAt.slice(0, 100),
      state: importedEditState(candidate.state, fallbackState),
    });
  }
  return snapshots;
}

function normalizeImportedCollection(
  value: unknown,
): Collection | undefined {
  if (!isObject(value)) return undefined;
  const id = stringValue(value.id);
  const name = stringValue(value.name);
  if (!id || !name) return undefined;

  return {
    id: id.slice(0, 200),
    name: name.slice(0, 200),
    createdAt:
      stringValue(value.createdAt)?.slice(0, 100) ??
      new Date().toISOString(),
    smartRule: isObject(value.smartRule)
      ? (structuredClone(value.smartRule) as Collection["smartRule"])
      : undefined,
  };
}

async function catalogInputText(
  input: string | Blob | Record<string, unknown>,
): Promise<unknown> {
  if (typeof input === "string") {
    if (new Blob([input]).size > MAX_CATALOG_BACKUP_BYTES) {
      throw new Error("Catalog backups are limited to 32 MB.");
    }
    try {
      return JSON.parse(input) as unknown;
    } catch (error) {
      throw catalogError("The catalog JSON is invalid", error);
    }
  }
  if (input instanceof Blob) {
    if (input.size > MAX_CATALOG_BACKUP_BYTES) {
      throw new Error("Catalog backups are limited to 32 MB.");
    }
    try {
      return JSON.parse(await input.text()) as unknown;
    } catch (error) {
      throw catalogError("The catalog file is not valid JSON", error);
    }
  }
  return input;
}

function isCompatibleCatalogFormat(format: unknown): format is string {
  return format === CATALOG_FORMAT || format === RETIRED_CATALOG_NAME;
}

/**
 * Restores ratings, labels, metadata, snapshots, and non-destructive edits onto
 * image blobs already present in this browser catalog. Missing source images are
 * reported and skipped rather than fabricated from metadata.
 */
export async function importCatalog(
  input: string | Blob | Record<string, unknown>,
): Promise<CatalogImportResult> {
  await flushCatalogWrites();
  const parsed = await catalogInputText(input);
  if (!isObject(parsed)) throw new Error("The catalog must contain a JSON object.");
  if (!isCompatibleCatalogFormat(parsed.format)) {
    throw new Error("This file is not a compatible Lightroom local catalog export.");
  }
  if (parsed.version !== CATALOG_EXPORT_VERSION) {
    throw new Error(
      `Catalog version ${String(parsed.version)} is not supported by this Lightroom local workflow.`,
    );
  }
  if (!Array.isArray(parsed.photos) || !Array.isArray(parsed.collections)) {
    throw new Error("The catalog export is missing its photos or collections list.");
  }
  if (parsed.photos.length > 20_000 || parsed.collections.length > 2_000) {
    throw new Error(
      "The catalog backup exceeds the supported photo or collection count.",
    );
  }
  const parsedPhotos: unknown[] = parsed.photos;
  const parsedCollections: unknown[] = parsed.collections;

  return enqueueCatalogWrite(async () => {
    const existingPhotos = await getStoredPhotos();
    const byId = new Map(existingPhotos.map((photo) => [photo.id, photo]));
    const byFingerprint = new Map(
      existingPhotos.map((photo) => [photo.fingerprint, photo]),
    );
    const updated = new Map<string, StoredPhoto>();
    const warnings: string[] = [];
    let skippedPhotos = 0;

    for (const candidate of parsedPhotos) {
      if (!isObject(candidate)) {
        skippedPhotos += 1;
        warnings.push("Skipped an invalid photo entry.");
        continue;
      }

      const id = stringValue(candidate.id);
      const fingerprint = stringValue(candidate.fingerprint);
      const name = stringValue(candidate.name) ?? "Unnamed photo";
      const target =
        (id ? byId.get(id) : undefined) ??
        (fingerprint ? byFingerprint.get(fingerprint) : undefined);

      if (!target) {
        skippedPhotos += 1;
        warnings.push(
          `Skipped “${name}” because its image file is not in this browser catalog.`,
        );
        continue;
      }

      const ratingValue = numberValue(candidate.rating);
      const flag = FLAG_STATES.has(candidate.flag as FlagState)
        ? (candidate.flag as FlagState)
        : target.flag;
      const colorLabel = COLOR_LABELS.has(candidate.colorLabel as ColorLabel)
        ? (candidate.colorLabel as ColorLabel)
        : target.colorLabel;

      updated.set(target.id, {
        ...target,
        lastEditedAt:
          stringValue(candidate.lastEditedAt) ?? target.lastEditedAt,
        metadata: importedMetadata(candidate.metadata, target.metadata),
        rating:
          ratingValue === undefined
            ? target.rating
            : Math.max(0, Math.min(5, Math.round(ratingValue))),
        flag,
        colorLabel,
        keywords: stringArray(candidate.keywords, target.keywords),
        collectionIds: stringArray(
          candidate.collectionIds,
          target.collectionIds,
        ),
        edits: importedEditState(candidate.edits, target.edits),
        snapshots: importedSnapshots(
          candidate.snapshots,
          target.snapshots,
          target.edits,
        ),
      });
    }

    const collections = parsedCollections
      .map(normalizeImportedCollection)
      .filter((collection): collection is Collection => Boolean(collection));

    try {
      const database = await openCatalog();
      const transaction = database.transaction(
        [PHOTO_STORE, COLLECTION_STORE],
        "readwrite",
      );
      const completed = transactionComplete(transaction);
      const photoStore = transaction.objectStore(PHOTO_STORE);
      const collectionStore = transaction.objectStore(COLLECTION_STORE);

      for (const photo of updated.values()) photoStore.put(photo);
      for (const collection of collections) collectionStore.put(collection);
      await completed;
    } catch (error) {
      throw catalogError("Could not restore the catalog metadata", error);
    }

    return {
      updatedPhotos: updated.size,
      importedCollections: collections.length,
      skippedPhotos,
      warnings,
    };
  });
}
