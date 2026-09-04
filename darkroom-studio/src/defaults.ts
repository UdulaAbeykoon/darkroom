import type {
  CalibrationAdjustments,
  ColorGrading,
  DevelopPreset,
  EditState,
  GlobalAdjustments,
  HslAdjustments,
  HueChannel,
  LensBlurAdjustments,
  LensCorrections,
  LocalAdjustments,
  PointColorAdjustments,
  ToneCurvePoint,
} from "./types";
import { RETIRED_PROFILE_NAMESPACE } from "./lib/retiredIdentity";

export const HUE_CHANNELS: HueChannel[] = [
  "red",
  "orange",
  "yellow",
  "green",
  "aqua",
  "blue",
  "purple",
  "magenta",
];

export const DEFAULT_GLOBAL_ADJUSTMENTS: GlobalAdjustments = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  vibrance: 0,
  saturation: 0,
  texture: 0,
  clarity: 0,
  dehaze: 0,
  sharpening: 20,
  sharpeningRadius: 1,
  sharpeningDetail: 25,
  sharpeningMasking: 0,
  noiseReduction: 0,
  noiseReductionDetail: 50,
  noiseReductionContrast: 0,
  colorNoiseReduction: 10,
  colorNoiseReductionDetail: 50,
  colorNoiseReductionSmoothness: 50,
  vignette: 0,
  vignetteMidpoint: 50,
  vignetteFeather: 50,
  grain: 0,
  grainSize: 25,
};

export const DEFAULT_LOCAL_ADJUSTMENTS: LocalAdjustments = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  vibrance: 0,
  saturation: 0,
  texture: 0,
  clarity: 0,
  dehaze: 0,
  hue: 0,
  sharpness: 0,
  noiseReduction: 0,
  moire: 0,
  defringe: 0,
};

export const DEFAULT_HSL: HslAdjustments = HUE_CHANNELS.reduce(
  (channels, channel) => {
    channels[channel] = { hue: 0, saturation: 0, luminance: 0 };
    return channels;
  },
  {} as HslAdjustments,
);

export const DEFAULT_COLOR_GRADING: ColorGrading = {
  shadows: { hue: 220, saturation: 0, luminance: 0 },
  midtones: { hue: 35, saturation: 0, luminance: 0 },
  highlights: { hue: 45, saturation: 0, luminance: 0 },
  blending: 50,
  balance: 0,
};

export const DEFAULT_POINT_COLOR: PointColorAdjustments = {
  enabled: false,
  hue: 0,
  range: 25,
  hueShift: 0,
  saturationShift: 0,
  luminanceShift: 0,
};

export const DEFAULT_LENS_CORRECTIONS: LensCorrections = {
  removeChromaticAberration: false,
  enableProfileCorrections: false,
  setup: "default",
  distortion: 0,
  vignette: 0,
  midpoint: 50,
  defringePurpleAmount: 0,
  defringePurpleHueLow: 30,
  defringePurpleHueHigh: 70,
  defringeGreenAmount: 0,
  defringeGreenHueLow: 40,
  defringeGreenHueHigh: 60,
};

export const DEFAULT_LENS_BLUR: LensBlurAdjustments = {
  enabled: false,
  amount: 50,
  focusRange: 45,
  focusX: 0.5,
  focusY: 0.42,
  bokeh: "circle",
  boost: 0,
};

export const DEFAULT_CALIBRATION: CalibrationAdjustments = {
  processVersion: "6",
  shadowsTint: 0,
  redPrimaryHue: 0,
  redPrimarySaturation: 0,
  greenPrimaryHue: 0,
  greenPrimarySaturation: 0,
  bluePrimaryHue: 0,
  bluePrimarySaturation: 0,
};

export const DEFAULT_TONE_CURVE: ToneCurvePoint[] = [
  { x: 0, y: 0 },
  { x: 0.25, y: 0.25 },
  { x: 0.5, y: 0.5 },
  { x: 0.75, y: 0.75 },
  { x: 1, y: 1 },
];

const LEGACY_PROFILE_FAMILIES: Record<string, string> = {
  Neutral: "Adobe Color",
  Vivid: "Adobe Vivid",
  Portrait: "Adobe Portrait",
  Landscape: "Adobe Landscape",
  Monochrome: "Adobe Monochrome",
};

