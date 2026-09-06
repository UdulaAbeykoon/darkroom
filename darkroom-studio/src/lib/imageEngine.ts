import type {
  BrushPoint,
  EditState,
  ExportSettings,
  GlobalAdjustments,
  HealSpot,
  HistogramData,
  HslAdjustments,
  LocalAdjustments,
  Mask,
  MaskComponent,
  PeopleFeature,
  ToneCurvePoint,
} from "../types";
import {
  composeMaskWeight,
  getMaskComponents,
  normalizePeopleFeatures,
} from "./maskMath";
import { expandHealPaths, type HealDab } from "./healPath";
import { canonicalProfileName } from "../defaults";

const MAX_MASKS = 8;
const MAX_HEAL_SPOTS = 32;
const MAX_CURVE_POINTS = 16;
const BRUSH_CELL_SIZE = 512;
const BRUSH_ATLAS_COLUMNS = 4;
const BRUSH_ATLAS_ROWS = 2;
const MAX_MASK_COMPONENTS = 32;
const DEFAULT_PREVIEW_DIMENSION = 4096;
const HISTOGRAM_SAMPLE_BUDGET = 300_000;

// The fragment shader is intentionally feature-rich, but most edits leave
// several entire adjustment families at their neutral values. A compact flag
// set lets the GPU bypass those neutral passes without changing the result.
const ADJUSTMENT_FLAG_TONE_CURVE = 1 << 0;
const ADJUSTMENT_FLAG_CHANNEL_CURVES = 1 << 1;
const ADJUSTMENT_FLAG_HSL = 1 << 2;
const ADJUSTMENT_FLAG_COLOR_GRADING = 1 << 3;
const ADJUSTMENT_FLAG_CALIBRATION = 1 << 4;
const ADJUSTMENT_FLAG_LENS_COLOR = 1 << 5;
const ADJUSTMENT_FLAG_VIGNETTE = 1 << 6;
const ADJUSTMENT_FLAG_GRAIN = 1 << 7;
const ADJUSTMENT_FLAG_LENS_VIGNETTE = 1 << 8;
const ADJUSTMENT_FLAG_LENS_BLUR = 1 << 9;

type Rgb = [number, number, number];
type DecodedImage = ImageBitmap | HTMLImageElement | HTMLCanvasElement;

export type LensBokehShape = EditState["lensBlur"]["bokeh"];

export interface LensBlurSampleOffset {
  x: number;
  y: number;
}

export interface LoadedImageInfo {
  /** Original, orientation-corrected dimensions. */
  sourceWidth: number;
  sourceHeight: number;
  /** Dimensions of the texture used by the interactive renderer. */
  previewWidth: number;
  previewHeight: number;
  /** Backwards-friendly aliases for sourceWidth/sourceHeight. */
  width: number;
  height: number;
}

export interface RenderOptions {
  showOriginal?: boolean;
  activeMaskId?: string;
  showMaskOverlay?: boolean;
  maskOverlayMode?:
    | "color"
    | "color-on-black"
    | "color-on-white"
    | "white-on-black"
    | "black-on-white";
  maskOverlayOpacity?: number;
  showClipping?: boolean;
  /** Display-only inverted high-frequency view used to reveal sensor spots. */
  visualizeSpots?: boolean;
  /** Normalized 0...1 edge threshold for the Visualize Spots view. */
  visualizeSpotsThreshold?: number;
  /** Show the full transformed source while the crop frame is being edited. */
  cropPreview?: boolean;
}

export interface ImageBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImagePoint {
  x: number;
  y: number;
  inside: boolean;
}

export interface UprightAnalysis {
  rotation: number;
  vertical: number;
  horizontal: number;
  confidence: number;
  horizontalLines: number;
  verticalLines: number;
}

export interface HealOverlayGeometry {
  center: ImagePoint;
  source: ImagePoint;
  axisX: { x: number; y: number };
  axisY: { x: number; y: number };
}

interface FrameGeometry {
  bounds: ImageBounds;
  crop: [number, number, number, number];
  sourceWidth: number;
  sourceHeight: number;
  adjustedCropWidth: number;
  adjustedCropHeight: number;
  boundingWidth: number;
  boundingHeight: number;
  cosine: number;
  sine: number;
  effectiveScale: number;
  offsetX: number;
  offsetY: number;
}

