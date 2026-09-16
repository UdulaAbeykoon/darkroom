import type {
  BrushPoint,
  BrushStroke,
  LocalAdjustments,
  Mask,
  MaskComponent,
  MaskKind,
  MaskOperation,
  MaskPayload,
  PeopleFeature,
} from "../types";

const MASK_KINDS: readonly MaskKind[] = [
  "brush",
  "linear",
  "radial",
  "luminance",
  "color",
  "sky",
  "subject",
  "background",
  "object",
  "people",
  "landscape",
  "depth",
];

const MASK_OPERATIONS: readonly MaskOperation[] = [
  "add",
  "subtract",
  "intersect",
];

const DEFAULT_LOCAL_ADJUSTMENTS: LocalAdjustments = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  vibrance: 0,
  saturation: 0,
  texture: 0,
  clarity: 0,
  dehaze: 0,
  hue: 0,
  sharpness: 0,
  noiseReduction: 0,
  moire: 0,
  defringe: 0,
};

const LOCAL_ADJUSTMENT_RANGES: Record<
  keyof LocalAdjustments,
  readonly [number, number]
> = {
  exposure: [-5, 5],
  contrast: [-100, 100],
  highlights: [-100, 100],
  shadows: [-100, 100],
  whites: [-100, 100],
  blacks: [-100, 100],
  temperature: [-100, 100],
  tint: [-100, 100],
  vibrance: [-100, 100],
  saturation: [-100, 100],
  texture: [-100, 100],
  clarity: [-100, 100],
  dehaze: [-100, 100],
  hue: [-180, 180],
  sharpness: [-100, 100],
  noiseReduction: [0, 100],
  moire: [0, 100],
  defringe: [-100, 100],
};

const DEFAULT_OVERLAY_COLOR = "#ff6b63";
const MAX_STROKES = 4096;
const MAX_POINTS_PER_STROKE = 16384;
const MAX_COMPONENTS_PER_MASK = 32;

export const PEOPLE_FEATURES: readonly PeopleFeature[] = [
  "wholePerson",
  "faceSkin",
  "bodySkin",
  "hair",
  "clothes",
  "eyes",
  "lips",
  "teeth",
  "facialHair",
];

export const PEOPLE_FEATURE_LABELS: Readonly<Record<PeopleFeature, string>> = {
  wholePerson: "Whole person",
  faceSkin: "Face skin",
  bodySkin: "Body skin",
  hair: "Hair",
  clothes: "Clothes",
  eyes: "Eyes",
  lips: "Lips",
  teeth: "Teeth",
  facialHair: "Facial hair",
};

type UnknownRecord = Record<string, unknown>;

let generatedId = 0;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const clamp = (value: number, minimum = 0, maximum = 1): number =>
  Math.min(maximum, Math.max(minimum, value));

const bounded = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number => clamp(finite(value, fallback), minimum, maximum);

const cleanString = (
  value: unknown,
  fallback: string,
  maximumLength = 120,
): string => {
  if (typeof value !== "string") return fallback;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, maximumLength) : fallback;
};

const cleanBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const nextId = (prefix: string): string => {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return `${prefix}-${randomUuid}`;
  generatedId += 1;
  return `${prefix}-${generatedId}`;
};

const titleForKind = (kind: MaskKind): string => {
  const labels: Record<MaskKind, string> = {
    brush: "Brush",
    linear: "Linear Gradient",
    radial: "Radial Gradient",
    luminance: "Luminance Range",
    color: "Color Range",
    sky: "Sky",
    subject: "Subject",
    background: "Background",
    object: "Object",
    people: "People",
    landscape: "Landscape",
    depth: "Depth Range",
  };
  return labels[kind];
};

export const isMaskKind = (value: unknown): value is MaskKind =>
  typeof value === "string" && MASK_KINDS.includes(value as MaskKind);

export const isMaskOperation = (value: unknown): value is MaskOperation =>
  typeof value === "string" &&
  MASK_OPERATIONS.includes(value as MaskOperation);

const normalizePoint = (value: unknown): BrushPoint | null => {
  if (!isRecord(value)) return null;
  if (
    typeof value.x !== "number" ||
    !Number.isFinite(value.x) ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.y)
  ) {
    return null;
  }
  const point: BrushPoint = {
    x: clamp(value.x, -4, 5),
    y: clamp(value.y, -4, 5),
  };
  if (typeof value.pressure === "number" && Number.isFinite(value.pressure)) {
    point.pressure = clamp(value.pressure);
  }
  return point;
};