/**
 * Converts two-part profile names written by older builds to the current Adobe
 * equivalents without coupling the catalog to a retired product name.
 */
export function canonicalProfileName(profile: string): string {
  const parts = profile.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0] !== RETIRED_PROFILE_NAMESPACE) {
    return profile;
  }
  return LEGACY_PROFILE_FAMILIES[parts[1]] ?? profile;
}

export const createDefaultEditState = (): EditState => ({
  profile: "Adobe Color",
  global: { ...DEFAULT_GLOBAL_ADJUSTMENTS },
  curve: structuredClone(DEFAULT_TONE_CURVE),
  redCurve: structuredClone(DEFAULT_TONE_CURVE),
  greenCurve: structuredClone(DEFAULT_TONE_CURVE),
  blueCurve: structuredClone(DEFAULT_TONE_CURVE),
  hsl: structuredClone(DEFAULT_HSL),
  pointColor: structuredClone(DEFAULT_POINT_COLOR),
  colorGrading: structuredClone(DEFAULT_COLOR_GRADING),
  lensCorrections: structuredClone(DEFAULT_LENS_CORRECTIONS),
  lensBlur: structuredClone(DEFAULT_LENS_BLUR),
  calibration: structuredClone(DEFAULT_CALIBRATION),
  geometry: {
    uprightMode: "off",
    constrainCrop: false,
    guides: [],
    rotate: 0,
    vertical: 0,
    horizontal: 0,
    aspect: 0,
    scale: 100,
    offsetX: 0,
    offsetY: 0,
    flipX: false,
    flipY: false,
  },
  crop: {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    aspect: "Original",
    locked: false,
    angle: 0,
  },
  masks: [],
  healSpots: [],
});

export const BUILT_IN_PRESETS: DevelopPreset[] = [
  {
    id: "clean-color",
    name: "Clean color",
    group: "Classic",
    description: "Open shadows, restrained contrast, natural color.",
    adjustments: {
      exposure: 0.15,
      contrast: 8,
      highlights: -24,
      shadows: 20,
      whites: 8,
      blacks: -8,
      vibrance: 12,
      clarity: 4,
    },
  },
  {
    id: "quiet-film",
    name: "Quiet film",
    group: "Classic",
    description: "Soft highlight rolloff with muted color and fine grain.",
    adjustments: {
      contrast: -4,
      highlights: -36,
      shadows: 10,
      blacks: 12,
      saturation: -8,
      vibrance: 6,
      grain: 18,
      grainSize: 22,
    },
    curve: [
      { x: 0, y: 0.045 },
      { x: 0.22, y: 0.2 },
      { x: 0.52, y: 0.54 },
      { x: 0.82, y: 0.86 },
      { x: 1, y: 0.97 },
    ],
  },
  {
    id: "night-chrome",
    name: "Night chrome",
    group: "Classic",
    description: "Cool shadows, protected highlights, crisp night color.",
    adjustments: {
      exposure: -0.12,
      contrast: 18,
      highlights: -30,
      shadows: 14,
      blacks: -16,
      temperature: -9,
      tint: 4,
      vibrance: 18,
      clarity: 10,
      dehaze: 8,
    },
  },
  {
    id: "warm-portrait",
    name: "Warm portrait",
    group: "Portrait",
    description: "Gentle warmth with smooth midtone contrast.",
    adjustments: {
      exposure: 0.2,
      contrast: -6,
      highlights: -18,
      shadows: 16,
      temperature: 10,
      tint: 3,
      texture: -8,
      clarity: -4,
      vibrance: 8,
    },
  },
  {
    id: "hard-mono",
    name: "Hard mono",
    group: "Monochrome",
    description: "Graphic monochrome with a deep black point.",
    adjustments: {
      saturation: -100,
      contrast: 28,
      highlights: -12,
      shadows: 10,
      whites: 16,
      blacks: -26,
      clarity: 14,
      grain: 14,
    },
  },
];

export const cloneEditState = (state: EditState): EditState =>
  structuredClone(state);
