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

  it.each(BUILT_IN_PRESETS.filter((candidate) => candidate.profile))(
    "applies $name without overwriting existing edits",
    (profilePreset) => {
      const base = createDefaultEditState();
      base.global.exposure = 1.25;
      base.global.temperature = -18;
      base.curve[2].y = 0.65;
      base.hsl.blue.saturation = 30;
      base.crop.width = 0.7;
      base.geometry.vertical = 12;
      const before = structuredClone(base);

      const next = applyPresetAtAmount(base, profilePreset, 100);

      expect(next).toEqual({ ...before, profile: profilePreset.profile });
      expect(base).toEqual(before);
      expect(next.global).not.toBe(base.global);
      expect(next.crop).not.toBe(base.crop);
    },
  );

  it("restores the previous profile at zero and treats profiles as discrete transforms", () => {
    const base = createDefaultEditState();
    base.profile = "Darkroom Portrait";
    const landscape = BUILT_IN_PRESETS.find(
      (candidate) => candidate.id === "darkroom-landscape",
    )!;

    expect(applyPresetAtAmount(base, landscape, 0)).toEqual(base);
    for (const amount of [1, 50, 100, 200]) {
      expect(applyPresetAtAmount(base, landscape, amount)).toEqual({
        ...base,
        profile: "Darkroom Landscape",
      });
    }
  });

  it("keeps the chosen rendering profile when applying an adjustment preset", () => {
    const base = createDefaultEditState();
    base.profile = "Darkroom Landscape";

    expect(applyPresetAtAmount(base, preset, 100).profile).toBe(
      "Darkroom Landscape",
    );
  });

  it("accepts legacy profile names without changing the source preset", () => {
    const legacyPreset = { ...preset, profile: "Adobe Portrait" };

    expect(
      applyPresetAtAmount(createDefaultEditState(), legacyPreset, 100).profile,
    ).toBe("Darkroom Portrait");
    expect(legacyPreset.profile).toBe("Adobe Portrait");
  });
});
