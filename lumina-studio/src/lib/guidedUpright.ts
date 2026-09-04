/**
 * Pure geometry for Lightroom-style Guided Upright corrections.
 *
 * Guide coordinates are normalized source-image coordinates: (0, 0) is the
 * top-left and (1, 1) is the bottom-right. The returned correction uses the
 * application's Geometry units directly: `rotate` is degrees and
 * `horizontal`/`vertical` are in the -100...100 Transform-slider range.
 */

export type GuidedUprightOrientation = "horizontal" | "vertical";

export interface GuidedUprightPoint {
  x: number;
  y: number;
}

export interface GuidedUprightGuide {
  orientation: GuidedUprightOrientation;
  start: GuidedUprightPoint;
  end: GuidedUprightPoint;
}

export interface GuidedUprightCorrection {
  /** Clockwise image rotation in degrees, compatible with geometry.rotate. */
  rotate: number;
  /** Horizontal Transform slider value in the inclusive -100...100 range. */
  horizontal: number;
  /** Vertical Transform slider value in the inclusive -100...100 range. */
  vertical: number;
}

export interface GuidedUprightSolution {
  correction: GuidedUprightCorrection;
  /** Root-mean-square guide alignment error after correction, in degrees. */
  residualDegrees: number;
  guideCount: number;
  horizontalGuideCount: number;
  verticalGuideCount: number;
  /**
   * A 0...1 quality heuristic, not a statistical probability.
   *
   * It combines the post-correction angular fit, the number and orientation
   * coverage of the guides, their usable length/separation, and the distance
   * from an unstable projective transform. Four long, well-separated guides
   * (two in each orientation) can approach 1. Two-guide or single-orientation
   * solutions intentionally receive a lower score because part of the
   * perspective transform is inferred by a minimum-correction prior.
   */
  confidence: number;
}

export type GuidedUprightFailureReason =
  | "guide-count"
  | "invalid-options"
  | "invalid-guide"
  | "guide-out-of-bounds"
  | "guide-too-short"
  | "duplicate-guides"
  | "unstable-solution"
  | "inconsistent-guides";

export type GuidedUprightResult =
  | { ok: true; solution: GuidedUprightSolution }
  | {
      ok: false;
      reason: GuidedUprightFailureReason;
      message: string;
      guideIndices?: readonly number[];
    };

export interface GuidedUprightOptions {
  /** Source image width divided by height. Defaults to 1. */
  aspectRatio?: number;
  /** Minimum accepted guide length in normalized image-height units. */
  minimumGuideLength?: number;
  /** Maximum absolute perspective slider value. Defaults to 100. */
  maximumPerspective?: number;
  /** Maximum absolute automatic rotation in degrees. Defaults to 89. */
  maximumRotationDegrees?: number;
  /** Maximum accepted RMS alignment error in degrees. Defaults to 3. */
  maximumResidualDegrees?: number;
}

interface PreparedGuide extends GuidedUprightGuide {
  index: number;
  /** Homogeneous source-line coefficients in engine-normalized coordinates. */
  a: number;
  b: number;
  c: number;
  length: number;
  weight: number;
  /** Canonical unit line in aspect-corrected (pixel-isotropic) coordinates. */
  unitPixelLine: readonly [number, number, number];
}

interface EvaluatedAngle {
  angleRadians: number;
  horizontalCoefficient: number;
  verticalCoefficient: number;
  horizontal: number;
  vertical: number;
  objective: number;
}

const DEFAULT_MINIMUM_GUIDE_LENGTH = 0.04;
const DEFAULT_MAXIMUM_PERSPECTIVE = 100;
const DEFAULT_MAXIMUM_ROTATION = 89;
const DEFAULT_MAXIMUM_RESIDUAL = 3;
const COORDINATE_EPSILON = 1e-7;
const LINE_EPSILON = 1e-10;
const DUPLICATE_ANGLE_RADIANS = (0.25 * Math.PI) / 180;
const DUPLICATE_DISTANCE = 0.004;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const clamp01 = (value: number): number => clamp(value, 0, 1);

const finite = (value: number): boolean => Number.isFinite(value);

