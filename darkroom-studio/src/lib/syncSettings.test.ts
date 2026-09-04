import { describe, expect, it } from "vitest";
import { createSyncSettingsSelection } from "../components/SyncSettingsDialog";
import { createDefaultEditState } from "../defaults";
import { mergeSynchronizedSettings } from "./syncSettings";

describe("mergeSynchronizedSettings", () => {
  it("copies the expanded Lightroom tone, detail, lens, blur, and calibration state", () => {
    const target = createDefaultEditState();
    const source = createDefaultEditState();
    source.redCurve[1].y = 0.42;
    source.pointColor = { ...source.pointColor, enabled: true, hue: 214, hueShift: 18 };
    source.global.sharpeningRadius = 2.2;
    source.lensCorrections = {
      ...source.lensCorrections,
      enableProfileCorrections: true,
      distortion: 17,
    };
    source.lensBlur = { ...source.lensBlur, enabled: true, amount: 67 };
    source.calibration = { ...source.calibration, bluePrimaryHue: -22 };

    const merged = mergeSynchronizedSettings(
      target,
      source,
      createSyncSettingsSelection(true),
    );

    expect(merged.redCurve[1].y).toBe(0.42);
    expect(merged.pointColor).toEqual(source.pointColor);
    expect(merged.global.sharpeningRadius).toBe(2.2);
    expect(merged.lensCorrections).toEqual(source.lensCorrections);
    expect(merged.lensBlur).toEqual(source.lensBlur);
    expect(merged.calibration).toEqual(source.calibration);
  });

  it("leaves unchecked categories untouched", () => {
    const target = createDefaultEditState();
    const source = createDefaultEditState();
    source.global.exposure = 2;
    source.lensBlur.enabled = true;
    source.calibration.redPrimaryHue = 35;

    const selection = createSyncSettingsSelection(false);
    selection.lensBlur = true;
    const merged = mergeSynchronizedSettings(target, source, selection);

    expect(merged.lensBlur.enabled).toBe(true);
    expect(merged.global.exposure).toBe(0);
    expect(merged.calibration.redPrimaryHue).toBe(0);
  });

  it("copies only explicitly selected Basic, Detail, Lens, Transform, and Effects controls", () => {
    const target = createDefaultEditState();
    const source = createDefaultEditState();
    source.global.exposure = 1.35;
    source.global.contrast = 28;
    source.global.sharpening = 73;
    source.global.noiseReduction = 41;
    source.global.grain = 62;
    source.global.vignette = -34;
    source.lensCorrections.removeChromaticAberration = true;
    source.lensCorrections.enableProfileCorrections = true;
    source.lensCorrections.distortion = 27;
    source.lensCorrections.vignette = -31;
    source.geometry.rotate = 8.5;
    source.geometry.vertical = 24;
    source.geometry.offsetX = 17;
    source.geometry.offsetY = -9;

    const selection = createSyncSettingsSelection(false);
    selection.details = {
      "basicTone.exposure": true,
      "detail.sharpening": true,
      "lensCorrections.chromaticAberration": true,
      "lensCorrections.distortion": true,
      "transform.rotate": true,
      "transform.offsets": true,
      "effects.grain": true,
    };

    const merged = mergeSynchronizedSettings(target, source, selection);

    expect(merged.global.exposure).toBe(1.35);
    expect(merged.global.contrast).toBe(0);
    expect(merged.global.sharpening).toBe(73);
    expect(merged.global.noiseReduction).toBe(0);
    expect(merged.global.grain).toBe(62);
    expect(merged.global.vignette).toBe(0);
    expect(merged.lensCorrections.removeChromaticAberration).toBe(true);
    expect(merged.lensCorrections.enableProfileCorrections).toBe(false);
    expect(merged.lensCorrections.distortion).toBe(27);
    expect(merged.lensCorrections.vignette).toBe(0);
    expect(merged.geometry.rotate).toBe(8.5);
    expect(merged.geometry.vertical).toBe(0);
    expect(merged.geometry.offsetX).toBe(17);
    expect(merged.geometry.offsetY).toBe(-9);
  });

  it("treats missing detail selections as the legacy parent category value", () => {
    const target = createDefaultEditState();
    const source = createDefaultEditState();
    source.global.exposure = 0.7;
    source.global.saturation = 19;
    source.global.sharpeningRadius = 1.8;
    source.lensCorrections.defringeGreenAmount = 14;
    source.geometry.aspect = -12;
    source.geometry.flipX = true;
    source.global.vignetteFeather = 84;

    const legacySelection = createSyncSettingsSelection(false);
    legacySelection.basicTone = true;
    legacySelection.detail = true;
    legacySelection.lensCorrections = true;
    legacySelection.transform = true;
    legacySelection.effects = true;

    const merged = mergeSynchronizedSettings(
      target,
      source,
      legacySelection,
    );

    expect(merged.global.exposure).toBe(0.7);
    expect(merged.global.saturation).toBe(19);
    expect(merged.global.sharpeningRadius).toBe(1.8);
    expect(merged.lensCorrections.defringeGreenAmount).toBe(14);
    expect(merged.geometry.aspect).toBe(-12);
    expect(merged.geometry.flipX).toBe(true);
    expect(merged.global.vignetteFeather).toBe(84);
  });

  it("lets an explicit child selection override a checked legacy parent", () => {
    const target = createDefaultEditState();
    const source = createDefaultEditState();
    source.global.exposure = 1;
    source.global.contrast = 35;

    const selection = createSyncSettingsSelection(false);
    selection.basicTone = true;
    selection.details = { "basicTone.contrast": false };

    const merged = mergeSynchronizedSettings(target, source, selection);

    expect(merged.global.exposure).toBe(1);
    expect(merged.global.contrast).toBe(0);
  });
});
