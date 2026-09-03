import { describe, expect, it } from "vitest";
import type {
  LocalAdjustments,
  Mask,
  MaskComponent,
  MaskKind,
} from "../types";
import {
  composeMaskWeight,
  composeMaskWeights,
  duplicateMaskComponent,
  duplicateMaskComponentInMask,
  getMaskComponents,
  legacyRegionForPeopleFeatures,
  makeMaskComponent,
  normalizeMask,
  normalizeMaskComponent,
  normalizeMasks,
  normalizePeopleFeatures,
  updateMaskComponent,
} from "./maskMath";

const adjustments = (): LocalAdjustments => ({
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
});

const legacyMask = (overrides: Partial<Mask> = {}): Mask => ({
  id: "legacy-mask",
  name: "Legacy Brush",
  kind: "brush",
  enabled: true,
  inverted: true,
  opacity: 0.4,
  overlayColor: "#ff0000",
  adjustments: adjustments(),
  strokes: [
    {
      points: [{ x: 0.25, y: 0.75, pressure: 0.5 }],
      size: 20,
      feather: 50,
      flow: 75,
      erase: false,
    },
  ],
  ...overrides,
});

describe("makeMaskComponent", () => {
  it("creates complete defaults for every supported component kind", () => {
    const kinds: MaskKind[] = [
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

    for (const kind of kinds) {
      const component = makeMaskComponent(kind, "intersect");
      expect(component.id).toBeTruthy();
      expect(component.kind).toBe(kind);
      expect(component.operation).toBe("intersect");
      expect(component.enabled).toBe(true);
      expect(component.inverted).toBe(false);
      expect(component.opacity).toBe(1);
    }

    expect(makeMaskComponent("linear").linear).toEqual({
      x1: 0.5,
      y1: 0.12,
      x2: 0.5,
      y2: 0.72,
    });
    expect(makeMaskComponent("people").people).toEqual({
      region: "all",
      features: ["wholePerson"],
      personId: "person-1",
    });
    expect(makeMaskComponent("depth").depth).toEqual({
      min: 0,
      max: 100,
      smoothness: 35,
    });
  });
});

describe("legacy mask migration", () => {
  it("turns a flat mask into one additive component without double-applying group controls", () => {
    const mask = legacyMask();
    const components = getMaskComponents(mask);

    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({
      id: "legacy-mask-component-1",
      name: "Brush",
      kind: "brush",
      operation: "add",
      enabled: true,
      inverted: false,
      opacity: 1,
    });
    expect(components[0].strokes).toEqual([
      {
        ...mask.strokes![0],
        density: 100,
        autoMask: false,
      },
    ]);
    expect(components[0].strokes).not.toBe(mask.strokes);

    const normalized = normalizeMask(mask);
    expect(normalized.inverted).toBe(true);
    expect(normalized.opacity).toBe(0.4);
    expect(normalized.components).toEqual(components);
    expect(normalized.kind).toBe("brush");
    expect(normalized.strokes).toEqual(components[0].strokes);
  });

  it("preserves an intentional empty component list instead of recreating a legacy component", () => {
    const normalized = normalizeMask({ ...legacyMask(), components: [] });
    expect(normalized.components).toEqual([]);
  });
});

describe("normalization and import validation", () => {
  it("sanitizes malformed group, adjustment, geometry, color, and stroke data", () => {
    const normalized = normalizeMask(
      {
        id: "   ",
        name: "",
        kind: "not-a-kind",
        enabled: "yes",
        inverted: 1,
        opacity: 42,
        overlayColor: "#F0A",
        adjustments: {
          exposure: Number.POSITIVE_INFINITY,
          contrast: -900,
          whites: 900,
          hue: 999,
          noiseReduction: -50,
        },
        components: [
          {
            id: "",
            name: "",
            kind: "brush",
            operation: "multiply",
            enabled: "no",
            inverted: "yes",
            opacity: -4,
            strokes: [
              {
                points: [
                  { x: -1, y: 4, pressure: 2 },
                  { x: Number.NaN, y: 0.5 },
                  null,
                ],
                size: 900,
                feather: -10,
                flow: 300,
                erase: "true",
                density: -20,
                autoMask: true,
              },
            ],
          },
        ],
      },
      2,
    );

    expect(normalized).toMatchObject({
      id: "mask-3",
      name: "Mask 3",
      kind: "brush",
      enabled: true,
      inverted: false,
      opacity: 1,
      overlayColor: "#ff00aa",
    });
    expect(normalized.adjustments).toMatchObject({
      exposure: 0,
      contrast: -100,
      whites: 100,
      hue: 180,
      noiseReduction: 0,
      tint: 0,
    });
    expect(normalized.components?.[0]).toMatchObject({
      id: "mask-3-component-1",
      name: "Component 1",
      operation: "add",
      enabled: true,
      inverted: false,
      opacity: 0,
    });
    expect(normalized.components?.[0].strokes).toEqual([
      {
        points: [{ x: 0, y: 1, pressure: 1 }],
        size: 100,
        feather: 0,
        flow: 100,
        erase: false,
        density: 0,
        autoMask: true,
      },
    ]);
  });

  it("clamps every new semantic mask payload and rejects invalid enum values", () => {
    expect(
      normalizeMaskComponent({
        kind: "object",
        object: { x: -1, y: 2, width: 2, height: 0 },
      }).object,
    ).toEqual({ x: 0, y: 0.999, width: 1, height: 0.001 });

    expect(
      normalizeMaskComponent({
        kind: "people",
        people: { region: "eyes" },
      }).people,
    ).toEqual({
      region: "all",
      features: ["wholePerson"],
      personId: "person-1",
    });

    expect(
      normalizeMaskComponent({
        kind: "landscape",
        landscape: { element: "clouds" },
      }).landscape,
    ).toEqual({ element: "sky" });

    expect(
      normalizeMaskComponent({
        kind: "depth",
        depth: { min: 120, max: -20, smoothness: 500 },
      }).depth,
    ).toEqual({ min: 0, max: 100, smoothness: 100 });
  });

  it("migrates legacy people regions and sanitizes multi-feature selections", () => {
    expect(
      normalizeMaskComponent({
        kind: "people",
        people: { region: "skin" },
      }).people,
    ).toEqual({
      region: "skin",
      features: ["faceSkin", "bodySkin"],
      personId: "person-1",
    });

    expect(
      normalizeMaskComponent({
        kind: "people",
        people: {
          region: "face",
          personId: "person-99",
          features: ["eyes", "lips", "eyes", "unsupported"],
        },
      }).people,
    ).toEqual({
      region: "all",
      features: ["eyes", "lips"],
      personId: "person-1",
    });

    expect(normalizePeopleFeatures(["hair", "wholePerson", "eyes"])).toEqual([
      "wholePerson",
    ]);
    expect(legacyRegionForPeopleFeatures(["faceSkin", "bodySkin"])).toBe(
      "skin",
    );
  });

  it("normalizes reversed ranges, rotations, and coordinates", () => {
    const luminance = normalizeMaskComponent({
      kind: "luminance",
      luminance: { min: 85, max: 15, smoothness: -2 },
    });
    expect(luminance.luminance).toEqual({
      min: 15,
      max: 85,
      smoothness: 0,
    });

    const radial = normalizeMaskComponent({
      kind: "radial",
      radial: {
        cx: -1,
        cy: 2,
        rx: 0,
        ry: 8,
        rotation: 540,
        feather: 150,
      },
    });
    expect(radial.radial).toEqual({
      cx: 0,
      cy: 1,
      rx: 0.001,
      ry: 2,
      rotation: -180,
      feather: 100,
    });
  });

  it("drops non-object entries when validating an imported mask collection", () => {
    const masks = normalizeMasks([
      null,
      "bad",
      legacyMask(),
      7,
      { id: "second", kind: "sky" },
    ]);
    expect(masks.map((mask) => mask.id)).toEqual(["legacy-mask", "second"]);
    expect(masks[1].components?.[0].kind).toBe("sky");
  });

  it("caps imported component groups and guarantees an additive base", () => {
    const components = getMaskComponents({
      id: "oversized",
      components: Array.from({ length: 40 }, (_, index) => ({
        id: `component-${index}`,
        name: `Component ${index}`,
        kind: "brush",
        operation: index % 2 ? "intersect" : "subtract",
      })),
    });

    expect(components).toHaveLength(32);
    expect(components[0].operation).toBe("add");
    expect(components[1].operation).toBe("intersect");
  });
});

describe("soft mask composition", () => {
  it("implements additive union, subtraction, and intersection", () => {
    expect(composeMaskWeight(0.4, 0.5, "add")).toBeCloseTo(0.7);
    expect(composeMaskWeight(0.8, 0.25, "subtract")).toBeCloseTo(0.6);
    expect(composeMaskWeight(0.8, 0.25, "intersect")).toBeCloseTo(0.2);
  });

  it("clamps malformed weights before composing them", () => {
    expect(composeMaskWeight(-2, 2, "add")).toBe(1);
    expect(composeMaskWeight(Number.NaN, 0.5, "subtract")).toBe(0);
    expect(composeMaskWeight(2, -1, "intersect")).toBe(0);
  });

  it("applies component enabled, inversion, and opacity before ordered boolean operations", () => {
    const components: MaskComponent[] = [
      {
        ...makeMaskComponent("brush", "add"),
        id: "add",
        opacity: 0.5,
      },
      {
        ...makeMaskComponent("brush", "subtract"),
        id: "subtract",
        inverted: true,
      },
      {
        ...makeMaskComponent("brush", "add"),
        id: "disabled",
        enabled: false,
      },
    ];
    const samples: Record<string, number> = {
      add: 0.8,
      subtract: 0.75,
      disabled: 1,
    };

    // add: 0.8 * .5 = .4; inverted subtract: 1 - .75 = .25;
    // .4 * (1 - .25) = .3
    expect(
      composeMaskWeights(components, (component) => samples[component.id]),
    ).toBeCloseTo(0.3);
  });
});

describe("component updates and duplication", () => {
  it("immutably updates and revalidates a selected component", () => {
    const mask = normalizeMask(legacyMask({ inverted: false, opacity: 1 }));
    const originalComponent = mask.components![0];
    const updated = updateMaskComponent(mask, originalComponent.id, {
      opacity: 4,
      operation: "subtract",
    });

    expect(updated).not.toBe(mask);
    expect(updated.components?.[0]).toMatchObject({
      opacity: 1,
      operation: "subtract",
    });
    expect(mask.components?.[0]).toEqual(originalComponent);
    expect(updateMaskComponent(mask, "missing", {})).toBe(mask);
  });

  it("deeply duplicates a component and can insert the copy after its source", () => {
    const source = getMaskComponents(legacyMask())[0];
    const copy = duplicateMaskComponent(source, {
      id: "copy-id",
      name: "Retouch Copy",
      operation: "intersect",
    });
    expect(copy).not.toBe(source);
    expect(copy).toMatchObject({
      id: "copy-id",
      name: "Retouch Copy",
      operation: "intersect",
    });
    expect(copy.strokes).not.toBe(source.strokes);

    const mask = normalizeMask(legacyMask());
    const withCopy = duplicateMaskComponentInMask(
      mask,
      mask.components![0].id,
      { id: "inserted-copy" },
    );
    expect(withCopy.components?.map((component) => component.id)).toEqual([
      "legacy-mask-component-1",
      "inserted-copy",
    ]);
    expect(
      duplicateMaskComponentInMask(mask, "missing", { id: "never-used" }),
    ).toBe(mask);
  });
});