const canonicalizeUnitLine = (
  a: number,
  b: number,
  c: number,
): readonly [number, number, number] => {
  if (a < -LINE_EPSILON || (Math.abs(a) <= LINE_EPSILON && b < 0)) {
    return [-a, -b, -c];
  }
  return [a, b, c];
};

const prepareGuide = (
  guide: GuidedUprightGuide,
  index: number,
  aspectRatio: number,
  minimumGuideLength: number,
): PreparedGuide | GuidedUprightResult => {
  if (
    !guide ||
    (guide.orientation !== "horizontal" && guide.orientation !== "vertical") ||
    !guide.start ||
    !guide.end ||
    !finite(guide.start.x) ||
    !finite(guide.start.y) ||
    !finite(guide.end.x) ||
    !finite(guide.end.y)
  ) {
    return {
      ok: false,
      reason: "invalid-guide",
      message: `Guide ${index + 1} has an invalid orientation or endpoint.`,
      guideIndices: [index],
    };
  }

  const coordinates = [
    guide.start.x,
    guide.start.y,
    guide.end.x,
    guide.end.y,
  ];
  if (
    coordinates.some(
      (coordinate) =>
        coordinate < -COORDINATE_EPSILON ||
        coordinate > 1 + COORDINATE_EPSILON,
    )
  ) {
    return {
      ok: false,
      reason: "guide-out-of-bounds",
      message: `Guide ${index + 1} must stay inside the normalized image bounds.`,
      guideIndices: [index],
    };
  }

  const startX = clamp(guide.start.x, 0, 1) - 0.5;
  const startY = clamp(guide.start.y, 0, 1) - 0.5;
  const endX = clamp(guide.end.x, 0, 1) - 0.5;
  const endY = clamp(guide.end.y, 0, 1) - 0.5;
  const length = Math.hypot(
    (endX - startX) * aspectRatio,
    endY - startY,
  );

  if (length < minimumGuideLength) {
    return {
      ok: false,
      reason: "guide-too-short",
      message: `Guide ${index + 1} is too short to produce a stable correction.`,
      guideIndices: [index],
    };
  }

  // Cross product of the two centered source points. The common scale of a,
  // b, and c is normalized in pixel-isotropic coordinates so every guide has
  // comparable influence regardless of image aspect ratio or draw direction.
  let a = startY - endY;
  let b = endX - startX;
  let c = startX * endY - endX * startY;
  const pixelNormalLength = Math.hypot(a / aspectRatio, b);
  if (pixelNormalLength < LINE_EPSILON) {
    return {
      ok: false,
      reason: "guide-too-short",
      message: `Guide ${index + 1} is too short to produce a stable correction.`,
      guideIndices: [index],
    };
  }
  a /= pixelNormalLength;
  b /= pixelNormalLength;
  c /= pixelNormalLength;

  const pixelA = a / aspectRatio;
  const pixelB = b;
  const unitPixelLine = canonicalizeUnitLine(pixelA, pixelB, c);

  return {
    ...guide,
    start: { x: startX + 0.5, y: startY + 0.5 },
    end: { x: endX + 0.5, y: endY + 0.5 },
    index,
    a,
    b,
    c,
    length,
    // A longer guide is easier to place accurately, but cap its leverage so a
    // single long guide cannot drown out the rest of the user's constraints.
    weight: 0.55 + 0.45 * clamp01(length / 0.55),
    unitPixelLine,
  };
};

const duplicateGuidePair = (
  first: PreparedGuide,
  second: PreparedGuide,
): boolean => {
  const [a1, b1, c1] = first.unitPixelLine;
  const [a2, b2, c2] = second.unitPixelLine;
  const normalDot = clamp(a1 * a2 + b1 * b2, -1, 1);
  const angle = Math.acos(normalDot);
  return angle <= DUPLICATE_ANGLE_RADIANS && Math.abs(c1 - c2) <= DUPLICATE_DISTANCE;
};

const estimateCompositeCoefficient = (
  guides: readonly PreparedGuide[],
  base: (guide: PreparedGuide) => number,
): number => {
  let numerator = 0;
  let denominator = 0;
  for (const guide of guides) {
    numerator += guide.weight * guide.c * base(guide);
    denominator += guide.weight * guide.c * guide.c;
  }
  return denominator > LINE_EPSILON ? -numerator / denominator : 0;
};

