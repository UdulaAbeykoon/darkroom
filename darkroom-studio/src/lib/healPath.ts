export interface HealPathPoint {
  x: number;
  y: number;
  pressure?: number;
}

export interface HealPathLike {
  destination: { x: number; y: number };
  source: { x: number; y: number };
  size: number;
  feather: number;
  opacity: number;
  mode: "remove" | "heal" | "clone";
  path?: HealPathPoint[];
}

export interface HealDab {
  groupIndex: number;
  destination: { x: number; y: number };
  source: { x: number; y: number };
  size: number;
  feather: number;
  opacity: number;
  mode: HealPathLike["mode"];
}

const RENDERER_DAB_CAP = 32;
const MIN_PRESSURE = 0.05;
// Half a brush diameter is dense enough that adjacent feathered dabs do not
// reveal gaps, while still making useful use of the renderer's small budget.
const BRUSH_SPACING_RATIO = 0.5;

interface PreparedSegment {
  start: HealPathPoint;
  end: HealPathPoint;
  metricLength: number;
  startDiameter: number;
  endDiameter: number;
}

interface PreparedPath {
  spot: HealPathLike;
  points: HealPathPoint[];
  segments: PreparedSegment[];
  metricLength: number;
  desiredCount: number;
  offsetX: number;
  offsetY: number;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const finitePoint = (point: HealPathPoint | undefined): HealPathPoint | null =>
  point && Number.isFinite(point.x) && Number.isFinite(point.y)
    ? {
        x: clamp01(point.x),
        y: clamp01(point.y),
        pressure: Number.isFinite(point.pressure)
          ? Math.min(1, Math.max(MIN_PRESSURE, point.pressure!))
          : 1,
      }
    : null;

const pressureScale = (pressure: number | undefined): number =>
  0.35 + 0.65 * (pressure ?? 1);

/**
 * Mirrors the engine's dual brush-size representation: current repairs use
 * source pixels, while legacy values at or below one are normalized against
 * the image's shorter edge.
 */
const brushDiameterPixels = (
  size: number,
  width: number,
  height: number,
): number => {
  if (!Number.isFinite(size) || size <= 0) return 1;
  return Math.max(1, size <= 1 ? size * Math.min(width, height) : size);
};

const dabSizeForPressure = (
  size: number,
  pressure: number,
  width: number,
  height: number,
): number => {
  if (!Number.isFinite(size) || size <= 0) return 0;
  const scaledSize = size * pressureScale(pressure);
  if (size <= 1 || scaledSize > 1) return scaledSize;
  // A pixel-sized brush can cross the engine's `<= 1` legacy-normalized
  // boundary at low pressure. Re-encode that sub-pixel value as normalized so
  // it does not accidentally become an image-width-sized brush.
  return scaledSize / Math.min(width, height);
};

const segmentMetricLength = (
  physicalLength: number,
  startDiameter: number,
  endDiameter: number,
): number => {
  if (physicalLength <= 1e-6) return 0;
  const difference = endDiameter - startDiameter;
  if (Math.abs(difference) <= 1e-6) {
    return physicalLength / (BRUSH_SPACING_RATIO * startDiameter);
  }
  // Pressure changes linearly between input samples. Integrating 1 / diameter
  // makes low-pressure (smaller-brush) portions receive proportionally denser
  // dabs, rather than merely using one average size for the entire segment.
  return (
    (physicalLength / BRUSH_SPACING_RATIO) *
    (Math.log(endDiameter / startDiameter) / difference)
  );
};

const preparePath = (
  spot: HealPathLike,
  width: number,
  height: number,
): PreparedPath => {
  const destination = finitePoint(spot.destination) ?? {
    x: 0.5,
    y: 0.5,
    pressure: 1,
  };
  const source = finitePoint(spot.source) ?? destination;
  const supplied = (spot.path ?? [])
    .map(finitePoint)
    .filter((point): point is HealPathPoint => point !== null);
  const points = supplied.length ? supplied : [destination];
  const baseDiameter = brushDiameterPixels(spot.size, width, height);
  const segments: PreparedSegment[] = [];
  let metricLength = 0;

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const physicalLength = Math.hypot(
      (end.x - start.x) * width,
      (end.y - start.y) * height,
    );
    if (physicalLength <= 1e-6) continue;
    const startDiameter = baseDiameter * pressureScale(start.pressure);
    const endDiameter = baseDiameter * pressureScale(end.pressure);
    const weight = segmentMetricLength(
      physicalLength,
      startDiameter,
      endDiameter,
    );
    if (!Number.isFinite(weight) || weight <= 0) continue;
    segments.push({
      start,
      end,
      metricLength: weight,
      startDiameter,
      endDiameter,
    });
    metricLength += weight;
  }

  // Include both endpoints whenever the path has length. A zero-length or
  // legacy repair remains exactly one dab.
  const desiredCount = metricLength > 0 ? Math.ceil(metricLength) + 1 : 1;
  return {
    spot,
    points,
    segments,
    metricLength,
    desiredCount,
    offsetX: source.x - destination.x,
    offsetY: source.y - destination.y,
  };
};

