import { describe, expect, it } from "vitest";
import { BrushRasterizer, constrainGradientPoint, gradientSampler, gradientWeight, linearFromCenter, linearMetrics, radialLocalPoint, radialPoint, rasterizeBrush } from "./maskGeometry";
import { composeMaskWeights, makeMaskComponent, normalizeMask, normalizeMaskComponent } from "./maskMath";
import type { BrushStroke } from "../types";

describe("gradient geometry", () => {
  it("has full, half, and zero strength along a linear transition", () => {
    const mask = { ...makeMaskComponent("linear"), linear: { x1: 0.2, y1: 0.3, x2: 0.8, y2: 0.3 } };
    [0, 0.2, 0.5, 0.8, 1].forEach((x, i) => expect(gradientWeight(mask, x, 0.7, 2)).toBeCloseTo([1, 1, 0.5, 0, 0][i]));
  });
  it.each([0.5, 1.5, 3])("keeps a diagonal gradient perpendicular in source pixels at aspect %s", aspect => {
    const g = linearFromCenter(0.5, 0.5, 0.5, 30, aspect);
    const mask = { ...makeMaskComponent("linear"), linear: g };
    expect(gradientWeight(mask, 0.5 - Math.sin(Math.PI / 6) * 0.1 / aspect, 0.5 + Math.cos(Math.PI / 6) * 0.1, aspect)).toBeCloseTo(0.5);
    expect(linearMetrics(g, aspect).rotation).toBeCloseTo(30);
  });
  it.each([0.5, 2, 3])("rotates an ellipse without changing its radii at aspect %s", aspect => {
    const radial = { cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.3, rotation: 90, feather: 50 };
    const mask = { ...makeMaskComponent("radial"), radial };
    const edge = radialPoint(radial, radial.rx, 0, aspect);
    expect(Math.hypot((edge.x - radial.cx) * aspect, edge.y - radial.cy)).toBeCloseTo(radial.rx * aspect);
    expect(radialLocalPoint(radial, edge, aspect).x).toBeCloseTo(radial.rx);
    const halfway = radialPoint(radial, radial.rx * 0.75, 0, aspect);
    expect(gradientWeight(mask, halfway.x, halfway.y, aspect)).toBeCloseTo(0.5);
    expect(gradientWeight(mask, edge.x, edge.y, aspect)).toBeCloseTo(0);
  });
  it("supports hard edges, full feather, and off-image centers", () => {
    const mask = normalizeMaskComponent({ kind: "radial", radial: { cx: -0.1, cy: 0.5, rx: 0.3, ry: 0.3, feather: 0 } });
    expect(gradientWeight(mask, 0.1, 0.5, 1)).toBe(1);
    expect(gradientWeight(mask, 0.3, 0.5, 1)).toBe(0);
    mask.radial!.feather = 100;
    expect(gradientWeight(mask, 0.05, 0.5, 1)).toBeCloseTo(0.5);
    expect(normalizeMaskComponent({kind: "linear", linear: { x1: -1, y1: 0, x2: -0.5, y2: 0 }}).linear!.x1).toBe(-1);
  });
  it("makes Shift circles in pixels and snaps linear angles", () => {
    const start = {x: 0.3, y: 0.3};
    const circle = constrainGradientPoint(start, {x: 0.5, y: 0.4}, "radial", 2);
    expect((circle.x - start.x) * 2).toBeCloseTo(circle.y - start.y);
    const line = constrainGradientPoint(start, {x: 0.6, y: 0.35}, "linear", 2);
    expect(line.y).toBeCloseTo(start.y);
  });
  it("combines an inverted radial gradient with subtract brush and luminance intersection", () => {
    const a = makeMaskComponent("radial"), b = makeMaskComponent("brush", "subtract"), c = makeMaskComponent("luminance", "intersect");
    a.inverted = true;
    expect(composeMaskWeights([a, b, c], (_, i) => [0.2, 0.5, 0.25][i])).toBeCloseTo(0.1);
  });
  it("preserves amount and local curve through edits and catalog normalization", () => {
    const mask = normalizeMask({kind: "linear", amount: 150, curve: [{x: 1, y: 1}, {x: 0, y: 0.2}], adjustments: {exposure: 5}});
    expect(normalizeMask(JSON.parse(JSON.stringify(mask)))).toEqual(mask);
    expect(mask.amount).toBe(150);
    expect(mask.adjustments.exposure).toBe(5);
    expect(mask.curve![0]).toEqual({x: 0, y: 0.2});
  });
});

