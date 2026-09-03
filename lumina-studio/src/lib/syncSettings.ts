import type {
  SyncSettingsCategory,
  SyncSettingsDetail,
  SyncSettingsSelection,
} from "../components/SyncSettingsDialog";
import { cloneEditState } from "../defaults";
import type {
  EditState,
  GeometryAdjustments,
  GlobalAdjustments,
  LensCorrections,
} from "../types";

function isSelected(
  selection: SyncSettingsSelection,
  category: SyncSettingsCategory,
  detail: SyncSettingsDetail,
): boolean {
  return selection.details?.[detail] ?? selection[category];
}

export function mergeSynchronizedSettings(
  target: EditState,
  source: EditState,
  selection: SyncSettingsSelection,
): EditState {
  const next = cloneEditState(target);
  const copyGlobal = (keys: (keyof GlobalAdjustments)[]) => {
    keys.forEach((key) => {
      next.global[key] = source.global[key] as never;
    });
  };
  const copyLensCorrections = (keys: (keyof LensCorrections)[]) => {
    keys.forEach((key) => {
      next.lensCorrections[key] = source.lensCorrections[key] as never;
    });
  };
  const copyGeometry = (keys: (keyof GeometryAdjustments)[]) => {
    keys.forEach((key) => {
      next.geometry[key] = structuredClone(source.geometry[key]) as never;
    });
  };

  if (selection.treatmentProfile) next.profile = source.profile;
  if (selection.whiteBalance) copyGlobal(["temperature", "tint"]);
  if (isSelected(selection, "basicTone", "basicTone.exposure"))
    copyGlobal(["exposure"]);
  if (isSelected(selection, "basicTone", "basicTone.contrast"))
    copyGlobal(["contrast"]);
  if (isSelected(selection, "basicTone", "basicTone.highlights"))
    copyGlobal(["highlights"]);
  if (isSelected(selection, "basicTone", "basicTone.shadows"))
    copyGlobal(["shadows"]);
  if (isSelected(selection, "basicTone", "basicTone.whites"))
    copyGlobal(["whites"]);
  if (isSelected(selection, "basicTone", "basicTone.blacks"))
    copyGlobal(["blacks"]);
  if (isSelected(selection, "basicTone", "basicTone.texture"))
    copyGlobal(["texture"]);
  if (isSelected(selection, "basicTone", "basicTone.clarity"))
    copyGlobal(["clarity"]);
  if (isSelected(selection, "basicTone", "basicTone.dehaze"))
    copyGlobal(["dehaze"]);
  if (isSelected(selection, "basicTone", "basicTone.vibrance"))
    copyGlobal(["vibrance"]);
  if (isSelected(selection, "basicTone", "basicTone.saturation"))
    copyGlobal(["saturation"]);
  if (selection.toneCurve) {
    next.curve = structuredClone(source.curve);
    next.redCurve = structuredClone(source.redCurve);
    next.greenCurve = structuredClone(source.greenCurve);
    next.blueCurve = structuredClone(source.blueCurve);
  }
  if (selection.hslColor) {
    next.hsl = structuredClone(source.hsl);
    next.pointColor = structuredClone(source.pointColor);
  }
  if (selection.colorGrading) next.colorGrading = structuredClone(source.colorGrading);
  if (isSelected(selection, "detail", "detail.sharpening")) {
    copyGlobal([
      "sharpening", "sharpeningRadius", "sharpeningDetail", "sharpeningMasking",
    ]);
  }
  if (isSelected(selection, "detail", "detail.noiseReduction")) {
    copyGlobal([
      "noiseReduction", "noiseReductionDetail", "noiseReductionContrast",
    ]);
  }
  if (isSelected(selection, "detail", "detail.colorNoiseReduction")) {
    copyGlobal([
      "colorNoiseReduction", "colorNoiseReductionDetail", "colorNoiseReductionSmoothness",
    ]);
  }
  if (
    isSelected(
      selection,
      "lensCorrections",
      "lensCorrections.chromaticAberration",
    )
  ) {
    copyLensCorrections(["removeChromaticAberration"]);
  }
  if (
    isSelected(selection, "lensCorrections", "lensCorrections.profile")
  ) {
    copyLensCorrections(["enableProfileCorrections", "setup"]);
  }
  if (
    isSelected(selection, "lensCorrections", "lensCorrections.distortion")
  ) {
    copyLensCorrections(["distortion"]);
  }
  if (
    isSelected(selection, "lensCorrections", "lensCorrections.vignetting")
  ) {
    copyLensCorrections(["vignette", "midpoint"]);
  }
  if (isSelected(selection, "lensCorrections", "lensCorrections.defringe")) {
    copyLensCorrections([
      "defringePurpleAmount",
      "defringePurpleHueLow",
      "defringePurpleHueHigh",
      "defringeGreenAmount",
      "defringeGreenHueLow",
      "defringeGreenHueHigh",
    ]);
  }
  if (selection.lensBlur) next.lensBlur = structuredClone(source.lensBlur);
  if (isSelected(selection, "transform", "transform.upright"))
    copyGeometry(["uprightMode"]);
  if (isSelected(selection, "transform", "transform.guides"))
    copyGeometry(["guides"]);
  if (isSelected(selection, "transform", "transform.constrainCrop"))
    copyGeometry(["constrainCrop"]);
  if (isSelected(selection, "transform", "transform.rotate"))
    copyGeometry(["rotate"]);
  if (isSelected(selection, "transform", "transform.vertical"))
    copyGeometry(["vertical"]);
  if (isSelected(selection, "transform", "transform.horizontal"))
    copyGeometry(["horizontal"]);
  if (isSelected(selection, "transform", "transform.aspect"))
    copyGeometry(["aspect"]);
  if (isSelected(selection, "transform", "transform.scale"))
    copyGeometry(["scale"]);
  if (isSelected(selection, "transform", "transform.offsets"))
    copyGeometry(["offsetX", "offsetY"]);
  if (isSelected(selection, "transform", "transform.flip"))
    copyGeometry(["flipX", "flipY"]);
  if (isSelected(selection, "effects", "effects.vignette"))
    copyGlobal(["vignette", "vignetteMidpoint", "vignetteFeather"]);
  if (isSelected(selection, "effects", "effects.grain"))
    copyGlobal(["grain", "grainSize"]);
  if (selection.calibration) next.calibration = structuredClone(source.calibration);
  if (selection.crop) next.crop = structuredClone(source.crop);
  if (selection.remove) next.healSpots = structuredClone(source.healSpots);
  if (selection.masks) next.masks = structuredClone(source.masks);
  return next;
}