// Edit recipes are immutable. Keep saved strokes shared while a live stroke
// grows, instead of cloning the entire painting on every pointer frame.
const normalizedStrokeCache = new WeakMap<object, BrushStroke>();
const normalizedComponentCache = new WeakMap<object, MaskComponent>();
const componentListCache = new WeakMap<object, MaskComponent[]>();

const normalizeStroke = (value: unknown): BrushStroke | null => {
  if (!isRecord(value)) return null;
  const cached = normalizedStrokeCache.get(value);
  if (cached) return cached;
  const points = Array.isArray(value.points)
    ? value.points
        .slice(0, MAX_POINTS_PER_STROKE)
        .map(normalizePoint)
        .filter((point): point is BrushPoint => point !== null)
    : [];
  if (points.length === 0) return null;
  const stroke: BrushStroke = {
    points,
    size: bounded(value.size, 34, 0.1, 100),
    feather: bounded(value.feather, 65, 0, 100),
    flow: bounded(value.flow, 100, 0, 100),
    erase: cleanBoolean(value.erase, false),
    density: bounded(value.density, 100, 0, 100),
    autoMask: cleanBoolean(value.autoMask, false),
  };
  normalizedStrokeCache.set(value, stroke);
  normalizedStrokeCache.set(stroke, stroke);
  return stroke;
};

const normalizeRange = (
  value: unknown,
  fallback: { min: number; max: number; smoothness: number },
): { min: number; max: number; smoothness: number } => {
  const record = isRecord(value) ? value : {};
  const first = bounded(record.min, fallback.min, 0, 100);
  const second = bounded(record.max, fallback.max, 0, 100);
  return {
    min: Math.min(first, second),
    max: Math.max(first, second),
    smoothness: bounded(record.smoothness, fallback.smoothness, 0, 100),
  };
};

const normalizeRotation = (value: unknown): number => {
  const rotation = finite(value, 0);
  return ((((rotation + 180) % 360) + 360) % 360) - 180;
};

export const legacyPeopleFeatures = (
  region: unknown,
): PeopleFeature[] => {
  switch (region) {
    case "face":
      return ["faceSkin"];
    case "skin":
      return ["faceSkin", "bodySkin"];
    case "hair":
      return ["hair"];
    case "clothes":
      return ["clothes"];
    case "all":
    default:
      return ["wholePerson"];
  }
};

export const normalizePeopleFeatures = (
  value: unknown,
  legacyRegion: unknown = "all",
): PeopleFeature[] => {
  const features = Array.isArray(value)
    ? value.filter(
        (feature): feature is PeopleFeature =>
          typeof feature === "string" &&
          PEOPLE_FEATURES.includes(feature as PeopleFeature),
      )
    : [];
  const unique = [...new Set(features)];
  if (unique.includes("wholePerson")) return ["wholePerson"];
  return unique.length ? unique : legacyPeopleFeatures(legacyRegion);
};

export const legacyRegionForPeopleFeatures = (
  features: readonly PeopleFeature[],
): NonNullable<MaskPayload["people"]>["region"] => {
  const normalized = normalizePeopleFeatures(features);
  if (normalized.length === 1) {
    if (normalized[0] === "wholePerson") return "all";
    if (normalized[0] === "faceSkin") return "face";
    if (normalized[0] === "hair") return "hair";
    if (normalized[0] === "clothes") return "clothes";
  }
  if (
    normalized.length === 2 &&
    normalized.includes("faceSkin") &&
    normalized.includes("bodySkin")
  ) {
    return "skin";
  }
  return "all";
};

const defaultPayload = (kind: MaskKind): MaskPayload => {
  switch (kind) {
    case "brush":
      return { strokes: [] };
    case "linear":
      return { linear: { x1: 0.5, y1: 0.12, x2: 0.5, y2: 0.72 } };
    case "radial":
      return {
        radial: {
          cx: 0.5,
          cy: 0.5,
          rx: 0.28,
          ry: 0.34,
          rotation: 0,
          feather: 55,
        },
      };
    case "luminance":
      return { luminance: { min: 0, max: 100, smoothness: 35 } };
    case "color":
      return { color: { r: 0.5, g: 0.5, b: 0.5, tolerance: 28 } };
    case "object":
      return { object: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 } };
    case "people":
      return {
        people: {
          region: "all",
          features: ["wholePerson"],
          personId: "person-1",
        },
      };
    case "landscape":
      return { landscape: { element: "sky" } };
    case "depth":
      return { depth: { min: 0, max: 100, smoothness: 35 } };
    default:
      return {};
  }
};