describe("brush coverage", () => {
  const dot: BrushStroke = {points: [{x: 0.5, y: 0.5}], size: 40, feather: 0, flow: 20, density: 50, erase: false};
  const atCenter = (strokes: BrushStroke[]) => rasterizeBrush(strokes, 100, 1)[5050];
  it("builds with flow up to density and never inherits a higher previous density", () => {
    expect(atCenter([dot])).toBeCloseTo(0.2);
    expect(atCenter([dot, dot])).toBeCloseTo(0.4);
    expect(atCenter([dot, dot, dot, dot])).toBeCloseTo(0.5);
    expect(atCenter([{...dot, density: 100}, dot, dot, dot])).toBeCloseTo(0.5);
    expect(atCenter([{...dot, flow: 100, density: 100}, dot])).toBeCloseTo(1);
  });
  it("erases existing paint and allows painting it back", () => {
    const full = {...dot, flow: 100, density: 100};
    expect(atCenter([full, {...full, erase: true}])).toBe(0);
    expect(atCenter([full, {...full, erase: true}, dot])).toBeCloseTo(0.2);
  });
  it("caps consecutive eraser passes at their density", () => {
    const full = {...dot, flow: 100, density: 100};
    const erase = {...dot, erase: true, density: 50};
    expect(atCenter([full, erase, erase, erase, erase])).toBeCloseTo(0.5);
  });
  it("does not paint with zero flow or density", () => {
    expect(atCenter([{...dot, flow: 0}])).toBe(0);
    expect(atCenter([{...dot, density: 0}])).toBe(0);
  });
  it("handles tiny brush sizes continuously around 1%", () => {
    const covered = (size: number) => rasterizeBrush([{...dot, size, flow: 100}], 200, 1).reduce((a, b) => a + b, 0);
    expect(covered(1)).toBeLessThan(10);
    expect(covered(1.1)).toBeLessThan(10);
    expect(covered(0.9)).toBeLessThanOrEqual(covered(1.1));
  });
  it("paints continuous sparse paths and does not change strength with pointer event frequency", () => {
    const points = [{x: 0.1, y: 0.5}, {x: 0.9, y: 0.5}];
    const sparse = rasterizeBrush([{...dot, points, size: 10}], 100, 1);
    const dense = rasterizeBrush([{...dot, points: Array.from({length: 81}, (_,i) => ({x: 0.1 + i * 0.01, y: 0.5})), size: 10}], 100, 1);
    for (let x = 10; x < 90; x++) { expect(sparse[5000+x]).toBeCloseTo(0.2); expect(sparse[5000+x]).toBeCloseTo(dense[5000+x]); }
  });
  it("has a soft feather and round pixels on rectangular photographs", () => {
    const map = rasterizeBrush([{...dot, feather: 100, flow: 100, density: 100}], 100, 2);
    expect(map[5050]).toBeGreaterThan(map[5057]);
    expect(map[5057]).toBeGreaterThan(map[5061]);
    expect(map[5061]).toBe(0);
    expect(map[6450]).toBeGreaterThan(0);
  });
  it("applies pressure to size and strength", () => {
    expect(atCenter([{...dot, points: [{x: 0.5, y: 0.5, pressure: 0.5}]}])).toBeCloseTo(0.1);
  });
});

describe("incremental mask rendering", () => {
  const stroke = (erase = false): BrushStroke => ({size: 16, feather: 80, flow: 35, density: 70, erase,
    points: Array.from({length: 24}, (_, i) => ({x: 0.2 + i * 0.025, y: 0.45 + Math.sin(i / 3) * 0.1, pressure: 0.3 + i / 35}))});
  const close = (a: Float32Array, b: Float32Array) => {
    let max = 0; for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
    expect(max).toBeLessThan(0.00001);
  };
  it("matches full rendering through stroke growth, erase, undo, redo and replacement", () => {
    const raster = new BrushRasterizer(96, 1.5), paint = stroke(), erase = stroke(true);
    const history: BrushStroke[][] = [[], [paint]];
    for (let count = 1; count <= erase.points.length; count += 3) history.push([paint, {...erase, points: erase.points.slice(0, count)}]);
    history.push([paint, erase], [paint], [paint, erase], [paint, erase, {...paint, density: 30}], [],
      [{...paint, feather: 0}], [{...paint, points: [{x: -0.1, y: 0.5}, {x: 1.1, y: 0.5}]}]);
    for (const snapshot of history) { raster.update(snapshot); close(raster.pixels, rasterizeBrush(snapshot, 96, 1.5)); }
  });
  it("touches only new dabs and reuses saved stroke coverage", () => {
    let edgeCalls = 0;
    const raster = new BrushRasterizer(256, 1.5, () => {edgeCalls++; return 1;});
    const saved = {...stroke(), autoMask: true}; raster.update([saved]);
    const before = raster.pixels.slice(); edgeCalls = 0;
    const added = {...saved, points: [{x: 0.9, y: 0.1}]};
    const dirty = raster.update([saved, added])!;
    expect(edgeCalls).toBeLessThan(2000);
    expect((dirty.x1 - dirty.x0) * (dirty.y1 - dirty.y0)).toBeLessThan(256 * 256 / 20);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      if (x < dirty.x0 || x >= dirty.x1 || y < dirty.y0 || y >= dirty.y1) expect(raster.pixels[y * 256 + x]).toBe(before[y * 256 + x]);
    }
    edgeCalls = 0;
    expect(raster.update([saved, added])).toBeNull();
    expect(edgeCalls).toBe(0);
  });
  it("keeps edge-aware flow and density stable while extending an eraser", () => {
    const edge = (_: BrushStroke, x: number) => x < 0.5 ? 0.25 : 1;
    const raster = new BrushRasterizer(96, 2, edge), paint = {...stroke(), autoMask: true}, erase = {...stroke(true), autoMask: true};
    for (let count = 1; count <= 24; count++) {
      const recipe = [paint, {...erase, points: erase.points.slice(0, count)}];
      raster.update(recipe); close(raster.pixels, rasterizeBrush(recipe, 96, 2, edge));
    }
  });
  it.each([0.5, 1, 2.5])("precomputed gradients match source geometry at aspect %s", aspect => {
    const components = [makeMaskComponent('linear'), {...makeMaskComponent('radial'), radial: {cx: 0.45, cy: 0.7, rx: 0.16, ry: 0.5, rotation: 36, feather: 63}}];
    for (const component of components) {
      const sample = gradientSampler(component, aspect)!;
      for (let y = -0.1; y < 1.1; y += 0.1) for (let x = -0.1; x < 1.1; x += 0.1) expect(sample(x, y)).toBeCloseTo(gradientWeight(component, x, y, aspect), 10);
    }
  });
});