const evaluateAngle = (
  angleRadians: number,
  horizontalGuides: readonly PreparedGuide[],
  verticalGuides: readonly PreparedGuide[],
  aspectRatio: number,
  maximumPerspectiveCoefficient: number,
): EvaluatedAngle => {
  const cosine = Math.cos(angleRadians);
  const sine = Math.sin(angleRadians);

  // Under the renderer's homography, each horizontal constraint is linear in
  // u = cos(r)H - sin(r)A*V, and each vertical constraint is linear in
  // w = sin(r)H + cos(r)A*V. Solving u/w at a fixed angle reduces the robust
  // three-parameter problem to a deterministic one-dimensional search.
  const horizontalCoefficient = estimateCompositeCoefficient(
    horizontalGuides,
    (guide) => cosine * guide.a - sine * aspectRatio * guide.b,
  );
  const verticalCoefficient = estimateCompositeCoefficient(
    verticalGuides,
    (guide) => sine * guide.a + cosine * aspectRatio * guide.b,
  );

  const horizontal =
    cosine * horizontalCoefficient + sine * verticalCoefficient;
  const vertical =
    (-sine * horizontalCoefficient + cosine * verticalCoefficient) /
    aspectRatio;

  let weightedSquaredResidual = 0;
  let totalWeight = 0;
  for (const guide of horizontalGuides) {
    const residual =
      cosine * guide.a -
      sine * aspectRatio * guide.b +
      guide.c * horizontalCoefficient;
    weightedSquaredResidual += guide.weight * residual * residual;
    totalWeight += guide.weight;
  }
  for (const guide of verticalGuides) {
    const residual =
      sine * guide.a +
      cosine * aspectRatio * guide.b +
      guide.c * verticalCoefficient;
    weightedSquaredResidual += guide.weight * residual * residual;
    totalWeight += guide.weight;
  }

  const fit = weightedSquaredResidual / Math.max(LINE_EPSILON, totalWeight);
  const excessHorizontal = Math.max(
    0,
    Math.abs(horizontal) - maximumPerspectiveCoefficient,
  );
  const excessVertical = Math.max(
    0,
    Math.abs(vertical) - maximumPerspectiveCoefficient,
  );
  const minimumDenominator = 1 - 0.5 * (Math.abs(horizontal) + Math.abs(vertical));
  const unstableDenominator = Math.max(0, 0.35 - minimumDenominator);

  // The tiny prior is irrelevant when the guides determine a unique fit. It
  // makes underconstrained two-guide layouts deterministic by selecting the
  // valid correction nearest the identity transform.
  const identityPrior =
    1e-8 *
    (Math.pow(angleRadians / 0.5, 2) +
      Math.pow(horizontal / 0.25, 2) +
      Math.pow(vertical / 0.25, 2));
  const boundPenalty =
    1e4 *
    (excessHorizontal * excessHorizontal +
      excessVertical * excessVertical +
      unstableDenominator * unstableDenominator);

  return {
    angleRadians,
    horizontalCoefficient,
    verticalCoefficient,
    horizontal,
    vertical,
    objective: fit + identityPrior + boundPenalty,
  };
};

