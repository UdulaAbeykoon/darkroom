import { describe, expect, it } from "vitest";
import {
  BUILT_IN_PRESETS,
  DEFAULT_GLOBAL_ADJUSTMENTS,
  HUE_CHANNELS,
  canonicalProfileName,
  cloneEditState,
  createDefaultEditState,
} from "./defaults";
import { RETIRED_PROFILE_NAMESPACE } from "./lib/retiredIdentity";

describe("default edit state", () => {
  it("normalizes profile names created by previous builds", () => {
    expect(canonicalProfileName(`${RETIRED_PROFILE_NAMESPACE} Neutral`)).toBe(
      "Darkroom Color",
    );
    expect(canonicalProfileName(`${RETIRED_PROFILE_NAMESPACE} Vivid`)).toBe(
      "Darkroom Vivid",
    );
    expect(canonicalProfileName("Adobe Portrait")).toBe("Darkroom Portrait");
    expect(canonicalProfileName("Darkroom Portrait")).toBe("Darkroom Portrait");
    expect(canonicalProfileName("Previous Vivid")).toBe("Previous Vivid");
    expect(canonicalProfileName("Custom Flat Profile")).toBe(
      "Custom Flat Profile",
    );
  });

  it("creates isolated non-destructive state objects", () => {
    const first = createDefaultEditState();
    const second = createDefaultEditState();

    first.global.exposure = 2;
    first.curve[0].y = 0.2;
    first.redCurve[1].y = 0.4;
    first.hsl.blue.saturation = -40;
    first.pointColor.hue = 210;
    first.lensCorrections.distortion = 18;
    first.lensBlur.focusX = 0.2;
    first.calibration.bluePrimaryHue = -25;
    first.geometry.guides.push({
      orientation: "horizontal",
      start: { x: 0.1, y: 0.2 },
      end: { x: 0.9, y: 0.2 },
    });

    expect(second.global.exposure).toBe(0);
    expect(second.curve[0].y).toBe(0);
    expect(second.redCurve[1].y).toBe(0.25);
    expect(second.hsl.blue.saturation).toBe(0);
    expect(second.pointColor.hue).toBe(0);
    expect(second.lensCorrections.distortion).toBe(0);
    expect(second.lensBlur.focusX).toBe(0.5);
    expect(second.calibration.bluePrimaryHue).toBe(0);
    expect(second.geometry.guides).toEqual([]);
  });

  it("defines every color mixer channel", () => {
    const state = createDefaultEditState();
    expect(Object.keys(state.hsl).sort()).toEqual([...HUE_CHANNELS].sort());
  });

  it("clones nested edit structures", () => {
    const original = createDefaultEditState();
    const clone = cloneEditState(original);
    clone.crop.width = 0.5;
    clone.colorGrading.shadows.saturation = 30;
    clone.greenCurve[2].y = 0.7;
    clone.lensBlur.amount = 90;
    clone.geometry.guides.push({
      orientation: "vertical",
      start: { x: 0.25, y: 0.1 },
      end: { x: 0.25, y: 0.9 },
    });

    expect(original.crop.width).toBe(1);
    expect(original.colorGrading.shadows.saturation).toBe(0);
    expect(original.greenCurve[2].y).toBe(0.5);
    expect(original.lensBlur.amount).toBe(50);
    expect(original.geometry.guides).toEqual([]);
  });
});

describe("built-in presets", () => {
  it("uses known adjustment keys and values within engine ranges", () => {
    for (const preset of BUILT_IN_PRESETS) {
      expect(preset.name.length).toBeGreaterThan(2);
      for (const [key, value] of Object.entries(preset.adjustments)) {
        expect(key in DEFAULT_GLOBAL_ADJUSTMENTS).toBe(true);
        expect(Number.isFinite(value)).toBe(true);
        expect(Math.abs(value)).toBeLessThanOrEqual(100);
      }
    }
  });
});
