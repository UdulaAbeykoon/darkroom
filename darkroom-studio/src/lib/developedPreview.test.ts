import { describe, expect, it } from "vitest";
import { createDefaultEditState } from "../defaults";
import { normalizeMask, updateMaskComponent } from "./maskMath";
import {
  developedPreviewDimensions,
  editRevision,
  previewDimensionBucket,
} from "./developedPreview";

describe("editRevision", () => {
  it("is stable for equivalent edit recipes", () => {
    const left = createDefaultEditState();
    const right = structuredClone(left);
    expect(editRevision(left)).toBe(editRevision(right));
  });

  it("changes when a nested adjustment or brush point changes", () => {
    const baseline = createDefaultEditState();
    const adjusted = structuredClone(baseline);
    adjusted.global.exposure = 0.35;
    expect(editRevision(adjusted)).not.toBe(editRevision(baseline));
  });

  it("changes for the expanded curve, point color, lens blur, and calibration recipe", () => {
    const baseline = createDefaultEditState();
    const recipes = [
      (state: ReturnType<typeof createDefaultEditState>) => { state.blueCurve[1].y = 0.31; },
      (state: ReturnType<typeof createDefaultEditState>) => { state.pointColor.enabled = true; },
      (state: ReturnType<typeof createDefaultEditState>) => { state.lensBlur.enabled = true; },
      (state: ReturnType<typeof createDefaultEditState>) => { state.calibration.redPrimaryHue = 20; },
    ];

    recipes.forEach((change) => {
      const adjusted = structuredClone(baseline);
      change(adjusted);
      expect(editRevision(adjusted)).not.toBe(editRevision(baseline));
    });
  });

  it("reuses unchanged structural sections while still tracking the changed section", () => {
    const baseline = createDefaultEditState();
    const adjusted = {
      ...baseline,
      global: { ...baseline.global, exposure: 0.75 },
    };
    expect(adjusted.masks).toBe(baseline.masks);
    expect(editRevision(adjusted)).not.toBe(editRevision(baseline));
    expect(editRevision(adjusted)).toBe(editRevision(structuredClone(adjusted)));
  });

  it("tracks local sliders and growing strokes while sharing immutable brush history", () => {
    const baseline = createDefaultEditState();
    const mask = normalizeMask({id: 'paint', kind: 'brush', strokes: [{size: 10, flow: 50, feather: 80, points: [{x: 0.2, y: 0.5}]}]});
    baseline.masks = [mask];
    const original = editRevision(baseline);
    const local = {...baseline, masks: [{...mask, adjustments: {...mask.adjustments, exposure: 1}}]};
    expect(editRevision(local)).not.toBe(original);
    expect(editRevision(local)).toBe(editRevision(structuredClone(local)));
    const component = mask.components![0];
    const grown = {...baseline, masks: [updateMaskComponent(mask, component.id, {strokes: [...component.strokes!, {...component.strokes![0], points: [{x: 0.9, y: 0.6}]}]})]};
    expect(editRevision(grown)).not.toBe(original);
    expect(editRevision(grown)).toBe(editRevision(structuredClone(grown)));
    expect(editRevision(baseline)).toBe(original);
  });
});

describe("previewDimensionBucket", () => {
  it("coalesces nearby layout requests into bounded reusable render sizes", () => {
    expect(previewDimensionBucket(128)).toBe(256);
    expect(previewDimensionBucket(220)).toBe(256);
    expect(previewDimensionBucket(257)).toBe(512);
    expect(previewDimensionBucket(900)).toBe(1_024);
    expect(previewDimensionBucket(10_000)).toBe(2_048);
  });
});

describe("developedPreviewDimensions", () => {
  it("caps the long edge and honors a crop", () => {
    const edits = createDefaultEditState();
    edits.crop.width = 0.5;
    expect(developedPreviewDimensions(6_000, 4_000, edits, 600)).toEqual({
      width: 450,
      height: 600,
    });
  });

  it("swaps orientation for a quarter turn", () => {
    const edits = createDefaultEditState();
    edits.geometry.rotate = 90;
    expect(developedPreviewDimensions(6_000, 4_000, edits, 600)).toEqual({
      width: 400,
      height: 600,
    });
  });

  it("includes crop straightening when sizing developed previews", () => {
    const edits = createDefaultEditState();
    edits.crop.angle = 90;
    expect(developedPreviewDimensions(6_000, 4_000, edits, 600)).toEqual({
      width: 400,
      height: 600,
    });
  });
});