const findBestAngle = (
  horizontalGuides: readonly PreparedGuide[],
  verticalGuides: readonly PreparedGuide[],
  aspectRatio: number,
  maximumPerspectiveCoefficient: number,
  maximumRotationRadians: number,
): EvaluatedAngle => {
  const evaluate = (angle: number): EvaluatedAngle =>
    evaluateAngle(
      angle,
      horizontalGuides,
      verticalGuides,
      aspectRatio,
      maximumPerspectiveCoefficient,
    );

  // A global scan avoids depending on an initial guess and handles the shallow
  // multiple minima that two-guide layouts can produce.
  const steps = Math.max(180, Math.ceil((maximumRotationRadians * 2) / (Math.PI / 720)));
  const step = (maximumRotationRadians * 2) / steps;
  let best = evaluate(-maximumRotationRadians);
  let bestIndex = 0;
  for (let index = 1; index <= steps; index += 1) {
    const candidate = evaluate(-maximumRotationRadians + step * index);
    if (candidate.objective < best.objective) {
      best = candidate;
      bestIndex = index;
    }
  }

  // Golden-section refinement within the winning grid cell.
  let left = Math.max(
    -maximumRotationRadians,
    -maximumRotationRadians + step * (bestIndex - 1),
  );
  let right = Math.min(
    maximumRotationRadians,
    -maximumRotationRadians + step * (bestIndex + 1),
  );
  const ratio = (Math.sqrt(5) - 1) / 2;
  let firstX = right - ratio * (right - left);
  let secondX = left + ratio * (right - left);
  let first = evaluate(firstX);
  let second = evaluate(secondX);
  for (let iteration = 0; iteration < 48; iteration += 1) {
    if (first.objective <= second.objective) {
      right = secondX;
      secondX = firstX;
      second = first;
      firstX = right - ratio * (right - left);
      first = evaluate(firstX);
    } else {
      left = firstX;
      firstX = secondX;
      first = second;
      secondX = left + ratio * (right - left);
      second = evaluate(secondX);
    }
  }
  const refined = first.objective <= second.objective ? first : second;
  return refined.objective <= best.objective ? refined : best;
};

const mapPreparedPoint = (
  point: GuidedUprightPoint,
  angleRadians: number,
  horizontal: number,
  vertical: number,
  aspectRatio: number,
): GuidedUprightPoint | null => {
  const sourceX = point.x - 0.5;
  const sourceY = point.y - 0.5;
  const denominator = 1 - horizontal * sourceX - vertical * sourceY;
  if (!finite(denominator) || denominator <= 0.05) return null;
  const projectedX = (sourceX / denominator) * aspectRatio;
  const projectedY = sourceY / denominator;
  const cosine = Math.cos(angleRadians);
  const sine = Math.sin(angleRadians);
  return {
    x: cosine * projectedX - sine * projectedY,
    y: sine * projectedX + cosine * projectedY,
  };
};

const residualForSolution = (
  guides: readonly PreparedGuide[],
  angleRadians: number,
  horizontal: number,
  vertical: number,
  aspectRatio: number,
): { rmsDegrees: number; stable: boolean } => {
  let weightedSquaredDegrees = 0;
  let totalWeight = 0;
  for (const guide of guides) {
    const start = mapPreparedPoint(
      guide.start,
      angleRadians,
      horizontal,
      vertical,
      aspectRatio,
    );
    const end = mapPreparedPoint(
      guide.end,
      angleRadians,
      horizontal,
      vertical,
      aspectRatio,
    );
    if (!start || !end) return { rmsDegrees: Number.POSITIVE_INFINITY, stable: false };
    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    if (Math.hypot(deltaX, deltaY) < LINE_EPSILON) {
      return { rmsDegrees: Number.POSITIVE_INFINITY, stable: false };
    }
    const errorRadians =
      guide.orientation === "horizontal"
        ? Math.atan2(Math.abs(deltaY), Math.abs(deltaX))
        : Math.atan2(Math.abs(deltaX), Math.abs(deltaY));
    const errorDegrees = (errorRadians * 180) / Math.PI;
    weightedSquaredDegrees += guide.weight * errorDegrees * errorDegrees;
    totalWeight += guide.weight;
  }
  return {
    rmsDegrees: Math.sqrt(weightedSquaredDegrees / Math.max(LINE_EPSILON, totalWeight)),
    stable: true,
  };
};

const familyLeverage = (guides: readonly PreparedGuide[]): number => {
  if (guides.length < 2) return 0.42;
  let best = 0;
  for (let firstIndex = 0; firstIndex < guides.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < guides.length; secondIndex += 1) {
      const [a1, b1, c1] = guides[firstIndex].unitPixelLine;
      const [a2, b2, c2] = guides[secondIndex].unitPixelLine;
      const dot = clamp(a1 * a2 + b1 * b2, -1, 1);
      const angle = Math.acos(dot);
      const offset = Math.abs(c1 - c2);
      // Parallel guides gain leverage through separation; converging guides
      // gain it through their angle. Either pattern can determine keystone.
      best = Math.max(
        best,
        clamp01(offset / 0.28),
        clamp01(angle / ((9 * Math.PI) / 180)),
      );
    }
  }
  return 0.42 + 0.58 * best;
};

