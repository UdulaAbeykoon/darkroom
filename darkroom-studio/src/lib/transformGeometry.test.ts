import { describe, expect, it } from "vitest";
import { createDefaultEditState } from "../defaults";
import { normalizeCatalogEditState } from "./catalog";
import {
  editedFrameDimensions,
  projectiveFrameToSource,
  projectiveSourceToFrame,
} from "./imageEngine";

describe("editedFrameDimensions", () => {
  it("uses the combined geometry rotation and crop angle for output bounds", () => {
    expect(editedFrameDimensions(6_000, 4_000, 80, 10)).toEqual({
      width: 4_000,
      height: 6_000,
    });
    expect(editedFrameDimensions(6_000, 4_000, -80, -10)).toEqual({
      width: 4_000,
      height: 6_000,
    });
  });

  it("does not swap bounds when crop straightening moves off a quarter turn", () => {
    expect(editedFrameDimensions(6_000, 4_000, 90, -10)).toEqual({
      width: 6_000,
      height: 4_000,
    });
  });

  it("sanitizes a non-finite component without losing the valid angle", () => {
    expect(editedFrameDimensions(6_000, 4_000, Number.NaN, 90)).toEqual({
      width: 4_000,
      height: 6_000,
    });
  });
});

describe("projective geometry mappings", () => {
  it("preserves points when no keystone correction is applied", () => {
    const point = { x: 0.37, y: -0.28 };

    expect(projectiveFrameToSource(point.x, point.y, 0, 0)).toEqual(point);
    expect(projectiveSourceToFrame(point.x, point.y, 0, 0)).toEqual(point);
  });

  it("applies the expected homogeneous divide", () => {
    const x = 0.3;
    const y = -0.2;
    const horizontal = 0.4;
    const vertical = -0.25;
    const denominator = 1 + horizontal * x + vertical * y;

    const mapped = projectiveFrameToSource(
      x,
      y,
      horizontal,
      vertical,
    );

    expect(mapped.x).toBeCloseTo(x / denominator, 12);
    expect(mapped.y).toBeCloseTo(y / denominator, 12);
  });

  it("round-trips representative frame and source points", () => {
    const corrections = [
      { horizontal: 0.32, vertical: -0.27 },
      { horizontal: -0.41, vertical: 0.18 },
      { horizontal: 0.08, vertical: 0.44 },
    ];
    const points = [
      { x: -0.45, y: -0.4 },
      { x: 0, y: 0 },
      { x: 0.17, y: -0.31 },
      { x: 0.46, y: 0.39 },
    ];

    for (const correction of corrections) {
      for (const point of points) {
        const source = projectiveFrameToSource(
          point.x,
          point.y,
          correction.horizontal,
          correction.vertical,
        );
        const restoredFrame = projectiveSourceToFrame(
          source.x,
          source.y,
          correction.horizontal,
          correction.vertical,
        );
        expect(restoredFrame.x).toBeCloseTo(point.x, 10);
        expect(restoredFrame.y).toBeCloseTo(point.y, 10);

        const frame = projectiveSourceToFrame(
          point.x,
          point.y,
          correction.horizontal,
          correction.vertical,
        );
        const restoredSource = projectiveFrameToSource(
          frame.x,
          frame.y,
          correction.horizontal,
          correction.vertical,
        );
        expect(restoredSource.x).toBeCloseTo(point.x, 10);
        expect(restoredSource.y).toBeCloseTo(point.y, 10);
      }
    }
  });

  it("returns finite coordinates at a projective singularity", () => {
    const mapped = projectiveFrameToSource(0.5, 0, -2, 0);

    expect(Number.isFinite(mapped.x)).toBe(true);
    expect(Number.isFinite(mapped.y)).toBe(true);
  });
});

describe("Transform state defaults and migration", () => {
  it("starts with Upright off and Constrain Crop disabled", () => {
    const state = createDefaultEditState();

    expect(state.geometry.uprightMode).toBe("off");
    expect(state.geometry.constrainCrop).toBe(false);
  });

  it("adds the new Transform fields to legacy catalog recipes", () => {
    const legacy = structuredClone(createDefaultEditState()) as unknown as {
      geometry: Record<string, unknown>;
    };
    delete legacy.geometry.uprightMode;
    delete legacy.geometry.constrainCrop;
    legacy.geometry.rotate = 2.4;
    legacy.geometry.vertical = -18;

    const migrated = normalizeCatalogEditState(legacy);

    expect(migrated.geometry).toMatchObject({
      uprightMode: "off",
      constrainCrop: false,
      rotate: 2.4,
      vertical: -18,
    });
  });

  it("preserves valid persisted Upright and crop constraints", () => {
    const persisted = createDefaultEditState();
    persisted.geometry.uprightMode = "full";
    persisted.geometry.constrainCrop = true;

    const restored = normalizeCatalogEditState(structuredClone(persisted));

    expect(restored.geometry.uprightMode).toBe("full");
    expect(restored.geometry.constrainCrop).toBe(true);
  });
});
