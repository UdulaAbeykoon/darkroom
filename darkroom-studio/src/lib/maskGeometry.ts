import type { BrushPoint, BrushStroke, MaskComponent } from "../types";

export type LinearGeometry = NonNullable<MaskComponent["linear"]>;
export type RadialGeometry = NonNullable<MaskComponent["radial"]>;
export const clampMask = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const smooth = (value: number) => { const t = clampMask(value); return t * t * (3 - 2 * t); };

// Work in source-image pixels: rotating normalized coordinates shears ellipses
// whenever the photograph is not square.
export function radialPoint(radial: RadialGeometry, x: number, y: number, aspect: number): BrushPoint {
  const angle = radial.rotation * Math.PI / 180;
  return {
    x: radial.cx + Math.cos(angle) * x - Math.sin(angle) * y / aspect,
    y: radial.cy + Math.sin(angle) * x * aspect + Math.cos(angle) * y,
  };
}

export function radialLocalPoint(radial: RadialGeometry, point: BrushPoint, aspect: number): BrushPoint {
  const angle = radial.rotation * Math.PI / 180;
  const x = (point.x - radial.cx) * aspect;
  const y = point.y - radial.cy;
  return { x: (Math.cos(angle) * x + Math.sin(angle) * y) / aspect, y: -Math.sin(angle) * x + Math.cos(angle) * y };
}

export function gradientWeight(component: MaskComponent, x: number, y: number, aspect: number): number {
  if (component.kind === "linear" && component.linear) {
    const g = component.linear;
    const dx = (g.x2 - g.x1) * aspect, dy = g.y2 - g.y1;
    const length = dx * dx + dy * dy;
    if (length < 1e-12) return 0;
    return 1 - smooth((((x - g.x1) * aspect) * dx + (y - g.y1) * dy) / length);
  }
  if (component.kind === "radial" && component.radial) {
    const g = component.radial;
    const p = radialLocalPoint(g, { x, y }, aspect);
    const radius = Math.hypot(p.x / g.rx, p.y / g.ry);
    if (g.feather === 0) return radius <= 1 ? 1 : 0;
    return 1 - smooth((radius - (1 - g.feather / 100)) / (g.feather / 100));
  }
  return 0;
}

/** Precompute shape coefficients once when rasterizing a compound gradient. */
export function gradientSampler(component: MaskComponent, aspect: number): ((x: number, y: number) => number) | null {
  if (component.kind === "linear" && component.linear) {
    const g = component.linear, dx = (g.x2 - g.x1) * aspect, dy = g.y2 - g.y1;
    const length = dx * dx + dy * dy;
    if (length < 1e-12) return () => 0;
    const a = dx * aspect / length, b = dy / length, c = -g.x1 * a - g.y1 * b;
    return (x, y) => 1 - smooth(a * x + b * y + c);
  }
  if (component.kind === "radial" && component.radial) {
    const g = component.radial, angle = g.rotation * Math.PI / 180;
    const a = Math.cos(angle) / g.rx, b = Math.sin(angle) / (aspect * g.rx);
    const c = -Math.sin(angle) * aspect / g.ry, d = Math.cos(angle) / g.ry;
    const feather = g.feather / 100;
    return (x, y) => {
      const dx = x - g.cx, dy = y - g.cy;
      const u = a * dx + b * dy, v = c * dx + d * dy, r2 = u * u + v * v;
      if (feather === 0) return r2 <= 1 ? 1 : 0;
      return r2 >= 1 ? 0 : 1 - smooth((Math.sqrt(r2) - 1 + feather) / feather);
    };
  }
  return null;
}

export function linearFromCenter(cx: number, cy: number, length: number, rotation: number, aspect: number): LinearGeometry {
  const angle = rotation * Math.PI / 180;
  const dx = Math.cos(angle) * length / aspect / 2, dy = Math.sin(angle) * length / 2;
  return { x1: cx - dx, y1: cy - dy, x2: cx + dx, y2: cy + dy };
}

