import {
  Eye,
  EyeOff,
  Grid2X2,
  Maximize,
  Minus,
  Plus,
  Scan,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ImageEngine, type RenderOptions } from "../lib/imageEngine";
import { getMaskComponents } from "../lib/maskMath";
import { renderBlobForPhoto } from "../lib/rawImage";
import type {
  BrushPoint,
  BrushStroke,
  CropOverlay,
  CropState,
  EditState,
  HealSpot,
  HistogramData,
  MaskComponent,
  PhotoRecord,
  UprightGuide,
} from "../types";
import type {
  EditorTool,
  HealOverlayMode,
  HealToolSettings,
  MaskBrushSettings,
} from "./RightInspector";
import { IconButton } from "./ui";

type Props = {
  photo: PhotoRecord;
  tool: EditorTool;
  cropOverlay: CropOverlay;
  activeMaskId: string | null;
  activeMaskComponentId: string | null;
  showOriginal: boolean;
  showMaskOverlay: boolean;
  maskOverlayMode:
    | "color"
    | "color-on-black"
    | "color-on-white"
    | "white-on-black"
    | "black-on-white";
  maskOverlayOpacity: number;
  showClipping: boolean;
  guidedUprightActive: boolean;
  uprightGuides: UprightGuide[];
  healSettings: HealToolSettings;
  activeHealSpotId: string | null;
  healOverlayMode: HealOverlayMode;
  visualizeSpots: boolean;
  visualizeSpotsThreshold: number;
  maskBrushSettings: MaskBrushSettings;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  onHistogram: (histogram: HistogramData) => void;
  onEngineReady: (engine: ImageEngine | null) => void;
  onToggleOriginal: () => void;
  onToggleMaskOverlay: () => void;
  onBeginEdit: () => void;
  onCommitEdit: () => void;
  onAppendBrushStroke: (maskId: string, stroke: BrushStroke) => void;
  onUpdateMaskComponent: (
    maskId: string,
    componentId: string,
    patch: Partial<MaskComponent>,
  ) => void;
  onAddHealSpot: (spot: Omit<HealSpot, "id">) => void;
  onUpdateHealSpot: (id: string, patch: Partial<HealSpot>) => void;
  onRemoveHealSpot: (id: string) => void;
  onSelectHealSpot: (id: string | null) => void;
  onAddUprightGuide: (guide: UprightGuide) => void;
  onCropChange: (crop: CropState) => void;
  onError: (message: string) => void;
};

type LinearMaskGeometry = NonNullable<MaskComponent["linear"]>;
type RadialMaskGeometry = NonNullable<MaskComponent["radial"]>;

type DraftGesture =
  | {
      type: "brush";
      maskId: string;
      componentId: string;
      points: BrushPoint[];
      erase: boolean;
    }
  | {
      type: "heal";
      points: BrushPoint[];
    }
  | {
      type: "upright-guide";
      start: { x: number; y: number };
      current: { x: number; y: number };
    }
  | {
      type: "linear";
      maskId: string;
      componentId: string;
      start: { x: number; y: number };
      current: { x: number; y: number };
    }
  | {
      type: "radial";
      maskId: string;
      componentId: string;
      start: { x: number; y: number };
      current: { x: number; y: number };
    }
  | {
      type: "object";
      maskId: string;
      componentId: string;
      start: { x: number; y: number };
      current: { x: number; y: number };
    }
  | {
      type: "linear-control";
      action: "start" | "end" | "feather";
      maskId: string;
      componentId: string;
      pointerStart: { x: number; y: number };
      linear: LinearMaskGeometry;
      started: boolean;
    }
  | {
      type: "radial-control";
      action: "center" | "resize-x" | "resize-y" | "resize-both" | "rotate" | "feather";
      maskId: string;
      componentId: string;
      pointerStart: { x: number; y: number };
      radial: RadialMaskGeometry;
      started: boolean;
    }
  | {
      type: "crop";
      action: "move" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
      start: { x: number; y: number };
      crop: CropState;
    }
  | {
      type: "pan";
      start: { x: number; y: number };
      origin: { x: number; y: number };
    }
  | { type: "heal-source"; spotId: string };

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

const HISTOGRAM_SETTLE_MS = 100;

type PreviewRenderSnapshot = {
  photoId: string;
  state: EditState;
  options: RenderOptions;
};

type PendingMaskUpdate = {
  maskId: string;
  componentId: string;
  patch: Partial<MaskComponent>;
};

const previewMappingSignature = ({
  photoId,
  state,
  options,
}: PreviewRenderSnapshot) => {
  const crop = state.crop;
  const geometry = state.geometry;
  return [
    photoId,
    options.cropPreview ? 1 : 0,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    crop.angle,
    geometry.rotate,
    geometry.vertical,
    geometry.horizontal,
    geometry.aspect,
    geometry.scale,
    geometry.offsetX,
    geometry.offsetY,
    geometry.flipX ? 1 : 0,
    geometry.flipY ? 1 : 0,
    geometry.constrainCrop ? 1 : 0,
  ].join("|");
};

