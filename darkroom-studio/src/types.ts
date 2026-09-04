export type WorkspaceMode = "library" | "develop";
export type LibraryView = "photo-grid" | "square-grid" | "detail";
export type FlagState = "pick" | "reject" | "unflagged";
export type ColorLabel = "red" | "yellow" | "green" | "blue" | "purple" | "none";
export type HueChannel =
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "aqua"
  | "blue"
  | "purple"
  | "magenta";

export interface PhotoMetadata {
  camera?: string;
  lens?: string;
  iso?: number;
  aperture?: number;
  shutter?: string;
  focalLength?: number;
  capturedAt?: string;
  latitude?: number;
  longitude?: number;
  copyright?: string;
  caption?: string;
}

export interface ToneCurvePoint {
  x: number;
  y: number;
}

export interface HslChannel {
  hue: number;
  saturation: number;
  luminance: number;
}

export type HslAdjustments = Record<HueChannel, HslChannel>;

export interface ColorWheel {
  hue: number;
  saturation: number;
  luminance: number;
}

export interface ColorGrading {
  shadows: ColorWheel;
  midtones: ColorWheel;
  highlights: ColorWheel;
  blending: number;
  balance: number;
}

export interface PointColorAdjustments {
  enabled: boolean;
  hue: number;
  range: number;
  hueShift: number;
  saturationShift: number;
  luminanceShift: number;
}

export interface LensCorrections {
  removeChromaticAberration: boolean;
  enableProfileCorrections: boolean;
  setup: "default" | "auto" | "custom";
  distortion: number;
  vignette: number;
  midpoint: number;
  defringePurpleAmount: number;
  defringePurpleHueLow: number;
  defringePurpleHueHigh: number;
  defringeGreenAmount: number;
  defringeGreenHueLow: number;
  defringeGreenHueHigh: number;
}

export interface LensBlurAdjustments {
  enabled: boolean;
  amount: number;
  focusRange: number;
  focusX: number;
  focusY: number;
  bokeh: "circle" | "bubble" | "five-blade" | "ring" | "cat-eye";
  boost: number;
}

export interface CalibrationAdjustments {
  processVersion: "6";
  shadowsTint: number;
  redPrimaryHue: number;
  redPrimarySaturation: number;
  greenPrimaryHue: number;
  greenPrimarySaturation: number;
  bluePrimaryHue: number;
  bluePrimarySaturation: number;
}

export interface GlobalAdjustments {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  temperature: number;
  tint: number;
  vibrance: number;
  saturation: number;
  texture: number;
  clarity: number;
  dehaze: number;
  sharpening: number;
  sharpeningRadius: number;
  sharpeningDetail: number;
  sharpeningMasking: number;
  noiseReduction: number;
  noiseReductionDetail: number;
  noiseReductionContrast: number;
  colorNoiseReduction: number;
  colorNoiseReductionDetail: number;
  colorNoiseReductionSmoothness: number;
  vignette: number;
  vignetteMidpoint: number;
  vignetteFeather: number;
  grain: number;
  grainSize: number;
}

