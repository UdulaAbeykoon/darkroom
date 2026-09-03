import { describe, expect, it } from "vitest";
import type { CropState } from "../types";
import {
  cropFromDelta,
  cropOverlayLines,
  type CropAction,
  type CropOverlayCorners,
} from "./DevelopWorkspace";

const cropState = (patch: Partial<CropState> = {}): CropState => ({
  x: 0.2,
  y: 0.2,
  width: 0.6,
  height: 0.3,
  aspect: "Original",
  locked: false,
  angle: 0,
  ...patch,
});

const expectCropCoordinates = (
  actual: CropState,
  expected: Pick<CropState, "x" | "y" | "width" | "height">,
) => {
  expect(actual.x).toBeCloseTo(expected.x, 10);
  expect(actual.y).toBeCloseTo(expected.y, 10);
  expect(actual.width).toBeCloseTo(expected.width, 10);
  expect(actual.height).toBeCloseTo(expected.height, 10);
};

describe("cropFromDelta edge handles", () => {
  it.each<{
    action: CropAction;
    dx: number;
    dy: number;
    expected: Partial<CropState>;
  }>([
    { action: "n", dx: 0, dy: 0.1, expected: { x: 0.2, y: 0.3, width: 0.6, height: 0.2 } },
    { action: "e", dx: -0.1, dy: 0, expected: { x: 0.2, y: 0.2, width: 0.5, height: 0.3 } },
    { action: "s", dx: 0, dy: 0.1, expected: { x: 0.2, y: 0.2, width: 0.6, height: 0.4 } },
    { action: "w", dx: 0.1, dy: 0, expected: { x: 0.3, y: 0.2, width: 0.5, height: 0.3 } },
  ])("resizes the $action edge without moving unrelated edges", ({ action, dx, dy, expected }) => {
    const next = cropFromDelta(cropState(), action, dx, dy);

    for (const [key, value] of Object.entries(expected)) {
      expect(next[key as keyof CropState]).toBeCloseTo(value as number, 10);
    }
  });

  it("keeps a locked ratio when dragging a horizontal edge", () => {
    const original = cropState({ locked: true });
    const originalBottom = original.y + original.height;
    const next = cropFromDelta(original, "n", 0, 0.1);

    expect(next.width / next.height).toBeCloseTo(2, 10);
    expect(next.y + next.height).toBeCloseTo(originalBottom, 10);
    expect(next.x + next.width / 2).toBeCloseTo(
      original.x + original.width / 2,
      10,
    );
    expectCropCoordinates(next, { x: 0.3, y: 0.3, width: 0.4, height: 0.2 });
  });

  it("keeps a locked ratio when dragging a vertical edge", () => {
    const original = cropState({ locked: true });
    const originalCenterY = original.y + original.height / 2;
    const next = cropFromDelta(original, "e", -0.2, 0);

    expect(next.width / next.height).toBeCloseTo(2, 10);
    expect(next.x).toBeCloseTo(original.x, 10);
    expect(next.y + next.height / 2).toBeCloseTo(originalCenterY, 10);
    expectCropCoordinates(next, { x: 0.2, y: 0.25, width: 0.4, height: 0.2 });
  });

  it("preserves locked corner resizing", () => {
    const next = cropFromDelta(cropState({ locked: true }), "se", -0.2, 0);

    expect(next.width / next.height).toBeCloseTo(2, 10);
    expectCropCoordinates(next, { x: 0.2, y: 0.2, width: 0.4, height: 0.2 });
  });

  it("keeps the crop frame movable and clamped inside the image", () => {
    const original = cropState();
    const next = cropFromDelta(original, "move", 0.4, -0.5);

    expect(next).toMatchObject({
      x: 0.4,
      y: 0,
      width: original.width,
      height: original.height,
    });
  });
});

describe("cropOverlayLines", () => {
  const landscape: CropOverlayCorners = [
    { x: 0, y: 0 },
    { x: 900, y: 0 },
    { x: 900, y: 600 },
    { x: 0, y: 600 },
  ];

  it("creates a rule-of-thirds guide inside the crop frame", () => {
    const lines = cropOverlayLines("thirds", landscape);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toEqual({ x1: 300, y1: 0, x2: 300, y2: 600 });
    expect(lines[3]).toEqual({ x1: 0, y1: 400, x2: 900, y2: 400 });
  });

  it("creates a dense, nearly square grid for a landscape crop", () => {
    const lines = cropOverlayLines("grid", landscape);
    expect(lines).toHaveLength(11);
    expect(lines[0].x1).toBeCloseTo(112.5);
    expect(lines[7]).toEqual({ x1: 0, y1: 120, x2: 900, y2: 120 });
  });

  it("draws 45-degree diagonal guides inward from all four corners", () => {
    const lines = cropOverlayLines("diagonal", landscape);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toEqual({ x1: 0, y1: 0, x2: 600, y2: 600 });
    expect(lines[3].x1).toBe(900);
    expect(lines[3].y1).toBe(600);
    expect(lines[3].x2).toBeCloseTo(300);
    expect(lines[3].y2).toBe(0);
  });

  it("places golden-ratio guides at the phi sections", () => {
    const lines = cropOverlayLines("golden-ratio", landscape);
    const goldenSection = (3 - Math.sqrt(5)) / 2;
    expect(lines).toHaveLength(4);
    expect(lines[0].x1).toBeCloseTo(900 * goldenSection);
    expect(lines[2].y1).toBeCloseTo(600 * goldenSection);
  });

  it("avoids duplicate diagonal guides for a square crop", () => {
    const square: CropOverlayCorners = [
      { x: 10, y: 10 },
      { x: 410, y: 10 },
      { x: 410, y: 410 },
      { x: 10, y: 410 },
    ];
    expect(cropOverlayLines("diagonal", square)).toHaveLength(2);
  });
});
