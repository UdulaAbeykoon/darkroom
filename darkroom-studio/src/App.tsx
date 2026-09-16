import {
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  DatabaseBackup,
  Download,
  Flag,
  FolderOpen,
  Grid3X3,
  Import,
  LayoutGrid,
  Maximize2,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  SlidersHorizontal,
  Star,
  Undo2,
  Redo2,
  X,
} from "lucide-react";
import DevelopWorkspace from "./components/DevelopWorkspace";
import Filmstrip from "./components/Filmstrip";
import LeftSidebar from "./components/LeftSidebar";
import LibraryInspector from "./components/LibraryInspector";
import LibraryWorkspace from "./components/LibraryWorkspace";
import RightInspector, {
  type EditorTool,
  type HealOverlayMode,
  type HealToolSettings,
  type MaskBrushSettings,
} from "./components/RightInspector";
import SyncSettingsDialog, {
  createSyncSettingsSelection,
  type SyncSettingsSelection,
} from "./components/SyncSettingsDialog";
import { IconButton, Modal } from "./components/ui";
import {
  BUILT_IN_PRESETS,
  DEFAULT_GLOBAL_ADJUSTMENTS,
  DEFAULT_LOCAL_ADJUSTMENTS,
  cloneEditState,
  createDefaultEditState,
} from "./defaults";
import {
  createCollection,
  importFiles,
  initializeCatalog,
  exportCatalog,
  flushCatalogWrites,
  importCatalog,
  loadCollections,
  loadPhotos,
  normalizeImportOptions,
  requestPersistentStorage,
  saveCollection,
  savePhoto,
  savePhotos,
} from "./lib/catalog";
import type { ImportProgress } from "./lib/catalog";
import { ImageEngine } from "./lib/imageEngine";
import { solveGuidedUpright } from "./lib/guidedUpright";
import { applyPresetAtAmount } from "./lib/presetMath";
import { CAMERA_RAW_ACCEPT, renderBlobForPhoto } from "./lib/rawImage";
import { mergeSynchronizedSettings } from "./lib/syncSettings";
import { CROP_OVERLAY_SEQUENCE } from "./types";
import {
  getMaskComponents,
  makeMaskComponent,
  normalizeMasks,
  updateMaskComponent as updateMaskComponentInGroup,
} from "./lib/maskMath";
import { createSampleFile } from "./lib/sample";
import type {
  BrushStroke,
  Collection,
  CropOverlay,
  DevelopPreset,
  EditSnapshot,
  EditState,
  ExportSettings,
  FlagState,
  GeometryAdjustments,
  GlobalAdjustments,
  HealSpot,
  HistogramData,
  HslChannel,
  HueChannel,
  ImportOptions,
  LibraryView,
  LocalAdjustments,
  Mask,
  MaskComponent,
  MaskKind,
  MaskOperation,
  PhotoRecord,
  UprightGuide,
  WorkspaceMode,
} from "./types";

const ExportDialog = lazy(() => import("./components/ExportDialog"));
const ImportDialog = lazy(() => import("./components/ImportDialog"));
const ShortcutsDialog = lazy(() => import("./components/ShortcutsDialog"));

type SortMode = "imported-desc" | "captured-desc" | "name-asc" | "rating-desc";
type HistoryRecord = { past: EditState[]; future: EditState[] };
type Toast = { id: string; tone: "success" | "error" | "info"; message: string };
type CopiedDevelopSettings = {
  state: EditState;
  selection: SyncSettingsSelection;
};

const DEFAULT_EXPORT: ExportSettings = {
  format: "image/jpeg",
  quality: 0.9,
  resizeMode: "original",
  longEdge: 2400,
  width: 2400,
  height: 1600,
  fileName: "Darkroom_export",
  includeMetadata: false,
  watermarkEnabled: false,
  watermarkText: "© Your name",
  watermarkOpacity: 0.7,
  watermarkPosition: "bottom-right",
};

const GITHUB_REPO_URL = "https://github.com/UdulaAbeykoon/darkroom";
const GITHUB_STAR_REMINDER_KEY = "darkroom:github-star-reminder-dismissed";

function hasDismissedGitHubStarReminder() {
  try {
    return window.localStorage.getItem(GITHUB_STAR_REMINDER_KEY) === "true";
  } catch {
    return false;
  }
}

function rememberGitHubStarReminderDismissal() {
  try {
    window.localStorage.setItem(GITHUB_STAR_REMINDER_KEY, "true");
  } catch {
    // The reminder can still disappear for this session if storage is blocked.
  }
}

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

function withoutExtension(fileName: string) {
  return fileName.replace(/\.[^/.]+$/, "");
}

async function collectDirectoryFiles(handle: unknown): Promise<File[]> {
  const files: File[] = [];
  const visit = async (directory: {
    values: () => AsyncIterable<{
      kind: "file" | "directory";
      getFile?: () => Promise<File>;
      values?: () => AsyncIterable<unknown>;
    }>;
  }) => {
    for await (const entry of directory.values()) {
      if (entry.kind === "file" && entry.getFile) files.push(await entry.getFile());
      if (entry.kind === "directory" && entry.values) {
        await visit(entry as Parameters<typeof visit>[0]);
      }
    }
  };
  await visit(handle as Parameters<typeof visit>[0]);
  return files;
}

function maskDefaults(kind: MaskKind, index: number): Mask {
  const palette = ["#e95f66", "#43b9c7", "#f0b95b", "#9d82e8", "#4e9fce"];
  const component = makeMaskComponent(kind);
  const base: Mask = {
    id: makeId("mask"),
    name: `${component.name} ${index + 1}`,
    kind,
    enabled: true,
    inverted: false,
    opacity: 1,
    overlayColor: palette[index % palette.length],
    adjustments: { ...DEFAULT_LOCAL_ADJUSTMENTS },
    components: [component],
  };

  // Keep a representative legacy payload so older backups and integrations
  // still understand the first component of a composable group.
  if (component.strokes) base.strokes = component.strokes;
  if (component.linear) base.linear = component.linear;
  if (component.radial) base.radial = component.radial;
  if (component.luminance) base.luminance = component.luminance;
  if (component.color) base.color = component.color;
  if (component.object) base.object = component.object;
  if (component.people) base.people = component.people;
  if (component.landscape) base.landscape = component.landscape;
  if (component.depth) base.depth = component.depth;
  return base;
}

export function resolveMaskSelection(
  masks: readonly Mask[],
  activeMaskId: string | null,
  activeMaskComponentId: string | null,
): { maskId: string | null; componentId: string | null } {
  const activeMask = masks.find((mask) => mask.id === activeMaskId);
  const selectedMask = activeMask ?? masks[masks.length - 1] ?? null;
  if (!selectedMask) return { maskId: null, componentId: null };

  const components = getMaskComponents(selectedMask);
  const activeComponent =
    selectedMask.id === activeMaskId
      ? components.find(
          (component) => component.id === activeMaskComponentId,
        )
      : null;

  return {
    maskId: selectedMask.id,
    componentId: activeComponent?.id ?? components[0]?.id ?? null,
  };
}

