import { describe, expect, it } from "vitest";
import {
  mapPointThroughGuidedUpright,
  solveGuidedUpright,
  type GuidedUprightCorrection,
  type GuidedUprightGuide,
  type GuidedUprightPoint,
} from "./guidedUpright";

const framePointToSource = (
  point: GuidedUprightPoint,
  correction: GuidedUprightCorrection,
  aspectRatio: number,
): GuidedUprightPoint => {
  const outputX = (point.x - 0.5) * aspectRatio;
  const outputY = point.y - 0.5;
  const angle = (correction.rotate * Math.PI) / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const frameX = (cosine * outputX + sine * outputY) / aspectRatio;
  const frameY = -sine * outputX + cosine * outputY;
  const horizontal = correction.horizontal / 200;
  const vertical = correction.vertical / 200;
  const denominator = 1 + horizontal * frameX + vertical * frameY;
  return {
    x: frameX / denominator + 0.5,
    y: frameY / denominator + 0.5,
  };
};

const syntheticGuides = (
  correction: GuidedUprightCorrection,
  aspectRatio: number,
): GuidedUprightGuide[] => {
  const makeGuide = (
    orientation: GuidedUprightGuide["orientation"],
    start: GuidedUprightPoint,
    end: GuidedUprightPoint,
  ): GuidedUprightGuide => ({
    orientation,
    start: framePointToSource(start, correction, aspectRatio),
    end: framePointToSource(end, correction, aspectRatio),
  });
  return [
    makeGuide("horizontal", { x: 0.14, y: 0.27 }, { x: 0.86, y: 0.27 }),
    makeGuide("horizontal", { x: 0.14, y: 0.73 }, { x: 0.86, y: 0.73 }),
    makeGuide("vertical", { x: 0.26, y: 0.12 }, { x: 0.26, y: 0.88 }),
    makeGuide("vertical", { x: 0.74, y: 0.12 }, { x: 0.74, y: 0.88 }),
  ];
};

const expectGuideAligned = (
  guide: GuidedUprightGuide,
  correction: GuidedUprightCorrection,
  aspectRatio: number,
  precision = 7,
): void => {
  const start = mapPointThroughGuidedUpright(
    guide.start,
    correction,
    aspectRatio,
  );
  const end = mapPointThroughGuidedUpright(
    guide.end,
    correction,
    aspectRatio,
  );
  expect(start).not.toBeNull();
  expect(end).not.toBeNull();
  if (!start || !end) return;
  if (guide.orientation === "horizontal") {
    expect(end.y).toBeCloseTo(start.y, precision);
  } else {
    expect(end.x).toBeCloseTo(start.x, precision);
  }
};

