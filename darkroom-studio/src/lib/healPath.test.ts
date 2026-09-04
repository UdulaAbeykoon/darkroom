import { describe, expect, it } from "vitest";
import { expandHealPaths, type HealPathLike } from "./healPath";

const repair = (patch: Partial<HealPathLike> = {}): HealPathLike => ({
  destination: { x: 0.2, y: 0.3 },
  source: { x: 0.3, y: 0.4 },
  size: 40,
  feather: 70,
  opacity: 100,
  mode: "remove",
  ...patch,
});

describe("expandHealPaths", () => {
  it("keeps legacy point repairs renderer-compatible", () => {
    const [dab] = expandHealPaths([repair()], 1200, 800, 1);
    expect(dab.destination).toEqual({ x: 0.2, y: 0.3 });
    expect(dab.source).toEqual({ x: 0.3, y: 0.4 });
  });

  it("samples a painted path across both endpoints", () => {
    const dabs = expandHealPaths([
      repair({
        path: [
          { x: 0.1, y: 0.2 },
          { x: 0.7, y: 0.2 },
        ],
      }),
    ], 1000, 1000, 5);
    expect(dabs).toHaveLength(5);
    expect(dabs[0].destination.x).toBeCloseTo(0.1);
    expect(dabs[4].destination.x).toBeCloseTo(0.7);
    expect(dabs[2].source.x - dabs[2].destination.x).toBeCloseTo(0.1);
  });

  it("shares a constrained dab budget across repair groups", () => {
    const dabs = expandHealPaths([
      repair({ path: [{ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.2 }] }),
      repair({ path: [{ x: 0.1, y: 0.5 }, { x: 0.3, y: 0.5 }] }),
    ], 1000, 1000, 8);
    expect(dabs).toHaveLength(8);
    expect(dabs.filter((dab) => dab.groupIndex === 0).length).toBeGreaterThan(
      dabs.filter((dab) => dab.groupIndex === 1).length,
    );
    expect(new Set(dabs.map((dab) => dab.groupIndex))).toEqual(new Set([0, 1]));
  });

  it("uses pressure to vary brush diameter", () => {
    const dabs = expandHealPaths([
      repair({
        path: [
          { x: 0.2, y: 0.2, pressure: 0.1 },
          { x: 0.6, y: 0.2, pressure: 1 },
        ],
      }),
    ], 1000, 1000, 2);
    expect(dabs[0].size).toBeLessThan(dabs[1].size);
  });

  it("clamps invalid and out-of-bounds path points safely", () => {
    const dabs = expandHealPaths([
      repair({
        path: [
          { x: -1, y: 2 },
          { x: Number.NaN, y: 0.5 },
        ],
      }),
    ], 1000, 1000, 2);
    expect(dabs.every((dab) => Number.isFinite(dab.destination.x))).toBe(true);
    expect(dabs[0].destination).toEqual({ x: 0, y: 1 });
  });

  it("never exceeds the renderer's 32-dab hard cap", () => {
    const dabs = expandHealPaths([
      repair({
        path: [
          { x: 0, y: 0.1 },
          { x: 1, y: 0.1 },
        ],
      }),
    ], 4000, 3000, 1_000);

    expect(dabs).toHaveLength(32);
  });

  it("preserves every repair when the repairs themselves fit the budget", () => {
    const repairs = Array.from({ length: 32 }, (_, index) =>
      repair({
        destination: { x: index / 40, y: 0.2 },
        source: { x: index / 40, y: 0.3 },
        path: [
          { x: index / 40, y: 0.2 },
          { x: index / 40, y: 0.8 },
        ],
      }),
    );
    const dabs = expandHealPaths(repairs, 1200, 800);

    expect(dabs).toHaveLength(32);
    expect(dabs.map((dab) => dab.groupIndex)).toEqual(
      Array.from({ length: 32 }, (_, index) => index),
    );
  });

  it("does not spend spare capacity duplicating point repairs", () => {
    const dabs = expandHealPaths(
      Array.from({ length: 5 }, (_, index) =>
        repair({
          destination: { x: 0.1 + index * 0.1, y: 0.3 },
          source: { x: 0.2 + index * 0.1, y: 0.4 },
        }),
      ),
      1200,
      800,
    );

    expect(dabs).toHaveLength(5);
    expect(dabs.map((dab) => dab.groupIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it("allocates more constrained dabs to smaller brushes on equal paths", () => {
    const spots = [
      repair({
        size: 20,
        path: [
          { x: 0.1, y: 0.25 },
          { x: 0.9, y: 0.25 },
        ],
      }),
      repair({
        size: 80,
        path: [
          { x: 0.1, y: 0.75 },
          { x: 0.9, y: 0.75 },
        ],
      }),
    ];
    const firstRun = expandHealPaths(spots, 1000, 1000, 12);
    const secondRun = expandHealPaths(spots, 1000, 1000, 12);
    const counts = firstRun.reduce<number[]>(
      (result, dab) => {
        result[dab.groupIndex] = (result[dab.groupIndex] ?? 0) + 1;
        return result;
      },
      [],
    );

    expect(counts).toEqual([9, 3]);
    expect(secondRun).toEqual(firstRun);
  });

  it("uses brush diameter to avoid unnecessary dabs when unconstrained", () => {
    const path = [
      { x: 0.1, y: 0.5 },
      { x: 0.2, y: 0.5 },
    ];
    const smallBrush = expandHealPaths(
      [repair({ size: 20, path })],
      1000,
      1000,
    );
    const largeBrush = expandHealPaths(
      [repair({ size: 100, path })],
      1000,
      1000,
    );

    expect(smallBrush).toHaveLength(11);
    expect(largeBrush).toHaveLength(3);
    expect(smallBrush.at(0)?.destination.x).toBeCloseTo(0.1);
    expect(smallBrush.at(-1)?.destination.x).toBeCloseTo(0.2);
  });

  it("treats legacy normalized sizes like equivalent pixel diameters", () => {
    const path = [
      { x: 0.1, y: 0.5 },
      { x: 0.2, y: 0.5 },
    ];
    const normalized = expandHealPaths(
      [repair({ size: 0.1, path })],
      1000,
      500,
    );
    const pixels = expandHealPaths(
      [repair({ size: 50, path })],
      1000,
      500,
    );

    expect(normalized).toHaveLength(5);
    expect(pixels).toHaveLength(normalized.length);
    expect(normalized.map((dab) => dab.destination)).toEqual(
      pixels.map((dab) => dab.destination),
    );
  });

  it("measures multi-segment paths in source-image pixels", () => {
    const dabs = expandHealPaths([
      repair({
        size: 100,
        path: [
          { x: 0.1, y: 0.1 },
          { x: 0.2, y: 0.1 },
          { x: 0.2, y: 0.5 },
        ],
      }),
    ], 2000, 500, 9);

    // Both legs are 200 source pixels, so the middle dab lands on the corner.
    expect(dabs).toHaveLength(9);
    expect(dabs[4].destination.x).toBeCloseTo(0.2);
    expect(dabs[4].destination.y).toBeCloseTo(0.1);
  });

  it("spaces pressure-sensitive dabs more densely in smaller-brush regions", () => {
    const dabs = expandHealPaths([
      repair({
        source: { x: 0.3, y: 0.35 },
        destination: { x: 0.2, y: 0.25 },
        size: 100,
        path: [
          { x: 0.1, y: 0.25, pressure: 0.05 },
          { x: 0.9, y: 0.25, pressure: 1 },
        ],
      }),
    ], 1000, 1000, 9);

    expect(dabs).toHaveLength(9);
    expect(dabs[4].destination.x).toBeLessThan(0.5);
    expect(dabs[0].size).toBeCloseTo(38.25);
    expect(dabs.at(-1)?.size).toBeCloseTo(100);
    for (const dab of dabs) {
      expect(dab.source.x - dab.destination.x).toBeCloseTo(0.1);
      expect(dab.source.y - dab.destination.y).toBeCloseTo(0.1);
    }
  });

  it("keeps low-pressure pixel brushes correct across the legacy size boundary", () => {
    const dabs = expandHealPaths([
      repair({
        size: 2,
        path: [
          { x: 0.1, y: 0.25, pressure: 0.05 },
          { x: 0.9, y: 0.25, pressure: 1 },
        ],
      }),
    ], 1000, 500, 2);
    const diameterInPixels = (size: number) =>
      size <= 1 ? size * 500 : size;

    expect(diameterInPixels(dabs[0].size)).toBeCloseTo(0.765);
    expect(diameterInPixels(dabs[1].size)).toBeCloseTo(2);
  });

  it("breaks equal allocation remainders by stable repair order", () => {
    const spots = Array.from({ length: 3 }, (_, index) =>
      repair({
        path: [
          { x: 0.1, y: 0.2 + index * 0.2 },
          { x: 0.9, y: 0.2 + index * 0.2 },
        ],
      }),
    );
    const dabs = expandHealPaths(spots, 1000, 1000, 5);
    const counts = [0, 1, 2].map(
      (groupIndex) =>
        dabs.filter((dab) => dab.groupIndex === groupIndex).length,
    );

    expect(counts).toEqual([2, 2, 1]);
  });
});