const normalizePayload = (kind: MaskKind, input: UnknownRecord): MaskPayload => {
  switch (kind) {
    case "brush":
      return {
        strokes: Array.isArray(input.strokes)
          ? input.strokes
              .slice(0, MAX_STROKES)
              .map(normalizeStroke)
              .filter((stroke): stroke is BrushStroke => stroke !== null)
          : [],
      };
    case "linear": {
      const value = isRecord(input.linear) ? input.linear : {};
      return {
        linear: {
          x1: bounded(value.x1, 0.5, -4, 5),
          y1: bounded(value.y1, 0.12, -4, 5),
          x2: bounded(value.x2, 0.5, -4, 5),
          y2: bounded(value.y2, 0.72, -4, 5),
        },
      };
    }
    case "radial": {
      const value = isRecord(input.radial) ? input.radial : {};
      return {
        radial: {
          cx: bounded(value.cx, 0.5, -4, 5),
          cy: bounded(value.cy, 0.5, -4, 5),
          rx: bounded(value.rx, 0.28, 0.001, 5),
          ry: bounded(value.ry, 0.34, 0.001, 5),
          rotation: normalizeRotation(value.rotation),
          feather: bounded(value.feather, 55, 0, 100),
        },
      };
    }
    case "luminance":
      return {
        luminance: normalizeRange(input.luminance, {
          min: 0,
          max: 100,
          smoothness: 35,
        }),
      };
    case "color": {
      const value = isRecord(input.color) ? input.color : {};
      return {
        color: {
          r: bounded(value.r, 0.5, 0, 1),
          g: bounded(value.g, 0.5, 0, 1),
          b: bounded(value.b, 0.5, 0, 1),
          tolerance: bounded(value.tolerance, 28, 0, 100),
        },
      };
    }
    case "object": {
      const value = isRecord(input.object) ? input.object : {};
      const width = bounded(value.width, 0.4, 0.001, 1);
      const height = bounded(value.height, 0.4, 0.001, 1);
      return {
        object: {
          x: bounded(value.x, 0.3, 0, 1 - width),
          y: bounded(value.y, 0.3, 0, 1 - height),
          width,
          height,
        },
      };
    }
    case "people": {
      const value = isRecord(input.people) ? input.people : {};
      const regions = ["all", "face", "skin", "hair", "clothes"] as const;
      const region =
        typeof value.region === "string" &&
        regions.includes(value.region as (typeof regions)[number])
          ? (value.region as (typeof regions)[number])
          : "all";
      const features = normalizePeopleFeatures(value.features, region);
      return {
        people: {
          region: legacyRegionForPeopleFeatures(features),
          features,
          personId: "person-1",
        },
      };
    }
    case "landscape": {
      const value = isRecord(input.landscape) ? input.landscape : {};
      const elements = [
        "sky",
        "mountains",
        "architecture",
        "vegetation",
        "water",
        "snow",
        "ground",
      ] as const;
      return {
        landscape: {
          element:
            typeof value.element === "string" &&
            elements.includes(value.element as (typeof elements)[number])
              ? (value.element as (typeof elements)[number])
              : "sky",
        },
      };
    }
    case "depth":
      return {
        depth: normalizeRange(input.depth, {
          min: 0,
          max: 100,
          smoothness: 35,
        }),
      };
    default:
      return {};
  }
};

const normalizeAdjustments = (value: unknown): LocalAdjustments => {
  const input = isRecord(value) ? value : {};
  return (
    Object.keys(DEFAULT_LOCAL_ADJUSTMENTS) as (keyof LocalAdjustments)[]
  ).reduce(
    (adjustments, key) => {
      const [minimum, maximum] = LOCAL_ADJUSTMENT_RANGES[key];
      adjustments[key] = bounded(
        input[key],
        DEFAULT_LOCAL_ADJUSTMENTS[key],
        minimum,
        maximum,
      );
      return adjustments;
    },
    { ...DEFAULT_LOCAL_ADJUSTMENTS },
  );
};