const confidenceForSolution = (
  guides: readonly PreparedGuide[],
  horizontalGuides: readonly PreparedGuide[],
  verticalGuides: readonly PreparedGuide[],
  residualDegrees: number,
  horizontal: number,
  vertical: number,
): number => {
  const fitScore = Math.exp(-Math.pow(residualDegrees / 1.35, 2));
  const hasBothOrientations = horizontalGuides.length > 0 && verticalGuides.length > 0;
  const hasTwoPerOrientation =
    horizontalGuides.length >= 2 && verticalGuides.length >= 2;
  const supportScore = clamp01(
    0.44 +
      0.17 * (guides.length - 2) +
      (hasBothOrientations ? 0.1 : 0) +
      (hasTwoPerOrientation ? 0.12 : 0),
  );
  const averageLength =
    guides.reduce((sum, guide) => sum + guide.length, 0) / guides.length;
  const lengthScore = 0.35 + 0.65 * clamp01(averageLength / 0.55);
  const leverageScores = [
    ...(horizontalGuides.length ? [familyLeverage(horizontalGuides)] : []),
    ...(verticalGuides.length ? [familyLeverage(verticalGuides)] : []),
  ];
  const leverageScore =
    leverageScores.reduce((sum, value) => sum + value, 0) /
    Math.max(1, leverageScores.length);
  const minimumDenominator = 1 - 0.5 * (Math.abs(horizontal) + Math.abs(vertical));
  const stabilityScore = clamp01((minimumDenominator - 0.35) / 0.65);

  return clamp01(
    fitScore *
      stabilityScore *
      (0.55 * supportScore + 0.25 * lengthScore + 0.2 * leverageScore),
  );
};

/**
 * Solves a Guided Upright correction from two to four user-drawn guides.
 *
 * The solver fits the same three-parameter transform used by the renderer: a
 * 2D rotation followed by a restricted projective (keystone) correction. It
 * rejects malformed, duplicate, out-of-bounds, inconsistent, or numerically
 * unsafe constraints instead of returning NaN or an extreme transform.
 */