export default function App() {
  const [photos, setPhotos] = useState<PhotoRecord[]>([]);
  const photosRef = useRef<PhotoRecord[]>([]);
  const photoIndexRef = useRef(new Map<string, number>());
  const photoByIdRef = useRef(new Map<string, PhotoRecord>());
  const pendingPhotoFrameRef = useRef<number | null>(null);
  const pendingFramePhotosRef = useRef<PhotoRecord[] | null>(null);
  const [libraryDataVersion, setLibraryDataVersion] = useState(0);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [mode, setMode] = useState<WorkspaceMode>("library");
  const [libraryView, setLibraryView] = useState<LibraryView>("photo-grid");
  const [source, setSource] = useState("all");
  const [sortMode, setSortMode] = useState<SortMode>("imported-desc");
  const [minimumRating, setMinimumRating] = useState(0);
  const [search, setSearch] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [tool, setTool] = useState<EditorTool>("edit");
  const [cropOverlay, setCropOverlay] = useState<CropOverlay>("thirds");
  const [healSettings, setHealSettings] = useState<HealToolSettings>({
    size: 34,
    feather: 72,
    opacity: 100,
    mode: "heal",
  });
  const [activeHealSpotId, setActiveHealSpotId] = useState<string | null>(null);
  const [healOverlayMode, setHealOverlayMode] = useState<HealOverlayMode>("always");
  const [visualizeSpots, setVisualizeSpots] = useState(false);
  const [visualizeSpotsThreshold, setVisualizeSpotsThreshold] = useState(50);
  const healSourceCycleRef = useRef(new Map<string, number>());
  const [maskBrushSettings, setMaskBrushSettings] = useState<MaskBrushSettings>({
    size: 34,
    feather: 65,
    flow: 100,
    density: 100,
    autoMask: false,
    erase: false,
  });
  const [activeMaskId, setActiveMaskId] = useState<string | null>(null);
  const [activeMaskComponentId, setActiveMaskComponentId] = useState<
    string | null
  >(null);
  const [histogram, setHistogram] = useState<HistogramData | null>(null);
  const pendingHistogramRef = useRef<HistogramData | null>(null);
  const histogramTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [showMaskOverlay, setShowMaskOverlay] = useState(true);
  const [maskOverlayMode, setMaskOverlayMode] = useState<
    "color" | "color-on-black" | "color-on-white" | "white-on-black" | "black-on-white"
  >("color");
  const [maskOverlayOpacity, setMaskOverlayOpacity] = useState(0.5);
  const [showClipping, setShowClipping] = useState(false);
  const [panelsVisible, setPanelsVisible] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [pendingImportFiles, setPendingImportFiles] = useState<File[]>([]);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [importFailures, setImportFailures] = useState<
    { name: string; reason: string }[]
  >([]);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [singleKeyShortcuts, setSingleKeyShortcuts] = useState(true);
  const [showCatalogBackup, setShowCatalogBackup] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{
    current: number;
    total: number;
    name: string;
  } | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [persistentStorage, setPersistentStorage] = useState<boolean | null>(
    null,
  );
  const [exportSettings, setExportSettings] =
    useState<ExportSettings>(DEFAULT_EXPORT);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [showGitHubStarReminder, setShowGitHubStarReminder] = useState(
    () => !hasDismissedGitHubStarReminder(),
  );
  const [historyVersion, setHistoryVersion] = useState(0);
  const [copiedEditState, setCopiedEditState] = useState<CopiedDevelopSettings | null>(null);
  const [showCopySettings, setShowCopySettings] = useState(false);
  const [showSyncSettings, setShowSyncSettings] = useState(false);
  const [syncSettingsSelection, setSyncSettingsSelection] =
    useState<SyncSettingsSelection>(() => createSyncSettingsSelection(true));
  const fileInputRef = useRef<HTMLInputElement>(null);
  const catalogInputRef = useRef<HTMLInputElement>(null);
  const historiesRef = useRef(new Map<string, HistoryRecord>());
  const transactionRef = useRef<string | null>(null);
  const lastSelectedRef = useRef<string | null>(null);
  const engineRef = useRef<ImageEngine | null>(null);
  const exportCanceledRef = useRef(false);
  const presetBaseRef = useRef<{
    photoId: string;
    presetId: string;
    state: EditState;
  } | null>(null);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [presetAmount, setPresetAmount] = useState(100);
  const [previewPreset, setPreviewPreset] = useState<DevelopPreset | null>(null);

  const rebuildPhotoLookup = useCallback((next: PhotoRecord[]) => {
    photoIndexRef.current = new Map(
      next.map((photo, index) => [photo.id, index]),
    );
    photoByIdRef.current = new Map(next.map((photo) => [photo.id, photo]));
  }, []);

  const cancelPendingPhotoFrame = useCallback(() => {
    if (pendingPhotoFrameRef.current !== null) {
      cancelAnimationFrame(pendingPhotoFrameRef.current);
      pendingPhotoFrameRef.current = null;
    }
  }, []);

  const flushPendingPhotoRender = useCallback(() => {
    const pending = pendingFramePhotosRef.current;
    if (!pending) return;
    cancelPendingPhotoFrame();
    pendingFramePhotosRef.current = null;
    setPhotos(pending);
  }, [cancelPendingPhotoFrame]);

  const schedulePhotoRender = useCallback(() => {
    if (pendingPhotoFrameRef.current !== null) return;
    pendingPhotoFrameRef.current = requestAnimationFrame(() => {
      pendingPhotoFrameRef.current = null;
      const pending = pendingFramePhotosRef.current;
      pendingFramePhotosRef.current = null;
      if (pending) setPhotos(pending);
    });
  }, []);

  const setPhotosSafe = useCallback(
    (updater: PhotoRecord[] | ((current: PhotoRecord[]) => PhotoRecord[])) => {
      const next =
        typeof updater === "function"
          ? (updater as (current: PhotoRecord[]) => PhotoRecord[])(
              photosRef.current,
            )
          : updater;
      cancelPendingPhotoFrame();
      pendingFramePhotosRef.current = null;
      photosRef.current = next;
      rebuildPhotoLookup(next);
      setPhotos(next);
      setLibraryDataVersion((version) => version + 1);
    },
    [cancelPendingPhotoFrame, rebuildPhotoLookup],
  );

  useEffect(
    () => () => {
      cancelPendingPhotoFrame();
      if (histogramTimerRef.current) clearTimeout(histogramTimerRef.current);
    },
    [cancelPendingPhotoFrame],
  );

  const notify = useCallback((message: string, tone: Toast["tone"] = "info") => {
    const toast = { id: makeId("toast"), tone, message };
    setToasts((current) => [...current, toast]);
    window.setTimeout(
      () => setToasts((current) => current.filter((item) => item.id !== toast.id)),
      4200,
    );
  }, []);
  const notifyError = useCallback(
    (message: string) => notify(message, "error"),
    [notify],
  );

  const dismissGitHubStarReminder = useCallback(() => {
    rememberGitHubStarReminderDismissal();
    setShowGitHubStarReminder(false);
  }, []);

  const cycleCropOverlay = useCallback(() => {
    setCropOverlay((current) => {
      const index = CROP_OVERLAY_SEQUENCE.indexOf(current);
      return CROP_OVERLAY_SEQUENCE[(index + 1) % CROP_OVERLAY_SEQUENCE.length];
    });
  }, []);

  useEffect(() => {
    if (presetBaseRef.current?.photoId === activeId) return;
    presetBaseRef.current = null;
    setActivePresetId(null);
    setPresetAmount(100);
    setPreviewPreset(null);
  }, [activeId]);

  useEffect(() => {
    setActiveHealSpotId(null);
    setVisualizeSpots(false);
    healSourceCycleRef.current.clear();
  }, [activeId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await initializeCatalog();
        const [storedPhotos, storedCollections, isPersistent] = await Promise.all([
          loadPhotos(),
          loadCollections(),
          requestPersistentStorage(),
        ]);
        if (cancelled) return;
        setPersistentStorage(isPersistent);
        const normalizedPhotos = storedPhotos.map((photo) => ({
          ...photo,
          edits: {
            ...photo.edits,
            masks: normalizeMasks(photo.edits.masks),
          },
          snapshots: photo.snapshots.map((snapshot) => ({
            ...snapshot,
            state: {
              ...snapshot.state,
              masks: normalizeMasks(snapshot.state.masks),
            },
          })),
        }));
        setPhotosSafe(normalizedPhotos);
        setCollections(storedCollections);
        if (normalizedPhotos.length) {
          setActiveId(normalizedPhotos[0].id);
          setSelectedIds(new Set([normalizedPhotos[0].id]));
        }
      } catch (error) {
        notify(
          error instanceof Error ? error.message : "Could not open the local catalog.",
          "error",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notify, setPhotosSafe]);

  useEffect(() => {
    const flushWhenBackgrounded = () => {
      if (document.visibilityState !== "hidden") return;
      flushPendingPhotoRender();
      void flushCatalogWrites().catch(() => {
        // Individual save promises already report storage errors in the UI.
      });
    };
    const flushOnPageHide = () => {
      flushPendingPhotoRender();
      void flushCatalogWrites().catch(() => {
        // Browsers may stop asynchronous work after pagehide.
      });
    };
    document.addEventListener("visibilitychange", flushWhenBackgrounded);
    window.addEventListener("pagehide", flushOnPageHide);
    return () => {
      document.removeEventListener("visibilitychange", flushWhenBackgrounded);
      window.removeEventListener("pagehide", flushOnPageHide);
    };
  }, [flushPendingPhotoRender]);

  const activePhoto = activeId
    ? photoByIdRef.current.get(activeId) ?? null
    : null;

  const previewPhoto = useMemo(() => {
    if (!activePhoto || !previewPreset) return activePhoto;
    return {
      ...activePhoto,
      edits: applyPresetAtAmount(activePhoto.edits, previewPreset, 100),
    };
  }, [activePhoto, previewPreset]);

  const exportTargets = useMemo(() => {
    const selected = [...selectedIds].flatMap((id) => {
      const photo = photoByIdRef.current.get(id);
      return photo ? [photo] : [];
    });
    return selected.length ? selected : activePhoto ? [activePhoto] : [];
  }, [activePhoto, photos, selectedIds]);

  useEffect(() => {
    if (!activePhoto) return;
    setExportSettings((settings) => ({
      ...settings,
      fileName: `${withoutExtension(activePhoto.name)}_edit`,
      width: activePhoto.width,
      height: activePhoto.height,
    }));
  }, [activePhoto?.id]);

  const deferredSearch = useDeferredValue(search);
  const filteredPhotoIds = useMemo(() => {
    let result = [...photosRef.current];
    if (source === "recent") {
      result = result.filter(
        (photo) => Date.now() - Date.parse(photo.importedAt) < 86_400_000,
      );
    } else if (source === "picks") {
      result = result.filter((photo) => photo.flag === "pick");
    } else if (source === "five-stars") {
      result = result.filter((photo) => photo.rating === 5);
    } else if (source === "rejected") {
      result = result.filter((photo) => photo.flag === "reject");
    } else if (source.startsWith("collection:")) {
      const collectionId = source.slice("collection:".length);
      result = result.filter((photo) => photo.collectionIds.includes(collectionId));
    }

    if (minimumRating) result = result.filter((photo) => photo.rating >= minimumRating);
    if (deferredSearch.trim()) {
      const needle = deferredSearch.trim().toLowerCase();
      result = result.filter((photo) =>
        [
          photo.name,
          photo.metadata.camera,
          photo.metadata.lens,
          photo.metadata.caption,
          ...photo.keywords,
        ]
          .filter(Boolean)
          .some((value) => value!.toLowerCase().includes(needle)),
      );
    }

    result.sort((a, b) => {
      if (sortMode === "name-asc") return a.name.localeCompare(b.name);
      if (sortMode === "rating-desc") return b.rating - a.rating;
      if (sortMode === "captured-desc") {
        return (
          Date.parse(b.metadata.capturedAt ?? b.importedAt) -
          Date.parse(a.metadata.capturedAt ?? a.importedAt)
        );
      }
      return Date.parse(b.importedAt) - Date.parse(a.importedAt);
    });
    return result.map((photo) => photo.id);
  }, [deferredSearch, libraryDataVersion, minimumRating, sortMode, source]);

  const filteredPhotos = useMemo(
    () =>
      filteredPhotoIds.flatMap((id) => {
        const photo = photoByIdRef.current.get(id);
        return photo ? [photo] : [];
      }),
    [filteredPhotoIds, photos],
  );
  const filteredPhotosRef = useRef<PhotoRecord[]>(filteredPhotos);
  filteredPhotosRef.current = filteredPhotos;

  const updatePhoto = useCallback(
    (
      id: string,
      updater: (photo: PhotoRecord) => PhotoRecord,
      persist = false,
      deferRender = false,
      affectsLibrary = true,
    ) => {
      const index = photoIndexRef.current.get(id);
      const currentPhoto = photoByIdRef.current.get(id);
      if (index === undefined || !currentPhoto) return;
      const updated = updater(currentPhoto);
      if (updated === currentPhoto) return;

      // Reuse the unpublished frame buffer during continuous gestures. This
      // turns hundreds of full-array copies/renders into at most one per frame.
      const canReusePending =
        deferRender && pendingFramePhotosRef.current === photosRef.current;
      const next = canReusePending
        ? photosRef.current
        : photosRef.current.slice();
      next[index] = updated;
      photosRef.current = next;
      photoByIdRef.current.set(id, updated);

      if (deferRender) {
        pendingFramePhotosRef.current = next;
        schedulePhotoRender();
      } else {
        cancelPendingPhotoFrame();
        pendingFramePhotosRef.current = null;
        setPhotos(next);
      }
      if (affectsLibrary) {
        setLibraryDataVersion((version) => version + 1);
      }
      if (persist) {
        void savePhoto(updated).catch((error) =>
          notify(error instanceof Error ? error.message : "Could not save the change.", "error"),
        );
      }
    },
    [cancelPendingPhotoFrame, notify, schedulePhotoRender],
  );

  const updatePhotos = useCallback(
    (
      ids: Iterable<string>,
      updater: (photo: PhotoRecord) => PhotoRecord,
      persist = false,
      affectsLibrary = true,
    ) => {
      const next = photosRef.current.slice();
      const updated: PhotoRecord[] = [];
      for (const id of ids) {
        const index = photoIndexRef.current.get(id);
        const currentPhoto = photoByIdRef.current.get(id);
        if (index === undefined || !currentPhoto) continue;
        const changed = updater(currentPhoto);
        if (changed === currentPhoto) continue;
        next[index] = changed;
        photoByIdRef.current.set(id, changed);
        updated.push(changed);
      }
      if (!updated.length) return;
      cancelPendingPhotoFrame();
      pendingFramePhotosRef.current = null;
      photosRef.current = next;
      setPhotos(next);
      if (affectsLibrary) {
        setLibraryDataVersion((version) => version + 1);
      }
      if (persist) {
        void savePhotos(updated).catch((error) =>
          notify(
            error instanceof Error ? error.message : "Could not save the changes.",
            "error",
          ),
        );
      }
    },
    [cancelPendingPhotoFrame, notify],
  );

  const beginEdit = useCallback(() => {
    if (!activeId || transactionRef.current === activeId) return;
    const photo = photoByIdRef.current.get(activeId);
    if (!photo) return;
    const history = historiesRef.current.get(activeId) ?? { past: [], future: [] };
    // Edit states are replaced immutably, so retaining the old reference is a
    // lossless undo snapshot and avoids cloning large brush masks per gesture.
    history.past.push(photo.edits);
    if (history.past.length > 100) history.past.shift();
    history.future = [];
    historiesRef.current.set(activeId, history);
    transactionRef.current = activeId;
    setHistoryVersion((version) => version + 1);
  }, [activeId]);

  const commitEdit = useCallback(() => {
    const id = transactionRef.current;
    transactionRef.current = null;
    if (!id) return;
    flushPendingPhotoRender();
    const photo = photoByIdRef.current.get(id);
    if (!photo) return;
    void savePhoto(photo).catch((error) =>
      notify(error instanceof Error ? error.message : "Could not save the edit.", "error"),
    );
  }, [flushPendingPhotoRender, notify]);

  const updateEditState = useCallback(
    (updater: (edits: EditState) => EditState) => {
      if (!activeId) return;
      updatePhoto(
        activeId,
        (photo) => ({
          ...photo,
          lastEditedAt: new Date().toISOString(),
          edits: updater(photo.edits),
        }),
        false,
        true,
        false,
      );
    },
    [activeId, updatePhoto],
  );

  const undo = useCallback(() => {
    if (!activeId) return;
    commitEdit();
    const history = historiesRef.current.get(activeId);
    const photo = photoByIdRef.current.get(activeId);
    if (!history?.past.length || !photo) return;
    const previous = history.past.pop()!;
    history.future.push(photo.edits);
    updatePhoto(activeId, (item) => ({ ...item, edits: previous }), true, false, false);
    setHistoryVersion((version) => version + 1);
  }, [activeId, commitEdit, updatePhoto]);

  const redo = useCallback(() => {
    if (!activeId) return;
    commitEdit();
    const history = historiesRef.current.get(activeId);
    const photo = photoByIdRef.current.get(activeId);
    if (!history?.future.length || !photo) return;
    const next = history.future.pop()!;
    history.past.push(photo.edits);
    updatePhoto(activeId, (item) => ({ ...item, edits: next }), true, false, false);
    setHistoryVersion((version) => version + 1);
  }, [activeId, commitEdit, updatePhoto]);

  const handleImport = useCallback(
    async (
      files: File[],
      options: ImportOptions = normalizeImportOptions(),
    ) => {
      if (!files.length || importing) return;
      setImporting(true);
      setImportFailures([]);
      try {
        const result = await importFiles(files, options, setImportProgress);
        if (result.photos.length) {
          setPhotosSafe((current) => [...result.photos, ...current]);
          setActiveId(result.photos[0].id);
          setSelectedIds(new Set(result.photos.map((photo) => photo.id)));
          lastSelectedRef.current = result.photos[0].id;
          notify(
            `${result.photos.length} ${result.photos.length === 1 ? "photo" : "photos"} imported.`,
            "success",
          );
        }
        if (result.rejected.length) {
          setShowExport(false);
          setShowCatalogBackup(false);
          setShowShortcuts(false);
          setImportFailures(result.rejected);
          if (!result.photos.length) notify("No selected files could be imported.", "error");
        }
      } catch (error) {
        notify(error instanceof Error ? error.message : "Import failed.", "error");
      } finally {
        setImporting(false);
        setImportProgress(null);
        setPendingImportFiles([]);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [importing, notify, setPhotosSafe],
  );

  const handleFolderImport = useCallback(async () => {
    const picker = (
      window as Window & {
        showDirectoryPicker?: () => Promise<unknown>;
      }
    ).showDirectoryPicker;
    if (!picker) {
      notify("Folder import needs a Chromium-based browser. Choose individual files instead.");
      fileInputRef.current?.click();
      return;
    }
    try {
      const handle = await picker();
      const files = await collectDirectoryFiles(handle);
      setPendingImportFiles(files);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      notify(error instanceof Error ? error.message : "Could not open that folder.", "error");
    }
  }, [notify]);

  const selectPhoto = useCallback(
    (id: string, additive: boolean, range: boolean) => {
      setActiveId(id);
      setSelectedIds((current) => {
        if (range && lastSelectedRef.current) {
          const filtered = filteredPhotosRef.current;
          const start = filtered.findIndex(
            (photo) => photo.id === lastSelectedRef.current,
          );
          const end = filtered.findIndex((photo) => photo.id === id);
          if (start >= 0 && end >= 0) {
            return new Set(
              filtered
                .slice(Math.min(start, end), Math.max(start, end) + 1)
                .map((photo) => photo.id),
            );
          }
        }
        if (additive) {
          const next = new Set(current);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          if (!next.size) next.add(id);
          lastSelectedRef.current = id;
          return next;
        }
        lastSelectedRef.current = id;
        return new Set([id]);
      });
    },
    [],
  );

  const openDevelop = useCallback((id: string) => {
    commitEdit();
    setActiveId(id);
    setSelectedIds((current) => current.has(id) ? current : new Set([id]));
    setActiveMaskId(null);
    setActiveMaskComponentId(null);
    setMode("develop");
    setTool("edit");
  }, [commitEdit]);

  const changeTool = useCallback(
    (nextTool: EditorTool) => {
      if (nextTool === "mask") {
        const selection = resolveMaskSelection(
          activePhoto?.edits.masks ?? [],
          activeMaskId,
          activeMaskComponentId,
        );
        setActiveMaskId(selection.maskId);
        setActiveMaskComponentId(selection.componentId);
      }
      setTool(nextTool);
    },
    [activeMaskComponentId, activeMaskId, activePhoto],
  );

  const setRating = useCallback(
    (rating: number) => {
      const targets = selectedIds.size
        ? selectedIds
        : activeId
          ? new Set<string>([activeId])
          : new Set<string>();
      updatePhotos(
        targets,
        (photo) => (photo.rating === rating ? photo : { ...photo, rating }),
        true,
      );
    },
    [activeId, selectedIds, updatePhotos],
  );

  const setFlag = useCallback(
    (flag: FlagState) => {
      const targets = selectedIds.size
        ? selectedIds
        : activeId
          ? new Set<string>([activeId])
          : new Set<string>();
      updatePhotos(
        targets,
        (photo) => (photo.flag === flag ? photo : { ...photo, flag }),
        true,
      );
    },
    [activeId, selectedIds, updatePhotos],
  );

  const applyPreset = useCallback(
    (preset: DevelopPreset) => {
      if (!activePhoto) return;
      setPreviewPreset(null);
      const base = cloneEditState(activePhoto.edits);
      beginEdit();
      updateEditState(() => applyPresetAtAmount(base, preset, 100));
      commitEdit();
      presetBaseRef.current = {
        photoId: activePhoto.id,
        presetId: preset.id,
        state: base,
      };
      setActivePresetId(preset.id);
      setPresetAmount(100);
      notify(`${preset.name} applied.`, "success");
    },
    [activePhoto, beginEdit, commitEdit, notify, updateEditState],
  );

  const changePresetAmount = useCallback((amount: number) => {
    const base = presetBaseRef.current;
    if (!base || base.photoId !== activeId) return;
    const preset = BUILT_IN_PRESETS.find((candidate) => candidate.id === base.presetId);
    if (!preset) return;
    const nextAmount = Math.min(200, Math.max(0, Math.round(amount)));
    beginEdit();
    setPresetAmount(nextAmount);
    updateEditState(() => applyPresetAtAmount(base.state, preset, nextAmount));
  }, [activeId, beginEdit, updateEditState]);

  const resetEdits = useCallback(() => {
    if (!activePhoto) return;
    beginEdit();
    updateEditState(() => createDefaultEditState());
    setActiveMaskId(null);
    setActiveMaskComponentId(null);
    presetBaseRef.current = null;
    setActivePresetId(null);
    setPresetAmount(100);
    commitEdit();
    notify("Edits reset. The original file was not changed.");
  }, [activePhoto, beginEdit, commitEdit, notify, updateEditState]);

  const copyDevelopSettings = useCallback(() => {
    if (!activePhoto) return;
    setShowCopySettings(true);
  }, [activePhoto]);

  const confirmCopyDevelopSettings = useCallback((selection: SyncSettingsSelection) => {
    if (!activePhoto) return;
    setSyncSettingsSelection(selection);
    setCopiedEditState({
      state: cloneEditState(activePhoto.edits),
      selection: { ...selection },
    });
    setShowCopySettings(false);
    notify(`Settings copied from ${activePhoto.name}.`, "success");
  }, [activePhoto, notify]);

  const pasteDevelopSettings = useCallback(() => {
    if (!activePhoto || !copiedEditState) return;
    beginEdit();
    updateEditState((edits) => mergeSynchronizedSettings(
      edits,
      copiedEditState.state,
      copiedEditState.selection,
    ));
    commitEdit();
    notify(`Settings pasted to ${activePhoto.name}.`, "success");
  }, [activePhoto, beginEdit, commitEdit, copiedEditState, notify, updateEditState]);

  const applyPreviousSettings = useCallback(() => {
    if (!activePhoto) return;
    const activeIndex = filteredPhotos.findIndex((photo) => photo.id === activePhoto.id);
    const previous = filteredPhotos[activeIndex + 1] ?? filteredPhotos[activeIndex - 1];
    if (!previous) {
      notify("There is no previous photograph in this source.");
      return;
    }
    beginEdit();
    updateEditState(() => cloneEditState(previous.edits));
    commitEdit();
    notify(`Previous settings applied from ${previous.name}.`, "success");
  }, [activePhoto, beginEdit, commitEdit, filteredPhotos, notify, updateEditState]);

  const openSyncSettingsDialog = useCallback(() => {
    if (!activePhoto) return;
    const targets = [...selectedIds].filter((id) => id !== activePhoto.id);
    if (!targets.length) {
      notify("Select two or more photographs in Library before using Sync.");
      return;
    }
    setShowSyncSettings(true);
  }, [activePhoto, notify, selectedIds]);

  const synchronizeSelectedSettings = useCallback((selection: SyncSettingsSelection) => {
    if (!activePhoto) return;
    const targets = [...selectedIds].filter((id) => id !== activePhoto.id);
    if (!targets.length) return;
    const sourceEdits = cloneEditState(activePhoto.edits);
    targets.forEach((id) => historiesRef.current.delete(id));
    const editedAt = new Date().toISOString();
    updatePhotos(
      targets,
      (photo) => ({
          ...photo,
          lastEditedAt: editedAt,
          edits: mergeSynchronizedSettings(photo.edits, sourceEdits, selection),
      }),
      true,
      false,
    );
    setShowSyncSettings(false);
    notify(
      `Synchronized selected Develop settings to ${targets.length} ${targets.length === 1 ? "photograph" : "photographs"}.`,
      "success",
    );
  }, [activePhoto, notify, selectedIds, updatePhotos]);

  const createSnapshot = useCallback(() => {
    if (!activePhoto) return;
    const snapshot: EditSnapshot = {
      id: makeId("snapshot"),
      label: `Version ${activePhoto.snapshots.length + 1}`,
      createdAt: new Date().toISOString(),
      state: cloneEditState(activePhoto.edits),
    };
    updatePhoto(
      activePhoto.id,
      (photo) => ({ ...photo, snapshots: [...photo.snapshots, snapshot] }),
      true,
      false,
      false,
    );
    notify(`${snapshot.label} saved.`, "success");
  }, [activePhoto, notify, updatePhoto]);

  const restoreSnapshot = useCallback(
    (snapshot: EditSnapshot) => {
      beginEdit();
      updateEditState(() => cloneEditState(snapshot.state));
      commitEdit();
      notify(`${snapshot.label} restored.`);
    },
    [beginEdit, commitEdit, notify, updateEditState],
  );

  const handleCreateCollection = useCallback(
    async (name: string) => {
      try {
        const collection = await createCollection(name);
        setCollections((current) => [...current, collection]);
        setSource(`collection:${collection.id}`);
      } catch (error) {
        notify(
          error instanceof Error
            ? error.message.replace(/collection/gi, "album")
            : "Could not create album.",
          "error",
        );
      }
    },
    [notify],
  );

  const addSelectionToCollection = useCallback(
    async (collectionId: string) => {
      if (!collectionId) return;
      const targets = selectedIds.size
        ? selectedIds
        : activeId
          ? new Set([activeId])
          : new Set<string>();
      const updated: PhotoRecord[] = [];
      photosRef.current.forEach((photo) => {
        if (targets.has(photo.id) && !photo.collectionIds.includes(collectionId)) {
          updated.push({
            ...photo,
            collectionIds: [...photo.collectionIds, collectionId],
          });
        }
      });
      const collection = collections.find((item) => item.id === collectionId);
      if (!updated.length) {
        notify(`Those photos are already in ${collection?.name ?? "the album"}.`);
        return;
      }
      try {
        await savePhotos(updated);
        setPhotosSafe((current) =>
          current.map((photo) =>
            targets.has(photo.id) && !photo.collectionIds.includes(collectionId)
              ? {
                  ...photo,
                  collectionIds: [...photo.collectionIds, collectionId],
                }
              : photo,
          ),
        );
        notify(
          `Added ${updated.length} ${updated.length === 1 ? "photo" : "photos"} to ${
            collection?.name ?? "album"
          }.`,
          "success",
        );
      } catch (error) {
        notify(
          error instanceof Error
            ? error.message.replace(/collection/gi, "album")
            : "Could not update the album.",
          "error",
        );
      }
    },
    [activeId, collections, notify, selectedIds, setPhotosSafe],
  );

  const downloadCatalogBackup = useCallback(async () => {
    setCatalogBusy(true);
    try {
      const contents = await exportCatalog();
      const blob = new Blob([contents], {
        type: "application/json;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const date = new Date().toISOString().slice(0, 10);
      anchor.href = url;
      anchor.download = `Darkroom_catalog_${date}.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      notify("Catalog backup prepared; the browser download was requested.", "success");
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Could not create the catalog backup.",
        "error",
      );
    } finally {
      setCatalogBusy(false);
    }
  }, [notify]);

  const restoreCatalogBackup = useCallback(
    async (file: File) => {
      setCatalogBusy(true);
      try {
        const result = await importCatalog(file);
        const [storedPhotos, storedCollections] = await Promise.all([
          loadPhotos(),
          loadCollections(),
        ]);
        const normalizedPhotos = storedPhotos.map((photo) => ({
          ...photo,
          edits: { ...photo.edits, masks: normalizeMasks(photo.edits.masks) },
          snapshots: photo.snapshots.map((snapshot) => ({
            ...snapshot,
            state: {
              ...snapshot.state,
              masks: normalizeMasks(snapshot.state.masks),
            },
          })),
        }));
        setPhotosSafe(normalizedPhotos);
        setCollections(storedCollections);
        if (activeId && !normalizedPhotos.some((photo) => photo.id === activeId)) {
          setActiveId(normalizedPhotos[0]?.id ?? null);
        }
        notify(
          `Restored edits for ${result.updatedPhotos} ${
            result.updatedPhotos === 1 ? "photo" : "photos"
          }${result.skippedPhotos ? `; ${result.skippedPhotos} missing source copies skipped` : ""}.`,
          result.skippedPhotos ? "info" : "success",
        );
      } catch (error) {
        notify(
          error instanceof Error ? error.message : "Could not restore the catalog backup.",
          "error",
        );
      } finally {
        setCatalogBusy(false);
        if (catalogInputRef.current) catalogInputRef.current.value = "";
      }
    },
    [activeId, notify, setPhotosSafe],
  );

  const updateGlobal = useCallback(
    <K extends keyof GlobalAdjustments>(key: K, value: GlobalAdjustments[K]) => {
      updateEditState((edits) => ({
        ...edits,
        global: { ...edits.global, [key]: value },
      }));
    },
    [updateEditState],
  );

  const quickDevelopAdjust = useCallback(
    (key: "exposure" | "contrast", delta: number) => {
      if (!activePhoto) return;
      const limits = key === "exposure" ? [-5, 5] : [-100, 100];
      const next = Math.max(
        limits[0],
        Math.min(limits[1], activePhoto.edits.global[key] + delta),
      );
      beginEdit();
      updateGlobal(key, next);
      commitEdit();
    },
    [activePhoto, beginEdit, commitEdit, updateGlobal],
  );

  const updateHistogram = useCallback((next: HistogramData) => {
    pendingHistogramRef.current = next;
    if (histogramTimerRef.current) return;
    histogramTimerRef.current = setTimeout(() => {
      histogramTimerRef.current = null;
      const pending = pendingHistogramRef.current;
      pendingHistogramRef.current = null;
      if (pending) setHistogram(pending);
    }, 50);
  }, []);

  const updateProfile = useCallback(
    (profile: string) => {
      beginEdit();
      updateEditState((edits) => ({ ...edits, profile }));
      commitEdit();
    },
    [beginEdit, commitEdit, updateEditState],
  );

  const autoAdjust = useCallback(() => {
    if (!histogram) return;
    const total = histogram.luminance.reduce((sum, value) => sum + value, 0);
    if (total <= 0) return;
    const mean =
      histogram.luminance.reduce(
        (sum, value, index) => sum + value * (index / 255),
        0,
      ) / total;
    const shadows = histogram.luminance
      .slice(0, 64)
      .reduce((sum, value) => sum + value, 0) / total;
    const highlights = histogram.luminance
      .slice(210)
      .reduce((sum, value) => sum + value, 0) / total;
    beginEdit();
    updateEditState((edits) => ({
      ...edits,
      global: {
        ...edits.global,
        exposure: Math.max(
          -2,
          Math.min(2, Math.log2(0.46 / Math.max(0.03, mean))),
        ),
        contrast: Math.round((0.5 - Math.abs(mean - 0.5)) * 14),
        highlights: Math.round(-Math.min(45, highlights * 120)),
        shadows: Math.round(Math.min(45, shadows * 115)),
        whites: highlights < 0.06 ? 8 : 0,
        blacks: shadows < 0.08 ? -6 : 0,
        vibrance: 10,
      },
    }));
    commitEdit();
    notify("Auto tone applied.");
  }, [beginEdit, commitEdit, histogram, notify, updateEditState]);

  const updateGeometry = useCallback(
    <K extends keyof GeometryAdjustments>(
      key: K,
      value: GeometryAdjustments[K],
    ) => {
      updateEditState((edits) => ({
        ...edits,
        geometry: { ...edits.geometry, [key]: value },
      }));
    },
    [updateEditState],
  );

  const applyUprightMode = useCallback(
    (mode: GeometryAdjustments["uprightMode"], refresh = false) => {
      if (mode === "off") {
        beginEdit();
        updateEditState((edits) => ({
          ...edits,
          geometry: {
            ...edits.geometry,
            uprightMode: "off",
            rotate: 0,
            vertical: 0,
            horizontal: 0,
          },
        }));
        commitEdit();
        notify("Upright correction turned off.");
        return;
      }

      if (mode === "guided") {
        beginEdit();
        updateEditState((edits) => ({
          ...edits,
          geometry: { ...edits.geometry, uprightMode: "guided" },
        }));
        commitEdit();
        notify("Guided Upright is active. Draw two to four lines over edges that should be level or vertical.");
        return;
      }

      const engine = engineRef.current;
      if (!engine) {
        notify("The image is still loading; Upright will be available in a moment.");
        return;
      }
      const analysis = engine.analyzeUpright();
      if (analysis.confidence < 0.04) {
        notify("Upright could not find enough strong lines in this image.");
        return;
      }

      beginEdit();
      updateEditState((edits) => {
        const geometry = {
          ...edits.geometry,
          uprightMode: mode,
          rotate: analysis.rotation,
        };
        if (mode === "vertical" || mode === "full") {
          geometry.vertical = analysis.vertical;
        } else if (mode === "level") {
          geometry.vertical = 0;
          geometry.horizontal = 0;
        }
        if (mode === "full") {
          geometry.horizontal = analysis.horizontal;
        } else if (mode === "vertical") {
          geometry.horizontal = 0;
        }
        if (mode === "auto") {
          geometry.vertical = analysis.verticalLines >= 12 ? analysis.vertical : 0;
          geometry.horizontal = analysis.horizontalLines >= 12 ? analysis.horizontal : 0;
        }
        return { ...edits, geometry };
      });
      commitEdit();
      notify(`${refresh ? "Updated" : "Applied"} ${mode[0].toUpperCase()}${mode.slice(1)} Upright correction.`);
    },
    [beginEdit, commitEdit, notify, updateEditState],
  );

  const applyGuidedUprightGuides = useCallback(
    (guides: UprightGuide[]) => {
      if (!activePhoto) return;
      const nextGuides = guides.slice(0, 4);
      let correction = { rotate: 0, horizontal: 0, vertical: 0 };
      let confidence: number | null = null;

      if (nextGuides.length >= 2) {
        const result = solveGuidedUpright(nextGuides, {
          aspectRatio:
            Math.max(1, activePhoto.width) / Math.max(1, activePhoto.height),
        });
        if (!result.ok) {
          notify(result.message);
          return;
        }
        correction = result.solution.correction;
        confidence = result.solution.confidence;
      }

      beginEdit();
      updateEditState((edits) => ({
        ...edits,
        geometry: {
          ...edits.geometry,
          uprightMode: "guided",
          guides: nextGuides,
          ...correction,
        },
      }));
      commitEdit();

      if (confidence !== null) {
        notify(
          `Guided Upright updated from ${nextGuides.length} guides (${Math.round(confidence * 100)}% fit confidence).`,
        );
      }
    },
    [activePhoto, beginEdit, commitEdit, notify, updateEditState],
  );

  const createMask = useCallback(
    (kind: MaskKind) => {
      if (!activePhoto || activePhoto.edits.masks.length >= 8) {
        notify("A photo can currently contain up to eight mask groups.");
        return;
      }
      beginEdit();
      setShowMaskOverlay(true);
      const mask = maskDefaults(kind, activePhoto.edits.masks.length);
      updateEditState((edits) => ({ ...edits, masks: [...edits.masks, mask] }));
      setActiveMaskId(mask.id);
      setActiveMaskComponentId(mask.components?.[0]?.id ?? null);
      setTool("mask");
      commitEdit();
    },
    [activePhoto, beginEdit, commitEdit, notify, updateEditState],
  );

  const selectMask = useCallback(
    (id: string) => {
      const mask = activePhoto?.edits.masks.find((candidate) => candidate.id === id);
      setActiveMaskId(id);
      setActiveMaskComponentId(mask ? getMaskComponents(mask)[0]?.id ?? null : null);
    },
    [activePhoto],
  );

  const selectMaskComponent = useCallback(
    (maskId: string, componentId: string) => {
      setActiveMaskId(maskId);
      setActiveMaskComponentId(componentId);
      setTool("mask");
    },
    [],
  );

  const updateMask = useCallback(
    (id: string, patch: Partial<Mask>) => {
      if (patch.amount !== undefined || patch.curve || patch.grain || patch.adjustments) setShowMaskOverlay(false);
      updateEditState((edits) => ({
        ...edits,
        masks: edits.masks.map((mask) => (mask.id === id ? { ...mask, ...patch } : mask)),
      }));
    },
    [updateEditState],
  );

  const addMaskComponent = useCallback(
    (maskId: string, kind: MaskKind, operation: MaskOperation) => {
      setShowMaskOverlay(true);
      const component = makeMaskComponent(kind, operation);
      beginEdit();
      updateEditState((edits) => ({
        ...edits,
        masks: edits.masks.map((mask) =>
          mask.id === maskId
            ? {
                ...mask,
                components: [...getMaskComponents(mask), component].slice(0, 32),
              }
            : mask,
        ),
      }));
      setActiveMaskId(maskId);
      setActiveMaskComponentId(component.id);
      commitEdit();
    },
    [beginEdit, commitEdit, updateEditState],
  );

  const updateMaskComponent = useCallback(
    (
      maskId: string,
      componentId: string,
      patch: Partial<MaskComponent>,
    ) => {
      updateEditState((edits) => ({
        ...edits,
        masks: edits.masks.map((mask) =>
          mask.id === maskId
            ? updateMaskComponentInGroup(mask, componentId, patch)
            : mask,
        ),
      }));
    },
    [updateEditState],
  );

  const updateMaskAdjustments = useCallback(
    (id: string, patch: Partial<LocalAdjustments>) => {
      setShowMaskOverlay(false);
      updateEditState((edits) => ({
        ...edits,
        masks: edits.masks.map((mask) =>
          mask.id === id
            ? { ...mask, adjustments: { ...mask.adjustments, ...patch } }
            : mask,
        ),
      }));
    },
    [updateEditState],
  );

  const deleteMask = useCallback(
    (id: string) => {
      beginEdit();
      updateEditState((edits) => ({
        ...edits,
        masks: edits.masks.filter((mask) => mask.id !== id),
      }));
      setActiveMaskId(null);
      setActiveMaskComponentId(null);
      commitEdit();
    },
    [beginEdit, commitEdit, updateEditState],
  );

  const deleteMaskComponent = useCallback(
    (maskId: string, componentId: string) => {
      beginEdit();
      let nextActiveComponentId: string | null = null;
      let removedGroup = false;
      updateEditState((edits) => ({
        ...edits,
        masks: edits.masks.flatMap((mask) => {
          if (mask.id !== maskId) return [mask];
          const components = getMaskComponents(mask);
          if (components.length <= 1) {
            removedGroup = true;
            return [];
          }
          const nextComponents = components
            .filter((component) => component.id !== componentId)
            .map((component, index) =>
              index === 0 && component.operation !== "add"
                ? { ...component, operation: "add" as const }
                : component,
            );
          nextActiveComponentId = nextComponents[0]?.id ?? null;
          return [{ ...mask, components: nextComponents }];
        }),
      }));
      if (removedGroup) setActiveMaskId(null);
      setActiveMaskComponentId(nextActiveComponentId);
      commitEdit();
    },
    [beginEdit, commitEdit, updateEditState],
  );

  const duplicateMask = useCallback(
    (maskId: string, invert = false) => {
      const sourceMask = activePhoto?.edits.masks.find((mask) => mask.id === maskId);
      if (!sourceMask || !activePhoto || activePhoto.edits.masks.length >= 8) {
        notify("A photo can currently contain up to eight mask groups.");
        return;
      }
      const components = getMaskComponents(sourceMask).map((component) => ({
        ...structuredClone(component),
        id: makeId("mask-component"),
      }));
      const copy: Mask = {
        ...structuredClone(sourceMask),
        id: makeId("mask"),
        name: `${sourceMask.name} Copy`,
        inverted: invert ? !sourceMask.inverted : sourceMask.inverted,
        components,
      };
      beginEdit();
      updateEditState((edits) => ({
        ...edits,
        masks: [...edits.masks, copy],
      }));
      setActiveMaskId(copy.id);
      setActiveMaskComponentId(components[0]?.id ?? null);
      commitEdit();
    },
    [activePhoto, beginEdit, commitEdit, notify, updateEditState],
  );

  const renameMask = useCallback(
    (maskId: string, name: string) => {
      const cleanName = name.trim().slice(0, 80);
      if (!cleanName) return;
      updateMask(maskId, { name: cleanName });
    },
    [updateMask],
  );

  const appendBrushStroke = useCallback(
    (maskId: string, stroke: BrushStroke) => {
      const componentId = activeMaskComponentId;
      if (!componentId) return;
      beginEdit();
      updateEditState((edits) => ({
        ...edits,
        masks: edits.masks.map((mask) =>
          mask.id === maskId
            ? updateMaskComponentInGroup(mask, componentId, (component) => ({
                strokes: [...(component.strokes ?? []), stroke],
              }))
            : mask,
        ),
      }));
      commitEdit();
    },
    [
      activeMaskComponentId,
      beginEdit,
      commitEdit,
      updateEditState,
    ],
  );

  const addHealSpot = useCallback(
    (spot: Omit<HealSpot, "id">) => {
      if ((activePhoto?.edits.healSpots.length ?? 0) >= 16) {
        notify("This local renderer supports up to sixteen repair regions per photo.");
        return;
      }
      const id = makeId("heal");
      beginEdit();
      updateEditState((edits) => ({
        ...edits,
        healSpots: [...edits.healSpots, { ...spot, id }],
      }));
      setActiveHealSpotId(id);
      healSourceCycleRef.current.set(id, 0);
      commitEdit();
    },
    [activePhoto?.edits.healSpots.length, beginEdit, commitEdit, notify, updateEditState],
  );

  const updateHealSpot = useCallback(
    (id: string, patch: Partial<HealSpot>) => {
      updateEditState((edits) => ({
        ...edits,
        healSpots: edits.healSpots.map((spot) =>
          spot.id === id ? { ...spot, ...patch } : spot,
        ),
      }));
    },
    [updateEditState],
  );

  const removeHealSpot = useCallback(
    (id: string) => {
      beginEdit();
      updateEditState((edits) => ({
        ...edits,
        healSpots: edits.healSpots.filter((spot) => spot.id !== id),
      }));
      setActiveHealSpotId((activeId) => (activeId === id ? null : activeId));
      healSourceCycleRef.current.delete(id);
      commitEdit();
    },
    [beginEdit, commitEdit, updateEditState],
  );

  const recenterHealSource = useCallback(
    (id: string) => {
      const spot = activePhoto?.edits.healSpots.find((candidate) => candidate.id === id);
      if (!spot) return;
      const nextCycle = (healSourceCycleRef.current.get(id) ?? 0) + 1;
      healSourceCycleRef.current.set(id, nextCycle);
      const suggested = engineRef.current?.suggestHealSource(
        spot.destination,
        spot.size,
        nextCycle,
      );
      beginEdit();
      updateEditState((edits) => ({
        ...edits,
        healSpots: edits.healSpots.map((spot) =>
          spot.id === id
            ? {
                ...spot,
                source: suggested ?? {
                  x: Math.min(1, Math.max(0, spot.destination.x + 0.07)),
                  y: Math.min(1, Math.max(0, spot.destination.y + 0.045)),
                },
              }
            : spot,
        ),
      }));
      commitEdit();
    },
    [activePhoto, beginEdit, commitEdit, updateEditState],
  );

  const resetHealSpots = useCallback(() => {
    if (!activePhoto?.edits.healSpots.length) return;
    beginEdit();
    updateEditState((edits) => ({ ...edits, healSpots: [] }));
    setActiveHealSpotId(null);
    healSourceCycleRef.current.clear();
    commitEdit();
  }, [activePhoto?.edits.healSpots.length, beginEdit, commitEdit, updateEditState]);

  const resetSection = useCallback(
    (keys: (keyof GlobalAdjustments)[]) => {
      beginEdit();
      updateEditState((edits) => {
        const global = { ...edits.global };
        keys.forEach((key) => {
          global[key] = DEFAULT_GLOBAL_ADJUSTMENTS[key];
        });
        return { ...edits, global };
      });
      commitEdit();
    },
    [beginEdit, commitEdit, updateEditState],
  );

  const navigatePhoto = useCallback(
    (direction: number) => {
      if (!filteredPhotos.length) return;
      const index = Math.max(
        0,
        filteredPhotos.findIndex((photo) => photo.id === activeId),
      );
      const nextIndex = Math.min(
        filteredPhotos.length - 1,
        Math.max(0, index + direction),
      );
      const next = filteredPhotos[nextIndex];
      if (next) {
        commitEdit();
        setActiveId(next.id);
        setSelectedIds(new Set([next.id]));
      }
    },
    [activeId, commitEdit, filteredPhotos],
  );

  const handleExport = useCallback(async () => {
    if (!exportTargets.length) return;
    exportCanceledRef.current = false;
    setExporting(true);
    setExportProgress({
      current: 0,
      total: exportTargets.length,
      name: exportTargets[0].name,
    });
    const controller = new ImageEngine(document.createElement("canvas"));
    let exported = 0;
    const failures: string[] = [];
    try {
      const extension =
        exportSettings.format === "image/png"
          ? "png"
          : exportSettings.format === "image/webp"
            ? "webp"
            : "jpg";
      for (let index = 0; index < exportTargets.length; index += 1) {
        if (exportCanceledRef.current) break;
        const photo = exportTargets[index];
        setExportProgress({
          current: index + 1,
          total: exportTargets.length,
          name: photo.name,
        });
        try {
          const blob = await controller.export(
            renderBlobForPhoto(photo),
            photo.edits,
            exportSettings,
          );
          if (exportCanceledRef.current) break;
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          const fileName =
            exportTargets.length === 1
              ? exportSettings.fileName || `${withoutExtension(photo.name)}_edit`
              : `${exportSettings.fileName || "Darkroom_export"}_${String(index + 1).padStart(3, "0")}_${withoutExtension(photo.name)}`;
          anchor.href = url;
          anchor.download = `${fileName}.${extension}`;
          anchor.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
          exported += 1;
        } catch (error) {
          failures.push(
            `${photo.name}: ${
              error instanceof Error ? error.message : "render failed"
            }`,
          );
        }
      }
      setShowExport(false);
      if (exportCanceledRef.current) {
        notify(
          exported
            ? `Export canceled after ${exported} ${exported === 1 ? "photo" : "photos"}.`
            : "Export canceled.",
          "info",
        );
      } else if (exported) {
        notify(
          `${exported} ${exported === 1 ? "photo" : "photos"} rendered; browser downloads were requested.`,
          failures.length ? "info" : "success",
        );
      }
      if (failures.length) {
        notify(
          `${failures.length} export${failures.length === 1 ? "" : "s"} failed. ${failures[0]}`,
          "error",
        );
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "Export failed.", "error");
    } finally {
      controller.destroy();
      setExporting(false);
      setExportProgress(null);
    }
  }, [exportSettings, exportTargets, notify]);

  const closeOrCancelExport = useCallback(() => {
    if (exporting) {
      exportCanceledRef.current = true;
      return;
    }
    setShowExport(false);
  }, [exporting]);

  useEffect(() => {
    const isTyping = (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      return (
        element?.isContentEditable ||
        Boolean(
          element?.closest(
            'input, textarea, select, button, a, summary, [role="button"], [role="slider"], [role="dialog"]',
          ),
        )
      );
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      const cropOverlayShortcutTarget = event.target as HTMLElement | null;
      if (
        mode === "develop" &&
        tool === "crop" &&
        singleKeyShortcuts &&
        !event.repeat &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key.toLowerCase() === "o" &&
        !cropOverlayShortcutTarget?.isContentEditable &&
        !cropOverlayShortcutTarget?.closest("input, textarea, select")
      ) {
        event.preventDefault();
        cycleCropOverlay();
        return;
      }
      const target = event.target as HTMLElement | null;
      if (singleKeyShortcuts && mode === "develop" && tool === "mask" && !event.metaKey && !event.ctrlKey && !target?.closest("input, textarea, select") && !target?.isContentEditable) {
        if (event.key.toLowerCase() === "o") { event.preventDefault(); setShowMaskOverlay(v => !v); return; }
        if (event.key === "[" || event.key === "]" || event.key === "{" || event.key === "}") {
          event.preventDefault();
          setMaskBrushSettings(settings => event.shiftKey
            ? { ...settings, feather: Math.max(0, Math.min(100, settings.feather + (event.key === "}" ? 5 : -5))) }
            : { ...settings, size: Math.max(0.1, Math.min(100, settings.size + (event.key === "]" ? 1 : -1))) });
          return;
        }
        if (event.key.toLowerCase() === "x") { event.preventDefault(); setMaskBrushSettings(settings => ({ ...settings, erase: !settings.erase })); return; }
      }
      const meta = event.metaKey || event.ctrlKey;
      // Buttons and range controls keep focus after editing. Command/Ctrl-Z
      // must still undo the edit there; text fields keep their native undo.
      if (meta && event.key.toLowerCase() === "z" && !target?.isContentEditable &&
        !target?.closest('textarea, select, input:not([type="range"]):not([type="checkbox"]):not([type="radio"])')) {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (isTyping(event.target)) return;
      if (meta && event.shiftKey && event.key.toLowerCase() === "i") {
        event.preventDefault();
        fileInputRef.current?.click();
        return;
      }
      if (meta && event.shiftKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        if (activePhoto) setShowExport(true);
        return;
      }
      if (!singleKeyShortcuts) return;
      if (event.key === "\\") {
        event.preventDefault();
        setShowOriginal(true);
      } else if (event.key === "Tab") {
        event.preventDefault();
        setPanelsVisible((visible) => !visible);
      } else if (mode === "develop" && tool === "heal" && event.key.toLowerCase() === "h") {
        event.preventDefault();
        setHealOverlayMode((current) => (current === "never" ? "always" : "never"));
      } else if (mode === "develop" && tool === "heal" && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setVisualizeSpots((visible) => !visible);
      } else if (mode === "develop" && tool === "heal" && (event.key === "[" || event.key === "]")) {
        event.preventDefault();
        setHealSettings((settings) => ({
          ...settings,
          size: Math.min(500, Math.max(2, settings.size + (event.key === "]" ? 5 : -5))),
        }));
      } else if (mode === "develop" && tool === "heal" && event.key === "/" && !event.shiftKey) {
        event.preventDefault();
        if (activeHealSpotId) recenterHealSource(activeHealSpotId);
      } else if (
        mode === "develop" &&
        tool === "heal" &&
        (event.key === "Delete" || event.key === "Backspace")
      ) {
        event.preventDefault();
        if (activeHealSpotId) removeHealSpot(activeHealSpotId);
      } else if (mode === "develop" && tool === "heal" && event.key === "Escape") {
        event.preventDefault();
        setActiveHealSpotId(null);
      } else if (event.key === "ArrowLeft") navigatePhoto(-1);
      else if (event.key === "ArrowRight") navigatePhoto(1);
      else if (/^[0-5]$/.test(event.key)) setRating(Number(event.key));
      else if (event.key.toLowerCase() === "p") setFlag("pick");
      else if (event.key.toLowerCase() === "x") setFlag("reject");
      else if (event.key.toLowerCase() === "u") setFlag("unflagged");
      else if (event.key.toLowerCase() === "g") {
        setMode("library");
        setLibraryView(event.shiftKey ? "square-grid" : "photo-grid");
      } else if (event.key.toLowerCase() === "e" && !meta) {
        setMode("library");
        setLibraryView("detail");
      } else if (event.key.toLowerCase() === "d") {
        if (activePhoto) setMode("develop");
      } else if (event.shiftKey && event.key.toLowerCase() === "w") {
        setMode("develop"); setTool("mask");
      } else if (event.key.toLowerCase() === "r") {
        setMode("develop");
        setTool("crop");
      } else if (event.key.toLowerCase() === "q") {
        setMode("develop");
        setTool("heal");
      } else if (event.key.toLowerCase() === "k") {
        setMode("develop");
        const brushGroup = activePhoto?.edits.masks.find((mask) =>
          getMaskComponents(mask).some((component) => component.kind === "brush"),
        );
        const brushComponent = brushGroup
          ? getMaskComponents(brushGroup).find(
              (component) => component.kind === "brush",
            )
          : null;
        if (brushGroup && brushComponent) {
          setActiveMaskId(brushGroup.id);
          setActiveMaskComponentId(brushComponent.id);
          setTool("mask");
        } else createMask("brush");
      } else if (event.key.toLowerCase() === "m") {
        setMode("develop");
        createMask(event.shiftKey ? "radial" : "linear");
      } else if (event.key.toLowerCase() === "j") {
        setShowClipping((visible) => !visible);
      } else if (event.key === "?" || (event.key === "/" && event.shiftKey)) {
        setShowShortcuts(true);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "\\") setShowOriginal(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [
    activePhoto,
    activeHealSpotId,
    cycleCropOverlay,
    createMask,
    mode,
    navigatePhoto,
    redo,
    recenterHealSource,
    removeHealSpot,
    setFlag,
    setRating,
    singleKeyShortcuts,
    tool,
    undo,
  ]);

  const activeHistory = activeId ? historiesRef.current.get(activeId) : undefined;
  const canUndo = Boolean(activeHistory?.past.length);
  const canRedo = Boolean(activeHistory?.future.length);
  void historyVersion;

  const sourceLabel =
    source === "all"
      ? "All Photographs"
      : source === "recent"
        ? "Previous Import"
        : source === "picks"
          ? "Picks"
          : source === "five-stars"
            ? "Five stars"
            : source === "rejected"
              ? "Rejected"
              : collections.find((collection) => `collection:${collection.id}` === source)
                  ?.name ?? "Catalog";

  return (
    <div
      className={`app-shell ${panelsVisible ? "" : "panels-hidden"}`}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        event.preventDefault();
        setPendingImportFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        hidden
        multiple
        accept={`image/jpeg,image/png,image/webp,image/gif,image/bmp,image/tiff,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.gif,.bmp,.tif,.tiff,.heic,.heif,${CAMERA_RAW_ACCEPT}`}
        onChange={(event) =>
          setPendingImportFiles(Array.from(event.target.files ?? []))
        }
      />
      <input
        ref={catalogInputRef}
        type="file"
        hidden
        accept="application/json,.json"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void restoreCatalogBackup(file);
        }}
      />
      <header className="topbar classic-module-bar">
        <div className="classic-identity" aria-label="Darkroom catalog">
          <img
            className="classic-identity__mark"
            src={`${import.meta.env.BASE_URL}icon-192.png`}
            alt=""
            aria-hidden="true"
            width={27}
            height={27}
            draggable={false}
          />
          <span className="classic-identity__text">
            <strong>Darkroom</strong>
            <small>Local catalog</small>
          </span>
        </div>
        <nav className="mode-switcher" aria-label="Modules">
          <button
            type="button"
            className={mode === "library" ? "is-active" : ""}
            aria-pressed={mode === "library"}
            onClick={() => setMode("library")}
          >
            Library
          </button>
          <button
            type="button"
            className={mode === "develop" ? "is-active" : ""}
            aria-pressed={mode === "develop"}
            disabled={!activePhoto}
            onClick={() => setMode("develop")}
          >
            Develop
          </button>
          {['Map', 'Book', 'Slideshow', 'Print', 'Web'].map((module) => (
            <button key={module} type="button" disabled title={`${module} is not available in the browser catalog`}>
              {module}
            </button>
          ))}
        </nav>
        <div className="topbar__actions classic-utilities">
          {activePhoto ? (
            <div className="history-actions">
              <IconButton icon={Undo2} label="Undo" disabled={!canUndo} onClick={undo} />
              <IconButton icon={Redo2} label="Redo" disabled={!canRedo} onClick={redo} />
            </div>
          ) : null}
          <IconButton
            icon={panelsVisible ? PanelLeftClose : PanelLeftOpen}
            label={panelsVisible ? "Hide panels" : "Show panels"}
            onClick={() => setPanelsVisible((visible) => !visible)}
          />
          <IconButton
            icon={CircleHelp}
            label="Keyboard shortcuts"
            onClick={() => setShowShortcuts(true)}
          />
          <IconButton
            icon={DatabaseBackup}
            label="Catalog backup and restore"
            onClick={() => setShowCatalogBackup(true)}
          />
          <span className="classic-cloud" title="Local browser catalog" aria-label="Local browser catalog">☁</span>
        </div>
      </header>

      <div className="workspace">
        {panelsVisible ? (
          <LeftSidebar
            mode={mode}
            photos={photos}
            photo={previewPhoto}
            source={source}
            collections={collections}
            snapshots={activePhoto?.snapshots ?? []}
            historyCount={activeHistory?.past.length ?? 0}
            onSourceChange={(nextSource) => {
              setSource(nextSource);
              setMode("library");
            }}
            onCreateCollection={handleCreateCollection}
            onApplyPreset={applyPreset}
            onPreviewPreset={setPreviewPreset}
            activePresetId={activePresetId}
            presetAmount={presetAmount}
            onPresetAmountChange={changePresetAmount}
            onPresetAmountCommit={commitEdit}
            onCreateSnapshot={createSnapshot}
            onRestoreSnapshot={restoreSnapshot}
            onReset={resetEdits}
            onCopySettings={copyDevelopSettings}
            onPasteSettings={pasteDevelopSettings}
            canPasteSettings={Boolean(copiedEditState)}
          />
        ) : null}

        <section className="workspace-center">
          {mode === "library" ? (
            <>
              <div className="library-toolbar">
                <div className="library-toolbar__title">
                  <strong>{sourceLabel}</strong>
                  <span>
                    {filteredPhotos.length}{" "}
                    {filteredPhotos.length === 1 ? "photo" : "photos"}
                  </span>
                </div>
                <label className="topbar-search library-filter-search">
                  <Search size={13} aria-hidden="true" />
                  <input
                    value={search}
                    placeholder="Filter photos"
                    aria-label="Search photos"
                    onChange={(event) => setSearch(event.target.value)}
                  />
                  {search ? (
                    <button
                      type="button"
                      onClick={() => setSearch("")}
                      title="Clear search"
                      aria-label="Clear search"
                    >
                      <X size={11} />
                    </button>
                  ) : null}
                </label>
                <div className="library-toolbar__selection">
                  {selectedIds.size > 1 ? <span>{selectedIds.size} selected</span> : null}
                  {collections.length && selectedIds.size ? (
                    <label className="collection-select">
                      <select
                        defaultValue=""
                        onChange={(event) => {
                          addSelectionToCollection(event.target.value);
                          event.target.value = "";
                        }}
                      >
                        <option value="" disabled>
                          Add to album
                        </option>
                        {collections.map((collection) => (
                          <option key={collection.id} value={collection.id}>
                            {collection.name}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={12} />
                    </label>
                  ) : null}
                </div>
                <div className="library-toolbar__filters">
                  <label className="rating-filter" title="Minimum rating">
                    <Star size={13} />
                    <select
                      value={minimumRating}
                      onChange={(event) => setMinimumRating(Number(event.target.value))}
                    >
                      <option value={0}>Any</option>
                      <option value={1}>1+</option>
                      <option value={2}>2+</option>
                      <option value={3}>3+</option>
                      <option value={4}>4+</option>
                      <option value={5}>5</option>
                    </select>
                  </label>
                  <select
                    className="sort-select"
                    value={sortMode}
                    onChange={(event) => setSortMode(event.target.value as SortMode)}
                    aria-label="Sort photos"
                  >
                    <option value="imported-desc">Recently imported</option>
                    <option value="captured-desc">Capture time</option>
                    <option value="name-asc">File name</option>
                    <option value="rating-desc">Rating</option>
                  </select>
                  <div className="view-switcher">
                    <IconButton
                      icon={Grid3X3}
                      label="Photo Grid"
                      active={libraryView === "photo-grid"}
                      onClick={() => setLibraryView("photo-grid")}
                    />
                    <IconButton
                      icon={LayoutGrid}
                      label="Square Grid"
                      active={libraryView === "square-grid"}
                      onClick={() => setLibraryView("square-grid")}
                    />
                    <IconButton
                      icon={Maximize2}
                      label="Detail"
                      active={libraryView === "detail"}
                      onClick={() => setLibraryView("detail")}
                    />
                  </div>
                </div>
              </div>
              <LibraryWorkspace
                photos={filteredPhotos}
                activeId={activeId}
                selectedIds={selectedIds}
                view={libraryView}
                onSelect={selectPhoto}
                onOpen={openDevelop}
                onImport={() => fileInputRef.current?.click()}
                onLoadSample={() => void createSampleFile().then((file) => handleImport([file]))}
              />
              <div className="classic-library-footer" aria-label="Library actions">
                <div>
                  <button type="button" onClick={() => fileInputRef.current?.click()}>
                    <Import size={13} /> Import…
                  </button>
                  <button type="button" onClick={() => void handleFolderImport()}>
                    <FolderOpen size={13} /> Folder…
                  </button>
                  <button type="button" disabled={!activePhoto} onClick={() => setShowExport(true)}>
                    <Download size={13} /> Export…
                  </button>
                </div>
                <span>{selectedIds.size || filteredPhotos.length} selected / {filteredPhotos.length} photographs</span>
              </div>
            </>
          ) : activePhoto ? (
            <DevelopWorkspace
              photo={previewPhoto ?? activePhoto}
              tool={tool}
              cropOverlay={cropOverlay}
              activeMaskId={activeMaskId}
              activeMaskComponentId={activeMaskComponentId}
              showOriginal={showOriginal}
              showMaskOverlay={showMaskOverlay}
              maskOverlayMode={maskOverlayMode}
              maskOverlayOpacity={maskOverlayOpacity}
              showClipping={showClipping}
              guidedUprightActive={activePhoto.edits.geometry.uprightMode === "guided"}
              uprightGuides={activePhoto.edits.geometry.guides}
              activeHealSpotId={activeHealSpotId}
              healOverlayMode={healOverlayMode}
              visualizeSpots={visualizeSpots}
              visualizeSpotsThreshold={visualizeSpotsThreshold}
              zoom={zoom}
              onZoomChange={setZoom}
              onHistogram={updateHistogram}
              onEngineReady={(engine) => {
                engineRef.current = engine;
              }}
              onToggleOriginal={() => setShowOriginal((visible) => !visible)}
              onToggleMaskOverlay={() => setShowMaskOverlay((visible) => !visible)}
              onBeginEdit={beginEdit}
              onCommitEdit={commitEdit}
              onAppendBrushStroke={appendBrushStroke}
              onUpdateMaskComponent={updateMaskComponent}
              onAddHealSpot={addHealSpot}
              onUpdateHealSpot={updateHealSpot}
              onRemoveHealSpot={removeHealSpot}
              onSelectHealSpot={setActiveHealSpotId}
              onAddUprightGuide={(guide) =>
                applyGuidedUprightGuides([
                  ...activePhoto.edits.geometry.guides,
                  guide,
                ])
              }
              healSettings={healSettings}
              maskBrushSettings={maskBrushSettings}
              onError={notifyError}
              onCropChange={(crop) =>
                updateEditState((edits) => ({ ...edits, crop }))
              }
            />
          ) : null}
        </section>

        {mode === "library" && panelsVisible ? (
          <LibraryInspector
            photo={activePhoto}
            histogram={null}
            onQuickAdjust={quickDevelopAdjust}
            onRatingChange={setRating}
            onFlagChange={setFlag}
            onKeywordsChange={(keywords) => {
              if (!activePhoto) return;
              updatePhoto(activePhoto.id, (photo) => ({ ...photo, keywords }), true);
            }}
            onMetadataChange={(patch) => {
              if (!activePhoto) return;
              updatePhoto(
                activePhoto.id,
                (photo) => ({ ...photo, metadata: { ...photo.metadata, ...patch } }),
                true,
              );
            }}
          />
        ) : null}

        {mode === "develop" && activePhoto && panelsVisible ? (
          <RightInspector
            photo={activePhoto}
            histogram={histogram}
            tool={tool}
            cropOverlay={cropOverlay}
            activeMaskId={activeMaskId}
            activeMaskComponentId={activeMaskComponentId}
            healSettings={healSettings}
            activeHealSpotId={activeHealSpotId}
            healOverlayMode={healOverlayMode}
            visualizeSpots={visualizeSpots}
            visualizeSpotsThreshold={visualizeSpotsThreshold}
            maskBrushSettings={maskBrushSettings}
            showClipping={showClipping}
            snapshots={activePhoto.snapshots}
            historyCount={activeHistory?.past.length ?? 0}
            overlayMode={maskOverlayMode}
            overlayOpacity={maskOverlayOpacity}
            onToolChange={changeTool}
            onCropOverlayChange={setCropOverlay}
            onToggleClipping={() => setShowClipping((visible) => !visible)}
            onProfileChange={updateProfile}
            onAutoAdjust={autoAdjust}
            onApplyPreset={applyPreset}
            onPreviewPreset={setPreviewPreset}
            onCreateSnapshot={createSnapshot}
            onRestoreSnapshot={restoreSnapshot}
            onResetEdits={resetEdits}
            onBeginEdit={beginEdit}
            onCommitEdit={commitEdit}
            onGlobalChange={updateGlobal}
            onCurveChange={(curve) => updateEditState((edits) => ({ ...edits, curve }))}
            onColorCurveChange={(channel, curve) => updateEditState((edits) => ({
              ...edits,
              [`${channel}Curve`]: curve,
            }))}
            onHslChange={(channel: HueChannel, value: HslChannel) =>
              updateEditState((edits) => ({
                ...edits,
                hsl: { ...edits.hsl, [channel]: value },
              }))
            }
            onPointColorChange={(pointColor) =>
              updateEditState((edits) => ({ ...edits, pointColor }))
            }
            onColorGradingChange={(colorGrading) =>
              updateEditState((edits) => ({ ...edits, colorGrading }))
            }
            onLensCorrectionsChange={(lensCorrections) =>
              updateEditState((edits) => ({ ...edits, lensCorrections }))
            }
            onLensBlurChange={(lensBlur) =>
              updateEditState((edits) => ({ ...edits, lensBlur }))
            }
            onCalibrationChange={(calibration) =>
              updateEditState((edits) => ({ ...edits, calibration }))
            }
            onGeometryChange={updateGeometry}
            onUprightModeChange={applyUprightMode}
            onUprightGuidesChange={applyGuidedUprightGuides}
            onCropChange={(crop) => updateEditState((edits) => ({ ...edits, crop }))}
            onCreateMask={createMask}
            onSelectMask={selectMask}
            onSelectMaskComponent={selectMaskComponent}
            onAddMaskComponent={addMaskComponent}
            onUpdateMask={updateMask}
            onUpdateMaskComponent={updateMaskComponent}
            onUpdateMaskAdjustments={updateMaskAdjustments}
            onDeleteMask={deleteMask}
            onDeleteMaskComponent={deleteMaskComponent}
            onDuplicateMask={duplicateMask}
            onRenameMask={renameMask}
            onAppendBrushStroke={appendBrushStroke}
            onOverlayModeChange={setMaskOverlayMode}
            onOverlayOpacityChange={setMaskOverlayOpacity}
            onRemoveHealSpot={removeHealSpot}
            onUpdateHealSpot={updateHealSpot}
            onRecenterHealSource={recenterHealSource}
            onActiveHealSpotChange={setActiveHealSpotId}
            onHealOverlayModeChange={setHealOverlayMode}
            onVisualizeSpotsChange={setVisualizeSpots}
            onVisualizeSpotsThresholdChange={setVisualizeSpotsThreshold}
            onResetHealSpots={resetHealSpots}
            onCloseHeal={() => {
              setVisualizeSpots(false);
              setTool("edit");
            }}
            onHealSettingsChange={setHealSettings}
            onMaskBrushSettingsChange={setMaskBrushSettings}
            onResetSection={resetSection}
            onPreviousSettings={applyPreviousSettings}
            onSyncSettings={openSyncSettingsDialog}
            syncCount={Math.max(0, selectedIds.size - (activeId && selectedIds.has(activeId) ? 1 : 0))}
            onMetadataChange={(patch) =>
              updatePhoto(
                activePhoto.id,
                (photo) => ({
                  ...photo,
                  metadata: { ...photo.metadata, ...patch },
                }),
                true,
              )
            }
            onKeywordsChange={(keywords) =>
              updatePhoto(
                activePhoto.id,
                (photo) => ({ ...photo, keywords }),
                true,
              )
            }
            onColorLabelChange={(colorLabel) =>
              updatePhoto(
                activePhoto.id,
                (photo) => ({ ...photo, colorLabel }),
                true,
              )
            }
          />
        ) : null}
      </div>

      {photos.length ? (
        <Filmstrip
          photos={filteredPhotos}
          activeId={activeId}
          selectedIds={selectedIds}
          onActivate={selectPhoto}
        />
      ) : null}

      {loading ? (
        <div className="blocking-status">
          <span className="spinner" />
          <strong>Opening local catalog…</strong>
        </div>
      ) : null}

      {importing ? (
        <div className="import-progress" role="status">
          <div>
            <span className="spinner" />
            <strong>Importing {importProgress?.fileName ?? "photos"}</strong>
          </div>
          <span>
            {importProgress?.completed ?? 0} / {importProgress?.total ?? 0}
          </span>
          <progress
            max={importProgress?.total ?? 1}
            value={importProgress?.completed ?? 0}
          />
        </div>
      ) : null}

      {importFailures.length ? (
        <Modal
          title="Some files were not imported"
          description="The originals were left untouched."
          onClose={() => setImportFailures([])}
          footer={
            <button
              type="button"
              className="button button--primary"
              onClick={() => setImportFailures([])}
            >
              Done
            </button>
          }
        >
          <div className="import-failures">
            {importFailures.map((failure) => (
              <div key={`${failure.name}-${failure.reason}`}>
                <X size={14} />
                <span>
                  <strong>{failure.name}</strong>
                  <small>{failure.reason}</small>
                </span>
              </div>
            ))}
          </div>
        </Modal>
      ) : null}

      {showCatalogBackup ? (
        <Modal
          title="Catalog backup"
          description="Protect your ratings, metadata, albums, masks, and edit recipes."
          onClose={() => setShowCatalogBackup(false)}
          footer={
            <button
              type="button"
              className="button button--quiet"
              onClick={() => setShowCatalogBackup(false)}
            >
              Done
            </button>
          }
        >
          <div className="catalog-backup-panel">
            <div className="catalog-storage-status">
              <DatabaseBackup size={20} aria-hidden="true" />
              <div>
                <strong>
                  {persistentStorage
                    ? "Persistent browser storage granted"
                    : "Browser-profile storage"}
                </strong>
                <p>
                  {persistentStorage
                    ? "The browser has agreed not to evict this catalog automatically, though clearing site data still removes it."
                    : "The browser may evict this origin-scoped catalog under storage pressure. Keep a current backup."}
                </p>
              </div>
            </div>
            <div className="catalog-backup-actions">
              <button
                type="button"
                className="button button--primary"
                disabled={catalogBusy}
                onClick={() => void downloadCatalogBackup()}
              >
                <Download size={15} />
                {catalogBusy ? "Working…" : "Download catalog backup"}
              </button>
              <button
                type="button"
                className="button button--quiet"
                disabled={catalogBusy}
                onClick={() => catalogInputRef.current?.click()}
              >
                <Import size={15} />
                Restore from backup
              </button>
            </div>
            <p className="catalog-backup-note">
              Backups are JSON and intentionally exclude image pixels. Restore
              applies edits only to matching photos already imported in this
              browser. Precise GPS coordinates are omitted. Selected source
              files are never moved or modified.
            </p>
          </div>
        </Modal>
      ) : null}

      {showExport && activePhoto ? (
        <Suspense fallback={null}>
          <ExportDialog
            photo={activePhoto}
            settings={exportSettings}
            exporting={exporting}
            selectionCount={exportTargets.length}
            progress={exportProgress}
            onChange={setExportSettings}
            onClose={closeOrCancelExport}
            onExport={() => void handleExport()}
          />
        </Suspense>
      ) : null}
      {showCopySettings ? (
        <SyncSettingsDialog
          title="Copy Settings"
          instruction="Select the Develop settings to copy from the active photograph."
          confirmLabel="Copy"
          selection={syncSettingsSelection}
          onSelectionChange={setSyncSettingsSelection}
          onCancel={() => setShowCopySettings(false)}
          onSynchronize={confirmCopyDevelopSettings}
        />
      ) : null}
      {showSyncSettings ? (
        <SyncSettingsDialog
          selection={syncSettingsSelection}
          targetCount={Math.max(0, selectedIds.size - (activeId && selectedIds.has(activeId) ? 1 : 0))}
          onSelectionChange={setSyncSettingsSelection}
          onCancel={() => setShowSyncSettings(false)}
          onSynchronize={synchronizeSelectedSettings}
        />
      ) : null}
      {pendingImportFiles.length ? (
        <Suspense fallback={null}>
          <ImportDialog
            files={pendingImportFiles}
            photos={photos}
            collections={collections}
            importing={importing}
            onClose={() => {
              setPendingImportFiles([]);
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
            onImport={(files, options) =>
              void handleImport(files, options)
            }
          />
        </Suspense>
      ) : null}
      {showShortcuts ? (
        <Suspense fallback={null}>
          <ShortcutsDialog
            enabled={singleKeyShortcuts}
            onEnabledChange={setSingleKeyShortcuts}
            onClose={() => setShowShortcuts(false)}
          />
        </Suspense>
      ) : null}

      {showGitHubStarReminder ? (
        <aside className="repo-star-card" aria-label="Support Darkroom on GitHub">
          <div className="repo-star-card__intro">
            <div className="repo-star-card__icon" aria-hidden="true">
              <Star size={16} fill="currentColor" />
            </div>
            <div>
              <strong>Enjoying Darkroom?</strong>
              <p>A GitHub star helps other photographers find the project.</p>
            </div>
          </div>
          <a
            className="repo-star-card__link"
            href={GITHUB_REPO_URL}
            target="_blank"
            rel="noreferrer"
            onClick={dismissGitHubStarReminder}
          >
            <span>Star Darkroom on GitHub</span>
            <ArrowUpRight size={14} aria-hidden="true" />
          </a>
          <small>This card disappears when you star the repo.</small>
        </aside>
      ) : null}

      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.tone}`}>
            {toast.tone === "success" ? (
              <Check size={14} />
            ) : toast.tone === "error" ? (
              <X size={14} />
            ) : (
              <SlidersHorizontal size={14} />
            )}
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