export interface UprightGuide {
  orientation: "horizontal" | "vertical";
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface GeometryAdjustments {
  uprightMode: "off" | "auto" | "guided" | "level" | "vertical" | "full";
  constrainCrop: boolean;
  guides: UprightGuide[];
  rotate: number;
  vertical: number;
  horizontal: number;
  aspect: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  flipX: boolean;
  flipY: boolean;
}

export const CROP_OVERLAY_SEQUENCE = [
  "thirds",
  "grid",
  "diagonal",
  "golden-ratio",
] as const;

export type CropOverlay = (typeof CROP_OVERLAY_SEQUENCE)[number];

export interface CropState {
  x: number;
  y: number;
  width: number;
  height: number;
  aspect: string;
  locked: boolean;
  angle: number;
}

export interface LocalAdjustments {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  temperature: number;
  tint: number;
  vibrance: number;
  saturation: number;
  texture: number;
  clarity: number;
  dehaze: number;
  hue: number;
  sharpness: number;
  noiseReduction: number;
  moire: number;
  defringe: number;
}

export interface BrushPoint {
  x: number;
  y: number;
  pressure?: number;
}

export interface BrushStroke {
  points: BrushPoint[];
  size: number;
  feather: number;
  flow: number;
  erase: boolean;
  density?: number;
  autoMask?: boolean;
}

export type MaskOperation = "add" | "subtract" | "intersect";

export type PeopleFeature =
  | "wholePerson"
  | "faceSkin"
  | "bodySkin"
  | "hair"
  | "clothes"
  | "eyes"
  | "lips"
  | "teeth"
  | "facialHair";

export type LegacyPeopleRegion = "all" | "face" | "skin" | "hair" | "clothes";

export type MaskKind =
  | "brush"
  | "linear"
  | "radial"
  | "luminance"
  | "color"
  | "sky"
  | "subject"
  | "background"
  | "object"
  | "people"
  | "landscape"
  | "depth";

export interface MaskPayload {
  strokes?: BrushStroke[];
  linear?: { x1: number; y1: number; x2: number; y2: number };
  radial?: {
    cx: number;
    cy: number;
    rx: number;
    ry: number;
    rotation: number;
    feather: number;
  };
  luminance?: { min: number; max: number; smoothness: number };
  color?: { r: number; g: number; b: number; tolerance: number };
  object?: { x: number; y: number; width: number; height: number };
  people?: {
    /** Retained for catalogs and integrations created before feature masks. */
    region: LegacyPeopleRegion;
    /** Canonical feature selection. Missing values are migrated from `region`. */
    features?: PeopleFeature[];
    /** Local analysis currently exposes one deterministic candidate. */
    personId?: "person-1";
  };
  landscape?: {
    element:
      | "sky"
      | "mountains"
      | "architecture"
      | "vegetation"
      | "water"
      | "snow"
      | "ground";
  };
  depth?: { min: number; max: number; smoothness: number };
}

export interface MaskComponent extends MaskPayload {
  id: string;
  name: string;
  kind: MaskKind;
  operation: MaskOperation;
  enabled: boolean;
  inverted: boolean;
  opacity: number;
}

export interface Mask extends MaskPayload {
  id: string;
  name: string;
  kind: MaskKind;
  enabled: boolean;
  inverted: boolean;
  opacity: number;
  overlayColor: string;
  adjustments: LocalAdjustments;
  /**
   * New composable-mask representation. When absent, the legacy top-level
   * kind and payload are interpreted as one additive component.
   */
  components?: MaskComponent[];
}

export interface HealSpot {
  id: string;
  mode: "remove" | "clone" | "heal";
  destination: { x: number; y: number };
  source: { x: number; y: number };
  size: number;
  feather: number;
  opacity: number;
  /** Painted centerline. Missing/empty retains legacy single-point behavior. */
  path?: BrushPoint[];
}

export interface EditState {
  profile: string;
  global: GlobalAdjustments;
  curve: ToneCurvePoint[];
  redCurve: ToneCurvePoint[];
  greenCurve: ToneCurvePoint[];
  blueCurve: ToneCurvePoint[];
  hsl: HslAdjustments;
  pointColor: PointColorAdjustments;
  colorGrading: ColorGrading;
  lensCorrections: LensCorrections;
  lensBlur: LensBlurAdjustments;
  calibration: CalibrationAdjustments;
  geometry: GeometryAdjustments;
  crop: CropState;
  masks: Mask[];
  healSpots: HealSpot[];
}

export interface EditSnapshot {
  id: string;
  label: string;
  createdAt: string;
  state: EditState;
}

export type ImportMethod = "add" | "copy";
export type ImportDuplicateHandling = "skip" | "include";

export interface ImportOptions {
  method: ImportMethod;
  duplicateHandling: ImportDuplicateHandling;
  keywords: string[];
  collectionId: string | null;
}

export interface PhotoRecord {
  id: string;
  name: string;
  type: string;
  size: number;
  width: number;
  height: number;
  importedAt: string;
  lastEditedAt?: string;
  importMethod?: ImportMethod;
  /** Browser-decodable working image when `blob` is a camera RAW original. */
  renderBlob?: Blob;
  blob: Blob;
  objectUrl: string;
  thumbnailUrl: string;
  metadata: PhotoMetadata;
  rating: number;
  flag: FlagState;
  colorLabel: ColorLabel;
  keywords: string[];
  collectionIds: string[];
  edits: EditState;
  snapshots: EditSnapshot[];
}

export interface Collection {
  id: string;
  name: string;
  createdAt: string;
  smartRule?: {
    ratingAtLeast?: number;
    flag?: FlagState;
    keyword?: string;
  };
}

export interface DevelopPreset {
  id: string;
  name: string;
  group: string;
  description: string;
  adjustments: Partial<GlobalAdjustments>;
  hsl?: Partial<HslAdjustments>;
  curve?: ToneCurvePoint[];
}

export interface ExportSettings {
  format: "image/jpeg" | "image/png" | "image/webp";
  quality: number;
  resizeMode: "original" | "long-edge" | "dimensions";
  longEdge: number;
  width: number;
  height: number;
  fileName: string;
  includeMetadata: boolean;
  watermarkEnabled: boolean;
  watermarkText: string;
  watermarkOpacity: number;
  watermarkPosition:
    | "top-left"
    | "top-right"
    | "bottom-left"
    | "bottom-right"
    | "center";
}

export interface HistogramData {
  red: number[];
  green: number[];
  blue: number[];
  luminance: number[];
}