interface GlResources {
  program: WebGLProgram;
  vertexShader: WebGLShader;
  fragmentShader: WebGLShader;
  vertexBuffer: WebGLBuffer;
  vertexArray: WebGLVertexArrayObject;
  sourceTexture: WebGLTexture;
  brushTexture: WebGLTexture;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

interface CpuCurves {
  tone: ToneCurvePoint[];
  channels: [ToneCurvePoint[], ToneCurvePoint[], ToneCurvePoint[]];
}

interface ComponentEvaluationContext {
  objectTarget?: Rgb;
  peopleFeatures?: PeopleFeature[];
}

const clamp = (value: number, min = 0, max = 1): number =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

const finite = (value: number | undefined, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const normalizedPercent = (value: number): number =>
  clamp(Math.abs(value) <= 1 ? value : value / 100);

const percentage = (value: number): number => clamp(value / 100);

/**
 * Strength of the browser's generic lens-profile approximation. The Setup
 * choices intentionally produce distinct, deterministic results even when a
 * proprietary manufacturer lens profile is unavailable.
 */
export const lensProfileCorrectionStrength = (
  lens: EditState["lensCorrections"],
): number => {
  if (!lens.enableProfileCorrections) return 0;
  if (lens.setup === "auto") return 1;
  if (lens.setup === "custom") return 0.65;
  return 0.82;
};

export const combinePeopleFeatureWeights = (
  weights: readonly number[],
): number =>
  weights.reduce(
    (combined, weight) => 1 - (1 - combined) * (1 - clamp(weight)),
    0,
  );

const normalizeChannel = (value: number): number =>
  clamp(Math.abs(value) <= 1 ? value : value / 255);

const normalizeLuminanceRange = (value: number): number =>
  clamp(value / 100);

export const normalizeRepairRadius = (value: number, referencePixels: number): number => {
  const safe = Math.max(1, referencePixels);
  if (!Number.isFinite(value) || value <= 0) return 0;
  // Values at or below one are retained for legacy catalogs that stored a
  // normalized diameter. Current repairs store normalized source pixels.
  if (value <= 1) return value * 0.5;
  return value / safe / 2;
};

export const orientedFrameDimensions = (
  width: number,
  height: number,
  angleDegrees: number,
): { width: number; height: number } => {
  const normalizedAngle =
    ((finite(angleDegrees) % 360) + 360) % 360;
  const isQuarterTurn =
    Math.abs(normalizedAngle - 90) < 0.0001 ||
    Math.abs(normalizedAngle - 270) < 0.0001;
  return isQuarterTurn
    ? { width: Math.max(1e-6, height), height: Math.max(1e-6, width) }
    : { width: Math.max(1e-6, width), height: Math.max(1e-6, height) };
};

/**
 * Returns output dimensions from the same combined rotation used to sample the
 * image. Keeping crop straightening in this calculation prevents render and
 * export bounds from disagreeing when the two rotations form a quarter turn.
 */
export const editedFrameDimensions = (
  width: number,
  height: number,
  geometryRotationDegrees: number,
  cropAngleDegrees: number,
): { width: number; height: number } =>
  orientedFrameDimensions(
    width,
    height,
    finite(geometryRotationDegrees) + finite(cropAngleDegrees),
  );

const stableProjectiveDenominator = (value: number): number => {
  if (Math.abs(value) >= 0.05) return value;
  return value < 0 ? -0.05 : 0.05;
};

/** Maps a rectified frame point through an inverse projective keystone term. */
export const projectiveFrameToSource = (
  x: number,
  y: number,
  horizontal: number,
  vertical: number,
): { x: number; y: number } => {
  const denominator = stableProjectiveDenominator(
    1 + finite(horizontal) * finite(x) + finite(vertical) * finite(y),
  );
  return { x: finite(x) / denominator, y: finite(y) / denominator };
};

/** Exact inverse of projectiveFrameToSource for overlay/source alignment. */
export const projectiveSourceToFrame = (
  x: number,
  y: number,
  horizontal: number,
  vertical: number,
): { x: number; y: number } => {
  const denominator = stableProjectiveDenominator(
    1 - finite(horizontal) * finite(x) - finite(vertical) * finite(y),
  );
  return { x: finite(x) / denominator, y: finite(y) / denominator };
};

export const minimumFillScale = ({
  frameWidth,
  frameHeight,
  sourceWidth,
  sourceHeight,
  angleRadians,
  horizontal = 0,
  vertical = 0,
  offsetX = 0,
  offsetY = 0,
}: {
  frameWidth: number;
  frameHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  angleRadians: number;
  horizontal?: number;
  vertical?: number;
  offsetX?: number;
  offsetY?: number;
}): number => {
  const cosine = Math.cos(finite(angleRadians));
  const sine = Math.sin(finite(angleRadians));
  const safeSourceWidth = Math.max(1e-6, finite(sourceWidth, 1));
  const safeSourceHeight = Math.max(1e-6, finite(sourceHeight, 1));
  const halfFrameWidth = Math.max(1e-6, finite(frameWidth, 1)) / 2;
  const halfFrameHeight = Math.max(1e-6, finite(frameHeight, 1)) / 2;
  let maximumX = 0;
  let maximumY = 0;

  for (const frameX of [-halfFrameWidth, halfFrameWidth]) {
    for (const frameY of [-halfFrameHeight, halfFrameHeight]) {
      const unrotatedX = cosine * frameX + sine * frameY;
      const unrotatedY = -sine * frameX + cosine * frameY;
      const localX = unrotatedX / safeSourceWidth;
      const localY = unrotatedY / safeSourceHeight;
      const transformed = projectiveFrameToSource(
        localX,
        localY,
        finite(horizontal),
        finite(vertical),
      );
      const transformedX = transformed.x;
      const transformedY = transformed.y;
      maximumX = Math.max(maximumX, Math.abs(transformedX));
      maximumY = Math.max(maximumY, Math.abs(transformedY));
    }
  }

  const horizontalRoom = Math.max(0.01, 0.5 - Math.abs(finite(offsetX)));
  const verticalRoom = Math.max(0.01, 0.5 - Math.abs(finite(offsetY)));
  return Math.max(
    1,
    maximumX / horizontalRoom,
    maximumY / verticalRoom,
  );
};

const blankHistogram = (): HistogramData => ({
  red: Array<number>(256).fill(0),
  green: Array<number>(256).fill(0),
  blue: Array<number>(256).fill(0),
  luminance: Array<number>(256).fill(0),
});

const copyHistogram = (histogram: HistogramData): HistogramData => ({
  red: [...histogram.red],
  green: [...histogram.green],
  blue: [...histogram.blue],
  luminance: [...histogram.luminance],
});

const luminance = (color: Rgb): number =>
  color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;

const mix = (a: number, b: number, amount: number): number =>
  a + (b - a) * clamp(amount);

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = clamp((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

const ellipseWeightAt = (
  x: number,
  y: number,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  inner = 0.72,
): number =>
  1 - smoothstep(
    inner,
    1.08,
    Math.hypot(
      (x - centerX) / radiusX,
      (y - centerY) / radiusY,
    ),
  );

const fract = (value: number): number => value - Math.floor(value);

/**
 * Eight-tap kernels used by both the Canvas2D renderer and mirrored in GLSL.
 * Every kernel is centered, which avoids a shape selection shifting the image.
 */
export const lensBlurSampleOffsets = (
  shape: LensBokehShape,
  frameX = 0.5,
  frameY = 0.5,
): LensBlurSampleOffset[] => {
  const circlePoint = (index: number, radius = 1): LensBlurSampleOffset => {
    const angle = -Math.PI / 2 + index * Math.PI / 4;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  };

  if (shape === "bubble") {
    return Array.from({ length: 8 }, (_, index) =>
      circlePoint(index, index % 2 === 0 ? 1.25 : 0.42),
    );
  }
  if (shape === "five-blade") {
    return Array.from({ length: 8 }, (_, index) => {
      const outer = index < 5;
      const bladeIndex = outer ? index : index - 5;
      const count = outer ? 5 : 3;
      const angle = -Math.PI / 2 + bladeIndex * Math.PI * 2 / count;
      const radius = outer ? 1.18 : 0.3;
      return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
    });
  }
  if (shape === "ring") {
    return Array.from({ length: 8 }, (_, index) => circlePoint(index, 1.52));
  }
  if (shape === "cat-eye") {
    const centerX = finite(frameX, 0.5) - 0.5;
    const centerY = finite(frameY, 0.5) - 0.5;
    const distance = Math.hypot(centerX, centerY);
    const radialX = distance > 1e-6 ? centerX / distance : 1;
    const radialY = distance > 1e-6 ? centerY / distance : 0;
    const tangentX = -radialY;
    const tangentY = radialX;
    return Array.from({ length: 8 }, (_, index) => {
      const point = circlePoint(index);
      return {
        x: tangentX * point.x * 1.22 + radialX * point.y * 0.38,
        y: tangentY * point.x * 1.22 + radialY * point.y * 0.38,
      };
    });
  }
  return Array.from({ length: 8 }, (_, index) => circlePoint(index));
};

export const averageColorSamples = (
  samples: ReadonlyArray<readonly [number, number, number]>,
): Rgb => {
  if (samples.length === 0) return [0, 0, 0];
  const total = samples.reduce<Rgb>(
    (sum, sample) => [
      sum[0] + finite(sample[0]),
      sum[1] + finite(sample[1]),
      sum[2] + finite(sample[2]),
    ],
    [0, 0, 0],
  );
  return total.map((channel) => channel / samples.length) as Rgb;
};

export type DefringeHueFamily = "purple" | "green";

/**
 * Hue-range controls are 0...100 positions within a family band,
 * not raw degrees. Purple spans blue through red (and wraps the hue wheel),
 * while green spans yellow through aqua/blue.
 */
export const defringeHueRangeWeight = (
  hue: number,
  family: DefringeHueFamily,
  rangeLow: number,
  rangeHigh: number,
): number => {
  const domainStart = family === "purple" ? 220 : 55;
  const domainSpan = family === "purple" ? 160 : 160;
  let hueDegrees = fract(finite(hue) + 1) * 360;
  if (hueDegrees < domainStart) hueDegrees += 360;
  const position = (hueDegrees - domainStart) / domainSpan * 100;
  const low = clamp(Math.min(finite(rangeLow), finite(rangeHigh)), 0, 100);
  const high = clamp(Math.max(finite(rangeLow), finite(rangeHigh)), 0, 100);
  const feather = 4;
  return smoothstep(low - feather, low, position) *
    (1 - smoothstep(high, high + feather, position));
};

const rgbToHsv = (color: Rgb): Rgb => {
  const [r, g, b] = color;
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta > 1e-6) {
    if (maximum === r) hue = ((g - b) / delta) % 6;
    else if (maximum === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue /= 6;
    if (hue < 0) hue += 1;
  }
  return [hue, maximum <= 1e-6 ? 0 : delta / maximum, maximum];
};

const hsvToRgb = (hsv: Rgb): Rgb => {
  const hue = fract(hsv[0] + 1);
  const saturation = clamp(hsv[1]);
  const value = Math.max(0, hsv[2]);
  const sector = Math.floor(hue * 6);
  const fraction = hue * 6 - sector;
  const p = value * (1 - saturation);
  const q = value * (1 - fraction * saturation);
  const t = value * (1 - (1 - fraction) * saturation);
  switch (sector % 6) {
    case 0:
      return [value, t, p];
    case 1:
      return [q, value, p];
    case 2:
      return [p, value, t];
    case 3:
      return [p, q, value];
    case 4:
      return [t, p, value];
    default:
      return [value, p, q];
  }
};

const samplePixelsInto = (
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  result: Rgb,
): Rgb => {
  const px = clamp(x, 0, 1) * Math.max(0, width - 1);
  const py = clamp(y, 0, 1) * Math.max(0, height - 1);
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = px - x0;
  const fy = py - y0;
  const a = (y0 * width + x0) * 4;
  const b = (y0 * width + x1) * 4;
  const c = (y1 * width + x0) * 4;
  const d = (y1 * width + x1) * 4;
  for (let index = 0; index < 3; index += 1) {
    const top = mix(pixels[a + index] / 255, pixels[b + index] / 255, fx);
    const bottom = mix(pixels[c + index] / 255, pixels[d + index] / 255, fx);
    result[index] = mix(top, bottom, fy);
  }
  return result;
};

const samplePixels = (
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
): Rgb => samplePixelsInto(pixels, width, height, x, y, [0, 0, 0]);

const sanitizeCurve = (curve: ToneCurvePoint[]): ToneCurvePoint[] => {
  const sorted = curve
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({ x: clamp(point.x), y: clamp(point.y) }))
    .sort((a, b) => a.x - b.x);
  if (sorted.length === 0) return [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  if (sorted.length <= MAX_CURVE_POINTS) return sorted;
  return Array.from({ length: MAX_CURVE_POINTS }, (_, index) => {
    const sourceIndex = Math.round(
      (index / (MAX_CURVE_POINTS - 1)) * (sorted.length - 1),
    );
    return sorted[sourceIndex];
  });
};

const isSanitizedIdentityToneCurve = (
  sanitized: ToneCurvePoint[],
): boolean => {
  if (
    sanitized[0].x !== 0 ||
    sanitized[0].y !== 0 ||
    sanitized[sanitized.length - 1].x !== 1 ||
    sanitized[sanitized.length - 1].y !== 1
  ) {
    return false;
  }
  return sanitized.every((point) => point.x === point.y);
};

/** True when evaluating the curve cannot alter any normalized channel value. */
export const isIdentityToneCurve = (curve: ToneCurvePoint[]): boolean =>
  isSanitizedIdentityToneCurve(sanitizeCurve(curve));

const adjustmentFlags = (
  state: EditState,
  curves?: CpuCurves,
): number => {
  const tone = curves?.tone ?? sanitizeCurve(state.curve);
  const channels = curves?.channels ?? [
    sanitizeCurve(state.redCurve),
    sanitizeCurve(state.greenCurve),
    sanitizeCurve(state.blueCurve),
  ];
  let flags = 0;
  if (!isSanitizedIdentityToneCurve(tone)) flags |= ADJUSTMENT_FLAG_TONE_CURVE;
  if (channels.some((curve) => !isSanitizedIdentityToneCurve(curve))) {
    flags |= ADJUSTMENT_FLAG_CHANNEL_CURVES;
  }
  if (
    hueChannelNames.some((name) => {
      const channel = state.hsl[name];
      return finite(channel?.hue) !== 0 ||
        finite(channel?.saturation) !== 0 ||
        finite(channel?.luminance) !== 0;
    })
  ) {
    flags |= ADJUSTMENT_FLAG_HSL;
  }
  if (
    [
      state.colorGrading.shadows,
      state.colorGrading.midtones,
      state.colorGrading.highlights,
    ].some(
      (wheel) =>
        percentage(wheel.saturation) > 0 || finite(wheel.luminance) !== 0,
    )
  ) {
    flags |= ADJUSTMENT_FLAG_COLOR_GRADING;
  }
  const calibration = state.calibration;
  if (
    finite(calibration.shadowsTint) !== 0 ||
    finite(calibration.redPrimaryHue) !== 0 ||
    finite(calibration.redPrimarySaturation) !== 0 ||
    finite(calibration.greenPrimaryHue) !== 0 ||
    finite(calibration.greenPrimarySaturation) !== 0 ||
    finite(calibration.bluePrimaryHue) !== 0 ||
    finite(calibration.bluePrimarySaturation) !== 0
  ) {
    flags |= ADJUSTMENT_FLAG_CALIBRATION;
  }
  const lens = state.lensCorrections;
  if (
    lens.removeChromaticAberration ||
    percentage(lens.defringePurpleAmount) > 0 ||
    percentage(lens.defringeGreenAmount) > 0
  ) {
    flags |= ADJUSTMENT_FLAG_LENS_COLOR;
  }
  if (finite(state.global.vignette) !== 0) {
    flags |= ADJUSTMENT_FLAG_VIGNETTE;
  }
  if (percentage(state.global.grain) > 0) {
    flags |= ADJUSTMENT_FLAG_GRAIN;
  }
  if (
    lensProfileCorrectionStrength(lens) !== 0 ||
    finite(lens.vignette) !== 0
  ) {
    flags |= ADJUSTMENT_FLAG_LENS_VIGNETTE;
  }
  if (state.lensBlur.enabled && percentage(state.lensBlur.amount) > 0) {
    flags |= ADJUSTMENT_FLAG_LENS_BLUR;
  }
  return flags;
};

const evaluateCurve = (value: number, curve: ToneCurvePoint[]): number => {
  if (value <= curve[0].x) return curve[0].y;
  for (let index = 1; index < curve.length; index += 1) {
    const next = curve[index];
    const previous = curve[index - 1];
    if (value <= next.x) {
      return mix(
        previous.y,
        next.y,
        (value - previous.x) / Math.max(1e-6, next.x - previous.x),
      );
    }
  }
  return curve[curve.length - 1].y;
};

const parseColor = (value: string | undefined): Rgb => {
  if (!value) return [1, 0.18, 0.1];
  const trimmed = value.trim().toLowerCase();
  const shortHex = /^#([0-9a-f]{3})$/i.exec(trimmed);
  if (shortHex) {
    return [
      Number.parseInt(shortHex[1][0] + shortHex[1][0], 16) / 255,
      Number.parseInt(shortHex[1][1] + shortHex[1][1], 16) / 255,
      Number.parseInt(shortHex[1][2] + shortHex[1][2], 16) / 255,
    ];
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(trimmed);
  if (hex) {
    return [
      Number.parseInt(hex[1].slice(0, 2), 16) / 255,
      Number.parseInt(hex[1].slice(2, 4), 16) / 255,
      Number.parseInt(hex[1].slice(4, 6), 16) / 255,
    ];
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(
    trimmed,
  );
  if (rgb) {
    return [
      clamp(Number(rgb[1]) / 255),
      clamp(Number(rgb[2]) / 255),
      clamp(Number(rgb[3]) / 255),
    ];
  }
  return [1, 0.18, 0.1];
};

const hueCenters = [
  0 / 360,
  30 / 360,
  60 / 360,
  120 / 360,
  180 / 360,
  240 / 360,
  275 / 360,
  320 / 360,
];

const hueChannelNames = [
  "red",
  "orange",
  "yellow",
  "green",
  "aqua",
  "blue",
  "purple",
  "magenta",
] as const;

const applyHsl = (color: Rgb, adjustments: HslAdjustments): Rgb => {
  const hsv = rgbToHsv(color);
  let weightTotal = 0;
  let hueDelta = 0;
  let saturationDelta = 0;
  let luminanceDelta = 0;
  for (let index = 0; index < hueCenters.length; index += 1) {
    const distance = Math.min(
      Math.abs(hsv[0] - hueCenters[index]),
      1 - Math.abs(hsv[0] - hueCenters[index]),
    );
    const weight = 1 - smoothstep(0.04, 0.17, distance);
    const channel = adjustments[hueChannelNames[index]];
    weightTotal += weight;
    hueDelta += weight * finite(channel?.hue);
    saturationDelta += weight * finite(channel?.saturation);
    luminanceDelta += weight * finite(channel?.luminance);
  }
  if (weightTotal > 1e-6) {
    hsv[0] = fract(hsv[0] + (hueDelta / weightTotal / 100) * (30 / 360) + 1);
    hsv[1] = clamp(hsv[1] * (1 + saturationDelta / weightTotal / 100));
    hsv[2] = Math.max(0, hsv[2] * (1 + luminanceDelta / weightTotal / 100));
  }
  return hsvToRgb(hsv);
};

const applyPointColor = (color: Rgb, state: EditState): Rgb => {
  const point = state.pointColor;
  if (!point.enabled) return color;
  const hsv = rgbToHsv(color);
  const center = fract(finite(point.hue) / 360 + 1);
  const distance = Math.min(Math.abs(hsv[0] - center), 1 - Math.abs(hsv[0] - center));
  const range = Math.max(3 / 360, (finite(point.range, 25) / 100) * 0.5);
  const weight = 1 - smoothstep(range * 0.55, range, distance);
  hsv[0] = fract(hsv[0] + weight * finite(point.hueShift) / 100 * (30 / 360) + 1);
  hsv[1] = clamp(hsv[1] * (1 + weight * finite(point.saturationShift) / 100));
  hsv[2] = Math.max(0, hsv[2] * (1 + weight * finite(point.luminanceShift) / 100));
  return hsvToRgb(hsv);
};

const applyCalibration = (color: Rgb, state: EditState): Rgb => {
  const calibration = state.calibration;
  let hsv = rgbToHsv(color);
  const primaries = [
    [0, calibration.redPrimaryHue, calibration.redPrimarySaturation],
    [1 / 3, calibration.greenPrimaryHue, calibration.greenPrimarySaturation],
    [2 / 3, calibration.bluePrimaryHue, calibration.bluePrimarySaturation],
  ] as const;
  for (const [center, hue, saturation] of primaries) {
    const distance = Math.min(Math.abs(hsv[0] - center), 1 - Math.abs(hsv[0] - center));
    const weight = 1 - smoothstep(0.08, 0.28, distance);
    hsv[0] = fract(hsv[0] + weight * finite(hue) / 100 * (18 / 360) + 1);
    hsv[1] = clamp(hsv[1] * (1 + weight * finite(saturation) / 100));
  }
  let adjusted = hsvToRgb(hsv);
  const shadowWeight = 1 - smoothstep(0.08, 0.52, luminance(adjusted));
  const shadowTint = finite(calibration.shadowsTint) / 100 * shadowWeight;
  adjusted = [
    adjusted[0] + shadowTint * 0.035,
    adjusted[1] - Math.abs(shadowTint) * 0.012,
    adjusted[2] - shadowTint * 0.035,
  ];
  return adjusted.map((channel) => clamp(channel)) as Rgb;
};

const applyLensColorCorrection = (color: Rgb, state: EditState): Rgb => {
  const lens = state.lensCorrections;
  let adjusted: Rgb = [...color];
  if (lens.removeChromaticAberration) {
    const lightness = luminance(adjusted);
    const purple = clamp((adjusted[0] + adjusted[2] - adjusted[1] * 2) * 2.2);
    const green = clamp((adjusted[1] * 1.7 - adjusted[0] - adjusted[2]) * 1.8);
    adjusted = adjusted.map((channel) =>
      mix(channel, lightness, Math.max(purple, green) * 0.42),
    ) as Rgb;
  }
  const lightness = luminance(adjusted);
  const purpleAmount = percentage(lens.defringePurpleAmount);
  const greenAmount = percentage(lens.defringeGreenAmount);
  const hue = rgbToHsv(adjusted)[0];
  const purpleHueWeight = defringeHueRangeWeight(
    hue,
    "purple",
    lens.defringePurpleHueLow,
    lens.defringePurpleHueHigh,
  );
  const greenHueWeight = defringeHueRangeWeight(
    hue,
    "green",
    lens.defringeGreenHueLow,
    lens.defringeGreenHueHigh,
  );
  const purple = clamp((adjusted[0] + adjusted[2] - adjusted[1] * 2) * 2.4);
  const green = clamp((adjusted[1] * 1.8 - adjusted[0] - adjusted[2]) * 1.9);
  adjusted = adjusted.map((channel) =>
    mix(
      channel,
      lightness,
      purple * purpleHueWeight * purpleAmount * 0.75 +
        green * greenHueWeight * greenAmount * 0.72,
    ),
  ) as Rgb;
  return adjusted;
};

const applyBasicTone = (
  input: Rgb,
  blurred: Rgb,
  adjustments: Pick<
    GlobalAdjustments,
    | "exposure"
    | "contrast"
    | "highlights"
    | "shadows"
    | "temperature"
    | "tint"
    | "saturation"
    | "clarity"
    | "dehaze"
  > & {
    whites?: number;
    blacks?: number;
    vibrance?: number;
    texture?: number;
    sharpening?: number;
    sharpeningRadius?: number;
    sharpeningDetail?: number;
    sharpeningMasking?: number;
    noiseReduction?: number;
    noiseReductionDetail?: number;
    noiseReductionContrast?: number;
    colorNoiseReduction?: number;
    colorNoiseReductionDetail?: number;
    colorNoiseReductionSmoothness?: number;
  },
): Rgb => {
  let color: Rgb = [...input];
  const temperature = finite(adjustments.temperature) / 100;
  const tint = finite(adjustments.tint) / 100;
  color = [
    color[0] + temperature * 0.11 + tint * 0.045,
    color[1] + temperature * 0.018 - tint * 0.075,
    color[2] - temperature * 0.11 + tint * 0.045,
  ];
  const exposure = 2 ** finite(adjustments.exposure);
  color = color.map((channel) => channel * exposure) as Rgb;

  let lightness = luminance(color);
  const shadowWeight = 1 - smoothstep(0.12, 0.64, lightness);
  const highlightWeight = smoothstep(0.36, 0.9, lightness);
  const shadows = finite(adjustments.shadows) / 100;
  const highlights = finite(adjustments.highlights) / 100;
  const whites = finite(adjustments.whites ?? 0) / 100;
  const blacks = finite(adjustments.blacks ?? 0) / 100;
  color = color.map((channel) => {
    let result = channel;
    result += shadows * shadowWeight * (1 - result) * 0.65;
    result += highlights * highlightWeight * (1 - result) * 0.55;
    result += whites * smoothstep(0.62, 1, lightness) * 0.35;
    result += blacks * (1 - smoothstep(0, 0.38, lightness)) * 0.3;
    return result;
  }) as Rgb;

  const contrast = 1 + finite(adjustments.contrast) / 100;
  color = color.map((channel) => (channel - 0.5) * contrast + 0.5) as Rgb;

  const noiseReduction = percentage(adjustments.noiseReduction ?? 0);
  const noiseDetail = percentage(adjustments.noiseReductionDetail ?? 50);
  const noiseContrast = percentage(adjustments.noiseReductionContrast ?? 0);
  color = color.map((channel, index) =>
    mix(
      channel,
      blurred[index],
      noiseReduction * (0.82 - noiseDetail * 0.42) * (1 - noiseContrast * 0.25),
    ),
  ) as Rgb;
  const sharpeningRadius = clamp(finite(adjustments.sharpeningRadius ?? 1) / 3);
  const sharpeningDetail = percentage(adjustments.sharpeningDetail ?? 25);
  const sharpeningMasking = percentage(adjustments.sharpeningMasking ?? 0);
  const edgeStrength = clamp(Math.abs(luminance(input) - luminance(blurred)) * 10);
  const sharpeningMask = smoothstep(sharpeningMasking * 0.65, 1, edgeStrength);
  const detail =
    finite(adjustments.texture ?? 0) * 0.0035 +
    finite(adjustments.clarity) * 0.005 +
    finite(adjustments.sharpening ?? 0) * 0.0025 *
      (0.62 + sharpeningRadius * 0.38) *
      (0.7 + sharpeningDetail * 0.6) *
      sharpeningMask;
  color = color.map(
    (channel, index) => channel + (input[index] - blurred[index]) * detail,
  ) as Rgb;

  const dehaze = finite(adjustments.dehaze) / 100;
  color = color.map((channel) => (channel - 0.72 * dehaze) / (1 - 0.72 * dehaze)) as Rgb;

  lightness = luminance(color);
  const saturation = 1 + finite(adjustments.saturation) / 100;
  const vibrance =
    (finite(adjustments.vibrance ?? 0) / 100) *
    (1 - (Math.max(...color) - Math.min(...color)));
  color = color.map((channel) =>
    lightness + (channel - lightness) * saturation * (1 + vibrance),
  ) as Rgb;

  const colorNoise = percentage(adjustments.colorNoiseReduction ?? 0);
  if (colorNoise > 0) {
    const colorDetail = percentage(adjustments.colorNoiseReductionDetail ?? 50);
    const colorSmoothness = percentage(adjustments.colorNoiseReductionSmoothness ?? 50);
    const blurLightness = luminance(blurred);
    color = color.map((channel, index) => {
      const neutralBlur = blurred[index] - blurLightness;
      return mix(
        channel,
        lightness + neutralBlur * (0.45 + colorDetail * 0.55),
        colorNoise * (0.22 + colorSmoothness * 0.28),
      );
    }) as Rgb;
  }
  return color.map((channel) => clamp(channel)) as Rgb;
};

const processGlobalCpu = (
  input: Rgb,
  blurred: Rgb,
  state: EditState,
  frameX: number,
  frameY: number,
  curves: CpuCurves,
  flags: number,
): Rgb => {
  let color = applyBasicTone(input, blurred, state.global);
  if ((flags & ADJUSTMENT_FLAG_TONE_CURVE) !== 0) {
    color = color.map((channel) =>
      evaluateCurve(clamp(channel), curves.tone),
    ) as Rgb;
  }
  if ((flags & ADJUSTMENT_FLAG_CHANNEL_CURVES) !== 0) {
    color = color.map((channel, index) =>
      evaluateCurve(clamp(channel), curves.channels[index]),
    ) as Rgb;
  }
  if ((flags & ADJUSTMENT_FLAG_HSL) !== 0) {
    color = applyHsl(color, state.hsl);
  }
  color = applyPointColor(color, state);
  if ((flags & ADJUSTMENT_FLAG_CALIBRATION) !== 0) {
    color = applyCalibration(color, state);
  }
  if ((flags & ADJUSTMENT_FLAG_LENS_COLOR) !== 0) {
    color = applyLensColorCorrection(color, state);
  }

  if ((flags & ADJUSTMENT_FLAG_COLOR_GRADING) !== 0) {
    const lightness = luminance(color);
    const balance = finite(state.colorGrading.balance) / 100;
    const blending = clamp(finite(state.colorGrading.blending, 50) / 100);
    const gradePower = mix(1.8, 0.65, blending);
    const shadowWeight =
      Math.pow(1 - smoothstep(0.12, 0.62, lightness), gradePower) *
      (1 - balance * 0.5);
    const highlightWeight =
      Math.pow(smoothstep(0.38, 0.9, lightness), gradePower) *
      (1 + balance * 0.5);
    const midtoneWeight = clamp(1 - shadowWeight - highlightWeight);
    const wheels = [
      [state.colorGrading.shadows, shadowWeight],
      [state.colorGrading.midtones, midtoneWeight],
      [state.colorGrading.highlights, highlightWeight],
    ] as const;
    for (const [wheel, weight] of wheels) {
      const saturation = percentage(wheel.saturation);
      const tintColor = hsvToRgb([finite(wheel.hue) / 360, saturation, 1]);
      color = color.map(
        (channel, index) =>
          channel +
          (tintColor[index] - 0.5) * saturation * weight * 0.28 +
          (finite(wheel.luminance) / 100) * weight * 0.2,
      ) as Rgb;
    }
  }

  if ((flags & ADJUSTMENT_FLAG_VIGNETTE) !== 0) {
    const dx = frameX - 0.5;
    const dy = frameY - 0.5;
    const radius = Math.sqrt(dx * dx + dy * dy) / 0.70710678;
    const midpoint = clamp(finite(state.global.vignetteMidpoint) / 100);
    const feather = Math.max(0.02, clamp(finite(state.global.vignetteFeather) / 100));
    const vignetteMask = smoothstep(
      clamp(midpoint * 0.7, 0, 0.85),
      clamp(midpoint * 0.7 + feather, 0.05, 1),
      radius,
    );
    const vignette = finite(state.global.vignette) / 100;
    color = color.map((channel) =>
      vignette < 0
        ? channel * (1 + vignette * vignetteMask * 0.85)
        : channel + (1 - channel) * vignette * vignetteMask * 0.55,
    ) as Rgb;
  }

  if ((flags & ADJUSTMENT_FLAG_GRAIN) !== 0) {
    const grain = percentage(state.global.grain);
    const size = 1 + percentage(state.global.grainSize) * 9;
    const noise =
      fract(Math.sin((frameX * 1713 + frameY * 927) / size) * 43758.5453) - 0.5;
    color = color.map((channel) => channel + noise * grain * 0.16) as Rgb;
  }

  if ((flags & ADJUSTMENT_FLAG_LENS_VIGNETTE) !== 0) {
    const lensRadius = Math.sqrt((frameX - 0.5) ** 2 + (frameY - 0.5) ** 2) / 0.70710678;
    const lens = state.lensCorrections;
    const profileLift = lensProfileCorrectionStrength(lens) * 0.13;
    const manualLift = finite(lens.vignette) / 100 * 0.5;
    const lensFalloff = smoothstep(
      clamp(finite(lens.midpoint, 50) / 160, 0.05, 0.75),
      1,
      lensRadius,
    );
    color = color.map((channel) =>
      clamp(channel + (1 - channel) * (profileLift + manualLift) * lensFalloff),
    ) as Rgb;
  }

  if ((flags & ADJUSTMENT_FLAG_LENS_BLUR) !== 0) {
    const blur = state.lensBlur;
    const dx = frameX - finite(blur.focusX, 0.5);
    const dy = frameY - finite(blur.focusY, 0.42);
    const focusDistance = Math.sqrt(dx * dx + dy * dy);
    const focusRadius = 0.06 + percentage(blur.focusRange) * 0.42;
    const blurWeight = smoothstep(focusRadius, focusRadius + 0.22, focusDistance) *
      percentage(blur.amount);
    const boost = percentage(blur.boost);
    color = color.map((channel, index) =>
      clamp(mix(channel, blurred[index] + (blurred[index] - 0.5) * boost * 0.16, blurWeight)),
    ) as Rgb;
  }
  return color.map((channel) => clamp(channel)) as Rgb;
};

const profileIndex = (profile: string): number => {
  const canonical = canonicalProfileName(profile);
  if (canonical === "Darkroom Vivid") return 1;
  if (canonical === "Darkroom Portrait") return 2;
  if (canonical === "Darkroom Landscape") return 3;
  if (canonical === "Darkroom Monochrome") return 4;
  return 0;
};

const applyProfileCpu = (input: Rgb, profile: string): Rgb => {
  const selected = profileIndex(profile);
  let color: Rgb = [...input];
  if (selected === 1) {
    const lightness = luminance(color);
    color = color.map((channel) => (channel - 0.5) * 1.08 + 0.5) as Rgb;
    color = color.map(
      (channel) => lightness + (channel - lightness) * 1.14,
    ) as Rgb;
  } else if (selected === 2) {
    color = [color[0] + 0.018, color[1] + 0.006, color[2] - 0.014];
    const lightness = luminance(color);
    color = color.map((channel) => mix(channel, lightness, 0.035)) as Rgb;
  } else if (selected === 3) {
    const lightness = luminance(color);
    color = color.map(
      (channel) => lightness + (channel - lightness) * 1.18,
    ) as Rgb;
    color = [color[0] - 0.008, color[1] + 0.012, color[2] + 0.008];
  } else if (selected === 4) {
    const lightness = luminance(color);
    color = [lightness, lightness, lightness];
  }
  return color.map((channel) => clamp(channel)) as Rgb;
};

const VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;
layout(location = 1) in vec2 aFrameUv;
out vec2 vFrameUv;
void main() {
  vFrameUv = aFrameUv;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

#define MAX_MASKS 8
#define MAX_HEAL_SPOTS 32
#define MAX_CURVE_POINTS 16

in vec2 vFrameUv;
out vec4 outColor;

uniform sampler2D uImage;
uniform sampler2D uBrushAtlas;
uniform float uMaskCellTexel;
uniform vec2 uSourceSize;
uniform vec4 uCrop;
uniform vec4 uTransform;
uniform vec2 uAdjustedCropSize;
uniform vec4 uGeometry0;
uniform vec4 uGeometry1;
uniform bool uShowOriginal;
uniform bool uShowClipping;
uniform bool uVisualizeSpots;
uniform float uVisualizeSpotsThreshold;
uniform int uProfile;
uniform int uAdjustmentFlags;

uniform vec4 uGlobal0;
uniform vec4 uGlobal1;
uniform vec4 uGlobal2;
uniform vec4 uGlobal3;
uniform vec4 uGlobal4;
uniform float uGrainSize;
uniform vec4 uDetail0;
uniform vec4 uDetail1;

uniform int uCurveCount;
uniform vec2 uCurve[MAX_CURVE_POINTS];
uniform int uRedCurveCount;
uniform vec2 uRedCurve[MAX_CURVE_POINTS];
uniform int uGreenCurveCount;
uniform vec2 uGreenCurve[MAX_CURVE_POINTS];
uniform int uBlueCurveCount;
uniform vec2 uBlueCurve[MAX_CURVE_POINTS];
uniform vec3 uHsl[MAX_MASKS];
uniform vec4 uPointColor0;
uniform vec4 uPointColor1;
uniform vec4 uGradeShadows;
uniform vec4 uGradeMidtones;
uniform vec4 uGradeHighlights;
uniform vec2 uGradeMix;
uniform vec4 uLens0;
uniform vec4 uLens1;
uniform vec4 uLensDefringeHue;
uniform vec4 uLensBlur0;
uniform vec4 uLensBlur1;
uniform vec4 uCalibration0;
uniform vec4 uCalibration1;

uniform int uHealCount;
uniform vec4 uHealPosition[MAX_HEAL_SPOTS];
uniform vec4 uHealSettings[MAX_HEAL_SPOTS];

uniform int uMaskCount;
uniform int uMaskKind[MAX_MASKS];
uniform int uMaskInverted[MAX_MASKS];
uniform float uMaskOpacity[MAX_MASKS];
uniform vec4 uMaskData0[MAX_MASKS];
uniform vec4 uMaskData1[MAX_MASKS];
uniform vec4 uMaskAdjust0[MAX_MASKS];
uniform vec4 uMaskAdjust1[MAX_MASKS];
uniform vec4 uMaskAdjust2[MAX_MASKS];
uniform vec4 uMaskAdjust3[MAX_MASKS];
uniform vec4 uMaskAdjust4[MAX_MASKS];
uniform int uActiveMask;
uniform bool uShowMaskOverlay;
uniform vec3 uOverlayColor;
uniform int uOverlayMode;
uniform float uOverlayOpacity;

float saturate(float value) { return clamp(value, 0.0, 1.0); }
vec3 saturate3(vec3 value) { return clamp(value, vec3(0.0), vec3(1.0)); }
float luma(vec3 value) { return dot(value, vec3(0.2126, 0.7152, 0.0722)); }
float rand(vec2 point) {
  return fract(sin(dot(point, vec2(12.9898, 78.233))) * 43758.5453123);
}

vec3 rgbToHsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsvToRgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

vec2 mapToImage(vec2 frameUv, out vec2 localCoordinate) {
  vec2 rotated = (frameUv - 0.5) * uTransform.zw;
  vec2 unrotated = vec2(
    uTransform.x * rotated.x + uTransform.y * rotated.y,
    -uTransform.y * rotated.x + uTransform.x * rotated.y
  );
  vec2 local = unrotated / uAdjustedCropSize;
  local /= max(0.01, uGeometry0.x);
  float perspectiveDenominator = 1.0 + uGeometry0.y * local.x + uGeometry0.z * local.y;
  if (abs(perspectiveDenominator) < 0.05) {
    perspectiveDenominator = perspectiveDenominator < 0.0 ? -0.05 : 0.05;
  }
  local /= perspectiveDenominator;
  local -= vec2(uGeometry0.w, uGeometry1.x);
  if (uGeometry1.y > 0.5) local.x = -local.x;
  if (uGeometry1.z > 0.5) local.y = -local.y;
  localCoordinate = local;
  return uCrop.xy + uCrop.zw * (local + 0.5);
}

vec3 sourceAt(vec2 uv) {
  return texture(uImage, clamp(uv, vec2(0.0), vec2(1.0))).rgb;
}

vec2 lensBlurSampleOffset(int index) {
  const float PI = 3.141592653589793;
  float sampleIndex = float(index);
  float shape = uLensBlur0.x > 0.5 ? uLensBlur1.z : 0.0;
  float angle = -PI * 0.5 + sampleIndex * PI * 0.25;
  float radius = 1.0;

  if (shape > 0.5 && shape < 1.5) {
    radius = mod(sampleIndex, 2.0) < 0.5 ? 1.25 : 0.42;
  } else if (shape > 1.5 && shape < 2.5) {
    if (index < 5) {
      angle = -PI * 0.5 + sampleIndex * PI * 2.0 / 5.0;
      radius = 1.18;
    } else {
      angle = -PI * 0.5 + (sampleIndex - 5.0) * PI * 2.0 / 3.0;
      radius = 0.3;
    }
  } else if (shape > 2.5 && shape < 3.5) {
    radius = 1.52;
  }

  vec2 point = vec2(cos(angle), sin(angle)) * radius;
  if (shape > 3.5) {
    vec2 radial = vFrameUv - 0.5;
    float radialLength = length(radial);
    radial = radialLength > 0.000001 ? radial / radialLength : vec2(1.0, 0.0);
    vec2 tangent = vec2(-radial.y, radial.x);
    point = tangent * point.x * 1.22 + radial * point.y * 0.38;
  }
  return point;
}

vec3 applyProfile(vec3 color) {
  if (uProfile == 1) {
    float lightness = luma(color);
    color = (color - 0.5) * 1.08 + 0.5;
    color = vec3(lightness) + (color - lightness) * 1.14;
  } else if (uProfile == 2) {
    color += vec3(0.018, 0.006, -0.014);
    color = mix(color, vec3(luma(color)), 0.035);
  } else if (uProfile == 3) {
    float lightness = luma(color);
    color = vec3(lightness) + (color - lightness) * 1.18;
    color += vec3(-0.008, 0.012, 0.008);
  } else if (uProfile == 4) {
    float lightness = luma(color);
    color = vec3(lightness);
  }
  return saturate3(color);
}

vec3 healedSource(vec2 uv) {
  vec3 base = sourceAt(uv);
  vec2 distanceScale =
    uSourceSize / max(1.0, min(uSourceSize.x, uSourceSize.y));
  for (int index = 0; index < MAX_HEAL_SPOTS; index++) {
    if (index >= uHealCount) break;
    vec2 destination = uHealPosition[index].xy;
    vec2 source = uHealPosition[index].zw;
    vec2 delta = (uv - destination) * distanceScale;
    float radius = max(0.0001, uHealSettings[index].x);
    float distanceToSpot = length(delta);
    if (distanceToSpot < radius) {
      float feather = max(0.001, uHealSettings[index].y);
      float weight = 1.0 - smoothstep(radius * (1.0 - feather), radius, distanceToSpot);
      weight *= uHealSettings[index].z;
      vec2 sourceUv = uv + source - destination;
      if (all(greaterThanEqual(sourceUv, vec2(0.0))) && all(lessThanEqual(sourceUv, vec2(1.0)))) {
        vec3 replacement = sourceAt(sourceUv);
        if (uHealSettings[index].w > 1.5) {
          vec2 patchStep = vec2(
            radius / max(0.0001, distanceScale.x),
            radius / max(0.0001, distanceScale.y)
          ) * 0.32;
          vec3 patchAverage = (
            replacement +
            sourceAt(sourceUv + vec2(patchStep.x, 0.0)) +
            sourceAt(sourceUv - vec2(patchStep.x, 0.0)) +
            sourceAt(sourceUv + vec2(0.0, patchStep.y)) +
            sourceAt(sourceUv - vec2(0.0, patchStep.y))
          ) * 0.2;
          replacement = mix(replacement, patchAverage, 0.55);
          replacement *= clamp(luma(base) / max(0.02, luma(replacement)), 0.6, 1.7);
        } else if (uHealSettings[index].w > 0.5) {
          replacement *= clamp(luma(base) / max(0.02, luma(replacement)), 0.45, 2.2);
        }
        base = mix(base, replacement, saturate(weight));
      }
    }
  }
  return base;
}

vec3 applyBasic(
  vec3 inputColor,
  vec3 blurred,
  vec4 adjustment0,
  vec4 adjustment1,
  vec4 adjustment2,
  vec4 adjustment3
) {
  float exposure = adjustment0.x;
  float contrast = adjustment0.y;
  float highlights = adjustment0.z;
  float shadows = adjustment0.w;
  float whites = adjustment1.x;
  float blacks = adjustment1.y;
  float temperature = adjustment1.z;
  float tint = adjustment1.w;
  float vibrance = adjustment2.x;
  float saturation = adjustment2.y;
  float textureAmount = adjustment2.z;
  float clarity = adjustment2.w;
  float dehaze = adjustment3.x;
  float sharpening = adjustment3.y;
  float noiseReduction = adjustment3.z;
  float colorNoiseReduction = adjustment3.w;

  vec3 color = inputColor;
  color += vec3(0.11, 0.018, -0.11) * temperature / 100.0;
  color += vec3(0.045, -0.075, 0.045) * tint / 100.0;
  color *= exp2(exposure);

  float lightness = luma(color);
  float shadowWeight = 1.0 - smoothstep(0.12, 0.64, lightness);
  float highlightWeight = smoothstep(0.36, 0.9, lightness);
  color += (shadows / 100.0) * shadowWeight * (1.0 - color) * 0.65;
  color += (highlights / 100.0) * highlightWeight * (1.0 - color) * 0.55;
  color += (whites / 100.0) * smoothstep(0.62, 1.0, lightness) * 0.35;
  color += (blacks / 100.0) * (1.0 - smoothstep(0.0, 0.38, lightness)) * 0.3;
  color = (color - 0.5) * (1.0 + contrast / 100.0) + 0.5;

  float noiseDetail = saturate(uDetail0.w / 100.0);
  float noiseContrast = saturate(uDetail1.x / 100.0);
  color = mix(
    color,
    blurred,
    saturate(noiseReduction / 100.0) * (0.82 - noiseDetail * 0.42) * (1.0 - noiseContrast * 0.25)
  );
  float edgeStrength = saturate(abs(luma(inputColor) - luma(blurred)) * 10.0);
  float sharpenMask = smoothstep(saturate(uDetail0.z / 100.0) * 0.65, 1.0, edgeStrength);
  float radiusScale = 0.62 + saturate(uDetail0.x / 3.0) * 0.38;
  float detailScale = 0.7 + saturate(uDetail0.y / 100.0) * 0.6;
  float detail = textureAmount * 0.0035 + clarity * 0.005 + sharpening * 0.0025 * radiusScale * detailScale * sharpenMask;
  color += (inputColor - blurred) * detail;
  float haze = dehaze / 100.0;
  color = (color - 0.72 * haze) / max(0.2, 1.0 - 0.72 * haze);

  lightness = luma(color);
  float chroma = max(color.r, max(color.g, color.b)) - min(color.r, min(color.g, color.b));
  float vibranceScale = 1.0 + (vibrance / 100.0) * (1.0 - chroma);
  color = lightness + (color - lightness) * (1.0 + saturation / 100.0) * vibranceScale;
  float blurLightness = luma(blurred);
  vec3 reducedChroma = vec3(lightness) + (blurred - blurLightness);
  float colorDetail = saturate(uDetail1.y / 100.0);
  float colorSmoothness = saturate(uDetail1.z / 100.0);
  reducedChroma = vec3(lightness) + (blurred - blurLightness) * (0.45 + colorDetail * 0.55);
  color = mix(
    color,
    reducedChroma,
    saturate(colorNoiseReduction / 100.0) * (0.22 + colorSmoothness * 0.28)
  );
  return saturate3(color);
}

float curveValue(float value) {
  if (uCurveCount <= 0) return value;
  if (value <= uCurve[0].x) return uCurve[0].y;
  vec2 previous = uCurve[0];
  for (int index = 1; index < MAX_CURVE_POINTS; index++) {
    if (index >= uCurveCount) break;
    vec2 next = uCurve[index];
    if (value <= next.x) {
      float amount = (value - previous.x) / max(0.00001, next.x - previous.x);
      return mix(previous.y, next.y, saturate(amount));
    }
    previous = next;
  }
  return previous.y;
}

float redCurveValue(float value) {
  if (uRedCurveCount <= 0) return value;
  if (value <= uRedCurve[0].x) return uRedCurve[0].y;
  vec2 previous = uRedCurve[0];
  for (int index = 1; index < MAX_CURVE_POINTS; index++) {
    if (index >= uRedCurveCount) break;
    vec2 next = uRedCurve[index];
    if (value <= next.x) return mix(previous.y, next.y, saturate((value - previous.x) / max(0.00001, next.x - previous.x)));
    previous = next;
  }
  return previous.y;
}

float greenCurveValue(float value) {
  if (uGreenCurveCount <= 0) return value;
  if (value <= uGreenCurve[0].x) return uGreenCurve[0].y;
  vec2 previous = uGreenCurve[0];
  for (int index = 1; index < MAX_CURVE_POINTS; index++) {
    if (index >= uGreenCurveCount) break;
    vec2 next = uGreenCurve[index];
    if (value <= next.x) return mix(previous.y, next.y, saturate((value - previous.x) / max(0.00001, next.x - previous.x)));
    previous = next;
  }
  return previous.y;
}

float blueCurveValue(float value) {
  if (uBlueCurveCount <= 0) return value;
  if (value <= uBlueCurve[0].x) return uBlueCurve[0].y;
  vec2 previous = uBlueCurve[0];
  for (int index = 1; index < MAX_CURVE_POINTS; index++) {
    if (index >= uBlueCurveCount) break;
    vec2 next = uBlueCurve[index];
    if (value <= next.x) return mix(previous.y, next.y, saturate((value - previous.x) / max(0.00001, next.x - previous.x)));
    previous = next;
  }
  return previous.y;
}

vec3 applyHslAdjustments(vec3 color) {
  vec3 hsv = rgbToHsv(color);
  float centers[MAX_MASKS] = float[MAX_MASKS](
    0.0, 30.0 / 360.0, 60.0 / 360.0, 120.0 / 360.0,
    180.0 / 360.0, 240.0 / 360.0, 275.0 / 360.0, 320.0 / 360.0
  );
  vec3 accumulated = vec3(0.0);
  float total = 0.0;
  for (int index = 0; index < MAX_MASKS; index++) {
    float directDistance = abs(hsv.x - centers[index]);
    float distanceToHue = min(directDistance, 1.0 - directDistance);
    float weight = 1.0 - smoothstep(0.04, 0.17, distanceToHue);
    accumulated += uHsl[index] * weight;
    total += weight;
  }
  if (total > 0.0001) {
    vec3 adjustment = accumulated / total;
    hsv.x = fract(hsv.x + (adjustment.x / 100.0) * (30.0 / 360.0) + 1.0);
    hsv.y = saturate(hsv.y * (1.0 + adjustment.y / 100.0));
    hsv.z = max(0.0, hsv.z * (1.0 + adjustment.z / 100.0));
  }
  return saturate3(hsvToRgb(hsv));
}

vec3 applyPointColor(vec3 color) {
  if (uPointColor0.x < 0.5) return color;
  vec3 hsv = rgbToHsv(color);
  float center = fract(uPointColor0.y / 360.0 + 1.0);
  float directDistance = abs(hsv.x - center);
  float distanceToHue = min(directDistance, 1.0 - directDistance);
  float width = max(3.0 / 360.0, saturate(uPointColor0.z / 100.0) * 0.5);
  float weight = 1.0 - smoothstep(width * 0.55, width, distanceToHue);
  hsv.x = fract(hsv.x + weight * uPointColor0.w / 100.0 * (30.0 / 360.0) + 1.0);
  hsv.y = saturate(hsv.y * (1.0 + weight * uPointColor1.x / 100.0));
  hsv.z = max(0.0, hsv.z * (1.0 + weight * uPointColor1.y / 100.0));
  return saturate3(hsvToRgb(hsv));
}

vec3 applyCalibration(vec3 color) {
  vec3 hsv = rgbToHsv(color);
  float centers[3] = float[3](0.0, 1.0 / 3.0, 2.0 / 3.0);
  vec2 changes[3] = vec2[3](
    vec2(uCalibration0.y, uCalibration0.z),
    vec2(uCalibration0.w, uCalibration1.x),
    vec2(uCalibration1.y, uCalibration1.z)
  );
  for (int index = 0; index < 3; index++) {
    float directDistance = abs(hsv.x - centers[index]);
    float distanceToHue = min(directDistance, 1.0 - directDistance);
    float weight = 1.0 - smoothstep(0.08, 0.28, distanceToHue);
    hsv.x = fract(hsv.x + weight * changes[index].x / 100.0 * (18.0 / 360.0) + 1.0);
    hsv.y = saturate(hsv.y * (1.0 + weight * changes[index].y / 100.0));
  }
  vec3 adjusted = hsvToRgb(hsv);
  float shadowWeight = 1.0 - smoothstep(0.08, 0.52, luma(adjusted));
  float shadowTint = uCalibration0.x / 100.0 * shadowWeight;
  adjusted += vec3(shadowTint * 0.035, -abs(shadowTint) * 0.012, -shadowTint * 0.035);
  return saturate3(adjusted);
}

vec3 applyLensColorCorrection(vec3 color) {
  float lightness = luma(color);
  vec3 hsv = rgbToHsv(color);
  float purple = saturate((color.r + color.b - color.g * 2.0) * 2.4);
  float green = saturate((color.g * 1.8 - color.r - color.b) * 1.9);
  float hueDegrees = fract(hsv.x) * 360.0;
  float purpleHue = hueDegrees < 220.0 ? hueDegrees + 360.0 : hueDegrees;
  float greenHue = hueDegrees < 55.0 ? hueDegrees + 360.0 : hueDegrees;
  float purplePosition = (purpleHue - 220.0) / 160.0 * 100.0;
  float greenPosition = (greenHue - 55.0) / 160.0 * 100.0;
  float purpleLow = min(uLensDefringeHue.x, uLensDefringeHue.y);
  float purpleHigh = max(uLensDefringeHue.x, uLensDefringeHue.y);
  float greenLow = min(uLensDefringeHue.z, uLensDefringeHue.w);
  float greenHigh = max(uLensDefringeHue.z, uLensDefringeHue.w);
  float purpleHueWeight =
    smoothstep(purpleLow - 4.0, purpleLow, purplePosition) *
    (1.0 - smoothstep(purpleHigh, purpleHigh + 4.0, purplePosition));
  float greenHueWeight =
    smoothstep(greenLow - 4.0, greenLow, greenPosition) *
    (1.0 - smoothstep(greenHigh, greenHigh + 4.0, greenPosition));
  float amount =
    purple * purpleHueWeight * saturate(uLens1.y / 100.0) * 0.75 +
    green * greenHueWeight * saturate(uLens1.z / 100.0) * 0.72;
  if (uLens0.x > 0.5) amount = max(amount, max(purple, green) * 0.42);
  return mix(color, vec3(lightness), saturate(amount));
}

vec3 applyGradeWheel(vec3 color, vec4 wheel, float weight) {
  float saturation = saturate(wheel.y / 100.0);
  vec3 tintColor = hsvToRgb(vec3(fract(wheel.x / 360.0), saturation, 1.0));
  color += (tintColor - 0.5) * saturation * weight * 0.28;
  color += (wheel.z / 100.0) * weight * 0.2;
  return color;
}

vec3 applyGlobal(vec3 inputColor, vec3 blurred) {
  vec3 color = applyBasic(inputColor, blurred, uGlobal0, uGlobal1, uGlobal2, uGlobal3);
  if ((uAdjustmentFlags & ${ADJUSTMENT_FLAG_TONE_CURVE}) != 0) {
    color = vec3(curveValue(color.r), curveValue(color.g), curveValue(color.b));
  }
  if ((uAdjustmentFlags & ${ADJUSTMENT_FLAG_CHANNEL_CURVES}) != 0) {
    color = vec3(redCurveValue(color.r), greenCurveValue(color.g), blueCurveValue(color.b));
  }
  if ((uAdjustmentFlags & ${ADJUSTMENT_FLAG_HSL}) != 0) {
    color = applyHslAdjustments(color);
  }
  color = applyPointColor(color);
  if ((uAdjustmentFlags & ${ADJUSTMENT_FLAG_CALIBRATION}) != 0) {
    color = applyCalibration(color);
  }
  if ((uAdjustmentFlags & ${ADJUSTMENT_FLAG_LENS_COLOR}) != 0) {
    color = applyLensColorCorrection(color);
  }
  if ((uAdjustmentFlags & ${ADJUSTMENT_FLAG_COLOR_GRADING}) != 0) {
    float lightness = luma(color);
    float balance = uGradeMix.y / 100.0;
    float blending = saturate(uGradeMix.x / 100.0);
    float gradePower = mix(1.8, 0.65, blending);
    float shadowWeight = pow(1.0 - smoothstep(0.12, 0.62, lightness), gradePower) * (1.0 - balance * 0.5);
    float highlightWeight = pow(smoothstep(0.38, 0.9, lightness), gradePower) * (1.0 + balance * 0.5);
    float middleWeight = saturate(1.0 - shadowWeight - highlightWeight);
    color = applyGradeWheel(color, uGradeShadows, shadowWeight);
    color = applyGradeWheel(color, uGradeMidtones, middleWeight);
    color = applyGradeWheel(color, uGradeHighlights, highlightWeight);
  }

  if ((uAdjustmentFlags & ${ADJUSTMENT_FLAG_VIGNETTE}) != 0) {
    float radius = length(vFrameUv - 0.5) / 0.70710678;
    float midpoint = saturate(uGlobal4.y / 100.0);
    float feather = max(0.02, saturate(uGlobal4.z / 100.0));
    float vignetteMask = smoothstep(
      clamp(midpoint * 0.7, 0.0, 0.85),
      clamp(midpoint * 0.7 + feather, 0.05, 1.0),
      radius
    );
    float vignette = uGlobal4.x / 100.0;
    if (vignette < 0.0) color *= 1.0 + vignette * vignetteMask * 0.85;
    else color += (1.0 - color) * vignette * vignetteMask * 0.55;
  }

  if ((uAdjustmentFlags & ${ADJUSTMENT_FLAG_GRAIN}) != 0) {
    float grain = saturate(uGlobal4.w / 100.0);
    float grainScale = 1.0 + saturate(uGrainSize / 100.0) * 9.0;
    color += (rand(gl_FragCoord.xy / grainScale) - 0.5) * grain * 0.16;
  }

  if ((uAdjustmentFlags & ${ADJUSTMENT_FLAG_LENS_VIGNETTE}) != 0) {
    float lensRadius = length(vFrameUv - 0.5) / 0.70710678;
    float profileLift = uLens0.y * 0.13;
    float manualLift = uLens0.w / 100.0 * 0.5;
    float lensFalloff = smoothstep(clamp(uLens1.x / 160.0, 0.05, 0.75), 1.0, lensRadius);
    color += (1.0 - color) * (profileLift + manualLift) * lensFalloff;
  }

  if ((uAdjustmentFlags & ${ADJUSTMENT_FLAG_LENS_BLUR}) != 0) {
    vec2 focusDelta = vFrameUv - uLensBlur1.xy;
    float focusDistance = length(focusDelta);
    float focusRadius = 0.06 + saturate(uLensBlur0.z / 100.0) * 0.42;
    float blurWeight = smoothstep(focusRadius, focusRadius + 0.22, focusDistance) * saturate(uLensBlur0.y / 100.0);
    vec3 blurTarget = blurred + (blurred - 0.5) * saturate(uLensBlur0.w / 100.0) * 0.16;
    color = mix(color, blurTarget, blurWeight);
  }
  return saturate3(color);
}

float brushMask(int index, vec2 uv) {
  float column = mod(float(index), 4.0);
  float row = floor(float(index) / 4.0);
  // Stay on texel centers at cell edges so linear filtering cannot bleed a
  // neighbouring mask into this one.
  vec2 safeUv = clamp(
    uv,
    vec2(0.5 * uMaskCellTexel),
    vec2(1.0 - 0.5 * uMaskCellTexel)
  );
  vec2 atlasUv = (vec2(column, row) + safeUv) / vec2(4.0, 2.0);
  return texture(uBrushAtlas, atlasUv).a;
}

float maskWeight(int index, vec2 uv, vec3 color) {
  float value = brushMask(index, uv);
  if (uMaskInverted[index] != 0) value = 1.0 - value;
  return saturate(value * uMaskOpacity[index]);
}

vec3 applyLocal(vec3 color, vec3 blurred, int index) {
  vec4 local0 = uMaskAdjust0[index];
  vec4 local1 = uMaskAdjust1[index];
  vec4 local2 = uMaskAdjust2[index];
  vec4 local3 = uMaskAdjust3[index];
  vec4 local4 = uMaskAdjust4[index];
  vec4 basic0 = local0;
  vec4 basic1 = local1;
  vec4 basic2 = local2;
  vec4 basic3 = vec4(local3.x, local3.y, local3.z, 0.0);
  vec3 adjusted = applyBasic(color, blurred, basic0, basic1, basic2, basic3);
  if (abs(local3.w) > 0.0001) {
    vec3 hsv = rgbToHsv(adjusted);
    hsv.x = fract(hsv.x + local3.w / 360.0 + 1.0);
    adjusted = hsvToRgb(hsv);
  }
  float moire = saturate(local4.x / 100.0);
  if (moire > 0.0001) {
    float adjustedLightness = luma(adjusted);
    float blurredLightness = luma(blurred);
    vec3 reducedChroma = vec3(adjustedLightness) + (blurred - blurredLightness);
    float chromaDifference = length(
      (adjusted - adjustedLightness) - (blurred - blurredLightness)
    );
    float artifactWeight = smoothstep(0.015, 0.12, chromaDifference);
    adjusted = mix(adjusted, reducedChroma, moire * artifactWeight * 0.85);
  }
  float defringe = saturate(local4.y / 100.0);
  float purple = saturate((adjusted.b + adjusted.r - adjusted.g * 2.0) * 2.4);
  adjusted = mix(adjusted, vec3(luma(adjusted)), purple * defringe * 0.72);
  return saturate3(adjusted);
}

void main() {
  vec2 localCoordinate;
  vec2 uv = mapToImage(vFrameUv, localCoordinate);
  vec2 lensVector = uv - 0.5;
  float distortion = uLens0.z / 100.0 + uLens0.y * 0.025;
  uv = 0.5 + lensVector * (1.0 + distortion * dot(lensVector, lensVector) * 0.5);
  if (any(greaterThan(abs(localCoordinate), vec2(0.50001))) ||
      any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
    discard;
  }

  vec3 original = sourceAt(uv);
  if (uVisualizeSpots) {
    vec2 viewTexel = 2.0 / max(vec2(1.0), uSourceSize);
    float centerLuma = luma(original);
    float nearbyLuma = (
      luma(sourceAt(uv + vec2(viewTexel.x, 0.0))) +
      luma(sourceAt(uv - vec2(viewTexel.x, 0.0))) +
      luma(sourceAt(uv + vec2(0.0, viewTexel.y))) +
      luma(sourceAt(uv - vec2(0.0, viewTexel.y))) +
      luma(sourceAt(uv + viewTexel)) +
      luma(sourceAt(uv - viewTexel)) +
      luma(sourceAt(uv + vec2(viewTexel.x, -viewTexel.y))) +
      luma(sourceAt(uv + vec2(-viewTexel.x, viewTexel.y)))
    ) * 0.125;
    float threshold = mix(0.0025, 0.055, saturate(uVisualizeSpotsThreshold));
    float viewValue = 1.0 - smoothstep(threshold * 0.42, threshold, abs(centerLuma - nearbyLuma));
    outColor = vec4(vec3(viewValue), 1.0);
    return;
  }
  if (uShowOriginal) {
    outColor = vec4(original, 1.0);
    return;
  }
  original = applyProfile(healedSource(uv));

  vec2 texel = 1.0 / max(vec2(1.0), uSourceSize);
  float blurRadius = uLensBlur0.x > 0.5 ? 1.0 + saturate(uLensBlur0.y / 100.0) * 12.0 : 1.0;
  vec2 blurTexel = texel * blurRadius;
  vec3 blurred = vec3(0.0);
  for (int index = 0; index < 8; index++) {
    blurred += sourceAt(uv + lensBlurSampleOffset(index) * blurTexel);
  }
  blurred *= 0.125;
  vec3 color = applyGlobal(original, blurred);
  vec3 maskReferenceColor = color;
  float activeWeight = 0.0;
  for (int index = 0; index < MAX_MASKS; index++) {
    if (index >= uMaskCount) break;
    float weight = maskWeight(index, uv, maskReferenceColor);
    if (weight > 0.0001) {
      vec3 locallyAdjusted = applyLocal(color, blurred, index);
      color = mix(color, locallyAdjusted, weight);
    }
    if (index == uActiveMask) activeWeight = weight;
  }
  if (uShowMaskOverlay && uActiveMask >= 0) {
    float overlayOpacity = saturate(uOverlayOpacity);
    if (uOverlayMode == 0) {
      color = mix(color, uOverlayColor, activeWeight * overlayOpacity);
    } else {
      vec3 mapColor = vec3(0.0);
      if (uOverlayMode == 1) {
        mapColor = mix(vec3(0.0), uOverlayColor, activeWeight);
      } else if (uOverlayMode == 2) {
        mapColor = mix(vec3(1.0), uOverlayColor, activeWeight);
      } else if (uOverlayMode == 3) {
        mapColor = vec3(activeWeight);
      } else {
        mapColor = vec3(1.0 - activeWeight);
      }
      color = mix(color, mapColor, overlayOpacity);
    }
  }
  color = saturate3(color);
  if (uShowClipping) {
    float maximum = max(color.r, max(color.g, color.b));
    if (maximum >= 0.997) {
      color = mix(color, vec3(1.0, 0.06, 0.025), 0.88);
    } else if (maximum <= 0.008) {
      color = mix(color, vec3(0.03, 0.22, 1.0), 0.9);
    }
  }
  outColor = vec4(color, 1.0);
}`;

/**
 * A non-destructive, browser-native photo renderer.
 *
 * Coordinates stored by crop, masks, healing, and clientToImage are normalized
 * to the orientation-corrected source image (top-left is 0,0).
 */
export class ImageEngine {
  private readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private context2d: CanvasRenderingContext2D | null = null;
  private resources: GlResources | null = null;
  private sourceImage: DecodedImage | null = null;
  private sourcePixels: Uint8ClampedArray | null = null;
  private sourceWidth = 0;
  private sourceHeight = 0;
  private previewWidth = 0;
  private previewHeight = 0;
  private cssWidth: number;
  private cssHeight: number;
  private dpr: number;
  private lastState: EditState | null = null;
  private lastOptions: RenderOptions = {};
  private lastGeometry: FrameGeometry | null = null;
  private imageBounds: ImageBounds = { x: 0, y: 0, width: 0, height: 0 };
  private histogram: HistogramData = blankHistogram();
  private histogramDirty = true;
  private histogramReadback: Uint8Array | null = null;
  private brushCellSize = BRUSH_CELL_SIZE;
  private brushAtlasCanvas: HTMLCanvasElement | null = null;
  private brushAtlasPixels: Uint8ClampedArray | null = null;
  private brushAtlasComponentGroups: MaskComponent[][] = [];
  private brushAtlasPreviewWidth = 0;
  private brushAtlasPreviewHeight = 0;
  private brushAtlasCellSize = 0;
  private readonly maskComponentCache = new WeakMap<object, MaskComponent[]>();
  private healDabs: HealDab[] = [];
  private healSpotSource: HealSpot[] | null = null;
  private healPreviewWidth = 0;
  private healPreviewHeight = 0;
  private readonly glVertices = new Float32Array(16);
  private readonly glCurveValues = new Float32Array(MAX_CURVE_POINTS * 2);
  private readonly glHslValues = new Float32Array(MAX_MASKS * 3);
  private readonly glHealPositions = new Float32Array(MAX_HEAL_SPOTS * 4);
  private readonly glHealSettings = new Float32Array(MAX_HEAL_SPOTS * 4);
  private readonly glMaskKinds = new Int32Array(MAX_MASKS);
  private readonly glMaskInverted = new Int32Array(MAX_MASKS);
  private readonly glMaskOpacity = new Float32Array(MAX_MASKS);
  private readonly glMaskData0 = new Float32Array(MAX_MASKS * 4);
  private readonly glMaskData1 = new Float32Array(MAX_MASKS * 4);
  private readonly glMaskAdjust0 = new Float32Array(MAX_MASKS * 4);
  private readonly glMaskAdjust1 = new Float32Array(MAX_MASKS * 4);
  private readonly glMaskAdjust2 = new Float32Array(MAX_MASKS * 4);
  private readonly glMaskAdjust3 = new Float32Array(MAX_MASKS * 4);
  private readonly glMaskAdjust4 = new Float32Array(MAX_MASKS * 4);
  private semanticAnalysis: {
    borderPalette: Rgb[];
    borderSpread: number;
    faceX: number;
    faceY: number;
    faceConfidence: number;
  } | null = null;
  private loadGeneration = 0;
  private destroyed = false;

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.resources = null;
    this.histogramDirty = true;
  };

  private readonly handleContextRestored = (): void => {
    if (this.destroyed) return;
    const restored = this.canvas.getContext("webgl2") as WebGL2RenderingContext | null;
    if (!restored) return;
    try {
      this.gl = restored;
      this.brushCellSize =
        finite(restored.getParameter(restored.MAX_TEXTURE_SIZE) as number) >=
        1024 * BRUSH_ATLAS_COLUMNS
          ? 1024
          : BRUSH_CELL_SIZE;
      this.resources = this.createGlResources(restored);
      if (this.sourceImage) this.uploadSourceTexture();
      this.brushAtlasComponentGroups = [];
      if (this.lastState) this.render(this.lastState, this.lastOptions);
    } catch {
      this.resources = null;
    }
  };

  public constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.cssWidth = Math.max(1, canvas.clientWidth || canvas.width || 1);
    this.cssHeight = Math.max(1, canvas.clientHeight || canvas.height || 1);
    this.dpr = Math.max(0.25, canvas.width / this.cssWidth || 1);
    canvas.addEventListener("webglcontextlost", this.handleContextLost);
    canvas.addEventListener("webglcontextrestored", this.handleContextRestored);

    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
      powerPreference: "high-performance",
    }) as WebGL2RenderingContext | null;
    if (gl) {
      try {
        this.gl = gl;
        this.brushCellSize =
          finite(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) >=
          1024 * BRUSH_ATLAS_COLUMNS
            ? 1024
            : BRUSH_CELL_SIZE;
        this.resources = this.createGlResources(gl);
      } catch (error) {
        this.gl = null;
        this.resources = null;
        throw new Error(
          `The browser's WebGL renderer could not start: ${
            error instanceof Error ? error.message : "unknown shader error"
          }`,
        );
      }
    }
    if (!this.resources) {
      this.context2d = canvas.getContext("2d", {
        alpha: true,
        willReadFrequently: true,
      });
    }
  }

  public async load(
    blob: Blob,
    maxPreviewDimension = DEFAULT_PREVIEW_DIMENSION,
  ): Promise<LoadedImageInfo> {
    this.assertAlive();
    if (!(blob instanceof Blob)) throw new TypeError("ImageEngine.load expects a Blob.");
    const generation = ++this.loadGeneration;

    const decoded = await this.decodeBlob(blob);
    const sourceWidth = this.imageWidth(decoded);
    const sourceHeight = this.imageHeight(decoded);
    if (sourceWidth < 1 || sourceHeight < 1) {
      this.closeImage(decoded);
      throw new Error("The image has invalid dimensions.");
    }

    let rendererLimit = Number.POSITIVE_INFINITY;
    if (this.gl) {
      rendererLimit = finite(
        this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number,
        DEFAULT_PREVIEW_DIMENSION,
      );
    }
    const requestedLimit =
      maxPreviewDimension === Number.POSITIVE_INFINITY
        ? rendererLimit
        : Math.max(1, finite(maxPreviewDimension, DEFAULT_PREVIEW_DIMENSION));
    const limit = Math.max(1, Math.min(requestedLimit, rendererLimit));
    const scale = Math.min(1, limit / Math.max(sourceWidth, sourceHeight));
    const previewWidth = Math.max(1, Math.round(sourceWidth * scale));
    const previewHeight = Math.max(1, Math.round(sourceHeight * scale));

    let preview: DecodedImage = decoded;
    if (previewWidth !== sourceWidth || previewHeight !== sourceHeight) {
      preview = await this.resizeDecodedImage(decoded, previewWidth, previewHeight);
      if (preview !== decoded) this.closeImage(decoded);
    }

    const result = {
      sourceWidth,
      sourceHeight,
      previewWidth,
      previewHeight,
      width: sourceWidth,
      height: sourceHeight,
    };
    if (generation !== this.loadGeneration || this.destroyed) {
      this.closeImage(preview);
      return result;
    }

    this.releaseSource();
    this.sourceImage = preview;
    this.sourceWidth = sourceWidth;
    this.sourceHeight = sourceHeight;
    this.previewWidth = previewWidth;
    this.previewHeight = previewHeight;
    this.sourcePixels = null;
    this.brushAtlasComponentGroups = [];
    this.healSpotSource = null;
    this.histogramReadback = null;
    this.histogram = blankHistogram();
    this.histogramDirty = true;
    if (this.resources) this.uploadSourceTexture();
    if (this.context2d) this.ensureSourcePixels();

    return result;
  }

  public resize(width: number, height: number, dpr?: number): void {
    this.assertAlive();
    this.cssWidth = Math.max(1, finite(width, 1));
    this.cssHeight = Math.max(1, finite(height, 1));
    const browserDpr =
      typeof window === "undefined" ? 1 : finite(window.devicePixelRatio, 1);
    this.dpr = clamp(dpr ?? browserDpr, 0.25, 4);
    const pixelWidth = Math.max(1, Math.round(this.cssWidth * this.dpr));
    const pixelHeight = Math.max(1, Math.round(this.cssHeight * this.dpr));
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
    this.canvas.style.width = `${this.cssWidth}px`;
    this.canvas.style.height = `${this.cssHeight}px`;
    this.histogramDirty = true;
    if (this.lastState) {
      this.lastGeometry = this.computeFrameGeometry(
        this.lastState,
        Boolean(this.lastOptions.cropPreview),
      );
      this.imageBounds = { ...this.lastGeometry.bounds };
    }
  }

  public render(editState: EditState, options: RenderOptions = {}): void {
    this.assertAlive();
    if (!this.sourceImage) {
      this.clear();
      return;
    }
    this.lastState = editState;
    this.lastOptions = { ...options };
    if (
      this.healSpotSource !== editState.healSpots ||
      this.healPreviewWidth !== this.previewWidth ||
      this.healPreviewHeight !== this.previewHeight
    ) {
      this.healDabs = expandHealPaths(
        editState.healSpots,
        this.previewWidth,
        this.previewHeight,
        MAX_HEAL_SPOTS,
      );
      this.healSpotSource = editState.healSpots;
      this.healPreviewWidth = this.previewWidth;
      this.healPreviewHeight = this.previewHeight;
    }
    const geometry = this.computeFrameGeometry(
      editState,
      Boolean(options.cropPreview),
    );
    this.lastGeometry = geometry;
    this.imageBounds = { ...geometry.bounds };

    if (this.gl?.isContextLost()) {
      return;
    }
    if (this.gl && this.resources) {
      this.renderWebGl(editState, options, geometry);
    } else if (this.context2d) {
      this.renderCanvas2d(editState, options, geometry);
    } else {
      throw new Error("Neither WebGL2 nor Canvas2D is available.");
    }
    this.histogramDirty = true;
  }

  public getImageBounds(): ImageBounds {
    return { ...this.imageBounds };
  }

  /** Samples the orientation-corrected source at normalized image coordinates. */
  public sampleColorAt(imageX: number, imageY: number): {
    r: number;
    g: number;
    b: number;
    luminance: number;
  } {
    const [r, g, b] = this.sampleMaskSourceColor(imageX, imageY);
    return { r, g, b, luminance: luminance([r, g, b]) };
  }

  /**
   * Estimates dominant architectural/horizon directions locally from source
   * pixels. It is deliberately deterministic and never uploads the image.
   */
  public analyzeUpright(): UprightAnalysis {
    const pixels = this.ensureSourcePixels();
    if (!pixels || this.previewWidth < 3 || this.previewHeight < 3) {
      return {
        rotation: 0,
        vertical: 0,
        horizontal: 0,
        confidence: 0,
        horizontalLines: 0,
        verticalLines: 0,
      };
    }

    const columns = Math.min(180, Math.max(24, this.previewWidth));
    const rows = Math.min(120, Math.max(18, this.previewHeight));
    const sample = (column: number, row: number): number => {
      const x = Math.min(
        this.previewWidth - 1,
        Math.max(0, Math.round((column / Math.max(1, columns - 1)) * (this.previewWidth - 1))),
      );
      const y = Math.min(
        this.previewHeight - 1,
        Math.max(0, Math.round((row / Math.max(1, rows - 1)) * (this.previewHeight - 1))),
      );
      const offset = (y * this.previewWidth + x) * 4;
      return (
        pixels[offset] * 0.2126 +
        pixels[offset + 1] * 0.7152 +
        pixels[offset + 2] * 0.0722
      ) / 255;
    };

    const normalizeLineAngle = (angle: number): number => {
      let normalized = angle;
      while (normalized <= -Math.PI / 2) normalized += Math.PI;
      while (normalized > Math.PI / 2) normalized -= Math.PI;
      return normalized;
    };
    const groups = {
      horizontal: { weight: 0, angle: 0, topWeight: 0, topAngle: 0, bottomWeight: 0, bottomAngle: 0, count: 0 },
      vertical: { weight: 0, angle: 0, leftWeight: 0, leftAngle: 0, rightWeight: 0, rightAngle: 0, count: 0 },
    };

    for (let row = 1; row < rows - 1; row += 1) {
      for (let column = 1; column < columns - 1; column += 1) {
        const gx =
          -sample(column - 1, row - 1) + sample(column + 1, row - 1) -
          2 * sample(column - 1, row) + 2 * sample(column + 1, row) -
          sample(column - 1, row + 1) + sample(column + 1, row + 1);
        const gy =
          -sample(column - 1, row - 1) - 2 * sample(column, row - 1) - sample(column + 1, row - 1) +
          sample(column - 1, row + 1) + 2 * sample(column, row + 1) + sample(column + 1, row + 1);
        const strength = Math.hypot(gx, gy);
        if (strength < 0.16) continue;
        const weight = Math.min(3, strength) ** 2;
        const lineAngle = normalizeLineAngle(Math.atan2(gy, gx) + Math.PI / 2);
        const x = column / (columns - 1);
        const y = row / (rows - 1);

        if (Math.abs(lineAngle) <= Math.PI / 6) {
          groups.horizontal.weight += weight;
          groups.horizontal.angle += lineAngle * weight;
          groups.horizontal.count += 1;
          if (y < 0.5) {
            groups.horizontal.topWeight += weight;
            groups.horizontal.topAngle += lineAngle * weight;
          } else {
            groups.horizontal.bottomWeight += weight;
            groups.horizontal.bottomAngle += lineAngle * weight;
          }
        }

        const verticalDeviation = lineAngle > 0
          ? lineAngle - Math.PI / 2
          : lineAngle + Math.PI / 2;
        if (Math.abs(verticalDeviation) <= Math.PI / 6) {
          groups.vertical.weight += weight;
          groups.vertical.angle += verticalDeviation * weight;
          groups.vertical.count += 1;
          if (x < 0.5) {
            groups.vertical.leftWeight += weight;
            groups.vertical.leftAngle += verticalDeviation * weight;
          } else {
            groups.vertical.rightWeight += weight;
            groups.vertical.rightAngle += verticalDeviation * weight;
          }
        }
      }
    }

    const mean = (value: number, weight: number) => value / Math.max(1e-6, weight);
    const horizontalAngle = mean(groups.horizontal.angle, groups.horizontal.weight);
    const verticalAngle = mean(groups.vertical.angle, groups.vertical.weight);
    const roll = groups.horizontal.weight > groups.vertical.weight * 0.35
      ? horizontalAngle
      : verticalAngle;
    const verticalDivergence =
      mean(groups.vertical.rightAngle, groups.vertical.rightWeight) -
      mean(groups.vertical.leftAngle, groups.vertical.leftWeight);
    const horizontalDivergence =
      mean(groups.horizontal.bottomAngle, groups.horizontal.bottomWeight) -
      mean(groups.horizontal.topAngle, groups.horizontal.topWeight);
    const evidence = groups.horizontal.count + groups.vertical.count;
    const confidence = clamp(evidence / Math.max(80, columns * rows * 0.08));

    return {
      rotation: clamp((-roll * 180) / Math.PI, -15, 15),
      vertical: clamp((-verticalDivergence * 180) / Math.PI * 3.2, -100, 100),
      horizontal: clamp((-horizontalDivergence * 180) / Math.PI * 3.2, -100, 100),
      confidence,
      horizontalLines: groups.horizontal.count,
      verticalLines: groups.vertical.count,
    };
  }

  public clientToImage(clientX: number, clientY: number): ImagePoint {
    if (!this.lastState || !this.lastGeometry || !this.sourceImage) {
      return { x: 0, y: 0, inside: false };
    }
    const clientBounds = this.canvas.getBoundingClientRect();
    const localX =
      ((clientX - clientBounds.left) / Math.max(1e-6, clientBounds.width)) *
      this.cssWidth;
    const localY =
      ((clientY - clientBounds.top) / Math.max(1e-6, clientBounds.height)) *
      this.cssHeight;
    return this.canvasToImage(localX, localY);
  }

  /** Maps an unzoomed CSS pixel in the canvas viewport to source coordinates. */
  public canvasToImage(canvasX: number, canvasY: number): ImagePoint {
    if (!this.lastState || !this.lastGeometry || !this.sourceImage) {
      return { x: 0, y: 0, inside: false };
    }
    const bounds = this.lastGeometry.bounds;
    const frameX = (canvasX - bounds.x) / Math.max(1e-6, bounds.width);
    const frameY = (canvasY - bounds.y) / Math.max(1e-6, bounds.height);
    const mapped = this.mapFrameToImage(
      frameX,
      frameY,
      this.lastState,
      this.lastGeometry,
    );
    const insideFrame = frameX >= 0 && frameX <= 1 && frameY >= 0 && frameY <= 1;
    return {
      x: clamp(mapped.x),
      y: clamp(mapped.y),
      inside: insideFrame && mapped.inside,
    };
  }

  /**
   * Maps a normalized source-image coordinate back into the canvas' CSS
   * coordinate space. Overlay controls use this inverse of clientToImage so
   * they continue to line up after crop, rotation, flips, and perspective.
   */
  public imageToCanvas(imageX: number, imageY: number): ImagePoint {
    if (!this.lastState || !this.lastGeometry || !this.sourceImage) {
      return { x: 0, y: 0, inside: false };
    }

    const state = this.lastState;
    const geometry = this.lastGeometry;
    const cropWidth = Math.max(1e-6, geometry.crop[2]);
    const cropHeight = Math.max(1e-6, geometry.crop[3]);
    let sourceX = (imageX - geometry.crop[0]) / cropWidth - 0.5;
    let sourceY = (imageY - geometry.crop[1]) / cropHeight - 0.5;

    if (state.geometry.flipX) sourceX = -sourceX;
    if (state.geometry.flipY) sourceY = -sourceY;
    sourceX += geometry.offsetX;
    sourceY += geometry.offsetY;

    const horizontal = finite(state.geometry.horizontal) / 200;
    const vertical = finite(state.geometry.vertical) / 200;
    const local = projectiveSourceToFrame(
      sourceX,
      sourceY,
      horizontal,
      vertical,
    );
    const localX = local.x;
    const localY = local.y;
    const scale = geometry.effectiveScale;
    const unrotatedX = localX * geometry.adjustedCropWidth * scale;
    const unrotatedY = localY * geometry.adjustedCropHeight * scale;
    const rotatedX =
      geometry.cosine * unrotatedX - geometry.sine * unrotatedY;
    const rotatedY =
      geometry.sine * unrotatedX + geometry.cosine * unrotatedY;
    const frameX = rotatedX / Math.max(1e-6, geometry.boundingWidth) + 0.5;
    const frameY = rotatedY / Math.max(1e-6, geometry.boundingHeight) + 0.5;

    return {
      x: geometry.bounds.x + frameX * geometry.bounds.width,
      y: geometry.bounds.y + frameY * geometry.bounds.height,
      inside:
        imageX >= geometry.crop[0] - 1e-5 &&
        imageX <= geometry.crop[0] + geometry.crop[2] + 1e-5 &&
        imageY >= geometry.crop[1] - 1e-5 &&
        imageY <= geometry.crop[1] + geometry.crop[3] + 1e-5 &&
        frameX >= -1e-5 &&
        frameX <= 1.00001 &&
        frameY >= -1e-5 &&
        frameY <= 1.00001,
    };
  }

  /**
   * Returns the exact transformed repair footprint in canvas coordinates.
   * The two axes describe a unit SVG ellipse and stay aligned with the
   * renderer through rotation, crop, flips, scale, and perspective controls.
   */
  public suggestHealSource(
    destination: { x: number; y: number },
    sizePixels: number,
    attempt = 0,
  ): { x: number; y: number } {
    const pixels = this.ensureSourcePixels();
    const width = Math.max(1, this.previewWidth);
    const height = Math.max(1, this.previewHeight);
    const radius = Math.max(3, finite(sizePixels, 34) * 0.5);
    const marginX = radius / width;
    const marginY = radius / height;
    const center = {
      x: clamp(finite(destination.x, 0.5), marginX, 1 - marginX),
      y: clamp(finite(destination.y, 0.5), marginY, 1 - marginY),
    };
    const candidates: { point: { x: number; y: number }; score: number }[] = [];
    const ringDistances = [Math.max(28, radius * 2.5), Math.max(52, radius * 4.5)];

    for (const ringDistance of ringDistances) {
      for (let index = 0; index < 16; index += 1) {
        const angle = (index / 16) * Math.PI * 2 + 0.21;
        const point = {
          x: center.x + (Math.cos(angle) * ringDistance) / width,
          y: center.y + (Math.sin(angle) * ringDistance) / height,
        };
        if (
          point.x < marginX ||
          point.x > 1 - marginX ||
          point.y < marginY ||
          point.y > 1 - marginY
        ) {
          continue;
        }

        let score = 0;
        if (pixels) {
          for (let sampleIndex = 0; sampleIndex < 12; sampleIndex += 1) {
            const sampleAngle = (sampleIndex / 12) * Math.PI * 2;
            const offsetX = (Math.cos(sampleAngle) * radius * 1.18) / width;
            const offsetY = (Math.sin(sampleAngle) * radius * 1.18) / height;
            const target = samplePixels(
              pixels,
              width,
              height,
              center.x + offsetX,
              center.y + offsetY,
            );
            const candidate = samplePixels(
              pixels,
              width,
              height,
              point.x + offsetX,
              point.y + offsetY,
            );
            score += Math.abs(luminance(target) - luminance(candidate)) * 2.2;
            score +=
              (Math.abs(target[0] - candidate[0]) +
                Math.abs(target[1] - candidate[1]) +
                Math.abs(target[2] - candidate[2])) *
              0.35;
          }
        }
        // Prefer nearby clean texture when two candidates match equally well.
        score += ringDistance / Math.max(width, height) * 0.18;
        candidates.push({ point, score });
      }
    }

    if (!candidates.length) {
      return {
        x: clamp(center.x + Math.max(16, radius * 2.5) / width),
        y: center.y,
      };
    }
    candidates.sort((first, second) => first.score - second.score);
    const shortlist = candidates.slice(0, Math.min(10, candidates.length));
    return shortlist[Math.abs(Math.floor(attempt)) % shortlist.length].point;
  }

  public healOverlayGeometry(spot: HealSpot): HealOverlayGeometry {
    const center = this.imageToCanvas(
      finite(spot.destination.x),
      finite(spot.destination.y),
    );
    const source = this.imageToCanvas(
      finite(spot.source.x),
      finite(spot.source.y),
    );
    const reference = Math.max(
      1,
      Math.min(this.previewWidth, this.previewHeight),
    );
    const radius = normalizeRepairRadius(spot.size, reference);
    const radiusX = radius * (reference / Math.max(1, this.previewWidth));
    const radiusY = radius * (reference / Math.max(1, this.previewHeight));
    const horizontalEdge = this.imageToCanvas(
      finite(spot.destination.x) + radiusX,
      finite(spot.destination.y),
    );
    const verticalEdge = this.imageToCanvas(
      finite(spot.destination.x),
      finite(spot.destination.y) + radiusY,
    );
    return {
      center,
      source,
      axisX: {
        x: horizontalEdge.x - center.x,
        y: horizontalEdge.y - center.y,
      },
      axisY: {
        x: verticalEdge.x - center.x,
        y: verticalEdge.y - center.y,
      },
    };
  }

  public getHistogram(): HistogramData {
    this.assertAlive();
    if (!this.histogramDirty) return copyHistogram(this.histogram);
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (width < 1 || height < 1 || !this.sourceImage) {
      this.histogram = blankHistogram();
      this.histogramDirty = false;
      return copyHistogram(this.histogram);
    }

    try {
      let pixels: Uint8Array | Uint8ClampedArray;
      if (this.gl && this.resources) {
        const requiredLength = width * height * 4;
        if (!this.histogramReadback || this.histogramReadback.length !== requiredLength) {
          this.histogramReadback = new Uint8Array(requiredLength);
        }
        pixels = this.histogramReadback;
        this.gl.readPixels(
          0,
          0,
          width,
          height,
          this.gl.RGBA,
          this.gl.UNSIGNED_BYTE,
          pixels,
        );
      } else if (this.context2d) {
        pixels = this.context2d.getImageData(0, 0, width, height).data;
      } else {
        return blankHistogram();
      }
      this.histogram = this.buildHistogram(pixels, width, height);
      this.histogramDirty = false;
    } catch {
      this.histogram = blankHistogram();
      this.histogramDirty = false;
    }
    return copyHistogram(this.histogram);
  }

  public async export(
    blob: Blob,
    editState: EditState,
    settings: ExportSettings,
  ): Promise<Blob> {
    this.assertAlive();
    if (typeof document === "undefined") {
      throw new Error("Image export requires a browser document.");
    }

    const renderCanvas = document.createElement("canvas");
    const exportEngine = new ImageEngine(renderCanvas);
    try {
      const info = await exportEngine.load(blob, Number.POSITIVE_INFINITY);
      const crop = this.sanitizeCrop(editState);
      const cropWidth = info.sourceWidth * crop[2];
      const cropHeight = info.sourceHeight * crop[3];
      const aspectScale = Math.max(
        0.05,
        1 + finite(editState.geometry.aspect) / 100,
      );
      const naturalDimensions = editedFrameDimensions(
        cropWidth * aspectScale,
        cropHeight,
        finite(editState.geometry.rotate),
        finite(editState.crop.angle),
      );
      const naturalWidth = naturalDimensions.width;
      const naturalHeight = naturalDimensions.height;
      let outputWidth = naturalWidth;
      let outputHeight = naturalHeight;

      if (settings.resizeMode === "long-edge") {
        const requested = Math.max(1, finite(settings.longEdge, Math.max(naturalWidth, naturalHeight)));
        const scale = requested / Math.max(naturalWidth, naturalHeight);
        outputWidth *= scale;
        outputHeight *= scale;
      } else if (settings.resizeMode === "dimensions") {
        const requestedWidth = Math.max(1, finite(settings.width, naturalWidth));
        const requestedHeight = Math.max(1, finite(settings.height, naturalHeight));
        const scale = Math.min(
          requestedWidth / naturalWidth,
          requestedHeight / naturalHeight,
        );
        outputWidth *= scale;
        outputHeight *= scale;
      }

      const previewScale = Math.min(
        1,
        exportEngine.previewWidth / info.sourceWidth,
        exportEngine.previewHeight / info.sourceHeight,
      );
      const viewportDimensions = exportEngine.gl
        ? (exportEngine.gl.getParameter(
            exportEngine.gl.MAX_VIEWPORT_DIMS,
          ) as Int32Array)
        : null;
      const maximumDimension = Math.max(
        1,
        viewportDimensions
          ? Math.min(viewportDimensions[0], viewportDimensions[1])
          : 16_384,
      );
      const maximumPixelCount = 64_000_000;
      const pixelBudgetScale = Math.sqrt(
        maximumPixelCount / Math.max(1, outputWidth * outputHeight),
      );
      const safeScale = Math.min(
        1,
        maximumDimension / Math.max(outputWidth, outputHeight),
        pixelBudgetScale,
        settings.resizeMode === "original" && previewScale < 1
          ? previewScale
          : 1,
      );
      outputWidth = Math.max(1, Math.round(outputWidth * safeScale));
      outputHeight = Math.max(1, Math.round(outputHeight * safeScale));

      exportEngine.resize(outputWidth, outputHeight, 1);
      exportEngine.render(editState);

      const outputCanvas = document.createElement("canvas");
      outputCanvas.width = outputWidth;
      outputCanvas.height = outputHeight;
      const context = outputCanvas.getContext("2d");
      if (!context) throw new Error("Unable to create the export canvas.");
      context.drawImage(renderCanvas, 0, 0, outputWidth, outputHeight);
      if (settings.watermarkEnabled && settings.watermarkText.trim()) {
        this.drawWatermark(context, outputWidth, outputHeight, settings);
      }
      const quality =
        settings.quality > 1
          ? clamp(settings.quality / 100)
          : clamp(settings.quality);
      return await this.canvasToBlob(outputCanvas, settings.format, quality);
    } finally {
      exportEngine.destroy();
    }
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.loadGeneration += 1;
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.removeEventListener(
      "webglcontextrestored",
      this.handleContextRestored,
    );
    this.releaseSource();
    if (this.gl && this.resources) {
      const { program, vertexShader, fragmentShader, vertexBuffer, vertexArray } =
        this.resources;
      this.gl.deleteTexture(this.resources.sourceTexture);
      this.gl.deleteTexture(this.resources.brushTexture);
      this.gl.deleteBuffer(vertexBuffer);
      this.gl.deleteVertexArray(vertexArray);
      this.gl.deleteProgram(program);
      this.gl.deleteShader(vertexShader);
      this.gl.deleteShader(fragmentShader);
    }
    this.resources = null;
    this.gl = null;
    this.context2d = null;
    this.brushAtlasCanvas = null;
    this.brushAtlasPixels = null;
    this.lastState = null;
    this.lastGeometry = null;
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("ImageEngine has been destroyed.");
  }

  public clear(): void {
    if (this.gl) {
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      this.gl.clearColor(0, 0, 0, 0);
      this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    } else {
      this.context2d?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    this.imageBounds = { x: 0, y: 0, width: 0, height: 0 };
    this.histogramDirty = true;
  }

  private createGlResources(gl: WebGL2RenderingContext): GlResources {
    const vertexShader = this.compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragmentShader = this.compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      FRAGMENT_SHADER,
    );
    const program = gl.createProgram();
    const vertexBuffer = gl.createBuffer();
    const vertexArray = gl.createVertexArray();
    const sourceTexture = gl.createTexture();
    const brushTexture = gl.createTexture();
    if (
      !program ||
      !vertexBuffer ||
      !vertexArray ||
      !sourceTexture ||
      !brushTexture
    ) {
      throw new Error("Unable to allocate WebGL resources.");
    }
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(
        `Unable to link the photo shader: ${gl.getProgramInfoLog(program) ?? "unknown error"}`,
      );
    }
    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);

    gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
    this.configureTexture(gl);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]),
    );
    gl.bindTexture(gl.TEXTURE_2D, brushTexture);
    this.configureTexture(gl);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]),
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
    return {
      program,
      vertexShader,
      fragmentShader,
      vertexBuffer,
      vertexArray,
      sourceTexture,
      brushTexture,
      uniforms: new Map(),
    };
  }

  private compileShader(
    gl: WebGL2RenderingContext,
    type: number,
    source: string,
  ): WebGLShader {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("Unable to create a WebGL shader.");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) ?? "unknown error";
      gl.deleteShader(shader);
      throw new Error(`Unable to compile the photo shader: ${message}`);
    }
    return shader;
  }

  private configureTexture(gl: WebGL2RenderingContext): void {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private uniform(name: string): WebGLUniformLocation | null {
    if (!this.gl || !this.resources) return null;
    if (!this.resources.uniforms.has(name)) {
      this.resources.uniforms.set(
        name,
        this.gl.getUniformLocation(this.resources.program, name),
      );
    }
    return this.resources.uniforms.get(name) ?? null;
  }

  private uploadSourceTexture(): void {
    if (!this.gl || !this.resources || !this.sourceImage) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.resources.sourceTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.configureTexture(gl);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.sourceImage,
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  private renderWebGl(
    state: EditState,
    options: RenderOptions,
    geometry: FrameGeometry,
  ): void {
    const gl = this.gl;
    const resources = this.resources;
    if (!gl || !resources) return;
    this.updateBrushAtlas(
      state.masks.filter((mask) => mask.enabled).slice(0, MAX_MASKS),
    );

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.useProgram(resources.program);
    gl.bindVertexArray(resources.vertexArray);

    const left = (geometry.bounds.x / this.cssWidth) * 2 - 1;
    const right =
      ((geometry.bounds.x + geometry.bounds.width) / this.cssWidth) * 2 - 1;
    const top = 1 - (geometry.bounds.y / this.cssHeight) * 2;
    const bottom =
      1 -
      ((geometry.bounds.y + geometry.bounds.height) / this.cssHeight) * 2;
    const vertices = this.glVertices;
    vertices[0] = left;
    vertices[1] = bottom;
    vertices[2] = 0;
    vertices[3] = 1;
    vertices[4] = right;
    vertices[5] = bottom;
    vertices[6] = 1;
    vertices[7] = 1;
    vertices[8] = left;
    vertices[9] = top;
    vertices[10] = 0;
    vertices[11] = 0;
    vertices[12] = right;
    vertices[13] = top;
    vertices[14] = 1;
    vertices[15] = 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, resources.sourceTexture);
    gl.uniform1i(this.uniform("uImage"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, resources.brushTexture);
    gl.uniform1i(this.uniform("uBrushAtlas"), 1);
    gl.uniform1f(this.uniform("uMaskCellTexel"), 1 / this.brushCellSize);

    gl.uniform2f(
      this.uniform("uSourceSize"),
      this.previewWidth,
      this.previewHeight,
    );
    gl.uniform4f(this.uniform("uCrop"), ...geometry.crop);
    gl.uniform4f(
      this.uniform("uTransform"),
      geometry.cosine,
      geometry.sine,
      geometry.boundingWidth,
      geometry.boundingHeight,
    );
    gl.uniform2f(
      this.uniform("uAdjustedCropSize"),
      geometry.adjustedCropWidth,
      geometry.adjustedCropHeight,
    );
    gl.uniform4f(
      this.uniform("uGeometry0"),
      geometry.effectiveScale,
      finite(state.geometry.horizontal) / 200,
      finite(state.geometry.vertical) / 200,
      geometry.offsetX,
    );
    gl.uniform4f(
      this.uniform("uGeometry1"),
      geometry.offsetY,
      state.geometry.flipX ? 1 : 0,
      state.geometry.flipY ? 1 : 0,
      0,
    );
    gl.uniform1i(this.uniform("uShowOriginal"), options.showOriginal ? 1 : 0);
    gl.uniform1i(this.uniform("uShowClipping"), options.showClipping ? 1 : 0);
    gl.uniform1i(this.uniform("uVisualizeSpots"), options.visualizeSpots ? 1 : 0);
    gl.uniform1f(
      this.uniform("uVisualizeSpotsThreshold"),
      clamp(finite(options.visualizeSpotsThreshold, 0.5)),
    );
    gl.uniform1i(this.uniform("uProfile"), profileIndex(state.profile));
    const curves: CpuCurves = {
      tone: sanitizeCurve(state.curve),
      channels: [
        sanitizeCurve(state.redCurve),
        sanitizeCurve(state.greenCurve),
        sanitizeCurve(state.blueCurve),
      ],
    };
    gl.uniform1i(
      this.uniform("uAdjustmentFlags"),
      adjustmentFlags(state, curves),
    );

    const global = state.global;
    gl.uniform4f(
      this.uniform("uGlobal0"),
      finite(global.exposure),
      finite(global.contrast),
      finite(global.highlights),
      finite(global.shadows),
    );
    gl.uniform4f(
      this.uniform("uGlobal1"),
      finite(global.whites),
      finite(global.blacks),
      finite(global.temperature),
      finite(global.tint),
    );
    gl.uniform4f(
      this.uniform("uGlobal2"),
      finite(global.vibrance),
      finite(global.saturation),
      finite(global.texture),
      finite(global.clarity),
    );
    gl.uniform4f(
      this.uniform("uGlobal3"),
      finite(global.dehaze),
      finite(global.sharpening),
      finite(global.noiseReduction),
      finite(global.colorNoiseReduction),
    );
    gl.uniform4f(
      this.uniform("uGlobal4"),
      finite(global.vignette),
      finite(global.vignetteMidpoint, 50),
      finite(global.vignetteFeather, 50),
      finite(global.grain),
    );
    gl.uniform1f(this.uniform("uGrainSize"), finite(global.grainSize, 25));
    gl.uniform4f(
      this.uniform("uDetail0"),
      finite(global.sharpeningRadius, 1),
      finite(global.sharpeningDetail, 25),
      finite(global.sharpeningMasking),
      finite(global.noiseReductionDetail, 50),
    );
    gl.uniform4f(
      this.uniform("uDetail1"),
      finite(global.noiseReductionContrast),
      finite(global.colorNoiseReductionDetail, 50),
      finite(global.colorNoiseReductionSmoothness, 50),
      0,
    );

    this.setCurveUniforms("uCurve", "uCurveCount", curves.tone, true);
    this.setCurveUniforms("uRedCurve", "uRedCurveCount", curves.channels[0], true);
    this.setCurveUniforms("uGreenCurve", "uGreenCurveCount", curves.channels[1], true);
    this.setCurveUniforms("uBlueCurve", "uBlueCurveCount", curves.channels[2], true);
    this.setHslUniforms(state.hsl);
    const point = state.pointColor;
    gl.uniform4f(
      this.uniform("uPointColor0"),
      point.enabled ? 1 : 0,
      finite(point.hue),
      finite(point.range, 25),
      finite(point.hueShift),
    );
    gl.uniform4f(
      this.uniform("uPointColor1"),
      finite(point.saturationShift),
      finite(point.luminanceShift),
      0,
      0,
    );
    const grading = state.colorGrading;
    gl.uniform4f(
      this.uniform("uGradeShadows"),
      finite(grading.shadows.hue),
      finite(grading.shadows.saturation),
      finite(grading.shadows.luminance),
      0,
    );
    gl.uniform4f(
      this.uniform("uGradeMidtones"),
      finite(grading.midtones.hue),
      finite(grading.midtones.saturation),
      finite(grading.midtones.luminance),
      0,
    );
    gl.uniform4f(
      this.uniform("uGradeHighlights"),
      finite(grading.highlights.hue),
      finite(grading.highlights.saturation),
      finite(grading.highlights.luminance),
      0,
    );
    gl.uniform2f(
      this.uniform("uGradeMix"),
      finite(grading.blending, 50),
      finite(grading.balance),
    );
    const lens = state.lensCorrections;
    gl.uniform4f(
      this.uniform("uLens0"),
      lens.removeChromaticAberration ? 1 : 0,
      lensProfileCorrectionStrength(lens),
      finite(lens.distortion),
      finite(lens.vignette),
    );
    gl.uniform4f(
      this.uniform("uLens1"),
      finite(lens.midpoint, 50),
      finite(lens.defringePurpleAmount),
      finite(lens.defringeGreenAmount),
      0,
    );
    gl.uniform4f(
      this.uniform("uLensDefringeHue"),
      finite(lens.defringePurpleHueLow, 30),
      finite(lens.defringePurpleHueHigh, 70),
      finite(lens.defringeGreenHueLow, 40),
      finite(lens.defringeGreenHueHigh, 60),
    );
    const lensBlur = state.lensBlur;
    gl.uniform4f(
      this.uniform("uLensBlur0"),
      lensBlur.enabled ? 1 : 0,
      finite(lensBlur.amount, 50),
      finite(lensBlur.focusRange, 45),
      finite(lensBlur.boost),
    );
    gl.uniform4f(
      this.uniform("uLensBlur1"),
      finite(lensBlur.focusX, 0.5),
      finite(lensBlur.focusY, 0.42),
      ["circle", "bubble", "five-blade", "ring", "cat-eye"].indexOf(lensBlur.bokeh),
      0,
    );
    const calibration = state.calibration;
    gl.uniform4f(
      this.uniform("uCalibration0"),
      finite(calibration.shadowsTint),
      finite(calibration.redPrimaryHue),
      finite(calibration.redPrimarySaturation),
      finite(calibration.greenPrimaryHue),
    );
    gl.uniform4f(
      this.uniform("uCalibration1"),
      finite(calibration.greenPrimarySaturation),
      finite(calibration.bluePrimaryHue),
      finite(calibration.bluePrimarySaturation),
      0,
    );
    this.setHealUniforms(state);
    this.setMaskUniforms(state, options);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  private setCurveUniforms(
    uniformName: string,
    countUniformName: string,
    points: ToneCurvePoint[],
    sanitized = false,
  ): void {
    if (!this.gl) return;
    const curve = sanitized ? points : sanitizeCurve(points);
    const values = this.glCurveValues;
    values.fill(0);
    curve.forEach((point, index) => {
      values[index * 2] = point.x;
      values[index * 2 + 1] = point.y;
    });
    this.gl.uniform1i(this.uniform(countUniformName), curve.length);
    this.gl.uniform2fv(this.uniform(`${uniformName}[0]`), values);
  }

  private setHslUniforms(hsl: HslAdjustments): void {
    if (!this.gl) return;
    const values = this.glHslValues;
    hueChannelNames.forEach((name, index) => {
      values[index * 3] = finite(hsl[name]?.hue);
      values[index * 3 + 1] = finite(hsl[name]?.saturation);
      values[index * 3 + 2] = finite(hsl[name]?.luminance);
    });
    this.gl.uniform3fv(this.uniform("uHsl[0]"), values);
  }

  private setHealUniforms(_state: EditState): void {
    if (!this.gl) return;
    const spots = this.healDabs;
    const positions = this.glHealPositions;
    const settings = this.glHealSettings;
    positions.fill(0);
    settings.fill(0);
    const reference = Math.min(this.previewWidth, this.previewHeight);
    spots.forEach((spot, index) => {
      positions.set(
        [
          finite(spot.destination.x),
          finite(spot.destination.y),
          finite(spot.source.x),
          finite(spot.source.y),
        ],
        index * 4,
      );
      settings.set(
        [
          normalizeRepairRadius(spot.size, reference),
          percentage(spot.feather),
          percentage(spot.opacity),
          spot.mode === "clone" ? 0 : spot.mode === "heal" ? 1 : 2,
        ],
        index * 4,
      );
    });
    this.gl.uniform1i(this.uniform("uHealCount"), spots.length);
    this.gl.uniform4fv(this.uniform("uHealPosition[0]"), positions);
    this.gl.uniform4fv(this.uniform("uHealSettings[0]"), settings);
  }

  private setMaskUniforms(state: EditState, options: RenderOptions): void {
    if (!this.gl) return;
    const masks = state.masks
      .filter((mask) => mask.enabled)
      .slice(0, MAX_MASKS);
    const kinds = this.glMaskKinds;
    const inverted = this.glMaskInverted;
    const opacity = this.glMaskOpacity;
    const data0 = this.glMaskData0;
    const data1 = this.glMaskData1;
    const adjust0 = this.glMaskAdjust0;
    const adjust1 = this.glMaskAdjust1;
    const adjust2 = this.glMaskAdjust2;
    const adjust3 = this.glMaskAdjust3;
    const adjust4 = this.glMaskAdjust4;
    kinds.fill(0);
    inverted.fill(0);
    opacity.fill(0);
    data0.fill(0);
    data1.fill(0);
    adjust0.fill(0);
    adjust1.fill(0);
    adjust2.fill(0);
    adjust3.fill(0);
    adjust4.fill(0);
    let activeIndex = -1;
    let overlayColor: Rgb = [1, 0.18, 0.1];

    masks.forEach((mask, index) => {
      kinds[index] = this.maskKindIndex(mask);
      inverted[index] = mask.inverted ? 1 : 0;
      opacity[index] = normalizedPercent(mask.opacity);
      if (mask.id === options.activeMaskId) {
        activeIndex = index;
        overlayColor = parseColor(mask.overlayColor);
      }
      this.packMaskData(mask, data0, data1, index);
      const local = mask.adjustments;
      adjust0.set(
        [
          finite(local.exposure),
          finite(local.contrast),
          finite(local.highlights),
          finite(local.shadows),
        ],
        index * 4,
      );
      adjust1.set(
        [
          finite(local.whites),
          finite(local.blacks),
          finite(local.temperature),
          finite(local.tint),
        ],
        index * 4,
      );
      adjust2.set(
        [
          finite(local.vibrance),
          finite(local.saturation),
          finite(local.texture),
          finite(local.clarity),
        ],
        index * 4,
      );
      adjust3.set(
        [
          finite(local.dehaze),
          finite(local.sharpness),
          finite(local.noiseReduction),
          finite(local.hue),
        ],
        index * 4,
      );
      adjust4.set(
        [finite(local.moire), finite(local.defringe), 0, 0],
        index * 4,
      );
    });
    this.gl.uniform1i(this.uniform("uMaskCount"), masks.length);
    this.gl.uniform1iv(this.uniform("uMaskKind[0]"), kinds);
    this.gl.uniform1iv(this.uniform("uMaskInverted[0]"), inverted);
    this.gl.uniform1fv(this.uniform("uMaskOpacity[0]"), opacity);
    this.gl.uniform4fv(this.uniform("uMaskData0[0]"), data0);
    this.gl.uniform4fv(this.uniform("uMaskData1[0]"), data1);
    this.gl.uniform4fv(this.uniform("uMaskAdjust0[0]"), adjust0);
    this.gl.uniform4fv(this.uniform("uMaskAdjust1[0]"), adjust1);
    this.gl.uniform4fv(this.uniform("uMaskAdjust2[0]"), adjust2);
    this.gl.uniform4fv(this.uniform("uMaskAdjust3[0]"), adjust3);
    this.gl.uniform4fv(this.uniform("uMaskAdjust4[0]"), adjust4);
    this.gl.uniform1i(this.uniform("uActiveMask"), activeIndex);
    this.gl.uniform1i(
      this.uniform("uShowMaskOverlay"),
      options.showMaskOverlay && activeIndex >= 0 ? 1 : 0,
    );
    this.gl.uniform3f(this.uniform("uOverlayColor"), ...overlayColor);
    const overlayModes: Record<
      NonNullable<RenderOptions["maskOverlayMode"]>,
      number
    > = {
      color: 0,
      "color-on-black": 1,
      "color-on-white": 2,
      "white-on-black": 3,
      "black-on-white": 4,
    };
    this.gl.uniform1i(
      this.uniform("uOverlayMode"),
      overlayModes[options.maskOverlayMode ?? "color"],
    );
    this.gl.uniform1f(
      this.uniform("uOverlayOpacity"),
      clamp(finite(options.maskOverlayOpacity, 0.48)),
    );
  }

  private maskKindIndex(mask: Mask): number {
    switch (mask.kind) {
      case "brush":
        return 0;
      case "linear":
        return 1;
      case "radial":
        return 2;
      case "luminance":
        return 3;
      case "color":
        return 4;
      case "sky":
        return 5;
      case "subject":
        return 6;
      default:
        return 0;
    }
  }

  private packMaskData(
    mask: Mask,
    data0: Float32Array,
    data1: Float32Array,
    index: number,
  ): void {
    const offset = index * 4;
    if (mask.kind === "linear" && mask.linear) {
      data0.set(
        [
          finite(mask.linear.x1),
          finite(mask.linear.y1),
          finite(mask.linear.x2),
          finite(mask.linear.y2),
        ],
        offset,
      );
    } else if (mask.kind === "radial" && mask.radial) {
      data0.set(
        [
          finite(mask.radial.cx, 0.5),
          finite(mask.radial.cy, 0.5),
          Math.max(0.0001, finite(mask.radial.rx, 0.25)),
          Math.max(0.0001, finite(mask.radial.ry, 0.25)),
        ],
        offset,
      );
      data1.set(
        [
          (finite(mask.radial.rotation) * Math.PI) / 180,
          percentage(mask.radial.feather),
          0,
          0,
        ],
        offset,
      );
    } else if (mask.kind === "luminance" && mask.luminance) {
      const minimum = normalizeLuminanceRange(mask.luminance.min);
      const maximum = normalizeLuminanceRange(mask.luminance.max);
      data0.set(
        [
          Math.min(minimum, maximum),
          Math.max(minimum, maximum),
          Math.max(0.001, percentage(mask.luminance.smoothness) * 0.25),
          0,
        ],
        offset,
      );
    } else if (mask.kind === "color" && mask.color) {
      data0.set(
        [
          normalizeChannel(mask.color.r),
          normalizeChannel(mask.color.g),
          normalizeChannel(mask.color.b),
          Math.max(0.001, percentage(mask.color.tolerance)),
        ],
        offset,
      );
    }
  }

  private updateBrushAtlas(masks: Mask[]): void {
    const componentGroups = masks.map((mask) =>
      this.cachedMaskComponents(mask),
    );
    const unchanged =
      this.brushAtlasPreviewWidth === this.previewWidth &&
      this.brushAtlasPreviewHeight === this.previewHeight &&
      this.brushAtlasCellSize === this.brushCellSize &&
      componentGroups.length === this.brushAtlasComponentGroups.length &&
      componentGroups.every(
        (components, index) =>
          components === this.brushAtlasComponentGroups[index],
      );
    if (unchanged) return;
    this.brushAtlasComponentGroups = componentGroups;
    this.brushAtlasPreviewWidth = this.previewWidth;
    this.brushAtlasPreviewHeight = this.previewHeight;
    this.brushAtlasCellSize = this.brushCellSize;
    const atlas = this.createBrushAtlas(componentGroups);
    this.brushAtlasCanvas = atlas;
    if (this.context2d) {
      const context = atlas.getContext("2d", { willReadFrequently: true });
      this.brushAtlasPixels =
        context?.getImageData(0, 0, atlas.width, atlas.height).data ?? null;
    } else {
      // WebGL samples the uploaded atlas directly; avoiding a synchronous
      // multi-megabyte Canvas2D readback makes mask edits substantially faster.
      this.brushAtlasPixels = null;
    }
    if (!this.gl || !this.resources) return;
    this.gl.activeTexture(this.gl.TEXTURE1);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.resources.brushTexture);
    this.configureTexture(this.gl);
    this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, false);
    this.gl.texImage2D(
      this.gl.TEXTURE_2D,
      0,
      this.gl.RGBA,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      atlas,
    );
  }

  private cachedMaskComponents(mask: Mask): MaskComponent[] {
    const source: object = Array.isArray(mask.components)
      ? mask.components
      : mask;
    const cached = this.maskComponentCache.get(source);
    if (cached) return cached;
    const components = getMaskComponents(mask).slice(0, MAX_MASK_COMPONENTS);
    this.maskComponentCache.set(source, components);
    return components;
  }

  private createBrushAtlas(
    componentGroups: MaskComponent[][],
  ): HTMLCanvasElement {
    const atlas = this.brushAtlasCanvas ?? document.createElement("canvas");
    const cellSize = this.brushCellSize;
    const atlasWidth = cellSize * BRUSH_ATLAS_COLUMNS;
    const atlasHeight = cellSize * BRUSH_ATLAS_ROWS;
    if (atlas.width !== atlasWidth) atlas.width = atlasWidth;
    if (atlas.height !== atlasHeight) atlas.height = atlasHeight;
    const context = atlas.getContext("2d", {
      willReadFrequently: Boolean(this.context2d),
    });
    if (!context) return atlas;
    context.clearRect(0, 0, atlas.width, atlas.height);
    componentGroups.forEach((allComponents, index) => {
      const components = allComponents
        .filter((component) => component.enabled)
        .slice(0, MAX_MASK_COMPONENTS);
      if (!components.length) return;
      const column = index % BRUSH_ATLAS_COLUMNS;
      const row = Math.floor(index / BRUSH_ATLAS_COLUMNS);
      const composed = new Float32Array(cellSize * cellSize);
      for (const component of components) {
        const componentMap =
          component.kind === "brush"
            ? this.rasterizeBrushComponent(component)
            : this.rasterizeAnalyticComponent(component);
        for (let pixel = 0; pixel < composed.length; pixel += 1) {
          let weight = componentMap[pixel];
          if (component.inverted) weight = 1 - weight;
          weight *= normalizedPercent(component.opacity);
          composed[pixel] = composeMaskWeight(
            composed[pixel],
            weight,
            component.operation,
          );
        }
      }
      const cell = context.createImageData(cellSize, cellSize);
      for (let pixel = 0; pixel < composed.length; pixel += 1) {
        const alpha = Math.round(clamp(composed[pixel]) * 255);
        const offset = pixel * 4;
        cell.data[offset] = 255;
        cell.data[offset + 1] = 255;
        cell.data[offset + 2] = 255;
        cell.data[offset + 3] = alpha;
      }
      context.putImageData(
        cell,
        column * cellSize,
        row * cellSize,
      );
    });
    return atlas;
  }

  private rasterizeBrushComponent(component: MaskComponent): Float32Array {
    const cellSize = this.brushCellSize;
    const result = new Float32Array(cellSize * cellSize);
    const paintDensityLimit = new Float32Array(result.length);
    const eraseBaseline = new Float32Array(result.length);
    const eraseDensityLimit = new Float32Array(result.length);
    const canvas = document.createElement("canvas");
    canvas.width = cellSize;
    canvas.height = cellSize;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return result;
    const sourceAspect = clamp(
      this.previewWidth / Math.max(1, this.previewHeight),
      0.1,
      10,
    );

    for (const stroke of component.strokes ?? []) {
      if (!stroke.points.length) continue;
      context.clearRect(0, 0, cellSize, cellSize);
      context.globalCompositeOperation = "source-over";
      const normalizedDiameter =
        stroke.size <= 1 ? stroke.size : stroke.size / 100;
      const baseRadiusY = Math.max(
        0.5,
        normalizedDiameter * cellSize * 0.5,
      );
      const baseRadiusX = Math.max(0.5, baseRadiusY / sourceAspect);
      const feather = percentage(stroke.feather);
      const flow = percentage(stroke.flow);

      const stamp = (point: BrushPoint) => {
        const pressure = clamp(finite(point.pressure, 1), 0.05, 1);
        const radiusX = baseRadiusX * (0.35 + pressure * 0.65);
        const radiusY = baseRadiusY * (0.35 + pressure * 0.65);
        const centerX = clamp(point.x) * cellSize;
        const centerY = clamp(point.y) * cellSize;
        context.save();
        context.translate(centerX, centerY);
        context.scale(radiusX, radiusY);
        const gradient = context.createRadialGradient(0, 0, 0, 0, 0, 1);
        const solidEdge = clamp(1 - feather, 0, 0.98);
        gradient.addColorStop(0, `rgba(255,255,255,${flow})`);
        gradient.addColorStop(
          solidEdge,
          `rgba(255,255,255,${flow})`,
        );
        gradient.addColorStop(1, "rgba(255,255,255,0)");
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(0, 0, 1, 0, Math.PI * 2);
        context.fill();
        context.restore();
      };

      let previous = stroke.points[0];
      stamp(previous);
      for (let pointIndex = 1; pointIndex < stroke.points.length; pointIndex += 1) {
        const point = stroke.points[pointIndex];
        const distance = Math.hypot(
          (point.x - previous.x) * cellSize,
          (point.y - previous.y) * cellSize,
        );
        const spacing = Math.max(1, Math.min(baseRadiusX, baseRadiusY) * 0.28);
        const steps = Math.max(1, Math.ceil(distance / spacing));
        for (let step = 1; step <= steps; step += 1) {
          const amount = step / steps;
          stamp({
            x: mix(previous.x, point.x, amount),
            y: mix(previous.y, point.y, amount),
            pressure: mix(
              finite(previous.pressure, 1),
              finite(point.pressure, 1),
              amount,
            ),
          });
        }
        previous = point;
      }

      const strokePixels = context.getImageData(
        0,
        0,
        cellSize,
        cellSize,
      ).data;
      const density = percentage(stroke.density ?? 100);
      const target = stroke.autoMask
        ? this.sampleMaskSourceColor(
            stroke.points[0].x,
            stroke.points[0].y,
          )
        : null;
      for (let pixel = 0; pixel < result.length; pixel += 1) {
        let weight = Math.min(strokePixels[pixel * 4 + 3] / 255, density);
        if (target && weight > 0) {
          const x = (pixel % cellSize + 0.5) / cellSize;
          const y =
            (Math.floor(pixel / cellSize) + 0.5) / cellSize;
          const sample = this.sampleMaskSourceColor(x, y);
          const distance = Math.hypot(
            sample[0] - target[0],
            sample[1] - target[1],
            sample[2] - target[2],
          ) / Math.sqrt(3);
          weight *= 1 - smoothstep(0.035, 0.22, distance);
        }
        if (weight <= 0) continue;
        if (stroke.erase) {
          if (eraseDensityLimit[pixel] <= 0) {
            eraseBaseline[pixel] = result[pixel];
          }
          eraseDensityLimit[pixel] = Math.max(
            eraseDensityLimit[pixel],
            density,
          );
          const densityFloor =
            eraseBaseline[pixel] * (1 - eraseDensityLimit[pixel]);
          result[pixel] = Math.max(
            densityFloor,
            result[pixel] * (1 - weight),
          );
        } else {
          paintDensityLimit[pixel] = Math.max(
            paintDensityLimit[pixel],
            density,
          );
          result[pixel] = Math.min(
            paintDensityLimit[pixel],
            1 - (1 - result[pixel]) * (1 - weight),
          );
          // A fresh paint pass establishes a new baseline for later erasing.
          eraseDensityLimit[pixel] = 0;
          eraseBaseline[pixel] = result[pixel];
        }
      }
    }
    return result;
  }

  private rasterizeAnalyticComponent(component: MaskComponent): Float32Array {
    const cellSize = this.brushCellSize;
    const result = new Float32Array(cellSize * cellSize);
    const evaluation: ComponentEvaluationContext = {};
    if (component.kind === "object" && component.object) {
      evaluation.objectTarget = this.sampleMaskSourceColor(
        component.object.x + component.object.width * 0.5,
        component.object.y + component.object.height * 0.5,
      );
    } else if (component.kind === "people") {
      evaluation.peopleFeatures = normalizePeopleFeatures(
        component.people?.features,
        component.people?.region,
      );
    }
    for (let y = 0; y < cellSize; y += 1) {
      const normalizedY = (y + 0.5) / cellSize;
      for (let x = 0; x < cellSize; x += 1) {
        const normalizedX = (x + 0.5) / cellSize;
        result[y * cellSize + x] = this.componentWeightAt(
          component,
          normalizedX,
          normalizedY,
          evaluation,
        );
      }
    }
    return result;
  }

  private componentWeightAt(
    component: MaskComponent,
    x: number,
    y: number,
    evaluation: ComponentEvaluationContext = {},
  ): number {
    if (component.kind === "linear" && component.linear) {
      const directionX =
        (component.linear.x2 - component.linear.x1) * this.previewWidth;
      const directionY =
        (component.linear.y2 - component.linear.y1) * this.previewHeight;
      const lengthSquared =
        directionX * directionX + directionY * directionY;
      if (lengthSquared < 1e-4) return 0;
      const amount =
        (((x - component.linear.x1) * this.previewWidth) * directionX +
          ((y - component.linear.y1) * this.previewHeight) * directionY) /
        lengthSquared;
      return 1 - smoothstep(0, 1, amount);
    }
    if (component.kind === "radial" && component.radial) {
      const angle = (finite(component.radial.rotation) * Math.PI) / 180;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      const pointX = x - component.radial.cx;
      const pointY = y - component.radial.cy;
      const rotatedX = cosine * pointX + sine * pointY;
      const rotatedY = -sine * pointX + cosine * pointY;
      const radius = Math.hypot(
        rotatedX / Math.max(0.0001, component.radial.rx),
        rotatedY / Math.max(0.0001, component.radial.ry),
      );
      const feather = Math.max(0.001, percentage(component.radial.feather));
      return 1 - smoothstep(Math.max(0, 1 - feather), 1, radius);
    }
    const color = this.sampleMaskSourceColor(x, y);
    const lightness = luminance(color);
    const saturation = Math.max(...color) - Math.min(...color);
    if (component.kind === "luminance" && component.luminance) {
      return this.rangeSelectionWeight(
        lightness,
        component.luminance.min,
        component.luminance.max,
        component.luminance.smoothness,
      );
    }
    if (component.kind === "color" && component.color) {
      const distance =
        Math.hypot(
          color[0] - normalizeChannel(component.color.r),
          color[1] - normalizeChannel(component.color.g),
          color[2] - normalizeChannel(component.color.b),
        ) / Math.sqrt(3);
      const tolerance = Math.max(
        0.001,
        percentage(component.color.tolerance),
      );
      return 1 - smoothstep(tolerance * 0.35, tolerance, distance);
    }

    if (component.kind === "subject") {
      return this.subjectEstimateWeight(x, y, color);
    }
    if (component.kind === "background") {
      return 1 - this.subjectEstimateWeight(x, y, color);
    }
    if (component.kind === "sky") {
      return this.skyEstimateWeight(x, y, color);
    }
    if (component.kind === "object" && component.object) {
      const object = component.object;
      const centerX = object.x + object.width * 0.5;
      const centerY = object.y + object.height * 0.5;
      const normalizedX = Math.abs(x - centerX) / Math.max(0.001, object.width * 0.5);
      const normalizedY = Math.abs(y - centerY) / Math.max(0.001, object.height * 0.5);
      const region = 1 - smoothstep(0.82, 1.08, Math.max(normalizedX, normalizedY));
      const target = evaluation.objectTarget ??
        this.sampleMaskSourceColor(centerX, centerY);
      const distance = Math.hypot(
        color[0] - target[0],
        color[1] - target[1],
        color[2] - target[2],
      ) / Math.sqrt(3);
      const similarity = 1 - smoothstep(0.05, 0.34, distance);
      return region * (0.32 + similarity * 0.68);
    }
    if (component.kind === "people") {
      const subjectWeight = this.subjectEstimateWeight(x, y, color);
      const analysis = this.getSemanticAnalysis();
      const face = ellipseWeightAt(
        x,
        y,
        analysis.faceX,
        analysis.faceY,
        0.17,
        0.22,
      );
      const skin =
        smoothstep(0.04, 0.28, color[0] - color[2]) *
        (1 - smoothstep(0.32, 0.72, Math.abs(color[0] - color[1]))) *
        smoothstep(0.12, 0.9, lightness);
      const hairRegion = ellipseWeightAt(
        x,
        y,
        analysis.faceX,
        analysis.faceY - 0.1,
        0.19,
        0.18,
        0.7,
      );
      const lowerBody = smoothstep(
        analysis.faceY + 0.1,
        analysis.faceY + 0.28,
        y,
      );
      const eyeLeft = ellipseWeightAt(
        x,
        y,
        analysis.faceX - 0.055,
        analysis.faceY - 0.025,
        0.034,
        0.021,
        0.58,
      );
      const eyeRight = ellipseWeightAt(
        x,
        y,
        analysis.faceX + 0.055,
        analysis.faceY - 0.025,
        0.034,
        0.021,
        0.58,
      );
      const eyeRegion = Math.max(eyeLeft, eyeRight);
      const mouthRegion = ellipseWeightAt(
        x,
        y,
        analysis.faceX,
        analysis.faceY + 0.075,
        0.054,
        0.03,
        0.58,
      );
      const redness = smoothstep(
        0.015,
        0.2,
        color[0] - (color[1] + color[2]) * 0.5,
      );
      const teethRegion = ellipseWeightAt(
        x,
        y,
        analysis.faceX,
        analysis.faceY + 0.07,
        0.038,
        0.014,
        0.48,
      );
      const neutralColor =
        1 - smoothstep(0.045, 0.22, saturation);
      const beardRegion = ellipseWeightAt(
        x,
        y,
        analysis.faceX,
        analysis.faceY + 0.085,
        0.105,
        0.105,
        0.62,
      );

      const features = evaluation.peopleFeatures ??
        normalizePeopleFeatures(
          component.people?.features,
          component.people?.region,
        );
      let combinedWeight = 0;
      for (const feature of features) {
        let featureWeight: number;
        switch (feature) {
          case "faceSkin":
            featureWeight = face * (0.3 + skin * 0.7);
            break;
          case "bodySkin":
            featureWeight = subjectWeight * lowerBody * skin * (1 - face * 0.85);
            break;
          case "hair":
            featureWeight = (
              subjectWeight *
              hairRegion *
              (1 - smoothstep(0.22, 0.58, lightness))
            );
            break;
          case "clothes":
            featureWeight = subjectWeight * lowerBody * (1 - skin * 0.72);
            break;
          case "eyes":
            featureWeight = face * eyeRegion *
              (0.45 + saturation * 0.3 + lightness * 0.25);
            break;
          case "lips":
            featureWeight = face * mouthRegion * (0.35 + redness * 0.65);
            break;
          case "teeth":
            featureWeight = (
              face *
              teethRegion *
              smoothstep(0.38, 0.84, lightness) *
              (0.35 + neutralColor * 0.65)
            );
            break;
          case "facialHair":
            featureWeight = (
              face *
              beardRegion *
              (1 - mouthRegion * 0.75) *
              (1 - smoothstep(0.24, 0.62, lightness))
            );
            break;
          case "wholePerson":
          default:
            featureWeight = subjectWeight;
            break;
        }
        const boundedWeight = clamp(featureWeight);
        combinedWeight = 1 - (1 - combinedWeight) * (1 - boundedWeight);
      }
      return combinedWeight;
    }
    if (component.kind === "landscape") {
      switch (component.landscape?.element ?? "sky") {
        case "sky":
          return this.skyEstimateWeight(x, y, color);
        case "vegetation":
          return (
            smoothstep(0.015, 0.18, color[1] - Math.max(color[0], color[2]) * 0.82) *
            smoothstep(0.18, 0.72, y)
          );
        case "water":
          return (
            smoothstep(0.0, 0.16, color[2] - color[0] * 0.8) *
            smoothstep(0.38, 0.72, y) *
            (1 - smoothstep(0.82, 1, y))
          );
        case "snow":
          return smoothstep(0.7, 0.96, lightness) * (1 - smoothstep(0.08, 0.3, saturation));
        case "ground":
          return smoothstep(0.54, 0.82, y) *
            (1 - this.skyEstimateWeight(x, y, color));
        case "mountains":
          return (
            (1 - smoothstep(0.58, 0.82, y)) *
            smoothstep(0.22, 0.42, y) *
            (1 - this.skyEstimateWeight(x, y, color))
          );
        case "architecture":
          return (
            smoothstep(0.2, 0.62, y) *
            (1 - smoothstep(0.35, 0.72, saturation)) *
            (1 - this.skyEstimateWeight(x, y, color))
          );
      }
    }
    if (component.kind === "depth" && component.depth) {
      // Browser image formats rarely expose a depth plane. This deterministic
      // local estimate uses perspective (vertical position) plus center
      // saliency and is labelled as estimated in the inspector.
      const centerDistance = clamp(
        Math.hypot((x - 0.5) / 0.72, (y - 0.5) / 0.72),
      );
      const estimatedDepth = clamp(y * 0.72 + centerDistance * 0.28);
      return this.rangeSelectionWeight(
        estimatedDepth,
        component.depth.min,
        component.depth.max,
        component.depth.smoothness,
      );
    }
    return 0;
  }

  private rangeSelectionWeight(
    value: number,
    minimum: number,
    maximum: number,
    smoothness: number,
  ): number {
    const lower = Math.min(minimum, maximum) / 100;
    const upper = Math.max(minimum, maximum) / 100;
    const feather = Math.max(0.001, percentage(smoothness) * 0.25);
    return (
      smoothstep(lower - feather, lower + feather, value) *
      (1 - smoothstep(upper - feather, upper + feather, value))
    );
  }

  private skyEstimateWeight(x: number, y: number, color: Rgb): number {
    const upper = 1 - smoothstep(0.12, 0.76, y);
    const blue = clamp(
      (color[2] - Math.max(color[0], color[1]) * 0.82) * 3.2 + 0.38,
    );
    const bright = smoothstep(0.18, 0.78, luminance(color));
    return upper * Math.max(blue, bright * 0.56);
  }

  private subjectEstimateWeight(x: number, y: number, color: Rgb): number {
    const analysis = this.getSemanticAnalysis();
    const central =
      1 -
      smoothstep(
        0.62,
        1.08,
        Math.hypot((x - 0.5) / 0.3, (y - 0.52) / 0.43),
      );
    const borderDistance = analysis.borderPalette.reduce(
      (minimum, borderColor) =>
        Math.min(
          minimum,
          Math.hypot(
            color[0] - borderColor[0],
            color[1] - borderColor[1],
            color[2] - borderColor[2],
          ) / Math.sqrt(3),
        ),
      1,
    );
    const foregroundEvidence = smoothstep(
      0.035 + analysis.borderSpread * 0.35,
      0.2 + analysis.borderSpread * 0.75,
      borderDistance,
    );
    const chroma = Math.max(...color) - Math.min(...color);
    const detailEvidence = smoothstep(0.025, 0.22, chroma);
    return clamp(
      foregroundEvidence * (0.76 + central * 0.24) +
        central * detailEvidence * (1 - foregroundEvidence) * 0.18,
    );
  }

  private getSemanticAnalysis(): {
    borderPalette: Rgb[];
    borderSpread: number;
    faceX: number;
    faceY: number;
    faceConfidence: number;
  } {
    if (this.semanticAnalysis) return this.semanticAnalysis;

    const borderSamples: Rgb[] = [];
    const borderSteps = 32;
    for (let index = 0; index < borderSteps; index += 1) {
      const amount = (index + 0.5) / borderSteps;
      borderSamples.push(
        this.sampleMaskSourceColor(amount, 0.002),
        this.sampleMaskSourceColor(amount, 0.998),
        this.sampleMaskSourceColor(0.002, amount),
        this.sampleMaskSourceColor(0.998, amount),
      );
    }

    const clusterCount = 5;
    const borderPalette = Array.from({ length: clusterCount }, (_, index) => [
      ...borderSamples[Math.floor((index / clusterCount) * borderSamples.length)],
    ] as Rgb);
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const sums = Array.from({ length: clusterCount }, () => [0, 0, 0, 0]);
      for (const sample of borderSamples) {
        let closest = 0;
        let closestDistance = Number.POSITIVE_INFINITY;
        borderPalette.forEach((center, index) => {
          const distance = Math.hypot(
            sample[0] - center[0],
            sample[1] - center[1],
            sample[2] - center[2],
          );
          if (distance < closestDistance) {
            closest = index;
            closestDistance = distance;
          }
        });
        sums[closest][0] += sample[0];
        sums[closest][1] += sample[1];
        sums[closest][2] += sample[2];
        sums[closest][3] += 1;
      }
      sums.forEach((sum, index) => {
        if (sum[3] > 0) {
          borderPalette[index] = [
            sum[0] / sum[3],
            sum[1] / sum[3],
            sum[2] / sum[3],
          ];
        }
      });
    }
    const borderSpread =
      borderSamples.reduce((total, sample) => {
        const distance = borderPalette.reduce(
          (minimum, center) =>
            Math.min(
              minimum,
              Math.hypot(
                sample[0] - center[0],
                sample[1] - center[1],
                sample[2] - center[2],
              ) / Math.sqrt(3),
            ),
          1,
        );
        return total + distance;
      }, 0) / Math.max(1, borderSamples.length);

    let faceWeight = 0;
    let faceX = 0;
    let faceY = 0;
    const analysisSteps = 48;
    for (let row = 0; row < analysisSteps; row += 1) {
      const sampleY = (row + 0.5) / analysisSteps;
      if (sampleY > 0.78) continue;
      for (let column = 0; column < analysisSteps; column += 1) {
        const sampleX = (column + 0.5) / analysisSteps;
        const sample = this.sampleMaskSourceColor(sampleX, sampleY);
        const sampleLightness = luminance(sample);
        const skin =
          smoothstep(0.015, 0.2, sample[0] - sample[2]) *
          (1 - smoothstep(0.34, 0.7, Math.abs(sample[0] - sample[1]))) *
          smoothstep(0.12, 0.36, sampleLightness) *
          (1 - smoothstep(0.82, 0.98, sampleLightness));
        const portraitPrior =
          0.55 +
          0.45 *
            (1 -
              smoothstep(0.45, 0.95, Math.abs(sampleX - 0.5) / 0.5));
        const weight = skin * portraitPrior;
        faceWeight += weight;
        faceX += sampleX * weight;
        faceY += sampleY * weight;
      }
    }
    const confidence = clamp(faceWeight / (analysisSteps * analysisSteps * 0.08));
    if (faceWeight > 0.001) {
      faceX /= faceWeight;
      faceY /= faceWeight;
    } else {
      faceX = 0.5;
      faceY = 0.34;
    }
    faceY = clamp(faceY, 0.16, 0.58);

    this.semanticAnalysis = {
      borderPalette,
      borderSpread,
      faceX,
      faceY,
      faceConfidence: confidence,
    };
    return this.semanticAnalysis;
  }

  private sampleMaskSourceColor(x: number, y: number): Rgb {
    const pixels = this.ensureSourcePixels();
    if (!pixels) return [0.5, 0.5, 0.5];
    return samplePixels(
      pixels,
      this.previewWidth,
      this.previewHeight,
      clamp(x),
      clamp(y),
    );
  }

  private renderCanvas2d(
    state: EditState,
    options: RenderOptions,
    geometry: FrameGeometry,
  ): void {
    const context = this.context2d;
    const sourcePixels = this.ensureSourcePixels();
    if (!context || !sourcePixels) return;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const output = context.createImageData(width, height);
    const bounds = {
      x: geometry.bounds.x * this.dpr,
      y: geometry.bounds.y * this.dpr,
      width: geometry.bounds.width * this.dpr,
      height: geometry.bounds.height * this.dpr,
    };
    const masks = state.masks
      .filter((mask) => mask.enabled)
      .slice(0, MAX_MASKS);
    const curves: CpuCurves = {
      tone: sanitizeCurve(state.curve),
      channels: [
        sanitizeCurve(state.redCurve),
        sanitizeCurve(state.greenCurve),
        sanitizeCurve(state.blueCurve),
      ],
    };
    const flags = adjustmentFlags(state, curves);
    this.updateBrushAtlas(masks);
    const activeIndex = masks.findIndex((mask) => mask.id === options.activeMaskId);
    const overlayColor =
      activeIndex >= 0 ? parseColor(masks[activeIndex].overlayColor) : [1, 0.18, 0.1] as Rgb;
    const minimumX = Math.max(0, Math.floor(bounds.x));
    const maximumX = Math.min(width, Math.ceil(bounds.x + bounds.width));
    const minimumY = Math.max(0, Math.floor(bounds.y));
    const maximumY = Math.min(height, Math.ceil(bounds.y + bounds.height));
    const inverseBoundsWidth = 1 / Math.max(1, bounds.width);
    const inverseBoundsHeight = 1 / Math.max(1, bounds.height);
    const lensDistortion =
      finite(state.lensCorrections.distortion) / 100 +
      lensProfileCorrectionStrength(state.lensCorrections) * 0.025;
    const blurRadius = state.lensBlur.enabled
      ? 1 + percentage(state.lensBlur.amount) * 12
      : 1;
    const texelX = blurRadius / Math.max(1, this.previewWidth);
    const texelY = blurRadius / Math.max(1, this.previewHeight);
    const blurShape = state.lensBlur.enabled ? state.lensBlur.bokeh : "circle";
    const fixedBlurOffsets = blurShape === "cat-eye"
      ? null
      : lensBlurSampleOffsets(blurShape);
    const sourceSample: Rgb = [0, 0, 0];
    const neighborSample: Rgb = [0, 0, 0];
    const blurred: Rgb = [0, 0, 0];
    const mappedPoint: ImagePoint = { x: 0, y: 0, inside: false };
    const spotTexelX = 2 / Math.max(1, this.previewWidth);
    const spotTexelY = 2 / Math.max(1, this.previewHeight);
    const spotOffsets = [
      [spotTexelX, 0],
      [-spotTexelX, 0],
      [0, spotTexelY],
      [0, -spotTexelY],
      [spotTexelX, spotTexelY],
      [-spotTexelX, -spotTexelY],
      [spotTexelX, -spotTexelY],
      [-spotTexelX, spotTexelY],
    ] as const;

    for (let y = minimumY; y < maximumY; y += 1) {
      const frameY = (y + 0.5 - bounds.y) * inverseBoundsHeight;
      for (let x = minimumX; x < maximumX; x += 1) {
        const frameX = (x + 0.5 - bounds.x) * inverseBoundsWidth;
        const mapped = this.mapFrameToImage(
          frameX,
          frameY,
          state,
          geometry,
          mappedPoint,
        );
        const lensVectorX = mapped.x - 0.5;
        const lensVectorY = mapped.y - 0.5;
        const lensScale = 1 +
          lensDistortion * (lensVectorX * lensVectorX + lensVectorY * lensVectorY) * 0.5;
        mapped.x = 0.5 + lensVectorX * lensScale;
        mapped.y = 0.5 + lensVectorY * lensScale;
        mapped.inside = mapped.inside &&
          mapped.x >= 0 && mapped.x <= 1 && mapped.y >= 0 && mapped.y <= 1;
        if (!mapped.inside) continue;
        let original = samplePixelsInto(
          sourcePixels,
          this.previewWidth,
          this.previewHeight,
          mapped.x,
          mapped.y,
          sourceSample,
        );
        if (!options.showOriginal) {
          original = this.applyHealCpu(original, mapped.x, mapped.y, state);
        }
        let color = original;
        if (!options.showOriginal) {
          const blurOffsets = fixedBlurOffsets ??
            lensBlurSampleOffsets(blurShape, frameX, frameY);
          let blurRed = 0;
          let blurGreen = 0;
          let blurBlue = 0;
          for (const blurOffset of blurOffsets) {
            samplePixelsInto(
              sourcePixels,
              this.previewWidth,
              this.previewHeight,
              mapped.x + blurOffset.x * texelX,
              mapped.y + blurOffset.y * texelY,
              neighborSample,
            );
            blurRed += neighborSample[0];
            blurGreen += neighborSample[1];
            blurBlue += neighborSample[2];
          }
          blurred[0] = blurRed / blurOffsets.length;
          blurred[1] = blurGreen / blurOffsets.length;
          blurred[2] = blurBlue / blurOffsets.length;
          const profiled = applyProfileCpu(original, state.profile);
          color = processGlobalCpu(
            profiled,
            blurred,
            state,
            frameX,
            frameY,
            curves,
            flags,
          );
          const maskReferenceColor: Rgb = [...color] as Rgb;
          let activeWeight = 0;
          masks.forEach((mask, index) => {
            const weight = this.maskWeightCpu(
              mask,
              index,
              mapped.x,
              mapped.y,
              maskReferenceColor,
            );
            if (weight > 0) {
              const locallyAdjusted = this.applyLocalCpu(color, blurred, mask.adjustments);
              color = color.map((channel, channelIndex) =>
                mix(channel, locallyAdjusted[channelIndex], weight),
              ) as Rgb;
            }
            if (index === activeIndex) activeWeight = weight;
          });
          if (options.showMaskOverlay && activeIndex >= 0) {
            const overlayOpacity = clamp(
              finite(options.maskOverlayOpacity, 0.48),
            );
            if ((options.maskOverlayMode ?? "color") === "color") {
              color = color.map((channel, index) =>
                mix(channel, overlayColor[index], activeWeight * overlayOpacity),
              ) as Rgb;
            } else {
              const mode = options.maskOverlayMode;
              let mapColor: Rgb;
              if (mode === "color-on-black") {
                mapColor = overlayColor.map(
                  (channel) => channel * activeWeight,
                ) as Rgb;
              } else if (mode === "color-on-white") {
                mapColor = overlayColor.map((channel) =>
                  mix(1, channel, activeWeight),
                ) as Rgb;
              } else if (mode === "white-on-black") {
                mapColor = [activeWeight, activeWeight, activeWeight];
              } else {
                mapColor = [
                  1 - activeWeight,
                  1 - activeWeight,
                  1 - activeWeight,
                ];
              }
              color = color.map((channel, index) =>
                mix(channel, mapColor[index], overlayOpacity),
              ) as Rgb;
            }
          }
          if (options.showClipping) {
            const maximum = Math.max(...color);
            if (maximum >= 0.997) {
              color = color.map((channel, index) =>
                mix(channel, [1, 0.06, 0.025][index], 0.88),
              ) as Rgb;
            } else if (maximum <= 0.008) {
              color = color.map((channel, index) =>
                mix(channel, [0.03, 0.22, 1][index], 0.9),
              ) as Rgb;
            }
          }
        }
        if (options.visualizeSpots) {
          const centerLuma = luminance(sourceSample);
          let nearbyLuma = 0;
          for (const [offsetX, offsetY] of spotOffsets) {
            samplePixelsInto(
                sourcePixels,
                this.previewWidth,
                this.previewHeight,
                mapped.x + offsetX,
                mapped.y + offsetY,
                neighborSample,
            );
            nearbyLuma += luminance(neighborSample);
          }
          nearbyLuma /= spotOffsets.length;
          const threshold = mix(
            0.0025,
            0.055,
            clamp(finite(options.visualizeSpotsThreshold, 0.5)),
          );
          const viewValue = 1 - smoothstep(
            threshold * 0.42,
            threshold,
            Math.abs(centerLuma - nearbyLuma),
          );
          color = [viewValue, viewValue, viewValue];
        }
        const offset = (y * width + x) * 4;
        output.data[offset] = Math.round(clamp(color[0]) * 255);
        output.data[offset + 1] = Math.round(clamp(color[1]) * 255);
        output.data[offset + 2] = Math.round(clamp(color[2]) * 255);
        output.data[offset + 3] = 255;
      }
    }
    context.clearRect(0, 0, width, height);
    context.putImageData(output, 0, 0);
  }

  private applyLocalCpu(
    color: Rgb,
    blurred: Rgb,
    local: LocalAdjustments,
  ): Rgb {
    let adjusted = applyBasicTone(color, blurred, {
      exposure: local.exposure,
      contrast: local.contrast,
      highlights: local.highlights,
      shadows: local.shadows,
      whites: local.whites,
      blacks: local.blacks,
      temperature: local.temperature,
      tint: local.tint,
      vibrance: local.vibrance,
      saturation: local.saturation,
      texture: local.texture,
      clarity: local.clarity,
      dehaze: local.dehaze,
      sharpening: local.sharpness,
      noiseReduction: local.noiseReduction,
      colorNoiseReduction: 0,
    });
    if (Math.abs(finite(local.hue)) > 0.0001) {
      const hsv = rgbToHsv(adjusted);
      hsv[0] = fract(hsv[0] + finite(local.hue) / 360 + 1);
      adjusted = hsvToRgb(hsv);
    }
    const moire = percentage(local.moire);
    if (moire > 0) {
      const adjustedLightness = luminance(adjusted);
      const blurredLightness = luminance(blurred);
      const reducedChroma = adjusted.map(
        (_, channel) =>
          adjustedLightness + (blurred[channel] - blurredLightness),
      ) as Rgb;
      const chromaDifference = Math.hypot(
        adjusted[0] - adjustedLightness - (blurred[0] - blurredLightness),
        adjusted[1] - adjustedLightness - (blurred[1] - blurredLightness),
        adjusted[2] - adjustedLightness - (blurred[2] - blurredLightness),
      );
      const artifactWeight = smoothstep(0.015, 0.12, chromaDifference);
      adjusted = adjusted.map((channel, index) =>
        mix(channel, reducedChroma[index], moire * artifactWeight * 0.85),
      ) as Rgb;
    }
    const defringe = percentage(local.defringe);
    if (defringe > 0) {
      const purple = clamp(
        (adjusted[2] + adjusted[0] - adjusted[1] * 2) * 2.4,
      );
      const neutral = luminance(adjusted);
      adjusted = adjusted.map((channel) =>
        mix(channel, neutral, purple * defringe * 0.72),
      ) as Rgb;
    }
    return adjusted.map((channel) => clamp(channel)) as Rgb;
  }

  private applyHealCpu(
    input: Rgb,
    x: number,
    y: number,
    state: EditState,
  ): Rgb {
    if (!this.sourcePixels) return input;
    let color = input;
    const reference = Math.min(this.previewWidth, this.previewHeight);
    const distanceScaleX = this.previewWidth / Math.max(1, reference);
    const distanceScaleY = this.previewHeight / Math.max(1, reference);
    for (const spot of this.healDabs) {
      const dx = (x - spot.destination.x) * distanceScaleX;
      const dy = (y - spot.destination.y) * distanceScaleY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const radius = Math.max(0.0001, normalizeRepairRadius(spot.size, reference));
      if (distance >= radius) continue;
      const feather = Math.max(0.001, percentage(spot.feather));
      let weight =
        1 -
        smoothstep(radius * (1 - feather), radius, distance);
      weight *= percentage(spot.opacity);
      const sourceX = x + spot.source.x - spot.destination.x;
      const sourceY = y + spot.source.y - spot.destination.y;
      if (sourceX < 0 || sourceX > 1 || sourceY < 0 || sourceY > 1) continue;
      let replacement = samplePixels(
        this.sourcePixels,
        this.previewWidth,
        this.previewHeight,
        sourceX,
        sourceY,
      );
      if (spot.mode === "remove") {
        const stepX = (radius / Math.max(0.0001, distanceScaleX)) * 0.32;
        const stepY = (radius / Math.max(0.0001, distanceScaleY)) * 0.32;
        const patchSamples = [
          replacement,
          samplePixels(this.sourcePixels, this.previewWidth, this.previewHeight, sourceX + stepX, sourceY),
          samplePixels(this.sourcePixels, this.previewWidth, this.previewHeight, sourceX - stepX, sourceY),
          samplePixels(this.sourcePixels, this.previewWidth, this.previewHeight, sourceX, sourceY + stepY),
          samplePixels(this.sourcePixels, this.previewWidth, this.previewHeight, sourceX, sourceY - stepY),
        ];
        const patchAverage = [0, 1, 2].map(
          (channel) =>
            patchSamples.reduce((sum, sample) => sum + sample[channel], 0) /
            patchSamples.length,
        ) as Rgb;
        replacement = replacement.map((channel, index) =>
          mix(channel, patchAverage[index], 0.55),
        ) as Rgb;
        const ratio = clamp(
          luminance(color) / Math.max(0.02, luminance(replacement)),
          0.6,
          1.7,
        );
        replacement = replacement.map((channel) => channel * ratio) as Rgb;
      } else if (spot.mode === "heal") {
        const ratio = clamp(
          luminance(color) / Math.max(0.02, luminance(replacement)),
          0.45,
          2.2,
        );
        replacement = replacement.map((channel) => channel * ratio) as Rgb;
      }
      color = color.map((channel, index) =>
        mix(channel, replacement[index], weight),
      ) as Rgb;
    }
    return color;
  }

  private maskWeightCpu(
    mask: Mask,
    maskIndex: number,
    x: number,
    y: number,
    _color: Rgb,
  ): number {
    let value = this.sampleBrushAtlas(maskIndex, x, y);
    if (mask.inverted) value = 1 - value;
    return clamp(value * normalizedPercent(mask.opacity));
  }

  private sampleBrushAtlas(index: number, x: number, y: number): number {
    if (!this.brushAtlasPixels || !this.brushAtlasCanvas) return 0;
    const cellSize = this.brushCellSize;
    const column = index % BRUSH_ATLAS_COLUMNS;
    const row = Math.floor(index / BRUSH_ATLAS_COLUMNS);
    const sampleX = clamp(x) * cellSize - 0.5;
    const sampleY = clamp(y) * cellSize - 0.5;
    const x0 = Math.max(0, Math.min(cellSize - 1, Math.floor(sampleX)));
    const y0 = Math.max(0, Math.min(cellSize - 1, Math.floor(sampleY)));
    const x1 = Math.min(cellSize - 1, x0 + 1);
    const y1 = Math.min(cellSize - 1, y0 + 1);
    const amountX = clamp(sampleX - x0);
    const amountY = clamp(sampleY - y0);
    const atlasWidth = this.brushAtlasCanvas.width;
    const atlasX0 = column * cellSize + x0;
    const atlasX1 = column * cellSize + x1;
    const atlasY0 = row * cellSize + y0;
    const atlasY1 = row * cellSize + y1;
    const topLeft = this.brushAtlasPixels[(atlasY0 * atlasWidth + atlasX0) * 4 + 3] / 255;
    const topRight = this.brushAtlasPixels[(atlasY0 * atlasWidth + atlasX1) * 4 + 3] / 255;
    const bottomLeft = this.brushAtlasPixels[(atlasY1 * atlasWidth + atlasX0) * 4 + 3] / 255;
    const bottomRight = this.brushAtlasPixels[(atlasY1 * atlasWidth + atlasX1) * 4 + 3] / 255;
    const top = mix(topLeft, topRight, amountX);
    const bottom = mix(bottomLeft, bottomRight, amountX);
    return mix(top, bottom, amountY);
  }

  private computeFrameGeometry(
    state: EditState,
    cropPreview = false,
  ): FrameGeometry {
    const crop = this.sanitizeCrop(state);
    const cropWidth = Math.max(1e-6, crop[2] * this.previewWidth);
    const cropHeight = Math.max(1e-6, crop[3] * this.previewHeight);
    const aspectScale = Math.max(
      0.05,
      1 + finite(state.geometry.aspect) / 100,
    );
    const adjustedCropWidth = cropWidth * aspectScale;
    const adjustedCropHeight = cropHeight;
    const combinedAngleDegrees =
      finite(state.geometry.rotate) + finite(state.crop.angle);
    const angle = (combinedAngleDegrees * Math.PI) / 180;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const absoluteCosine = Math.abs(cosine);
    const absoluteSine = Math.abs(sine);
    const oriented = editedFrameDimensions(
      adjustedCropWidth,
      adjustedCropHeight,
      finite(state.geometry.rotate),
      finite(state.crop.angle),
    );
    const boundingWidth = cropPreview
      ? absoluteCosine * adjustedCropWidth +
        absoluteSine * adjustedCropHeight
      : oriented.width;
    const boundingHeight = cropPreview
      ? absoluteSine * adjustedCropWidth +
        absoluteCosine * adjustedCropHeight
      : oriented.height;
    const requestedScale = Math.max(
      0.01,
      finite(state.geometry.scale, 100) / 100,
    );
    let effectiveScale = requestedScale;

    if (!cropPreview && state.geometry.constrainCrop) {
      const horizontal = finite(state.geometry.horizontal) / 200;
      const vertical = finite(state.geometry.vertical) / 200;
      const offsetX = clamp(finite(state.geometry.offsetX) / 200, -0.49, 0.49);
      const offsetY = clamp(finite(state.geometry.offsetY) / 200, -0.49, 0.49);
      effectiveScale = Math.max(
        requestedScale,
        minimumFillScale({
          frameWidth: boundingWidth,
          frameHeight: boundingHeight,
          sourceWidth: adjustedCropWidth,
          sourceHeight: adjustedCropHeight,
          angleRadians: angle,
          horizontal,
          vertical,
          offsetX,
          offsetY,
        }),
      );
    }
    const fit = Math.min(
      this.cssWidth / Math.max(1e-6, boundingWidth),
      this.cssHeight / Math.max(1e-6, boundingHeight),
    );
    const width = Math.max(0, boundingWidth * fit);
    const height = Math.max(0, boundingHeight * fit);
    return {
      bounds: {
        x: (this.cssWidth - width) / 2,
        y: (this.cssHeight - height) / 2,
        width,
        height,
      },
      crop,
      sourceWidth: this.previewWidth,
      sourceHeight: this.previewHeight,
      adjustedCropWidth,
      adjustedCropHeight,
      boundingWidth,
      boundingHeight,
      cosine,
      sine,
      effectiveScale,
      offsetX: clamp(finite(state.geometry.offsetX) / 200, -0.49, 0.49),
      offsetY: clamp(finite(state.geometry.offsetY) / 200, -0.49, 0.49),
    };
  }

  private sanitizeCrop(state: EditState): [number, number, number, number] {
    const width = clamp(finite(state.crop.width, 1), 1e-6, 1);
    const height = clamp(finite(state.crop.height, 1), 1e-6, 1);
    const x = clamp(finite(state.crop.x), 0, 1 - width);
    const y = clamp(finite(state.crop.y), 0, 1 - height);
    return [x, y, width, height];
  }

  private mapFrameToImage(
    frameX: number,
    frameY: number,
    state: EditState,
    geometry: FrameGeometry,
    result?: ImagePoint,
  ): ImagePoint {
    const rotatedX = (frameX - 0.5) * geometry.boundingWidth;
    const rotatedY = (frameY - 0.5) * geometry.boundingHeight;
    const unrotatedX =
      geometry.cosine * rotatedX + geometry.sine * rotatedY;
    const unrotatedY =
      -geometry.sine * rotatedX + geometry.cosine * rotatedY;
    const scale = geometry.effectiveScale;
    let localX = unrotatedX / geometry.adjustedCropWidth / scale;
    let localY = unrotatedY / geometry.adjustedCropHeight / scale;
    const projected = projectiveFrameToSource(
      localX,
      localY,
      finite(state.geometry.horizontal) / 200,
      finite(state.geometry.vertical) / 200,
    );
    localX = projected.x;
    localY = projected.y;
    localX -= geometry.offsetX;
    localY -= geometry.offsetY;
    if (state.geometry.flipX) localX = -localX;
    if (state.geometry.flipY) localY = -localY;
    const x = geometry.crop[0] + geometry.crop[2] * (localX + 0.5);
    const y = geometry.crop[1] + geometry.crop[3] * (localY + 0.5);
    const mapped = result ?? { x: 0, y: 0, inside: false };
    mapped.x = x;
    mapped.y = y;
    mapped.inside =
      Math.abs(localX) <= 0.50001 &&
      Math.abs(localY) <= 0.50001 &&
      x >= 0 &&
      x <= 1 &&
      y >= 0 &&
      y <= 1;
    return mapped;
  }

  private ensureSourcePixels(): Uint8ClampedArray | null {
    if (this.sourcePixels) return this.sourcePixels;
    if (!this.sourceImage || typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    canvas.width = this.previewWidth;
    canvas.height = this.previewHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(this.sourceImage, 0, 0, this.previewWidth, this.previewHeight);
    this.sourcePixels = context.getImageData(
      0,
      0,
      this.previewWidth,
      this.previewHeight,
    ).data;
    return this.sourcePixels;
  }

  private buildHistogram(
    pixels: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
  ): HistogramData {
    const histogram = this.histogram;
    histogram.red.fill(0);
    histogram.green.fill(0);
    histogram.blue.fill(0);
    histogram.luminance.fill(0);
    const stride = Math.max(
      1,
      Math.ceil(Math.sqrt((width * height) / HISTOGRAM_SAMPLE_BUDGET)),
    );
    for (let y = 0; y < height; y += stride) {
      for (let x = 0; x < width; x += stride) {
        const offset = (y * width + x) * 4;
        if (pixels[offset + 3] === 0) continue;
        const red = pixels[offset];
        const green = pixels[offset + 1];
        const blue = pixels[offset + 2];
        const lightness = Math.round(
          red * 0.2126 + green * 0.7152 + blue * 0.0722,
        );
        histogram.red[red] += 1;
        histogram.green[green] += 1;
        histogram.blue[blue] += 1;
        histogram.luminance[lightness] += 1;
      }
    }
    return histogram;
  }

  private async decodeBlob(blob: Blob): Promise<DecodedImage> {
    if (typeof createImageBitmap === "function") {
      try {
        return await createImageBitmap(blob, {
          imageOrientation: "from-image",
          premultiplyAlpha: "none",
          colorSpaceConversion: "default",
        });
      } catch {
        try {
          return await createImageBitmap(blob);
        } catch {
          // Continue to the HTMLImageElement decoder.
        }
      }
    }
    if (typeof document === "undefined") {
      throw new Error("This environment cannot decode browser image blobs.");
    }
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.decoding = "async";
      image.src = url;
      if (typeof image.decode === "function") {
        await image.decode();
      } else {
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error("Unable to decode the image."));
        });
      }
      return image;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private async resizeDecodedImage(
    source: DecodedImage,
    width: number,
    height: number,
  ): Promise<DecodedImage> {
    if (typeof createImageBitmap === "function") {
      try {
        return await createImageBitmap(
          source,
          0,
          0,
          this.imageWidth(source),
          this.imageHeight(source),
          {
            resizeWidth: width,
            resizeHeight: height,
            resizeQuality: "high",
          },
        );
      } catch {
        // Canvas resampling is the universal fallback.
      }
    }
    if (typeof document === "undefined") {
      throw new Error("This environment cannot resize browser images.");
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Unable to create a preview canvas.");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, width, height);
    return canvas;
  }

  private imageWidth(image: DecodedImage): number {
    if (
      typeof HTMLImageElement !== "undefined" &&
      image instanceof HTMLImageElement
    ) {
      return image.naturalWidth || image.width;
    }
    return image.width;
  }

  private imageHeight(image: DecodedImage): number {
    if (
      typeof HTMLImageElement !== "undefined" &&
      image instanceof HTMLImageElement
    ) {
      return image.naturalHeight || image.height;
    }
    return image.height;
  }

  private closeImage(image: DecodedImage | null): void {
    if (
      image &&
      typeof ImageBitmap !== "undefined" &&
      image instanceof ImageBitmap
    ) {
      image.close();
    }
  }

  private releaseSource(): void {
    this.closeImage(this.sourceImage);
    this.sourceImage = null;
    this.sourcePixels = null;
    this.semanticAnalysis = null;
    this.histogramReadback = null;
    this.healSpotSource = null;
  }

  private drawWatermark(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    settings: ExportSettings,
  ): void {
    const fontSize = Math.max(14, Math.round(Math.min(width, height) * 0.028));
    const padding = Math.max(12, Math.round(Math.min(width, height) * 0.025));
    context.save();
    context.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
    context.textBaseline = "middle";
    context.fillStyle = `rgba(255,255,255,${normalizedPercent(settings.watermarkOpacity)})`;
    context.shadowColor = "rgba(0,0,0,0.65)";
    context.shadowBlur = Math.max(2, fontSize * 0.16);
    const metrics = context.measureText(settings.watermarkText);
    const textWidth = metrics.width;
    const textHeight =
      metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent ||
      fontSize;
    let x = width / 2;
    let y = height / 2;
    context.textAlign = "center";
    if (settings.watermarkPosition.includes("left")) {
      x = padding;
      context.textAlign = "left";
    } else if (settings.watermarkPosition.includes("right")) {
      x = width - padding;
      context.textAlign = "right";
    }
    if (settings.watermarkPosition.startsWith("top")) {
      y = padding + textHeight / 2;
    } else if (settings.watermarkPosition.startsWith("bottom")) {
      y = height - padding - textHeight / 2;
    }
    // Keep very long watermarks inside the image without changing their text.
    if (textWidth > width - padding * 2) {
      const scale = (width - padding * 2) / textWidth;
      context.translate(x, y);
      context.scale(scale, scale);
      context.fillText(settings.watermarkText, 0, 0);
    } else {
      context.fillText(settings.watermarkText, x, y);
    }
    context.restore();
  }

  private canvasToBlob(
    canvas: HTMLCanvasElement,
    format: ExportSettings["format"],
    quality: number,
  ): Promise<Blob> {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error(`The browser could not encode ${format}.`));
            return;
          }
          if (blob.type !== format) {
            reject(
              new Error(
                `This browser returned ${blob.type || "an unknown format"} instead of ${format}. Choose another export format.`,
              ),
            );
            return;
          }
          resolve(blob);
        },
        format,
        quality,
      );
    });
  }
}

export default ImageEngine;