const normalizeOverlayColor = (value: unknown): string => {
  if (typeof value !== "string") return DEFAULT_OVERLAY_COLOR;
  const color = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(color)) return color;
  if (/^#[0-9a-f]{3}$/.test(color)) {
    return `#${color
      .slice(1)
      .split("")
      .map((channel) => channel.repeat(2))
      .join("")}`;
  }
  return DEFAULT_OVERLAY_COLOR;
};

export function makeMaskComponent(
  kind: MaskKind,
  operation: MaskOperation = "add",
  name = titleForKind(kind),
): MaskComponent {
  return {
    id: nextId("mask-component"),
    name: cleanString(name, titleForKind(kind)),
    kind,
    operation,
    enabled: true,
    inverted: false,
    opacity: 1,
    placed: kind !== "linear" && kind !== "radial",
    ...defaultPayload(kind),
  };
}

export function normalizeMaskComponent(
  value: unknown,
  fallback: Partial<MaskComponent> = {},
): MaskComponent {
  const input = isRecord(value) ? value : {};
  const kind = isMaskKind(input.kind)
    ? input.kind
    : isMaskKind(fallback.kind)
      ? fallback.kind
      : "brush";
  const operation = isMaskOperation(input.operation)
    ? input.operation
    : isMaskOperation(fallback.operation)
      ? fallback.operation
      : "add";
  const fallbackName = cleanString(fallback.name, titleForKind(kind));
  return {
    id: cleanString(input.id, cleanString(fallback.id, nextId("mask-component")), 200),
    name: cleanString(input.name, fallbackName),
    kind,
    operation,
    enabled: cleanBoolean(input.enabled, fallback.enabled ?? true),
    inverted: cleanBoolean(input.inverted, fallback.inverted ?? false),
    opacity: bounded(input.opacity, fallback.opacity ?? 1, 0, 1),
    placed: cleanBoolean(input.placed, true),
    ...normalizePayload(kind, input),
  };
}

/**
 * Returns an explicit component list for either a composable mask group or a
 * persisted legacy flat mask. Legacy inversion and opacity stay on the group,
 * so they are not accidentally applied twice by a grouped renderer.
 */
export function getMaskComponents(mask: Mask | unknown): MaskComponent[] {
  const input = isRecord(mask) ? mask : {};
  const parentId = cleanString(input.id, "mask");
  if (Array.isArray(input.components)) {
    const stableIds = input.components.every(component => isRecord(component) && typeof component.id === "string" && typeof component.name === "string");
    const cached = stableIds && componentListCache.get(input.components);
    if (cached) return cached;
    const components = input.components
      .slice(0, MAX_COMPONENTS_PER_MASK)
      .map((component, index) => {
        const cacheable = isRecord(component) && typeof component.id === "string" && typeof component.name === "string";
        const normalized = (cacheable && normalizedComponentCache.get(component)) || normalizeMaskComponent(component, {
          id: `${parentId}-component-${index + 1}`,
          name: `Component ${index + 1}`,
        });
        if (cacheable) normalizedComponentCache.set(component, normalized);
        normalizedComponentCache.set(normalized, normalized);
        return index === 0 && normalized.operation !== "add"
          ? { ...normalized, operation: "add" as const }
          : normalized;
      });
    if (stableIds) componentListCache.set(input.components, components);
    componentListCache.set(components, components);
    return components;
  }

  const kind = isMaskKind(input.kind) ? input.kind : "brush";
  return [
    normalizeMaskComponent(
      {
        ...input,
        id: `${parentId}-component-1`,
        name: titleForKind(kind),
        kind,
        operation: "add",
        enabled: true,
        inverted: false,
        opacity: 1,
      },
      { kind },
    ),
  ];
}