const pointAtMetric = (
  path: PreparedPath,
  targetMetric: number,
): HealPathPoint => {
  if (!path.segments.length) return path.points[0];
  let remaining = Math.min(path.metricLength, Math.max(0, targetMetric));

  for (const segment of path.segments) {
    if (remaining > segment.metricLength) {
      remaining -= segment.metricLength;
      continue;
    }

    const metricFraction =
      segment.metricLength <= 1e-9 ? 0 : remaining / segment.metricLength;
    const diameterDifference = segment.endDiameter - segment.startDiameter;
    let amount: number;
    if (Math.abs(diameterDifference) <= 1e-6) {
      amount = metricFraction;
    } else {
      // Inverse of the logarithmic integral used by segmentMetricLength.
      amount =
        (segment.startDiameter *
          (Math.exp(
            metricFraction *
              Math.log(segment.endDiameter / segment.startDiameter),
          ) -
            1)) /
        diameterDifference;
    }
    amount = clamp01(amount);
    return {
      x: segment.start.x + (segment.end.x - segment.start.x) * amount,
      y: segment.start.y + (segment.end.y - segment.start.y) * amount,
      pressure:
        (segment.start.pressure ?? 1) +
        ((segment.end.pressure ?? 1) - (segment.start.pressure ?? 1)) * amount,
    };
  }

  return path.segments[path.segments.length - 1].end;
};

const allocateDabs = (paths: PreparedPath[], budget: number): number[] => {
  const allocations = paths.map(() => 1);
  let remaining = budget - paths.length;
  if (remaining <= 0) return allocations;

  const additionalNeeds = paths.map((path) => path.desiredCount - 1);
  const totalAdditionalNeed = additionalNeeds.reduce(
    (sum, need) => sum + need,
    0,
  );
  if (totalAdditionalNeed <= remaining) {
    return allocations.map((allocation, index) =>
      allocation + additionalNeeds[index],
    );
  }

  // Hamilton/largest-remainder allocation is deterministic, honors relative
  // brush-spacing demand, and cannot starve a repair of its initial dab.
  const shares = additionalNeeds.map(
    (need) => (need / totalAdditionalNeed) * remaining,
  );
  shares.forEach((share, index) => {
    const whole = Math.floor(share);
    allocations[index] += whole;
    remaining -= whole;
  });
  const fractionalOrder = shares
    .map((share, index) => ({
      index,
      fraction: share - Math.floor(share),
      need: additionalNeeds[index],
    }))
    .filter(({ need }, index) => allocations[index] - 1 < need)
    .sort(
      (first, second) =>
        second.fraction - first.fraction || first.index - second.index,
    );
  for (let index = 0; index < remaining; index += 1) {
    allocations[fractionalOrder[index].index] += 1;
  }
  return allocations;
};

/**
 * Converts painted repair paths into renderer-friendly dabs. Up to 32 repairs
 * always retain at least one dab; remaining capacity is distributed according
 * to physical path length, pressure, and brush diameter. Calls requesting a
 * smaller test/runtime budget retain the same invariant for repairs that fit.
 */
export function expandHealPaths(
  spots: readonly HealPathLike[],
  sourceWidth: number,
  sourceHeight: number,
  maxDabs = RENDERER_DAB_CAP,
): HealDab[] {
  const width = Math.max(
    1,
    Number.isFinite(sourceWidth) ? Math.abs(sourceWidth) : 1,
  );
  const height = Math.max(
    1,
    Number.isFinite(sourceHeight) ? Math.abs(sourceHeight) : 1,
  );
  const requestedBudget = Number.isFinite(maxDabs)
    ? Math.max(0, Math.floor(maxDabs))
    : RENDERER_DAB_CAP;
  const budget = Math.min(RENDERER_DAB_CAP, requestedBudget);
  if (!budget || !spots.length) return [];

  // More distinct repairs cannot be represented by the fixed-size shader
  // arrays. The app keeps the count below this boundary; when handed overflow,
  // retain deterministic renderer behavior without exceeding its hard cap.
  const paths = spots.slice(0, budget).map((spot) =>
    preparePath(spot, width, height),
  );
  const allocations = allocateDabs(paths, budget);

  return paths.flatMap((path, groupIndex) => {
    const count = allocations[groupIndex];
    return Array.from({ length: count }, (_, index) => {
      const targetMetric =
        count <= 1
          ? path.metricLength / 2
          : (path.metricLength * index) / (count - 1);
      const point = pointAtMetric(path, targetMetric);
      const pressure = point.pressure ?? 1;
      return {
        groupIndex,
        destination: { x: point.x, y: point.y },
        source: {
          x: point.x + path.offsetX,
          y: point.y + path.offsetY,
        },
        size: dabSizeForPressure(
          path.spot.size,
          pressure,
          width,
          height,
        ),
        feather: path.spot.feather,
        opacity: path.spot.opacity,
        mode: path.spot.mode,
      };
    });
  });
}