export function linearMetrics(g: LinearGeometry, aspect: number) {
  const dx = (g.x2 - g.x1) * aspect, dy = g.y2 - g.y1;
  return { cx: (g.x1 + g.x2) / 2, cy: (g.y1 + g.y2) / 2, length: Math.hypot(dx, dy), rotation: Math.atan2(dy, dx) * 180 / Math.PI };
}

export function constrainGradientPoint(start: BrushPoint, point: BrushPoint, kind: "linear" | "radial", aspect: number): BrushPoint {
  const dx = (point.x - start.x) * aspect, dy = point.y - start.y;
  if (kind === "radial") {
    const radius = Math.max(Math.abs(dx), Math.abs(dy));
    return { x: start.x + (dx < 0 ? -1 : 1) * radius / aspect, y: start.y + (dy < 0 ? -1 : 1) * radius };
  }
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4;
  const distance = Math.hypot(dx, dy);
  return { x: start.x + Math.cos(angle) * distance / aspect, y: start.y + Math.sin(angle) * distance };
}

export interface MaskDirtyRect { x0: number; y0: number; x1: number; y1: number }
export const fullMaskRect = (size: number): MaskDirtyRect => ({ x0: 0, y0: 0, x1: size, y1: size });
export const unionMaskRect = (a: MaskDirtyRect | null, b: MaskDirtyRect | null): MaskDirtyRect | null => !a ? b : !b ? a : ({
  x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
});

const samePoint = (a: BrushPoint, b: BrushPoint) => a === b || (a.x === b.x && a.y === b.y && a.pressure === b.pressure);
const sameSettings = (a: BrushStroke, b: BrushStroke) => a.size === b.size && a.feather === b.feather && a.flow === b.flow && a.density === b.density && a.erase === b.erase && a.autoMask === b.autoMask;
const extendsStroke = (a: BrushStroke, b: BrushStroke) => sameSettings(a, b) && b.points.length >= a.points.length && a.points.every((p, i) => samePoint(p, b.points[i]));

/** Retains stroke coverage between frames. Each new dab contributes only the
 * increase in coverage, so flow remains per-stroke, independent of event rate.
 * Inputs are immutable edit snapshots. Undo, replacement and setting changes
 * invalidate the cache and replay the recipe exactly. */
export class BrushRasterizer {
  readonly pixels: Float32Array;
  private readonly coverage: Float32Array;
  private readonly eraseBaseline: Float32Array;
  private readonly eraseLimit: Float32Array;
  private strokes: readonly BrushStroke[] = [];
  private coverageBounds: MaskDirtyRect | null = null;
  private dirty: MaskDirtyRect | null = null;

  constructor(readonly size: number, readonly aspect: number,
    private readonly edgeWeight?: (stroke: BrushStroke, x: number, y: number) => number) {
    this.pixels = new Float32Array(size * size);
    this.coverage = new Float32Array(this.pixels.length);
    this.eraseBaseline = new Float32Array(this.pixels.length);
    this.eraseLimit = new Float32Array(this.pixels.length);
  }

