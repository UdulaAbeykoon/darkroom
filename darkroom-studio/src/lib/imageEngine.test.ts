import { describe, expect, it } from "vitest";
import { createDefaultEditState } from "../defaults";
import {
  averageColorSamples,
  combinePeopleFeatureWeights,
  defringeHueRangeWeight,
  isIdentityToneCurve,
  lensBlurSampleOffsets,
  lensProfileCorrectionStrength,
  minimumFillScale,
  normalizeRepairRadius,
  orientedFrameDimensions,
} from "./imageEngine";

describe("neutral render passes", () => {
  it("recognizes every default tone curve as an exact identity", () => {
    const state = createDefaultEditState();
    expect(isIdentityToneCurve(state.curve)).toBe(true);
    expect(isIdentityToneCurve(state.redCurve)).toBe(true);
    expect(isIdentityToneCurve(state.greenCurve)).toBe(true);
    expect(isIdentityToneCurve(state.blueCurve)).toBe(true);
  });

  it("does not skip curves that clip endpoints or alter a midpoint", () => {
    expect(isIdentityToneCurve([
      { x: 0.1, y: 0.1 },
      { x: 1, y: 1 },
    ])).toBe(false);
    expect(isIdentityToneCurve([
      { x: 0, y: 0 },
      { x: 0.5, y: 0.55 },
      { x: 1, y: 1 },
    ])).toBe(false);
  });
});

describe("lens profile setup", () => {
  it("gives every enabled setup a distinct correction strength", () => {
    const base = createDefaultEditState().lensCorrections;
    expect(lensProfileCorrectionStrength(base)).toBe(0);

    const strengths = (["default", "auto", "custom"] as const).map((setup) =>
      lensProfileCorrectionStrength({
        ...base,
        enableProfileCorrections: true,
        setup,
      }),
    );
    expect(new Set(strengths).size).toBe(3);
    strengths.forEach((strength) => expect(strength).toBeGreaterThan(0));
  });
});

describe("people feature masks", () => {
  it("combines independently estimated features as a bounded union", () => {
    expect(combinePeopleFeatureWeights([])).toBe(0);
    expect(combinePeopleFeatureWeights([0.5, 0.5])).toBeCloseTo(0.75, 10);
    expect(combinePeopleFeatureWeights([0.4, 2, -1])).toBe(1);
  });
});

describe("orientedFrameDimensions", () => {
  it("preserves dimensions for straightening angles and half turns", () => {
    expect(orientedFrameDimensions(6000, 4000, 0)).toEqual({
      width: 6000,
      height: 4000,
    });
    expect(orientedFrameDimensions(6000, 4000, 180)).toEqual({
      width: 6000,
      height: 4000,
    });
    expect(orientedFrameDimensions(6000, 4000, 45)).toEqual({
      width: 6000,
      height: 4000,
    });
    expect(orientedFrameDimensions(6000, 4000, -45)).toEqual({
      width: 6000,
      height: 4000,
    });
  });

  it("swaps dimensions for quarter-turn orientation changes", () => {
    expect(orientedFrameDimensions(6000, 4000, 90)).toEqual({
      width: 4000,
      height: 6000,
    });
    expect(orientedFrameDimensions(6000, 4000, -90)).toEqual({
      width: 4000,
      height: 6000,
    });
  });
});

describe("normalizeRepairRadius", () => {
  it("treats current Remove brush sizes as source-image pixels", () => {
    expect(normalizeRepairRadius(34, 1200)).toBeCloseTo(17 / 1200, 10);
    expect(normalizeRepairRadius(500, 4000)).toBeCloseTo(250 / 4000, 10);
  });

  it("keeps legacy normalized brush diameters readable", () => {
    expect(normalizeRepairRadius(0.2, 1200)).toBeCloseTo(0.1, 10);
  });
});

describe("minimumFillScale", () => {
  it("keeps right-angle rotations at native coverage", () => {
    expect(
      minimumFillScale({
        frameWidth: 4000,
        frameHeight: 6000,
        sourceWidth: 6000,
        sourceHeight: 4000,
        angleRadians: Math.PI / 2,
      }),
    ).toBeCloseTo(1, 8);
  });

  it("zooms enough to cover every corner after straightening", () => {
    expect(
      minimumFillScale({
        frameWidth: 1000,
        frameHeight: 1000,
        sourceWidth: 1000,
        sourceHeight: 1000,
        angleRadians: Math.PI / 4,
      }),
    ).toBeCloseTo(Math.SQRT2, 8);
  });

  it("accounts for offsets without exposing an empty edge", () => {
    expect(
      minimumFillScale({
        frameWidth: 1000,
        frameHeight: 1000,
        sourceWidth: 1000,
        sourceHeight: 1000,
        angleRadians: 0,
        offsetX: 0.1,
      }),
    ).toBeCloseTo(1.25, 8);
  });
});

describe("lens blur sampling", () => {
  const shapes = [
    "circle",
    "bubble",
    "five-blade",
    "ring",
    "cat-eye",
  ] as const;

  it("provides a distinct centered eight-tap kernel for every bokeh shape", () => {
    const signatures = shapes.map((shape) => {
      const offsets = lensBlurSampleOffsets(shape, 0.82, 0.64);
      expect(offsets).toHaveLength(8);
      expect(offsets.reduce((sum, offset) => sum + offset.x, 0)).toBeCloseTo(0, 10);
      expect(offsets.reduce((sum, offset) => sum + offset.y, 0)).toBeCloseTo(0, 10);
      return offsets
        .map((offset) => `${offset.x.toFixed(4)},${offset.y.toFixed(4)}`)
        .join("|");
    });

    expect(new Set(signatures).size).toBe(shapes.length);
  });

  it("orients cat-eye bokeh around the frame center", () => {
    const fromRight = lensBlurSampleOffsets("cat-eye", 0.9, 0.5);
    const fromBottom = lensBlurSampleOffsets("cat-eye", 0.5, 0.9);
    expect(fromRight).not.toEqual(fromBottom);
  });

  it("normalizes all eight samples instead of doubling their brightness", () => {
    const samples = Array.from(
      { length: 8 },
      () => [0.25, 0.5, 0.75] as const,
    );
    expect(averageColorSamples(samples)).toEqual([0.25, 0.5, 0.75]);
  });
});

describe("defringe hue ranges", () => {
  it("selects and rejects purple hues as its endpoints move", () => {
    const bluePurpleHue = 240 / 360;
    expect(defringeHueRangeWeight(bluePurpleHue, "purple", 30, 70)).toBe(0);
    expect(defringeHueRangeWeight(bluePurpleHue, "purple", 0, 20)).toBe(1);
    expect(defringeHueRangeWeight(300 / 360, "purple", 30, 70)).toBe(1);
  });

  it("selects and rejects green hues as its endpoints move", () => {
    const greenHue = 135 / 360;
    expect(defringeHueRangeWeight(greenHue, "green", 40, 60)).toBe(1);
    expect(defringeHueRangeWeight(greenHue, "green", 0, 25)).toBe(0);
  });

  it("handles the purple band's wrap through red", () => {
    expect(defringeHueRangeWeight(0, "purple", 80, 100)).toBe(1);
  });
});