export function normalizeMask(value: unknown, index = 0): Mask {
  const input = isRecord(value) ? value : {};
  const id = cleanString(input.id, `mask-${index + 1}`, 200);
  const components = getMaskComponents({ ...input, id });
  const kind = isMaskKind(input.kind)
    ? input.kind
    : components[0]?.kind ?? "brush";
  const representativePayload =
    Array.isArray(input.components) && components[0]
      ? normalizePayload(components[0].kind, components[0] as unknown as UnknownRecord)
      : normalizePayload(kind, input);

  return {
    id,
    name: cleanString(input.name, `Mask ${index + 1}`),
    kind,
    enabled: cleanBoolean(input.enabled, true),
    inverted: cleanBoolean(input.inverted, false),
    opacity: bounded(input.opacity, 1, 0, 1),
    overlayColor: normalizeOverlayColor(input.overlayColor),
    amount: bounded(input.amount, 100, 0, 200),
    grain: {
      amount: bounded(isRecord(input.grain) ? input.grain.amount : undefined, 0, 0, 100),
      size: bounded(isRecord(input.grain) ? input.grain.size : undefined, 25, 1, 100),
      roughness: bounded(isRecord(input.grain) ? input.grain.roughness : undefined, 50, 0, 100),
    },
    curve: normalizeLocalCurve(input.curve),
    adjustments: normalizeAdjustments(input.adjustments),
    ...representativePayload,
    components,
  };
}

export function normalizeMasks(value: unknown): Mask[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((mask, index) => normalizeMask(mask, index));
}

export function composeMaskWeight(
  current: number,
  next: number,
  operation: MaskOperation,
): number {
  const a = clamp(finite(current, 0));
  const b = clamp(finite(next, 0));
  switch (operation) {
    case "subtract":
      return a * (1 - b);
    case "intersect":
      return a * b;
    case "add":
    default:
      return 1 - (1 - a) * (1 - b);
  }
}

export function composeMaskWeights(
  components: readonly MaskComponent[],
  resolveWeight: (component: MaskComponent, index: number) => number,
): number {
  return components.reduce((weight, component, index) => {
    if (!component.enabled) return weight;
    let componentWeight = clamp(finite(resolveWeight(component, index), 0));
    if (component.inverted) componentWeight = 1 - componentWeight;
    componentWeight *= clamp(finite(component.opacity, 1));
    return composeMaskWeight(weight, componentWeight, component.operation);
  }, 0);
}

export function updateMaskComponent(
  mask: Mask,
  componentId: string,
  patch:
    | Partial<MaskComponent>
    | ((component: MaskComponent) => Partial<MaskComponent>),
): Mask {
  const normalized = Array.isArray(mask.components) ? mask : normalizeMask(mask);
  let updated = false;
  const components = getMaskComponents(normalized).map((component) => {
    if (component.id !== componentId) return component;
    updated = true;
    const nextPatch = typeof patch === "function" ? patch(component) : patch;
    return normalizeMaskComponent(
      { ...component, ...nextPatch, ...(nextPatch.linear || nextPatch.radial ? { placed: true } : {}) },
      component,
    );
  });
  if (!updated) return mask;
  const representativePeople =
    components[0]?.kind === "people" ? components[0].people : undefined;
  return {
    ...normalized,
    ...(representativePeople ? { people: representativePeople } : {}),
    components,
  };
}

export function duplicateMaskComponent(
  component: MaskComponent,
  overrides: Partial<MaskComponent> = {},
): MaskComponent {
  return normalizeMaskComponent(
    {
      ...structuredClone(component),
      ...overrides,
      id: overrides.id ?? nextId("mask-component"),
      name: overrides.name ?? `${component.name} Copy`,
    },
    component,
  );
}

export function duplicateMaskComponentInMask(
  mask: Mask,
  componentId: string,
  overrides: Partial<MaskComponent> = {},
): Mask {
  const normalized = normalizeMask(mask);
  const sourceIndex = normalized.components!.findIndex(
    (component) => component.id === componentId,
  );
  if (sourceIndex < 0) return mask;
  const copy = duplicateMaskComponent(
    normalized.components![sourceIndex],
    overrides,
  );
  const components = [...normalized.components!];
  components.splice(sourceIndex + 1, 0, copy);
  return { ...normalized, components };
}

export function normalizeLocalCurve(value: unknown): import("../types").ToneCurvePoint[] {
  const points = Array.isArray(value) ? value.filter(isRecord).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y)).slice(0, 4096).map(p => ({ x: clamp(p.x as number), y: clamp(p.y as number) })).sort((a, b) => a.x - b.x) : [];
  const unique = points.filter((p, i) => i === 0 || p.x > points[i - 1].x);
  if (unique.length > 16) return Array.from({ length: 16 }, (_, i) => unique[Math.round(i * (unique.length - 1) / 15)]);
  return unique.length >= 2 ? unique : [{ x: 0, y: 0 }, { x: 1, y: 1 }];
}