  update(strokes: readonly BrushStroke[]): MaskDirtyRect | null {
    if (strokes === this.strokes) return null;
    this.dirty = null;
    let common = 0;
    while (common < this.strokes.length && common < strokes.length &&
      (this.strokes[common] === strokes[common] ||
       (this.strokes[common].points.length === strokes[common].points.length && extendsStroke(this.strokes[common], strokes[common])))) common++;
    const extending = common === this.strokes.length - 1 && common < strokes.length && extendsStroke(this.strokes[common], strokes[common]);
    if (common < this.strokes.length && !extending) {
      this.pixels.fill(0); this.coverage.fill(0); this.eraseBaseline.fill(0); this.eraseLimit.fill(0);
      this.coverageBounds = null; this.dirty = fullMaskRect(this.size); common = 0;
    }
    for (let i = common; i < strokes.length; i++) {
      const stroke = strokes[i];
      const start = extending && i === common ? this.strokes[i].points.length : 0;
      if (!start) this.clearCoverage();
      if (!stroke.points.length || !stroke.flow || !(stroke.density ?? 100)) continue;
      const radius = stroke.size / 100 / 2;
      if (!start) this.stamp(stroke, stroke.points[0]);
      for (let p = Math.max(1, start); p < stroke.points.length; p++) {
        const a = stroke.points[p - 1], b = stroke.points[p];
        const distance = Math.hypot((b.x - a.x) * this.aspect, b.y - a.y);
        const steps = Math.max(1, Math.ceil(distance / Math.max(0.5 / this.size, radius * 0.15)));
        for (let j = 1; j <= steps; j++) {
          const t = j / steps;
          this.stamp(stroke, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, pressure: (a.pressure ?? 1) + ((b.pressure ?? 1) - (a.pressure ?? 1)) * t });
        }
      }
    }
    this.strokes = strokes;
    return this.dirty;
  }

  private clearCoverage() {
    const b = this.coverageBounds;
    if (b) for (let y = b.y0; y < b.y1; y++) this.coverage.fill(0, y * this.size + b.x0, y * this.size + b.x1);
    this.coverageBounds = null;
  }

  private stamp(stroke: BrushStroke, point: BrushPoint) {
    const size = this.size, pressure = clampMask(point.pressure ?? 1, 0.05, 1);
    const ry = Math.max(0.5 / size, stroke.size / 200 * (0.35 + pressure * 0.65)), rx = ry / this.aspect;
    const bounds = { x0: Math.max(0, Math.floor((point.x - rx) * size)), x1: Math.min(size, Math.ceil((point.x + rx) * size) + 1), y0: Math.max(0, Math.floor((point.y - ry) * size)), y1: Math.min(size, Math.ceil((point.y + ry) * size) + 1) };
    if (bounds.x0 >= bounds.x1 || bounds.y0 >= bounds.y1) return;
    this.coverageBounds = unionMaskRect(this.coverageBounds, bounds);
    this.dirty = unionMaskRect(this.dirty, bounds);
    const feather = stroke.feather / 100, density = (stroke.density ?? 100) / 100, flow = stroke.flow / 100;
    const inverseX = 1 / (size * rx), inverseY = 1 / (size * ry);
    for (let y = bounds.y0; y < bounds.y1; y++) {
      const dy = (y + 0.5 - point.y * size) * inverseY, dy2 = dy * dy;
      for (let x = bounds.x0; x < bounds.x1; x++) {
        const dx = (x + 0.5 - point.x * size) * inverseX, distance2 = dx * dx + dy2;
        if (distance2 > 1) continue;
        const weight = pressure * (feather === 0 ? 1 : 1 - smooth((Math.sqrt(distance2) - 1 + feather) / feather));
        const i = y * size + x, previous = this.coverage[i];
        // Round once to the same precision as the coverage cache.
        const next = Math.fround(weight);
        if (next <= previous) continue;
        this.coverage[i] = next;
        const edge = stroke.autoMask && this.edgeWeight ? this.edgeWeight(stroke, (x + 0.5) / size, (y + 0.5) / size) : 1;
        const amount = (next - previous) * flow * edge;
        if (stroke.erase) {
          if (this.eraseLimit[i] === 0) this.eraseBaseline[i] = this.pixels[i];
          this.eraseLimit[i] = Math.max(this.eraseLimit[i], density);
          this.pixels[i] = Math.max(this.eraseBaseline[i] * (1 - this.eraseLimit[i]), this.pixels[i] - amount * this.eraseBaseline[i]);
        } else {
          this.pixels[i] = Math.max(this.pixels[i], Math.min(density, this.pixels[i] + amount));
          this.eraseLimit[i] = 0;
        }
      }
    }
  }
}

/** One-shot rendering uses exactly the same brush kernel as live editing. */
export function rasterizeBrush(strokes: readonly BrushStroke[], size: number, aspect: number,
  edgeWeight?: (stroke: BrushStroke, x: number, y: number) => number): Float32Array {
  const raster = new BrushRasterizer(size, aspect, edgeWeight);
  raster.update(strokes);
  return raster.pixels;
}