function pointerDistance(a: BrushPoint, b: BrushPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export type CropAction = Extract<DraftGesture, { type: "crop" }>["action"];

export type CropOverlayPoint = { x: number; y: number };
export type CropOverlayCorners = readonly [
  CropOverlayPoint,
  CropOverlayPoint,
  CropOverlayPoint,
  CropOverlayPoint,
];
export type CropOverlayLine = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

const overlayPoint = (
  corners: CropOverlayCorners,
  u: number,
  v: number,
): CropOverlayPoint => {
  const [northWest, northEast, southEast, southWest] = corners;
  const top = {
    x: northWest.x + (northEast.x - northWest.x) * u,
    y: northWest.y + (northEast.y - northWest.y) * u,
  };
  const bottom = {
    x: southWest.x + (southEast.x - southWest.x) * u,
    y: southWest.y + (southEast.y - southWest.y) * u,
  };
  return {
    x: top.x + (bottom.x - top.x) * v,
    y: top.y + (bottom.y - top.y) * v,
  };
};

const overlayLine = (
  corners: CropOverlayCorners,
  u1: number,
  v1: number,
  u2: number,
  v2: number,
): CropOverlayLine => {
  const start = overlayPoint(corners, u1, v1);
  const end = overlayPoint(corners, u2, v2);
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
};

const averageEdgeLength = (
  firstStart: CropOverlayPoint,
  firstEnd: CropOverlayPoint,
  secondStart: CropOverlayPoint,
  secondEnd: CropOverlayPoint,
) =>
  (Math.hypot(firstEnd.x - firstStart.x, firstEnd.y - firstStart.y) +
    Math.hypot(secondEnd.x - secondStart.x, secondEnd.y - secondStart.y)) /
  2;

export function cropOverlayLines(
  overlay: CropOverlay,
  corners: CropOverlayCorners,
): CropOverlayLine[] {
  const [northWest, northEast, southEast, southWest] = corners;
  const width = averageEdgeLength(northWest, northEast, southWest, southEast);
  const height = averageEdgeLength(northWest, southWest, northEast, southEast);

  if (overlay === "diagonal") {
    if (width <= 0 || height <= 0) return [];
    if (Math.abs(width - height) / Math.max(width, height) < 0.001) {
      return [
        overlayLine(corners, 0, 0, 1, 1),
        overlayLine(corners, 1, 0, 0, 1),
      ];
    }
    if (width > height) {
      const inset = height / width;
      return [
        overlayLine(corners, 0, 0, inset, 1),
        overlayLine(corners, 0, 1, inset, 0),
        overlayLine(corners, 1, 0, 1 - inset, 1),
        overlayLine(corners, 1, 1, 1 - inset, 0),
      ];
    }
    const inset = width / height;
    return [
      overlayLine(corners, 0, 0, 1, inset),
      overlayLine(corners, 1, 0, 0, inset),
      overlayLine(corners, 0, 1, 1, 1 - inset),
      overlayLine(corners, 1, 1, 0, 1 - inset),
    ];
  }

  let verticalGuides: number[];
  let horizontalGuides: number[];
  if (overlay === "grid") {
    const longestSideDivisions = 8;
    const xDivisions =
      width >= height
        ? longestSideDivisions
        : Math.max(2, Math.round((longestSideDivisions * width) / Math.max(1, height)));
    const yDivisions =
      height >= width
        ? longestSideDivisions
        : Math.max(2, Math.round((longestSideDivisions * height) / Math.max(1, width)));
    verticalGuides = Array.from(
      { length: xDivisions - 1 },
      (_, index) => (index + 1) / xDivisions,
    );
    horizontalGuides = Array.from(
      { length: yDivisions - 1 },
      (_, index) => (index + 1) / yDivisions,
    );
  } else if (overlay === "golden-ratio") {
    const goldenSection = (3 - Math.sqrt(5)) / 2;
    verticalGuides = [goldenSection, 1 - goldenSection];
    horizontalGuides = [goldenSection, 1 - goldenSection];
  } else {
    verticalGuides = [1 / 3, 2 / 3];
    horizontalGuides = [1 / 3, 2 / 3];
  }

  return [
    ...verticalGuides.map((amount) =>
      overlayLine(corners, amount, 0, amount, 1),
    ),
    ...horizontalGuides.map((amount) =>
      overlayLine(corners, 0, amount, 1, amount),
    ),
  ];
}

export function cropFromDelta(
  crop: CropState,
  action: CropAction,
  dx: number,
  dy: number,
): CropState {
  let { x, y, width, height } = crop;
  const minimum = 0.05;

  if (action === "move") {
    x = clamp(crop.x + dx, 0, 1 - width);
    y = clamp(crop.y + dy, 0, 1 - height);
  } else {
    const ratio = crop.width / Math.max(minimum, crop.height);

    if (crop.locked && (action === "n" || action === "s")) {
      const bottom = crop.y + crop.height;
      const centerX = crop.x + crop.width / 2;
      const requestedHeight =
        action === "n" ? crop.height - dy : crop.height + dy;
      const maximumCenteredWidth = Math.max(
        minimum,
        2 * Math.min(centerX, 1 - centerX),
      );
      const maximumAxisHeight = action === "n" ? bottom : 1 - crop.y;
      const maximumHeight = Math.max(
        minimum,
        Math.min(maximumAxisHeight, maximumCenteredWidth / ratio),
      );
      const requiredMinimumHeight = Math.max(minimum, minimum / ratio);
      height = clamp(
        requestedHeight,
        Math.min(requiredMinimumHeight, maximumHeight),
        maximumHeight,
      );
      width = height * ratio;
      x = clamp(centerX - width / 2, 0, 1 - width);
      y = action === "n" ? bottom - height : crop.y;
      return { ...crop, x, y, width, height };
    }

    if (crop.locked && (action === "e" || action === "w")) {
      const right = crop.x + crop.width;
      const centerY = crop.y + crop.height / 2;
      const requestedWidth =
        action === "w" ? crop.width - dx : crop.width + dx;
      const maximumCenteredHeight = Math.max(
        minimum,
        2 * Math.min(centerY, 1 - centerY),
      );
      const maximumAxisWidth = action === "w" ? right : 1 - crop.x;
      const maximumWidth = Math.max(
        minimum,
        Math.min(maximumAxisWidth, maximumCenteredHeight * ratio),
      );
      const requiredMinimumWidth = Math.max(minimum, minimum * ratio);
      width = clamp(
        requestedWidth,
        Math.min(requiredMinimumWidth, maximumWidth),
        maximumWidth,
      );
      height = width / ratio;
      x = action === "w" ? right - width : crop.x;
      y = clamp(centerY - height / 2, 0, 1 - height);
      return { ...crop, x, y, width, height };
    }

    if (action.includes("w")) {
      const right = crop.x + crop.width;
      x = clamp(crop.x + dx, 0, right - minimum);
      width = right - x;
    }
    if (action.includes("e")) {
      width = clamp(crop.width + dx, minimum, 1 - crop.x);
    }
    if (action.includes("n")) {
      const bottom = crop.y + crop.height;
      y = clamp(crop.y + dy, 0, bottom - minimum);
      height = bottom - y;
    }
    if (action.includes("s")) {
      height = clamp(crop.height + dy, minimum, 1 - crop.y);
    }
    if (crop.locked) {
      if (width / Math.max(minimum, height) > ratio) {
        width = height * ratio;
      } else {
        height = width / ratio;
      }
      width = Math.min(width, 1);
      height = Math.min(height, 1);
      if (action.includes("w")) x = crop.x + crop.width - width;
      if (action.includes("n")) y = crop.y + crop.height - height;
      x = clamp(x, 0, 1 - width);
      y = clamp(y, 0, 1 - height);
    }
  }

  return { ...crop, x, y, width, height };
}

export default function DevelopWorkspace(props: Props) {
  const {
    photo,
    tool,
    activeMaskId,
    activeMaskComponentId,
    showOriginal,
    showMaskOverlay,
    maskOverlayMode,
    maskOverlayOpacity,
    showClipping,
    zoom,
  } = props;
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<ImageEngine | null>(null);
  const loadTokenRef = useRef(0);
  const [loaded, setLoaded] = useState(false);
  const [rendering, setRendering] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bounds, setBounds] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const [, setMappingRevision] = useState(0);
  const [gesture, setGesture] = useState<DraftGesture | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spacePressed, setSpacePressed] = useState(false);
  const [healStageHovered, setHealStageHovered] = useState(false);
  const [pointerPreview, setPointerPreview] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const loadedRef = useRef(false);
  const loadedPhotoIdRef = useRef<string | null>(null);
  const gestureRef = useRef<DraftGesture | null>(null);
  const pointerPreviewRef = useRef<{ x: number; y: number } | null>(null);
  const panRef = useRef(pan);
  const boundsRef = useRef(bounds);
  const renderSnapshotRef = useRef<PreviewRenderSnapshot | null>(null);
  const previewRevisionRef = useRef(0);
  const renderedMappingSignatureRef = useRef<string | null>(null);
  const renderFrameRef = useRef<number | null>(null);
  const histogramTimerRef = useRef<number | null>(null);
  const loadReadyFrameRef = useRef<number | null>(null);
  const gestureFrameRef = useRef<number | null>(null);
  const pendingGestureRef = useRef<DraftGesture | null>(null);
  const pointerPreviewFrameRef = useRef<number | null>(null);
  const pendingPointerPreviewRef = useRef<{
    x: number;
    y: number;
  } | null>(null);
  const panFrameRef = useRef<number | null>(null);
  const pendingPanRef = useRef<{ x: number; y: number } | null>(null);
  const maskUpdateFrameRef = useRef<number | null>(null);
  const pendingMaskUpdateRef = useRef<PendingMaskUpdate | null>(null);
  const healUpdateFrameRef = useRef<number | null>(null);
  const pendingHealUpdateRef = useRef<{
    id: string;
    patch: Partial<HealSpot>;
  } | null>(null);
  const cropUpdateFrameRef = useRef<number | null>(null);
  const pendingCropUpdateRef = useRef<CropState | null>(null);
  const renderRef = useRef<() => void>(() => {});

  const activeMaskGroup = useMemo(
    () => photo.edits.masks.find((mask) => mask.id === activeMaskId) ?? null,
    [activeMaskId, photo.edits.masks],
  );
  const activeMaskComponents = useMemo(
    () => (activeMaskGroup ? getMaskComponents(activeMaskGroup) : []),
    [activeMaskGroup],
  );
  const activeMask = activeMaskGroup
    ? activeMaskComponents.find(
        (component) => component.id === activeMaskComponentId,
      ) ?? activeMaskComponents[0] ?? null
    : null;

  const setDraftGesture = (next: DraftGesture | null) => {
    if (gestureFrameRef.current !== null) {
      cancelAnimationFrame(gestureFrameRef.current);
      gestureFrameRef.current = null;
    }
    pendingGestureRef.current = null;
    gestureRef.current = next;
    setGesture(next);
  };

  const queueDraftGesture = (next: DraftGesture) => {
    gestureRef.current = next;
    pendingGestureRef.current = next;
    if (gestureFrameRef.current !== null) return;
    gestureFrameRef.current = requestAnimationFrame(() => {
      gestureFrameRef.current = null;
      const pending = pendingGestureRef.current;
      pendingGestureRef.current = null;
      if (pending && gestureRef.current === pending) setGesture(pending);
    });
  };

  const setPointerPreviewNow = (next: { x: number; y: number } | null) => {
    if (pointerPreviewFrameRef.current !== null) {
      cancelAnimationFrame(pointerPreviewFrameRef.current);
      pointerPreviewFrameRef.current = null;
    }
    pendingPointerPreviewRef.current = null;
    pointerPreviewRef.current = next;
    setPointerPreview(next);
  };

  const queuePointerPreview = (next: { x: number; y: number } | null) => {
    pointerPreviewRef.current = next;
    pendingPointerPreviewRef.current = next;
    if (pointerPreviewFrameRef.current !== null) return;
    pointerPreviewFrameRef.current = requestAnimationFrame(() => {
      pointerPreviewFrameRef.current = null;
      const pending = pendingPointerPreviewRef.current;
      pendingPointerPreviewRef.current = null;
      setPointerPreview(pending);
    });
  };

  const setPanNow = (next: { x: number; y: number }) => {
    if (panFrameRef.current !== null) {
      cancelAnimationFrame(panFrameRef.current);
      panFrameRef.current = null;
    }
    pendingPanRef.current = null;
    panRef.current = next;
    setPan(next);
  };

  const queuePan = (next: { x: number; y: number }) => {
    panRef.current = next;
    pendingPanRef.current = next;
    if (panFrameRef.current !== null) return;
    panFrameRef.current = requestAnimationFrame(() => {
      panFrameRef.current = null;
      const pending = pendingPanRef.current;
      pendingPanRef.current = null;
      if (pending) setPan(pending);
    });
  };

  const flushMaskUpdate = () => {
    if (maskUpdateFrameRef.current !== null) {
      cancelAnimationFrame(maskUpdateFrameRef.current);
      maskUpdateFrameRef.current = null;
    }
    const pending = pendingMaskUpdateRef.current;
    pendingMaskUpdateRef.current = null;
    if (pending) {
      propsRef.current.onUpdateMaskComponent(
        pending.maskId,
        pending.componentId,
        pending.patch,
      );
    }
  };

  const queueMaskUpdate = (
    maskId: string,
    componentId: string,
    patch: Partial<MaskComponent>,
  ) => {
    pendingMaskUpdateRef.current = { maskId, componentId, patch };
    if (maskUpdateFrameRef.current !== null) return;
    maskUpdateFrameRef.current = requestAnimationFrame(() => {
      maskUpdateFrameRef.current = null;
      flushMaskUpdate();
    });
  };

  const flushHealUpdate = () => {
    if (healUpdateFrameRef.current !== null) {
      cancelAnimationFrame(healUpdateFrameRef.current);
      healUpdateFrameRef.current = null;
    }
    const pending = pendingHealUpdateRef.current;
    pendingHealUpdateRef.current = null;
    if (pending) {
      propsRef.current.onUpdateHealSpot(pending.id, pending.patch);
    }
  };

  const queueHealUpdate = (id: string, patch: Partial<HealSpot>) => {
    pendingHealUpdateRef.current = { id, patch };
    if (healUpdateFrameRef.current !== null) return;
    healUpdateFrameRef.current = requestAnimationFrame(() => {
      healUpdateFrameRef.current = null;
      flushHealUpdate();
    });
  };

  const flushCropUpdate = () => {
    if (cropUpdateFrameRef.current !== null) {
      cancelAnimationFrame(cropUpdateFrameRef.current);
      cropUpdateFrameRef.current = null;
    }
    const pending = pendingCropUpdateRef.current;
    pendingCropUpdateRef.current = null;
    if (pending) propsRef.current.onCropChange(pending);
  };

  const queueCropUpdate = (crop: CropState) => {
    pendingCropUpdateRef.current = crop;
    if (cropUpdateFrameRef.current !== null) return;
    cropUpdateFrameRef.current = requestAnimationFrame(() => {
      cropUpdateFrameRef.current = null;
      flushCropUpdate();
    });
  };

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code === "Space" && !event.repeat) setSpacePressed(true);
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpacePressed(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  useEffect(() => {
    if (zoom <= 1 && (panRef.current.x !== 0 || panRef.current.y !== 0)) {
      setPanNow({ x: 0, y: 0 });
    }
  }, [zoom]);

  useEffect(() => {
    if (tool !== "mask" || activeMask?.kind !== "brush") {
      if (pointerPreviewRef.current) setPointerPreviewNow(null);
    }
  }, [activeMask?.kind, tool]);

  const previewState = useMemo<EditState>(
    () =>
      tool === "crop"
        ? {
            ...photo.edits,
            crop: {
              ...photo.edits.crop,
              x: 0,
              y: 0,
              width: 1,
              height: 1,
            },
          }
        : photo.edits,
    [photo.edits, tool],
  );
  const previewOptions = useMemo<RenderOptions>(
    () => ({
      showOriginal,
      activeMaskId: activeMaskId ?? undefined,
      showMaskOverlay: tool === "mask" && showMaskOverlay,
      maskOverlayMode,
      maskOverlayOpacity,
      showClipping,
      visualizeSpots: tool === "heal" && props.visualizeSpots,
      visualizeSpotsThreshold: props.visualizeSpotsThreshold / 100,
      cropPreview: tool === "crop",
    }),
    [
      activeMaskId,
      maskOverlayMode,
      maskOverlayOpacity,
      props.visualizeSpots,
      props.visualizeSpotsThreshold,
      showClipping,
      showMaskOverlay,
      showOriginal,
      tool,
    ],
  );
  renderSnapshotRef.current = {
    photoId: photo.id,
    state: previewState,
    options: previewOptions,
  };

  const renderNow = useCallback(() => {
    const engine = engineRef.current;
    const snapshot = renderSnapshotRef.current;
    if (
      !engine ||
      !loadedRef.current ||
      !snapshot ||
      loadedPhotoIdRef.current !== snapshot.photoId
    ) {
      return;
    }

    engine.render(snapshot.state, snapshot.options);
    const nextBounds = engine.getImageBounds();
    const previousBounds = boundsRef.current;
    const nextMappingSignature = previewMappingSignature(snapshot);
    const mappingChanged =
      renderedMappingSignatureRef.current !== nextMappingSignature;
    renderedMappingSignatureRef.current = nextMappingSignature;
    if (
      nextBounds.x !== previousBounds.x ||
      nextBounds.y !== previousBounds.y ||
      nextBounds.width !== previousBounds.width ||
      nextBounds.height !== previousBounds.height
    ) {
      boundsRef.current = nextBounds;
      setBounds(nextBounds);
    } else if (mappingChanged) {
      setMappingRevision((revision) => revision + 1);
    }

    // Reading a WebGL canvas forces the GPU to finish outstanding work. Waiting
    // for a short quiet period keeps sliders and drags fluid while preserving an
    // exact histogram for the final rendered state.
    if (histogramTimerRef.current !== null) {
      window.clearTimeout(histogramTimerRef.current);
    }
    const histogramRevision = previewRevisionRef.current;
    histogramTimerRef.current = window.setTimeout(() => {
      histogramTimerRef.current = null;
      const currentEngine = engineRef.current;
      const currentSnapshot = renderSnapshotRef.current;
      if (
        currentEngine !== engine ||
        !loadedRef.current ||
        !currentSnapshot ||
        previewRevisionRef.current !== histogramRevision ||
        loadedPhotoIdRef.current !== currentSnapshot.photoId
      ) {
        return;
      }
      const hasDisplayOverlay =
        Boolean(currentSnapshot.options.showMaskOverlay) ||
        Boolean(currentSnapshot.options.showClipping) ||
        Boolean(currentSnapshot.options.visualizeSpots);
      if (hasDisplayOverlay) {
        currentEngine.render(currentSnapshot.state, {
          ...currentSnapshot.options,
          showMaskOverlay: false,
          showClipping: false,
          visualizeSpots: false,
        });
      }
      const histogram = currentEngine.getHistogram();
      if (hasDisplayOverlay) {
        currentEngine.render(currentSnapshot.state, currentSnapshot.options);
      }
      propsRef.current.onHistogram(histogram);
    }, HISTOGRAM_SETTLE_MS);
  }, []);

  const scheduleRender = useCallback(() => {
    if (renderFrameRef.current !== null) return;
    renderFrameRef.current = requestAnimationFrame(() => {
      renderFrameRef.current = null;
      renderNow();
    });
  }, [renderNow]);
  renderRef.current = scheduleRender;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    let engine: ImageEngine;
    try {
      engine = new ImageEngine(canvas);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "The image renderer could not start.";
      setLoadError(message);
      setRendering(false);
      propsRef.current.onError(message);
      return;
    }
    engineRef.current = engine;
    propsRef.current.onEngineReady(engine);

    let resizeFrame: number | null = null;
    let pendingSize: { width: number; height: number } | null = null;
    let appliedWidth = -1;
    let appliedHeight = -1;
    const applyResize = () => {
      resizeFrame = null;
      const size = pendingSize;
      pendingSize = null;
      if (!size) return;
      if (size.width === appliedWidth && size.height === appliedHeight) return;
      appliedWidth = size.width;
      appliedHeight = size.height;
      engine.resize(size.width, size.height);
      renderRef.current();
    };
    const resize = () => {
      const rect = stage.getBoundingClientRect();
      pendingSize = {
        width: Math.max(1, Math.round(rect.width * 100) / 100),
        height: Math.max(1, Math.round(rect.height * 100) / 100),
      };
      if (resizeFrame === null) resizeFrame = requestAnimationFrame(applyResize);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    resize();

    return () => {
      observer.disconnect();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      if (renderFrameRef.current !== null) {
        cancelAnimationFrame(renderFrameRef.current);
        renderFrameRef.current = null;
      }
      for (const frameRef of [
        gestureFrameRef,
        pointerPreviewFrameRef,
        panFrameRef,
        maskUpdateFrameRef,
        healUpdateFrameRef,
        cropUpdateFrameRef,
      ]) {
        if (frameRef.current !== null) {
          cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
      }
      pendingGestureRef.current = null;
      pendingPointerPreviewRef.current = null;
      pendingPanRef.current = null;
      pendingMaskUpdateRef.current = null;
      pendingHealUpdateRef.current = null;
      pendingCropUpdateRef.current = null;
      if (histogramTimerRef.current !== null) {
        window.clearTimeout(histogramTimerRef.current);
        histogramTimerRef.current = null;
      }
      loadedRef.current = false;
      loadedPhotoIdRef.current = null;
      renderedMappingSignatureRef.current = null;
      propsRef.current.onEngineReady(null);
      engine.destroy();
      engineRef.current = null;
    };
    // Engine lifetime follows the canvas, not edit changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const token = ++loadTokenRef.current;
    loadedRef.current = false;
    loadedPhotoIdRef.current = null;
    renderedMappingSignatureRef.current = null;
    setLoaded(false);
    setRendering(true);
    setLoadError(null);
    if (histogramTimerRef.current !== null) {
      window.clearTimeout(histogramTimerRef.current);
      histogramTimerRef.current = null;
    }
    const renderBlob = renderBlobForPhoto(photo);
    void engine
      .load(renderBlob)
      .then(() => {
        if (token !== loadTokenRef.current) return;
        loadedRef.current = true;
        loadedPhotoIdRef.current = photo.id;
        setLoaded(true);
        scheduleRender();
        if (loadReadyFrameRef.current !== null) {
          cancelAnimationFrame(loadReadyFrameRef.current);
        }
        loadReadyFrameRef.current = requestAnimationFrame(() => {
          loadReadyFrameRef.current = null;
          setRendering(false);
        });
      })
      .catch((error) => {
        if (token !== loadTokenRef.current) return;
        loadedRef.current = false;
        loadedPhotoIdRef.current = null;
        engine.clear();
        const emptyBounds = { x: 0, y: 0, width: 0, height: 0 };
        boundsRef.current = emptyBounds;
        setBounds(emptyBounds);
        const message =
          error instanceof Error
            ? error.message
            : `Could not open ${propsRef.current.photo.name}.`;
        setLoadError(message);
        setRendering(false);
        propsRef.current.onError(message);
      });
    return () => {
      if (loadTokenRef.current === token) loadTokenRef.current += 1;
      if (loadReadyFrameRef.current !== null) {
        cancelAnimationFrame(loadReadyFrameRef.current);
        loadReadyFrameRef.current = null;
      }
    };
  }, [photo.id, photo.blob, photo.renderBlob, scheduleRender]);

  useLayoutEffect(() => {
    previewRevisionRef.current += 1;
    if (histogramTimerRef.current !== null) {
      window.clearTimeout(histogramTimerRef.current);
      histogramTimerRef.current = null;
    }
    if (!loaded) return;
    scheduleRender();
  }, [loaded, previewOptions, previewState, scheduleRender]);

  const imagePoint = (event: React.PointerEvent) =>
    engineRef.current?.clientToImage(event.clientX, event.clientY) ?? {
      x: 0,
      y: 0,
      inside: false,
    };

  const canvasPoint = (x: number, y: number) =>
    engineRef.current?.imageToCanvas(x, y) ?? { x: 0, y: 0, inside: false };

  const beginPointerGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button === 1 || spacePressed) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setDraftGesture({
        type: "pan",
        start: { x: event.clientX, y: event.clientY },
        origin: panRef.current,
      });
      return;
    }
    if (tool === "crop") return;
    const point = imagePoint(event);
    if (!point.inside) return;

    if (props.guidedUprightActive && tool === "edit") {
      if (props.uprightGuides.length >= 4) {
        props.onError("Guided Upright supports up to four guides. Remove one to draw another.");
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setDraftGesture({
        type: "upright-guide",
        start: { x: point.x, y: point.y },
        current: { x: point.x, y: point.y },
      });
      return;
    }

    if (tool === "heal") {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setDraftGesture({
        type: "heal",
        points: [{
          x: point.x,
          y: point.y,
          pressure: event.pointerType === "pen" ? event.pressure || 1 : 1,
        }],
      });
      return;
    }

    if (tool !== "mask" || !activeMask) return;
    if (!activeMaskGroup) return;
    if (activeMask.kind === "color") {
      const sample = engineRef.current?.sampleColorAt(point.x, point.y);
      if (!sample) return;
      props.onBeginEdit();
      props.onUpdateMaskComponent(activeMaskGroup.id, activeMask.id, {
        color: {
          r: sample.r,
          g: sample.g,
          b: sample.b,
          tolerance: activeMask.color?.tolerance ?? 28,
        },
      });
      props.onCommitEdit();
      return;
    }
    if (activeMask.kind === "luminance") {
      const sample = engineRef.current?.sampleColorAt(point.x, point.y);
      if (!sample) return;
      const center = sample.luminance * 100;
      props.onBeginEdit();
      props.onUpdateMaskComponent(activeMaskGroup.id, activeMask.id, {
        luminance: {
          min: Math.max(0, center - 12),
          max: Math.min(100, center + 12),
          smoothness: activeMask.luminance?.smoothness ?? 35,
        },
      });
      props.onCommitEdit();
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    if (activeMask.kind === "brush") {
      setPointerPreviewNow({ x: point.x, y: point.y });
      setDraftGesture({
        type: "brush",
        maskId: activeMaskGroup.id,
        componentId: activeMask.id,
        points: [{
          x: point.x,
          y: point.y,
          pressure: event.pointerType === "pen" ? event.pressure || 1 : 1,
        }],
        erase: event.altKey || props.maskBrushSettings.erase,
      });
    } else if (activeMask.kind === "linear") {
      setDraftGesture({
        type: "linear",
        maskId: activeMaskGroup.id,
        componentId: activeMask.id,
        start: { x: point.x, y: point.y },
        current: { x: point.x, y: point.y },
      });
    } else if (activeMask.kind === "radial") {
      setDraftGesture({
        type: "radial",
        maskId: activeMaskGroup.id,
        componentId: activeMask.id,
        start: { x: point.x, y: point.y },
        current: { x: point.x, y: point.y },
      });
    } else if (activeMask.kind === "object") {
      setDraftGesture({
        type: "object",
        maskId: activeMaskGroup.id,
        componentId: activeMask.id,
        start: { x: point.x, y: point.y },
        current: { x: point.x, y: point.y },
      });
    }
  };

  const movePointerGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = gestureRef.current;
    const hoveredPoint = imagePoint(event);
    if (
      tool === "mask" &&
      activeMask?.kind === "brush" &&
      hoveredPoint.inside &&
      current?.type !== "pan"
    ) {
      queuePointerPreview({ x: hoveredPoint.x, y: hoveredPoint.y });
    } else if (!current && pointerPreviewRef.current) {
      queuePointerPreview(null);
    }
    if (
      !current ||
      current.type === "crop" ||
      current.type === "heal-source" ||
      current.type === "linear-control" ||
      current.type === "radial-control"
    ) {
      return;
    }
    if (current.type === "pan") {
      queuePan({
        x: current.origin.x + event.clientX - current.start.x,
        y: current.origin.y + event.clientY - current.start.y,
      });
      return;
    }
    const point = hoveredPoint;
    if (!point.inside && (current.type === "brush" || current.type === "heal")) return;
    if (current.type === "brush" || current.type === "heal") {
      const coalescedEvents = event.nativeEvent.getCoalescedEvents?.();
      const nativeEvents = coalescedEvents?.length
        ? coalescedEvents
        : [event.nativeEvent];
      const points = [...current.points];
      for (const nativeEvent of nativeEvents) {
        const mapped =
          engineRef.current?.clientToImage(
            nativeEvent.clientX,
            nativeEvent.clientY,
          ) ?? point;
        if (!mapped.inside) continue;
        const nextPoint = {
          x: mapped.x,
          y: mapped.y,
          pressure:
            nativeEvent.pointerType === "pen"
              ? nativeEvent.pressure || 1
              : 1,
        };
        const last = points[points.length - 1];
        if (pointerDistance(last, nextPoint) >= 0.0015) {
          points.push(nextPoint);
        }
      }
      if (points.length === current.points.length) return;
      queueDraftGesture({ ...current, points });
    } else {
      queueDraftGesture({
        ...current,
        current: { x: point.x, y: point.y },
      });
    }
  };

  const endPointerGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = gestureRef.current;
    if (
      !current ||
      current.type === "crop" ||
      current.type === "heal-source" ||
      current.type === "linear-control" ||
      current.type === "radial-control"
    ) {
      return;
    }
    setDraftGesture(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (current.type === "pan") return;
    if (current.type === "upright-guide") {
      const dx = current.current.x - current.start.x;
      const dy = current.current.y - current.start.y;
      const aspectRatio = Math.max(1, photo.width) / Math.max(1, photo.height);
      if (Math.hypot(dx * aspectRatio, dy) < 0.04) {
        props.onError("Draw a longer line along an edge that should be straight.");
        return;
      }
      props.onAddUprightGuide({
        orientation:
          Math.abs(dx * photo.width) >= Math.abs(dy * photo.height)
            ? "horizontal"
            : "vertical",
        start: current.start,
        end: current.current,
      });
    } else if (current.type === "heal" && current.points.length) {
      const destination = current.points[0];
      const suggestedSource = engineRef.current?.suggestHealSource(
        destination,
        props.healSettings.size,
        0,
      );
      props.onAddHealSpot({
        mode: props.healSettings.mode,
        destination: { x: destination.x, y: destination.y },
        source: suggestedSource ?? {
          x: clamp(destination.x + 0.07),
          y: clamp(destination.y + 0.045),
        },
        size: props.healSettings.size,
        feather: props.healSettings.feather,
        opacity: props.healSettings.opacity,
        path: current.points,
      });
    } else if (current.type === "brush" && current.points.length) {
      props.onAppendBrushStroke(current.maskId, {
        points: current.points,
        size: props.maskBrushSettings.size,
        feather: props.maskBrushSettings.feather,
        flow: props.maskBrushSettings.flow,
        density: props.maskBrushSettings.density,
        autoMask: props.maskBrushSettings.autoMask,
        erase: current.erase,
      });
    } else if (current.type === "linear") {
      if (
        Math.hypot(
          current.current.x - current.start.x,
          current.current.y - current.start.y,
        ) < 0.005
      ) {
        return;
      }
      props.onBeginEdit();
      props.onUpdateMaskComponent(current.maskId, current.componentId, {
        linear: {
          x1: current.start.x,
          y1: current.start.y,
          x2: current.current.x,
          y2: current.current.y,
        },
      });
      props.onCommitEdit();
    } else if (current.type === "radial") {
      if (
        Math.hypot(
          current.current.x - current.start.x,
          current.current.y - current.start.y,
        ) < 0.005
      ) {
        return;
      }
      props.onBeginEdit();
      props.onUpdateMaskComponent(current.maskId, current.componentId, {
        radial: {
          cx: current.start.x,
          cy: current.start.y,
          rx: Math.max(0.02, Math.abs(current.current.x - current.start.x)),
          ry: Math.max(0.02, Math.abs(current.current.y - current.start.y)),
          rotation: 0,
          feather: 55,
        },
      });
      props.onCommitEdit();
    } else if (current.type === "object") {
      const x = Math.min(current.start.x, current.current.x);
      const y = Math.min(current.start.y, current.current.y);
      const width = Math.abs(current.current.x - current.start.x);
      const height = Math.abs(current.current.y - current.start.y);
      const object =
        width < 0.01 || height < 0.01
          ? {
              x: clamp(current.start.x - 0.18, 0, 0.64),
              y: clamp(current.start.y - 0.18, 0, 0.64),
              width: 0.36,
              height: 0.36,
            }
          : {
              x: clamp(x),
              y: clamp(y),
              width: Math.max(0.01, Math.min(width, 1 - x)),
              height: Math.max(0.01, Math.min(height, 1 - y)),
            };
      props.onBeginEdit();
      props.onUpdateMaskComponent(current.maskId, current.componentId, {
        object,
      });
      props.onCommitEdit();
    }
  };

  const beginLinearControlGesture = (
    event: React.PointerEvent<SVGElement>,
    action: Extract<DraftGesture, { type: "linear-control" }>["action"],
  ) => {
    if (!activeMaskGroup || activeMask?.kind !== "linear" || !activeMask.linear) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const point = imagePoint(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraftGesture({
      type: "linear-control",
      action,
      maskId: activeMaskGroup.id,
      componentId: activeMask.id,
      pointerStart: { x: point.x, y: point.y },
      linear: { ...activeMask.linear },
      started: false,
    });
  };

  const beginRadialControlGesture = (
    event: React.PointerEvent<SVGElement>,
    action: Extract<DraftGesture, { type: "radial-control" }>["action"],
  ) => {
    if (!activeMaskGroup || activeMask?.kind !== "radial" || !activeMask.radial) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const point = imagePoint(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraftGesture({
      type: "radial-control",
      action,
      maskId: activeMaskGroup.id,
      componentId: activeMask.id,
      pointerStart: { x: point.x, y: point.y },
      radial: { ...activeMask.radial },
      started: false,
    });
  };

  const moveMaskControlGesture = (event: React.PointerEvent<SVGElement>) => {
    const current = gestureRef.current;
    if (
      !current ||
      (current.type !== "linear-control" && current.type !== "radial-control")
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const point = imagePoint(event);
    if (!current.started) props.onBeginEdit();

    if (current.type === "linear-control") {
      const linear = { ...current.linear };
      if (current.action === "start") {
        linear.x1 = point.x;
        linear.y1 = point.y;
      } else if (current.action === "end") {
        linear.x2 = point.x;
        linear.y2 = point.y;
      } else {
        const requestedX = point.x - current.pointerStart.x;
        const requestedY = point.y - current.pointerStart.y;
        const dx = clamp(
          requestedX,
          -Math.min(current.linear.x1, current.linear.x2),
          1 - Math.max(current.linear.x1, current.linear.x2),
        );
        const dy = clamp(
          requestedY,
          -Math.min(current.linear.y1, current.linear.y2),
          1 - Math.max(current.linear.y1, current.linear.y2),
        );
        linear.x1 += dx;
        linear.y1 += dy;
        linear.x2 += dx;
        linear.y2 += dy;
      }
      queueMaskUpdate(current.maskId, current.componentId, {
        linear,
      });
    } else {
      const radial = { ...current.radial };
      const angle = (current.radial.rotation * Math.PI) / 180;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      const pointX = point.x - current.radial.cx;
      const pointY = point.y - current.radial.cy;
      const localX = cosine * pointX + sine * pointY;
      const localY = -sine * pointX + cosine * pointY;

      if (current.action === "center") {
        radial.cx = clamp(
          current.radial.cx + point.x - current.pointerStart.x,
        );
        radial.cy = clamp(
          current.radial.cy + point.y - current.pointerStart.y,
        );
      } else if (current.action === "resize-x") {
        radial.rx = clamp(Math.abs(localX), 0.005, 1.5);
      } else if (current.action === "resize-y") {
        radial.ry = clamp(Math.abs(localY), 0.005, 1.5);
      } else if (current.action === "resize-both") {
        const diagonalScale = Math.SQRT1_2;
        radial.rx = clamp(
          Math.abs(localX) / diagonalScale,
          0.005,
          1.5,
        );
        radial.ry = clamp(
          Math.abs(localY) / diagonalScale,
          0.005,
          1.5,
        );
      } else if (current.action === "rotate") {
        radial.rotation =
          (((Math.atan2(pointY, pointX) * 180) / Math.PI + 90 + 180) %
            360) -
          180;
      } else {
        const radius = Math.hypot(
          localX / Math.max(0.005, current.radial.rx),
          localY / Math.max(0.005, current.radial.ry),
        );
        radial.feather = clamp((1 - radius) * 100, 0, 100);
      }
      queueMaskUpdate(current.maskId, current.componentId, {
        radial,
      });
    }

    queueDraftGesture({ ...current, started: true });
  };

  const endMaskControlGesture = (event: React.PointerEvent<SVGElement>) => {
    const current = gestureRef.current;
    if (
      !current ||
      (current.type !== "linear-control" && current.type !== "radial-control")
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setDraftGesture(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (current.started) {
      flushMaskUpdate();
      props.onCommitEdit();
    }
  };

  const keyboardMoveLinearGradient = (
    event: React.KeyboardEvent<SVGCircleElement>,
  ) => {
    if (
      !activeMaskGroup ||
      activeMask?.kind !== "linear" ||
      !activeMask.linear ||
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 0.02 : 0.005;
    const requestedX =
      event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const requestedY =
      event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    const dx = clamp(
      requestedX,
      -Math.min(activeMask.linear.x1, activeMask.linear.x2),
      1 - Math.max(activeMask.linear.x1, activeMask.linear.x2),
    );
    const dy = clamp(
      requestedY,
      -Math.min(activeMask.linear.y1, activeMask.linear.y2),
      1 - Math.max(activeMask.linear.y1, activeMask.linear.y2),
    );
    props.onBeginEdit();
    props.onUpdateMaskComponent(activeMaskGroup.id, activeMask.id, {
      linear: {
        x1: activeMask.linear.x1 + dx,
        y1: activeMask.linear.y1 + dy,
        x2: activeMask.linear.x2 + dx,
        y2: activeMask.linear.y2 + dy,
      },
    });
    props.onCommitEdit();
  };

  const keyboardMoveRadialGradient = (
    event: React.KeyboardEvent<SVGCircleElement>,
  ) => {
    if (
      !activeMaskGroup ||
      activeMask?.kind !== "radial" ||
      !activeMask.radial ||
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 0.02 : 0.005;
    const dx =
      event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const dy =
      event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    props.onBeginEdit();
    props.onUpdateMaskComponent(activeMaskGroup.id, activeMask.id, {
      radial: {
        ...activeMask.radial,
        cx: clamp(activeMask.radial.cx + dx),
        cy: clamp(activeMask.radial.cy + dy),
      },
    });
    props.onCommitEdit();
  };

  const beginHealSourceGesture = (
    event: React.PointerEvent<HTMLElement>,
    spotId: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    props.onBeginEdit();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraftGesture({ type: "heal-source", spotId });
  };

  const moveHealSourceGesture = (event: React.PointerEvent<HTMLElement>) => {
    const current = gestureRef.current;
    if (!current || current.type !== "heal-source") return;
    const point = imagePoint(event);
    queueHealUpdate(current.spotId, {
      source: { x: clamp(point.x), y: clamp(point.y) },
    });
  };

  const endHealSourceGesture = (event: React.PointerEvent<HTMLElement>) => {
    const current = gestureRef.current;
    if (!current || current.type !== "heal-source") return;
    setDraftGesture(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    flushHealUpdate();
    props.onCommitEdit();
  };

  const beginCropGesture = (
    event: React.PointerEvent<Element>,
    action: Extract<DraftGesture, { type: "crop" }>["action"],
  ) => {
    event.stopPropagation();
    const point = imagePoint(event);
    props.onBeginEdit();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraftGesture({
      type: "crop",
      action,
      start: { x: point.x, y: point.y },
      crop: { ...photo.edits.crop },
    });
  };

  const moveCropGesture = (event: React.PointerEvent<Element>) => {
    const current = gestureRef.current;
    if (!current || current.type !== "crop") return;
    const point = imagePoint(event);
    const dx = point.x - current.start.x;
    const dy = point.y - current.start.y;
    queueCropUpdate(cropFromDelta(current.crop, current.action, dx, dy));
  };

  const endCropGesture = (event: React.PointerEvent<Element>) => {
    const current = gestureRef.current;
    if (!current || current.type !== "crop") return;
    setDraftGesture(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    flushCropUpdate();
    props.onCommitEdit();
  };

  const keyboardCrop = (
    event: React.KeyboardEvent<Element>,
    action: CropAction,
  ) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 0.02 : 0.005;
    const dx =
      event.key === "ArrowLeft"
        ? -step
        : event.key === "ArrowRight"
          ? step
          : 0;
    const dy =
      event.key === "ArrowUp"
        ? -step
        : event.key === "ArrowDown"
          ? step
          : 0;
    props.onBeginEdit();
    props.onCropChange(cropFromDelta(photo.edits.crop, action, dx, dy));
    props.onCommitEdit();
  };

  const crop = photo.edits.crop;
  const cropCorners = bounds.width
    ? ([
        canvasPoint(crop.x, crop.y),
        canvasPoint(crop.x + crop.width, crop.y),
        canvasPoint(crop.x + crop.width, crop.y + crop.height),
        canvasPoint(crop.x, crop.y + crop.height),
      ] as CropOverlayCorners)
    : null;
  const cropGuideLines = cropCorners
    ? cropOverlayLines(props.cropOverlay, cropCorners)
    : [];
  const cropCanvasWidth = canvasRef.current?.clientWidth ?? 0;
  const cropCanvasHeight = canvasRef.current?.clientHeight ?? 0;
  const cropPoints = cropCorners
    ?.map((point) => `${point.x},${point.y}`)
    .join(" ");
  const cropShadePath =
    cropCorners && cropCanvasWidth && cropCanvasHeight
      ? `M0 0H${cropCanvasWidth}V${cropCanvasHeight}H0Z M${cropCorners
          .map((point) => `${point.x} ${point.y}`)
          .join("L")}Z`
      : "";
  const cropHandles = cropCorners
    ? (() => {
        const [northWest, northEast, southEast, southWest] = cropCorners;
        const midpoint = (
          first: { x: number; y: number },
          second: { x: number; y: number },
        ) => ({
          x: (first.x + second.x) / 2,
          y: (first.y + second.y) / 2,
        });
        return [
          ["nw", northWest, "top-left corner"],
          ["n", midpoint(northWest, northEast), "top edge"],
          ["ne", northEast, "top-right corner"],
          ["e", midpoint(northEast, southEast), "right edge"],
          ["se", southEast, "bottom-right corner"],
          ["s", midpoint(southWest, southEast), "bottom edge"],
          ["sw", southWest, "bottom-left corner"],
          ["w", midpoint(northWest, southWest), "left edge"],
        ] as const;
      })()
    : [];
  const overlayControlStyle = {
    "--overlay-control-scale": 1 / Math.max(0.1, zoom),
  } as React.CSSProperties;

  const showAllHealOverlays =
    props.healOverlayMode === "always" ||
    (props.healOverlayMode === "auto" && (healStageHovered || gesture !== null));
  const visibleHealSpots =
    tool !== "heal" || props.healOverlayMode === "never"
      ? []
      : showAllHealOverlays
        ? photo.edits.healSpots
        : photo.edits.healSpots.filter((spot) => spot.id === props.activeHealSpotId);
  const healOverlays =
    tool === "heal"
      ? visibleHealSpots.map((spot) => ({
          spot,
          index: photo.edits.healSpots.findIndex((candidate) => candidate.id === spot.id),
          geometry: engineRef.current?.healOverlayGeometry(spot) ?? null,
          destinationPath: (spot.path?.length ? spot.path : [spot.destination])
            .map((point) => canvasPoint(point.x, point.y)),
          sourcePath: (spot.path?.length ? spot.path : [spot.destination])
            .map((point) => canvasPoint(
              point.x + spot.source.x - spot.destination.x,
              point.y + spot.source.y - spot.destination.y,
            )),
        }))
      : [];

  const uprightGuideOverlay = (() => {
    if (!props.guidedUprightActive || tool !== "edit") return null;
    const guides = props.uprightGuides.map((guide, index) => ({
      ...guide,
      index,
      startCanvas: canvasPoint(guide.start.x, guide.start.y),
      endCanvas: canvasPoint(guide.end.x, guide.end.y),
    }));
    const draft = gesture?.type === "upright-guide"
      ? {
          startCanvas: canvasPoint(gesture.start.x, gesture.start.y),
          endCanvas: canvasPoint(gesture.current.x, gesture.current.y),
          orientation:
            Math.abs((gesture.current.x - gesture.start.x) * photo.width) >=
            Math.abs((gesture.current.y - gesture.start.y) * photo.height)
              ? "horizontal"
              : "vertical",
        }
      : null;
    return { guides, draft };
  })();

  const healDraft = (() => {
    if (gesture?.type !== "heal" || !gesture.points.length) return null;
    const points = gesture.points.map((point) => canvasPoint(point.x, point.y));
    const path = points
      .map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`)
      .join(" ");
    const normalizedSize = props.healSettings.size <= 1
      ? props.healSettings.size
      : props.healSettings.size / Math.max(1, photo.height);
    const last = gesture.points[gesture.points.length - 1];
    const top = canvasPoint(last.x, last.y - normalizedSize * 0.5);
    const bottom = canvasPoint(last.x, last.y + normalizedSize * 0.5);
    return {
      path,
      width: Math.max(2, Math.hypot(bottom.x - top.x, bottom.y - top.y)),
    };
  })();

  const linearDraft = (() => {
    if (gesture?.type !== "linear") return null;
    const start = canvasPoint(gesture.start.x, gesture.start.y);
    const current = canvasPoint(gesture.current.x, gesture.current.y);
    return {
      left: `${start.x}px`,
      top: `${start.y}px`,
      width: `${Math.hypot(current.x - start.x, current.y - start.y)}px`,
      transform: `rotate(${Math.atan2(current.y - start.y, current.x - start.x)}rad)`,
    };
  })();

  const radialDraft = (() => {
    if (gesture?.type !== "radial") return null;
    const center = canvasPoint(gesture.start.x, gesture.start.y);
    const edge = canvasPoint(gesture.current.x, gesture.current.y);
    const radiusX = Math.abs(edge.x - center.x);
    const radiusY = Math.abs(edge.y - center.y);
    return {
      left: `${center.x - radiusX}px`,
      top: `${center.y - radiusY}px`,
      width: `${radiusX * 2}px`,
      height: `${radiusY * 2}px`,
    };
  })();

  const objectDraft = (() => {
    if (gesture?.type !== "object") return null;
    const start = canvasPoint(gesture.start.x, gesture.start.y);
    const current = canvasPoint(gesture.current.x, gesture.current.y);
    return {
      left: `${Math.min(start.x, current.x)}px`,
      top: `${Math.min(start.y, current.y)}px`,
      width: `${Math.abs(current.x - start.x)}px`,
      height: `${Math.abs(current.y - start.y)}px`,
    };
  })();

  const mappedEllipsePath = (
    centerX: number,
    centerY: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    scale = 1,
  ) => {
    const radians = (rotation * Math.PI) / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const points = Array.from({ length: 64 }, (_, index) => {
      const angle = (index / 64) * Math.PI * 2;
      const localX = Math.cos(angle) * radiusX * scale;
      const localY = Math.sin(angle) * radiusY * scale;
      return canvasPoint(
        centerX + cosine * localX - sine * localY,
        centerY + sine * localX + cosine * localY,
      );
    });
    if (!points.length) return "";
    return `${points
      .map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`)
      .join(" ")} Z`;
  };

  const linearControl = (() => {
    if (
      tool !== "mask" ||
      activeMask?.kind !== "linear" ||
      !activeMask.linear ||
      gesture?.type === "linear"
    ) {
      return null;
    }
    const start = canvasPoint(activeMask.linear.x1, activeMask.linear.y1);
    const end = canvasPoint(activeMask.linear.x2, activeMask.linear.y2);
    const feather = {
      x: (start.x + end.x) / 2,
      y: (start.y + end.y) / 2,
    };
    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    const length = Math.max(0.001, Math.hypot(deltaX, deltaY));
    const perpendicularX = -deltaY / length;
    const perpendicularY = deltaX / length;
    const halfGuideLength =
      Math.max(400, Math.hypot(cropCanvasWidth, cropCanvasHeight)) * 1.25;
    const guide = (point: { x: number; y: number }) => ({
      x1: point.x - perpendicularX * halfGuideLength,
      y1: point.y - perpendicularY * halfGuideLength,
      x2: point.x + perpendicularX * halfGuideLength,
      y2: point.y + perpendicularY * halfGuideLength,
    });
    return {
      start,
      end,
      feather,
      startGuide: guide(start),
      endGuide: guide(end),
      featherGuide: guide(feather),
    };
  })();

  const radialControl = (() => {
    if (
      tool !== "mask" ||
      activeMask?.kind !== "radial" ||
      !activeMask.radial ||
      gesture?.type === "radial"
    ) {
      return null;
    }
    const radial = activeMask.radial;
    const radians = (radial.rotation * Math.PI) / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const point = (localX: number, localY: number) =>
      canvasPoint(
        radial.cx + cosine * localX - sine * localY,
        radial.cy + sine * localX + cosine * localY,
      );
    const featherScale = clamp(1 - radial.feather / 100, 0.001, 1);
    const north = point(0, -radial.ry);
    const rotate = point(
      0,
      -radial.ry - Math.max(0.025, 0.045 / Math.max(0.25, zoom)),
    );
    return {
      framePath: mappedEllipsePath(
        radial.cx,
        radial.cy,
        radial.rx,
        radial.ry,
        radial.rotation,
      ),
      featherPath: mappedEllipsePath(
        radial.cx,
        radial.cy,
        radial.rx,
        radial.ry,
        radial.rotation,
        featherScale,
      ),
      center: point(0, 0),
      north,
      south: point(0, radial.ry),
      east: point(radial.rx, 0),
      west: point(-radial.rx, 0),
      northEast: point(radial.rx * Math.SQRT1_2, -radial.ry * Math.SQRT1_2),
      northWest: point(-radial.rx * Math.SQRT1_2, -radial.ry * Math.SQRT1_2),
      southEast: point(radial.rx * Math.SQRT1_2, radial.ry * Math.SQRT1_2),
      southWest: point(-radial.rx * Math.SQRT1_2, radial.ry * Math.SQRT1_2),
      feather: point(radial.rx * featherScale, 0),
      rotate,
    };
  })();

  const brushCursorPoint =
    tool === "mask" && activeMask?.kind === "brush"
      ? gesture?.type === "brush"
        ? gesture.points[gesture.points.length - 1] ?? pointerPreview
        : pointerPreview
      : null;
  const brushCursor = (() => {
    if (!brushCursorPoint) return null;
    const normalizedDiameter =
      props.maskBrushSettings.size <= 1
        ? props.maskBrushSettings.size
        : props.maskBrushSettings.size / 100;
    const pressure =
      gesture?.type === "brush"
        ? clamp(gesture.points[gesture.points.length - 1]?.pressure ?? 1, 0.05, 1)
        : 1;
    const pressureScale = 0.35 + pressure * 0.65;
    const radiusY = Math.max(0.001, normalizedDiameter * 0.5 * pressureScale);
    const sourceAspect = clamp(
      photo.width / Math.max(1, photo.height),
      0.1,
      10,
    );
    const radiusX = radiusY / sourceAspect;
    const featherScale = clamp(
      1 - props.maskBrushSettings.feather / 100,
      0,
      1,
    );
    return {
      center: canvasPoint(brushCursorPoint.x, brushCursorPoint.y),
      outerPath: mappedEllipsePath(
        brushCursorPoint.x,
        brushCursorPoint.y,
        radiusX,
        radiusY,
        0,
      ),
      innerPath:
        featherScale > 0.01
          ? mappedEllipsePath(
              brushCursorPoint.x,
              brushCursorPoint.y,
              radiusX,
              radiusY,
              0,
              featherScale,
            )
          : "",
    };
  })();

  const brushDraft = (() => {
    if (gesture?.type !== "brush" || !gesture.points.length) return null;
    const points = gesture.points.map((point) => canvasPoint(point.x, point.y));
    const path =
      points.length === 1
        ? `M${points[0].x} ${points[0].y} l0.01 0`
        : points
            .map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`)
            .join(" ");
    const normalizedDiameter =
      props.maskBrushSettings.size <= 1
        ? props.maskBrushSettings.size
        : props.maskBrushSettings.size / 100;
    const lastPoint = gesture.points[gesture.points.length - 1];
    const pressureScale =
      0.35 + clamp(lastPoint.pressure ?? 1, 0.05, 1) * 0.65;
    const top = canvasPoint(
      lastPoint.x,
      lastPoint.y - normalizedDiameter * pressureScale * 0.5,
    );
    const bottom = canvasPoint(
      lastPoint.x,
      lastPoint.y + normalizedDiameter * pressureScale * 0.5,
    );
    const outerWidth = Math.max(2, Math.hypot(bottom.x - top.x, bottom.y - top.y));
    return {
      path,
      outerWidth,
      innerWidth: Math.max(
        1,
        outerWidth * (1 - props.maskBrushSettings.feather / 100),
      ),
      erase: gesture.erase,
    };
  })();

  return (
    <main className="develop-workspace">
      <div
        ref={stageRef}
        tabIndex={-1}
        className={[
          "canvas-stage",
          tool === "mask" ? "is-masking" : "",
          tool === "mask" && activeMask?.kind === "brush"
            ? "is-brush-masking"
            : "",
          tool === "heal" ? "is-healing" : "",
          tool === "crop" ? "is-cropping" : "",
          props.guidedUprightActive && tool === "edit" ? "is-guided-upright" : "",
          rendering ? "is-rendering" : "",
          gesture?.type === "pan" ? "is-panning" : "",
        ].join(" ")}
        onPointerDown={beginPointerGesture}
        onPointerMove={movePointerGesture}
        onPointerUp={endPointerGesture}
        onPointerCancel={endPointerGesture}
        onLostPointerCapture={endPointerGesture}
        onPointerEnter={() => setHealStageHovered(true)}
        onPointerLeave={() => {
          setHealStageHovered(false);
          if (gestureRef.current?.type !== "brush") setPointerPreviewNow(null);
        }}
        onWheel={(event) => {
          event.preventDefault();
          const direction = event.deltaY > 0 ? -1 : 1;
          const step = event.ctrlKey ? 0.2 : 0.1;
          props.onZoomChange(clamp(zoom + direction * step, 0.25, 4));
        }}
      >
        <div
          className="canvas-viewport"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        >
          <canvas ref={canvasRef} aria-label={`Editing ${photo.name}`} />
          {props.showClipping ? (
            <div className="clipping-indicator">
              <span>Clipping preview</span>
            </div>
          ) : null}
          {tool === "crop" && cropCorners && cropPoints ? (
            <>
              <svg
                className="crop-overlay"
                width="100%"
                height="100%"
                role="group"
                aria-label="Crop controls"
              >
                <path
                  className="crop-overlay__shade"
                  d={cropShadePath}
                  fillRule="evenodd"
                />
                {cropGuideLines.map((line, index) => (
                  <line
                    key={index}
                    className={`crop-overlay__grid-line crop-overlay__grid-line--${props.cropOverlay}`}
                    {...line}
                  />
                ))}
                <polygon
                  className="crop-overlay__frame"
                  points={cropPoints}
                  role="button"
                  aria-label="Crop frame. Use arrow keys to move."
                  tabIndex={0}
                  onPointerDown={(event) => beginCropGesture(event, "move")}
                  onPointerMove={moveCropGesture}
                  onPointerUp={endCropGesture}
                  onPointerCancel={endCropGesture}
                  onLostPointerCapture={endCropGesture}
                  onKeyDown={(event) => keyboardCrop(event, "move")}
                />
              </svg>
              {cropHandles.map(([action, point, label]) => (
                <button
                  type="button"
                  key={action}
                  className={`crop-handle crop-handle--${action}`}
                  style={{
                    left: `${point.x}px`,
                    top: `${point.y}px`,
                    ...overlayControlStyle,
                  }}
                  aria-label={`Resize crop from ${label}`}
                  onPointerDown={(event) => beginCropGesture(event, action)}
                  onPointerMove={moveCropGesture}
                  onPointerUp={endCropGesture}
                  onPointerCancel={endCropGesture}
                  onLostPointerCapture={endCropGesture}
                  onKeyDown={(event) => keyboardCrop(event, action)}
                />
              ))}
            </>
          ) : null}
          {uprightGuideOverlay ? (
            <svg
              className="upright-guide-overlay"
              width="100%"
              height="100%"
              aria-label="Guided Upright lines"
            >
              {uprightGuideOverlay.guides.map((guide) => (
                <g key={`${guide.orientation}-${guide.index}`}>
                  <line
                    className={`upright-guide upright-guide--${guide.orientation}`}
                    x1={guide.startCanvas.x}
                    y1={guide.startCanvas.y}
                    x2={guide.endCanvas.x}
                    y2={guide.endCanvas.y}
                  />
                  <circle
                    className="upright-guide__handle"
                    cx={guide.startCanvas.x}
                    cy={guide.startCanvas.y}
                    r={3 / Math.max(0.25, zoom)}
                  />
                  <circle
                    className="upright-guide__handle"
                    cx={guide.endCanvas.x}
                    cy={guide.endCanvas.y}
                    r={3 / Math.max(0.25, zoom)}
                  />
                </g>
              ))}
              {uprightGuideOverlay.draft ? (
                <line
                  className={`upright-guide upright-guide--draft upright-guide--${uprightGuideOverlay.draft.orientation}`}
                  x1={uprightGuideOverlay.draft.startCanvas.x}
                  y1={uprightGuideOverlay.draft.startCanvas.y}
                  x2={uprightGuideOverlay.draft.endCanvas.x}
                  y2={uprightGuideOverlay.draft.endCanvas.y}
                />
              ) : null}
            </svg>
          ) : null}
          {linearDraft ? (
            <div className="mask-linear-draft" style={linearDraft}>
              <span />
            </div>
          ) : null}
          {radialDraft ? <div className="mask-radial-draft" style={radialDraft} /> : null}
          {objectDraft ? <div className="mask-object-draft" style={objectDraft} /> : null}
          {brushDraft || brushCursor ? (
            <svg
              className="mask-brush-overlay"
              width="100%"
              height="100%"
              aria-hidden="true"
            >
              {brushDraft ? (
                <>
                  <path
                    className={`mask-brush-draft__outer${
                      brushDraft.erase ? " is-erasing" : ""
                    }`}
                    d={brushDraft.path}
                    stroke={activeMaskGroup?.overlayColor ?? "#ef5350"}
                    strokeWidth={brushDraft.outerWidth}
                  />
                  <path
                    className={`mask-brush-draft__core${
                      brushDraft.erase ? " is-erasing" : ""
                    }`}
                    d={brushDraft.path}
                    stroke={activeMaskGroup?.overlayColor ?? "#ef5350"}
                    strokeWidth={brushDraft.innerWidth}
                  />
                </>
              ) : null}
              {brushCursor ? (
                <>
                  <path
                    className="mask-brush-cursor__ring mask-brush-cursor__ring--outer"
                    d={brushCursor.outerPath}
                  />
                  {brushCursor.innerPath ? (
                    <path
                      className="mask-brush-cursor__ring mask-brush-cursor__ring--inner"
                      d={brushCursor.innerPath}
                    />
                  ) : null}
                  <line
                    className="mask-brush-cursor__cross"
                    x1={brushCursor.center.x - 3 / zoom}
                    y1={brushCursor.center.y}
                    x2={brushCursor.center.x + 3 / zoom}
                    y2={brushCursor.center.y}
                  />
                  <line
                    className="mask-brush-cursor__cross"
                    x1={brushCursor.center.x}
                    y1={brushCursor.center.y - 3 / zoom}
                    x2={brushCursor.center.x}
                    y2={brushCursor.center.y + 3 / zoom}
                  />
                </>
              ) : null}
            </svg>
          ) : null}
          {linearControl ? (
            <svg
              className="mask-control-overlay mask-control-overlay--linear"
              width="100%"
              height="100%"
              aria-label={`${activeMask?.name ?? "Linear gradient"} controls`}
            >
              <line
                className="mask-control__axis"
                x1={linearControl.start.x}
                y1={linearControl.start.y}
                x2={linearControl.end.x}
                y2={linearControl.end.y}
              />
              <line
                className="mask-control__guide mask-control__guide--start"
                {...linearControl.startGuide}
              />
              <line
                className="mask-control__guide mask-control__guide--feather"
                {...linearControl.featherGuide}
              />
              <line
                className="mask-control__guide mask-control__guide--end"
                {...linearControl.endGuide}
              />
              <line
                className="mask-control__guide-hit mask-control__guide-hit--endpoint"
                {...linearControl.startGuide}
                onPointerDown={(event) =>
                  beginLinearControlGesture(event, "start")
                }
                onPointerMove={moveMaskControlGesture}
                onPointerUp={endMaskControlGesture}
                onPointerCancel={endMaskControlGesture}
                onLostPointerCapture={endMaskControlGesture}
              />
              <line
                className="mask-control__guide-hit mask-control__guide-hit--feather"
                {...linearControl.featherGuide}
                onPointerDown={(event) =>
                  beginLinearControlGesture(event, "feather")
                }
                onPointerMove={moveMaskControlGesture}
                onPointerUp={endMaskControlGesture}
                onPointerCancel={endMaskControlGesture}
                onLostPointerCapture={endMaskControlGesture}
              />
              <line
                className="mask-control__guide-hit mask-control__guide-hit--endpoint"
                {...linearControl.endGuide}
                onPointerDown={(event) =>
                  beginLinearControlGesture(event, "end")
                }
                onPointerMove={moveMaskControlGesture}
                onPointerUp={endMaskControlGesture}
                onPointerCancel={endMaskControlGesture}
                onLostPointerCapture={endMaskControlGesture}
              />
              {(
                [
                  ["start", linearControl.start, "start"],
                  ["feather", linearControl.feather, "feather"],
                  ["end", linearControl.end, "end"],
                ] as const
              ).map(([key, point, action]) => (
                <g key={key}>
                  <circle
                    className={`mask-control__handle-hit mask-control__handle-hit--${action}`}
                    cx={point.x}
                    cy={point.y}
                    r={12 / Math.max(0.25, zoom)}
                    role={action === "feather" ? "button" : undefined}
                    aria-label={
                      action === "feather"
                        ? `Move ${activeMask?.name ?? "linear gradient"}`
                        : undefined
                    }
                    tabIndex={action === "feather" ? 0 : undefined}
                    onPointerDown={(event) =>
                      beginLinearControlGesture(event, action)
                    }
                    onPointerMove={moveMaskControlGesture}
                    onPointerUp={endMaskControlGesture}
                    onPointerCancel={endMaskControlGesture}
                    onLostPointerCapture={endMaskControlGesture}
                    onKeyDown={
                      action === "feather"
                        ? keyboardMoveLinearGradient
                        : undefined
                    }
                  />
                  <circle
                    className={`mask-control__handle mask-control__handle--${action}`}
                    cx={point.x}
                    cy={point.y}
                    r={(action === "feather" ? 5 : 4) / Math.max(0.25, zoom)}
                  />
                </g>
              ))}
            </svg>
          ) : null}
          {radialControl ? (
            <svg
              className="mask-control-overlay mask-control-overlay--radial"
              width="100%"
              height="100%"
              aria-label={`${activeMask?.name ?? "Radial gradient"} controls`}
            >
              <path className="mask-control__radial-frame" d={radialControl.framePath} />
              <path
                className="mask-control__radial-feather"
                d={radialControl.featherPath}
              />
              <line
                className="mask-control__radial-axis"
                x1={radialControl.west.x}
                y1={radialControl.west.y}
                x2={radialControl.east.x}
                y2={radialControl.east.y}
              />
              <line
                className="mask-control__radial-axis"
                x1={radialControl.north.x}
                y1={radialControl.north.y}
                x2={radialControl.south.x}
                y2={radialControl.south.y}
              />
              <line
                className="mask-control__rotate-link"
                x1={radialControl.north.x}
                y1={radialControl.north.y}
                x2={radialControl.rotate.x}
                y2={radialControl.rotate.y}
              />
              {(
                [
                  ["east", radialControl.east, "resize-x"],
                  ["west", radialControl.west, "resize-x"],
                  ["north", radialControl.north, "resize-y"],
                  ["south", radialControl.south, "resize-y"],
                  ["north-east", radialControl.northEast, "resize-both"],
                  ["north-west", radialControl.northWest, "resize-both"],
                  ["south-east", radialControl.southEast, "resize-both"],
                  ["south-west", radialControl.southWest, "resize-both"],
                ] as const
              ).map(([key, point, action]) => (
                <g key={key}>
                  <circle
                    className="mask-control__handle-hit mask-control__handle-hit--resize"
                    cx={point.x}
                    cy={point.y}
                    r={11 / Math.max(0.25, zoom)}
                    onPointerDown={(event) =>
                      beginRadialControlGesture(event, action)
                    }
                    onPointerMove={moveMaskControlGesture}
                    onPointerUp={endMaskControlGesture}
                    onPointerCancel={endMaskControlGesture}
                    onLostPointerCapture={endMaskControlGesture}
                  />
                  <rect
                    className="mask-control__resize-handle"
                    x={point.x - 3.5 / Math.max(0.25, zoom)}
                    y={point.y - 3.5 / Math.max(0.25, zoom)}
                    width={7 / Math.max(0.25, zoom)}
                    height={7 / Math.max(0.25, zoom)}
                    rx={1 / Math.max(0.25, zoom)}
                  />
                </g>
              ))}
              {(
                [
                  ["center", radialControl.center, "center"],
                  ["feather", radialControl.feather, "feather"],
                  ["rotate", radialControl.rotate, "rotate"],
                ] as const
              ).map(([key, point, action]) => (
                <g key={key}>
                  <circle
                    className={`mask-control__handle-hit mask-control__handle-hit--${action}`}
                    cx={point.x}
                    cy={point.y}
                    r={12 / Math.max(0.25, zoom)}
                    role={action === "center" ? "button" : undefined}
                    aria-label={
                      action === "center"
                        ? `Move ${activeMask?.name ?? "radial gradient"}`
                        : undefined
                    }
                    tabIndex={action === "center" ? 0 : undefined}
                    onPointerDown={(event) =>
                      beginRadialControlGesture(event, action)
                    }
                    onPointerMove={moveMaskControlGesture}
                    onPointerUp={endMaskControlGesture}
                    onPointerCancel={endMaskControlGesture}
                    onLostPointerCapture={endMaskControlGesture}
                    onKeyDown={
                      action === "center"
                        ? keyboardMoveRadialGradient
                        : undefined
                    }
                  />
                  <circle
                    className={`mask-control__handle mask-control__handle--${action}`}
                    cx={point.x}
                    cy={point.y}
                    r={(action === "center" ? 5 : 4) / Math.max(0.25, zoom)}
                  />
                </g>
              ))}
            </svg>
          ) : null}
          {healDraft || healOverlays.some(({ geometry }) => geometry) ? (
            <svg
              className="heal-overlay"
              width="100%"
              height="100%"
              aria-label="Repair overlays"
            >
              {healDraft ? (
                <path
                  className="heal-overlay__draft"
                  d={healDraft.path}
                  fill="none"
                  strokeWidth={healDraft.width}
                />
              ) : null}
              {healOverlays.map(({ spot, geometry, destinationPath, sourcePath }) => {
                if (!geometry) return null;
                const { center, source, axisX, axisY } = geometry;
                const matrix = (point: { x: number; y: number }) =>
                  `matrix(${axisX.x} ${axisX.y} ${axisY.x} ${axisY.y} ${point.x} ${point.y})`;
                const brushWidth = Math.max(
                  2,
                  (Math.hypot(axisX.x, axisX.y) + Math.hypot(axisY.x, axisY.y)),
                );
                const active = spot.id === props.activeHealSpotId;
                const showSource = active && spot.mode !== "remove";
                const selectSpot = (event: React.PointerEvent<SVGElement>) => {
                  event.preventDefault();
                  event.stopPropagation();
                  props.onSelectHealSpot(spot.id);
                };
                return (
                  <g key={spot.id} className={active ? "is-active" : undefined}>
                    {showSource ? (
                      <line
                        className="heal-overlay__link"
                        x1={center.x}
                        y1={center.y}
                        x2={source.x}
                        y2={source.y}
                      />
                    ) : null}
                    {destinationPath.length > 1 ? (
                      <>
                        <polyline
                          className="heal-overlay__destination-path"
                          points={destinationPath.map((point) => `${point.x},${point.y}`).join(" ")}
                          strokeWidth={brushWidth}
                        />
                        <polyline
                          className="heal-overlay__hit"
                          points={destinationPath.map((point) => `${point.x},${point.y}`).join(" ")}
                          strokeWidth={brushWidth + 10 / Math.max(0.25, zoom)}
                          onPointerDown={selectSpot}
                        />
                      </>
                    ) : null}
                    {showSource && sourcePath.length > 1 ? (
                      <polyline
                        className="heal-overlay__source-path"
                        points={sourcePath.map((point) => `${point.x},${point.y}`).join(" ")}
                        strokeWidth={brushWidth}
                      />
                    ) : null}
                    {destinationPath.length <= 1 ? (
                      <>
                        <ellipse
                          className="heal-overlay__destination"
                          cx="0"
                          cy="0"
                          rx="1"
                          ry="1"
                          transform={matrix(center)}
                        />
                        <ellipse
                          className="heal-overlay__hit"
                          cx="0"
                          cy="0"
                          rx="1.3"
                          ry="1.3"
                          transform={matrix(center)}
                          onPointerDown={selectSpot}
                        />
                      </>
                    ) : null}
                    {showSource ? (
                      <ellipse
                        className="heal-overlay__source"
                        cx="0"
                        cy="0"
                        rx="1"
                        ry="1"
                        transform={matrix(source)}
                      />
                    ) : null}
                    {active ? (
                      <circle
                        className="heal-overlay__center"
                        cx={center.x}
                        cy={center.y}
                        r="2.5"
                      />
                    ) : null}
                  </g>
                );
              })}
            </svg>
          ) : null}
          {healOverlays.map(({ spot, index, geometry }) => {
            if (
              !geometry ||
              spot.id !== props.activeHealSpotId ||
              spot.mode === "remove" ||
              geometry.center.x < 0 ||
              geometry.center.x > cropCanvasWidth ||
              geometry.center.y < 0 ||
              geometry.center.y > cropCanvasHeight
            ) {
              return null;
            }
            return (
              <div
                key={spot.id}
                className="heal-marker"
                role="group"
                aria-label={`Repair spot ${index + 1}`}
                style={{
                  left: `${geometry.center.x}px`,
                  top: `${geometry.center.y}px`,
                  ...overlayControlStyle,
                }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  className="heal-marker__source"
                  aria-label={`Move source for repair spot ${index + 1}`}
                  title="Drag to move the repair source"
                  style={{
                    left: `${geometry.source.x - geometry.center.x}px`,
                    top: `${geometry.source.y - geometry.center.y}px`,
                  }}
                  onPointerDown={(event) => {
                    props.onSelectHealSpot(spot.id);
                    beginHealSourceGesture(event, spot.id);
                  }}
                  onPointerMove={moveHealSourceGesture}
                  onPointerUp={endHealSourceGesture}
                  onPointerCancel={endHealSourceGesture}
                  onLostPointerCapture={endHealSourceGesture}
                  onKeyDown={(event) => {
                    if (
                      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
                        event.key,
                      )
                    ) {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    const engine = engineRef.current;
                    if (!engine) return;
                    const sourcePoint = engine.imageToCanvas(
                      spot.source.x,
                      spot.source.y,
                    );
                    const step = (event.shiftKey ? 12 : 3) / Math.max(0.1, zoom);
                    const canvasDx =
                      event.key === "ArrowLeft"
                        ? -step
                        : event.key === "ArrowRight"
                          ? step
                          : 0;
                    const canvasDy =
                      event.key === "ArrowUp"
                        ? -step
                        : event.key === "ArrowDown"
                          ? step
                          : 0;
                    const nextSource = engine.canvasToImage(
                      sourcePoint.x + canvasDx,
                      sourcePoint.y + canvasDy,
                    );
                    props.onBeginEdit();
                    props.onUpdateHealSpot(spot.id, {
                      source: {
                        x: nextSource.x,
                        y: nextSource.y,
                      },
                    });
                    props.onCommitEdit();
                  }}
                />
              </div>
            );
          })}
        </div>
        {rendering ? (
          <div className="canvas-loading">
            <span className="spinner" />
            <strong>Building preview…</strong>
          </div>
        ) : null}
        {loadError ? (
          <div className="canvas-error" role="alert">
            <strong>Could not display this photo</strong>
            <span>{loadError}</span>
          </div>
        ) : null}
      </div>
      <div className="canvas-toolbar">
        <div className="canvas-toolbar__group">
          <strong title={photo.name}>{photo.name}</strong>
          <span className="canvas-toolbar__readout">
            {photo.width} × {photo.height}
          </span>
        </div>
        <div className="canvas-toolbar__group">
          <IconButton
            icon={Eye}
            label="Show original"
            active={showOriginal}
            onClick={props.onToggleOriginal}
          />
          {tool === "mask" ? (
            <IconButton
              icon={showMaskOverlay ? EyeOff : Eye}
              label={showMaskOverlay ? "Hide mask overlay" : "Show mask overlay"}
              active={showMaskOverlay}
              onClick={props.onToggleMaskOverlay}
            />
          ) : null}
          <IconButton icon={Grid2X2} label="Grid overlay" disabled />
        </div>
        <div className="canvas-toolbar__right">
          <IconButton
            icon={Minus}
            label="Zoom out"
            disabled={zoom <= 0.25}
            onClick={() => props.onZoomChange(Math.max(0.25, zoom - 0.25))}
          />
          <button type="button" onClick={() => props.onZoomChange(1)}>
            <Scan size={13} />
            {zoom === 1 ? "Fit" : `${Math.round(zoom * 100)}%`}
          </button>
          <IconButton
            icon={Plus}
            label="Zoom in"
            disabled={zoom >= 4}
            onClick={() => props.onZoomChange(Math.min(4, zoom + 0.25))}
          />
        </div>
      </div>
    </main>
  );
}
