import { describe, expect, it } from "vitest";
import { BUILT_IN_PRESETS, createDefaultEditState } from "../defaults";
import { applyPresetAtAmount } from "./presetMath";

describe("applyPresetAtAmount", () => {
  const preset = BUILT_IN_PRESETS[0];

  it("returns the stable base at zero amount", () => {
    const base = createDefaultEditState();
    base.global.exposure = -0.4;
    expect(applyPresetAtAmount(base, preset, 0)).toEqual(base);
  });

  it("applies the preset exactly at 100", () => {
    const next = applyPresetAtAmount(createDefaultEditState(), preset, 100);
    expect(next.global.exposure).toBe(preset.adjustments.exposure);
    expect(next.global.highlights).toBe(preset.adjustments.highlights);
  });

  it("interpolates and supports the 200 percent extension", () => {
    const base = createDefaultEditState();
    base.global.exposure = -0.1;
    const half = applyPresetAtAmount(base, preset, 50);
    const double = applyPresetAtAmount(base, preset, 200);
    expect(half.global.exposure).toBeCloseTo(0.025, 6);
    expect(double.global.exposure).toBeCloseTo(0.4, 6);
  });

  it("does not alter controls absent from the preset", () => {
    const base = createDefaultEditState();
    base.global.temperature = 17;
    base.geometry.vertical = 22;
    const next = applyPresetAtAmount(base, preset, 130);
    expect(next.global.temperature).toBe(17);
    expect(next.geometry.vertical).toBe(22);
  });
});