describe("solveGuidedUpright", () => {
  it("returns the identity for already level four-guide geometry", () => {
    const guides: GuidedUprightGuide[] = [
      { orientation: "horizontal", start: { x: 0.1, y: 0.2 }, end: { x: 0.9, y: 0.2 } },
      { orientation: "horizontal", start: { x: 0.1, y: 0.8 }, end: { x: 0.9, y: 0.8 } },
      { orientation: "vertical", start: { x: 0.2, y: 0.1 }, end: { x: 0.2, y: 0.9 } },
      { orientation: "vertical", start: { x: 0.8, y: 0.1 }, end: { x: 0.8, y: 0.9 } },
    ];

    const result = solveGuidedUpright(guides, { aspectRatio: 1.5 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.solution.correction.rotate).toBeCloseTo(0, 7);
    expect(result.solution.correction.horizontal).toBeCloseTo(0, 7);
    expect(result.solution.correction.vertical).toBeCloseTo(0, 7);
    expect(result.solution.residualDegrees).toBeLessThan(1e-6);
    expect(result.solution.confidence).toBeGreaterThan(0.95);
  });

  it("recovers a known rotation and two-axis projective correction", () => {
    const aspectRatio = 1.5;
    const expected: GuidedUprightCorrection = {
      rotate: 7.25,
      horizontal: 28,
      vertical: -22,
    };
    const guides = syntheticGuides(expected, aspectRatio);

    const result = solveGuidedUpright(guides, { aspectRatio });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.solution.correction.rotate).toBeCloseTo(expected.rotate, 3);
    expect(result.solution.correction.horizontal).toBeCloseTo(expected.horizontal, 3);
    expect(result.solution.correction.vertical).toBeCloseTo(expected.vertical, 3);
    expect(result.solution.residualDegrees).toBeLessThan(1e-5);
    expect(result.solution.confidence).toBeGreaterThan(0.8);
    for (const guide of guides) {
      expectGuideAligned(guide, result.solution.correction, aspectRatio);
    }
  });

  it("uses a stable minimum-correction prior for a valid two-guide layout", () => {
    const aspectRatio = 4 / 3;
    const source = syntheticGuides(
      { rotate: -4, horizontal: 20, vertical: 16 },
      aspectRatio,
    );
    const guides = [source[0], source[2]];

    const result = solveGuidedUpright(guides, { aspectRatio });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.solution.guideCount).toBe(2);
    expect(result.solution.horizontalGuideCount).toBe(1);
    expect(result.solution.verticalGuideCount).toBe(1);
    expect(result.solution.residualDegrees).toBeLessThan(1e-4);
    expect(result.solution.confidence).toBeGreaterThan(0.35);
    expect(result.solution.confidence).toBeLessThan(0.8);
    for (const guide of guides) {
      expectGuideAligned(guide, result.solution.correction, aspectRatio, 5);
    }
  });

  it("aligns two same-orientation guides while reporting limited confidence", () => {
    const aspectRatio = 1.7;
    const guides = syntheticGuides(
      { rotate: 5, horizontal: -24, vertical: 0 },
      aspectRatio,
    ).slice(0, 2);

    const result = solveGuidedUpright(guides, { aspectRatio });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.solution.horizontalGuideCount).toBe(2);
    expect(result.solution.verticalGuideCount).toBe(0);
    expect(result.solution.residualDegrees).toBeLessThan(1e-4);
    expect(result.solution.confidence).toBeLessThan(0.8);
    for (const guide of guides) {
      expectGuideAligned(guide, result.solution.correction, aspectRatio, 5);
    }
  });

  it("is invariant to guide order and endpoint direction", () => {
    const aspectRatio = 1.4;
    const guides = syntheticGuides(
      { rotate: -6.5, horizontal: 18, vertical: -14 },
      aspectRatio,
    );
    const reversed = [...guides]
      .reverse()
      .map((guide) => ({ ...guide, start: guide.end, end: guide.start }));

    const first = solveGuidedUpright(guides, { aspectRatio });
    const second = solveGuidedUpright(reversed, { aspectRatio });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.solution.correction.rotate).toBeCloseTo(
      first.solution.correction.rotate,
      7,
    );
    expect(second.solution.correction.horizontal).toBeCloseTo(
      first.solution.correction.horizontal,
      7,
    );
    expect(second.solution.correction.vertical).toBeCloseTo(
      first.solution.correction.vertical,
      7,
    );
  });

  it("handles small endpoint noise and keeps quality metrics bounded", () => {
    const aspectRatio = 1.5;
    const exactGuides = syntheticGuides(
      { rotate: 4.5, horizontal: 22, vertical: -18 },
      aspectRatio,
    );
    const noisyGuides = exactGuides.map((guide, index) => ({
      ...guide,
      end: {
        x: guide.end.x + (index % 2 === 0 ? 0.0015 : -0.001),
        y: guide.end.y + (index < 2 ? 0.002 : -0.0015),
      },
    }));

    const exact = solveGuidedUpright(exactGuides, { aspectRatio });
    const noisy = solveGuidedUpright(noisyGuides, { aspectRatio });

    expect(exact.ok).toBe(true);
    expect(noisy.ok).toBe(true);
    if (!exact.ok || !noisy.ok) return;
    expect(noisy.solution.residualDegrees).toBeLessThan(1);
    expect(noisy.solution.residualDegrees).toBeGreaterThan(exact.solution.residualDegrees);
    expect(noisy.solution.confidence).toBeGreaterThan(0.5);
    expect(noisy.solution.confidence).toBeLessThanOrEqual(1);
  });

  it("rejects invalid counts, endpoints, short lines, and solver options", () => {
    const valid: GuidedUprightGuide = {
      orientation: "horizontal",
      start: { x: 0.1, y: 0.3 },
      end: { x: 0.9, y: 0.3 },
    };

    expect(solveGuidedUpright([valid])).toMatchObject({
      ok: false,
      reason: "guide-count",
    });
    expect(
      solveGuidedUpright([
        valid,
        { ...valid, start: { x: -0.1, y: 0.5 }, end: { x: 0.8, y: 0.5 } },
      ]),
    ).toMatchObject({ ok: false, reason: "guide-out-of-bounds", guideIndices: [1] });
    expect(
      solveGuidedUpright([
        valid,
        { ...valid, start: { x: 0.4, y: 0.5 }, end: { x: 0.401, y: 0.501 } },
      ]),
    ).toMatchObject({ ok: false, reason: "guide-too-short", guideIndices: [1] });
    expect(solveGuidedUpright([valid, { ...valid, start: { x: 0.1, y: 0.7 }, end: { x: 0.9, y: 0.7 } }], { aspectRatio: 0 })).toMatchObject({
      ok: false,
      reason: "invalid-options",
    });
  });

  it("rejects duplicate constraints even when their endpoints are reversed", () => {
    const first: GuidedUprightGuide = {
      orientation: "horizontal",
      start: { x: 0.1, y: 0.35 },
      end: { x: 0.9, y: 0.45 },
    };
    const result = solveGuidedUpright([
      first,
      { ...first, start: first.end, end: first.start },
    ]);

    expect(result).toMatchObject({
      ok: false,
      reason: "duplicate-guides",
      guideIndices: [0, 1],
    });
  });

  it("rejects mutually inconsistent guide families", () => {
    const result = solveGuidedUpright([
      { orientation: "horizontal", start: { x: 0.08, y: 0.12 }, end: { x: 0.92, y: 0.22 } },
      { orientation: "horizontal", start: { x: 0.08, y: 0.42 }, end: { x: 0.92, y: 0.7 } },
      { orientation: "horizontal", start: { x: 0.08, y: 0.88 }, end: { x: 0.92, y: 0.62 } },
      { orientation: "vertical", start: { x: 0.5, y: 0.08 }, end: { x: 0.52, y: 0.92 } },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["inconsistent-guides", "unstable-solution"]).toContain(result.reason);
  });
});

describe("mapPointThroughGuidedUpright", () => {
  it("returns null instead of emitting non-finite coordinates at a horizon", () => {
    expect(
      mapPointThroughGuidedUpright(
        { x: 1, y: 0.5 },
        { rotate: 0, horizontal: 400, vertical: 0 },
      ),
    ).toBeNull();
  });
});