export const solveGuidedUpright = (
  guides: readonly GuidedUprightGuide[],
  options: GuidedUprightOptions = {},
): GuidedUprightResult => {
  if (!Array.isArray(guides) || guides.length < 2 || guides.length > 4) {
    return {
      ok: false,
      reason: "guide-count",
      message: "Guided Upright requires between two and four guides.",
    };
  }

  const aspectRatio = options.aspectRatio ?? 1;
  const minimumGuideLength =
    options.minimumGuideLength ?? DEFAULT_MINIMUM_GUIDE_LENGTH;
  const maximumPerspective =
    options.maximumPerspective ?? DEFAULT_MAXIMUM_PERSPECTIVE;
  const maximumRotationDegrees =
    options.maximumRotationDegrees ?? DEFAULT_MAXIMUM_ROTATION;
  const maximumResidualDegrees =
    options.maximumResidualDegrees ?? DEFAULT_MAXIMUM_RESIDUAL;
  if (
    !finite(aspectRatio) ||
    aspectRatio < 0.1 ||
    aspectRatio > 20 ||
    !finite(minimumGuideLength) ||
    minimumGuideLength <= 0 ||
    minimumGuideLength > 1 ||
    !finite(maximumPerspective) ||
    maximumPerspective <= 0 ||
    maximumPerspective > 100 ||
    !finite(maximumRotationDegrees) ||
    maximumRotationDegrees <= 0 ||
    maximumRotationDegrees >= 90 ||
    !finite(maximumResidualDegrees) ||
    maximumResidualDegrees <= 0 ||
    maximumResidualDegrees > 45
  ) {
    return {
      ok: false,
      reason: "invalid-options",
      message: "Guided Upright solver options are outside their supported range.",
    };
  }

  const prepared: PreparedGuide[] = [];
  for (let index = 0; index < guides.length; index += 1) {
    const result = prepareGuide(
      guides[index],
      index,
      aspectRatio,
      minimumGuideLength,
    );
    if ("ok" in result) return result;
    prepared.push(result);
  }

  for (let first = 0; first < prepared.length; first += 1) {
    for (let second = first + 1; second < prepared.length; second += 1) {
      if (duplicateGuidePair(prepared[first], prepared[second])) {
        return {
          ok: false,
          reason: "duplicate-guides",
          message: `Guides ${first + 1} and ${second + 1} describe the same image line.`,
          guideIndices: [first, second],
        };
      }
    }
  }

  const horizontalGuides = prepared.filter(
    (guide) => guide.orientation === "horizontal",
  );
  const verticalGuides = prepared.filter(
    (guide) => guide.orientation === "vertical",
  );
  const maximumPerspectiveCoefficient = maximumPerspective / 200;
  const best = findBestAngle(
    horizontalGuides,
    verticalGuides,
    aspectRatio,
    maximumPerspectiveCoefficient,
    (maximumRotationDegrees * Math.PI) / 180,
  );

  if (
    !finite(best.angleRadians) ||
    !finite(best.horizontal) ||
    !finite(best.vertical) ||
    Math.abs(best.horizontal) > maximumPerspectiveCoefficient + 1e-6 ||
    Math.abs(best.vertical) > maximumPerspectiveCoefficient + 1e-6 ||
    1 - 0.5 * (Math.abs(best.horizontal) + Math.abs(best.vertical)) <= 0.35
  ) {
    return {
      ok: false,
      reason: "unstable-solution",
      message: "These guides require a perspective correction outside the stable range.",
    };
  }

  const residual = residualForSolution(
    prepared,
    best.angleRadians,
    best.horizontal,
    best.vertical,
    aspectRatio,
  );
  if (!residual.stable) {
    return {
      ok: false,
      reason: "unstable-solution",
      message: "These guides collapse or cross the projective horizon after correction.",
    };
  }
  if (residual.rmsDegrees > maximumResidualDegrees) {
    return {
      ok: false,
      reason: "inconsistent-guides",
      message: `The guides disagree by ${residual.rmsDegrees.toFixed(1)}° after correction.`,
    };
  }

  const correction: GuidedUprightCorrection = {
    rotate:
      Math.abs(best.angleRadians) < 1e-10
        ? 0
        : (best.angleRadians * 180) / Math.PI,
    horizontal:
      Math.abs(best.horizontal) < 1e-10
        ? 0
        : clamp(best.horizontal * 200, -maximumPerspective, maximumPerspective),
    vertical:
      Math.abs(best.vertical) < 1e-10
        ? 0
        : clamp(best.vertical * 200, -maximumPerspective, maximumPerspective),
  };

  return {
    ok: true,
    solution: {
      correction,
      residualDegrees: residual.rmsDegrees,
      guideCount: prepared.length,
      horizontalGuideCount: horizontalGuides.length,
      verticalGuideCount: verticalGuides.length,
      confidence: confidenceForSolution(
        prepared,
        horizontalGuides,
        verticalGuides,
        residual.rmsDegrees,
        best.horizontal,
        best.vertical,
      ),
    },
  };
};

/**
 * Maps a source point through a solved correction for overlay/tests. The
 * returned point is in the rectified frame's normalized coordinate system
 * before crop-to-fill; it is deliberately not clamped to the image bounds.
 */
export const mapPointThroughGuidedUpright = (
  point: GuidedUprightPoint,
  correction: GuidedUprightCorrection,
  aspectRatio = 1,
): GuidedUprightPoint | null => {
  if (
    !point ||
    !finite(point.x) ||
    !finite(point.y) ||
    !finite(correction.rotate) ||
    !finite(correction.horizontal) ||
    !finite(correction.vertical) ||
    !finite(aspectRatio) ||
    aspectRatio <= 0
  ) {
    return null;
  }
  const mapped = mapPreparedPoint(
    point,
    (correction.rotate * Math.PI) / 180,
    correction.horizontal / 200,
    correction.vertical / 200,
    aspectRatio,
  );
  if (!mapped) return null;
  return { x: mapped.x / aspectRatio + 0.5, y: mapped.y + 0.5 };
};
