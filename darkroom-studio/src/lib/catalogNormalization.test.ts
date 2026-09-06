import { describe, expect, it } from "vitest";
import {
  createDefaultEditState,
  DEFAULT_LOCAL_ADJUSTMENTS,
} from "../defaults";
import { makeMaskComponent } from "./maskMath";
import { normalizeCatalogEditState } from "./catalog";
import { RETIRED_PROFILE_NAMESPACE } from "./retiredIdentity";

describe("normalizeCatalogEditState", () => {
  it("migrates an older recipe and supplies every current control", () => {
    const legacy = createDefaultEditState() as unknown as Record<string, unknown>;
    legacy.profile = `${RETIRED_PROFILE_NAMESPACE} Vivid`;
    delete legacy.redCurve;
    delete legacy.greenCurve;
    delete legacy.blueCurve;
    delete legacy.pointColor;
    delete legacy.lensCorrections;
    delete legacy.lensBlur;
    delete legacy.calibration;
    const global = legacy.global as Record<string, unknown>;
    delete global.sharpeningRadius;
    delete global.noiseReductionDetail;

    const migrated = normalizeCatalogEditState(legacy);

    expect(migrated.profile).toBe("Darkroom Vivid");
    expect(migrated.redCurve).toHaveLength(5);
    expect(migrated.pointColor.enabled).toBe(false);
    expect(migrated.lensCorrections.midpoint).toBe(50);
    expect(migrated.lensBlur.focusY).toBe(0.42);
    expect(migrated.calibration.processVersion).toBe("6");
    expect(migrated.global.sharpeningRadius).toBe(1);
    expect(migrated.global.noiseReductionDetail).toBe(50);
  });

  it("preserves valid independent channel curves", () => {
    const state = createDefaultEditState();
    state.blueCurve[2].y = 0.72;
    const restored = normalizeCatalogEditState(structuredClone(state));
    expect(restored.blueCurve[2].y).toBe(0.72);
  });

  it("restores up to four normalized Guided Upright guides", () => {
    const state = createDefaultEditState() as unknown as {
      geometry: Record<string, unknown>;
    };
    state.geometry.guides = [
      {
        orientation: "horizontal",
        start: { x: -0.25, y: 0.2 },
        end: { x: 1.4, y: 0.22 },
      },
      {
        orientation: "vertical",
        start: { x: 0.7, y: "0.1" },
        end: { x: 0.72, y: "0.9" },
      },
      {
        orientation: "diagonal",
        start: { x: 0, y: 0 },
        end: { x: 1, y: 1 },
      },
      {
        orientation: "vertical",
        start: { x: Number.NaN, y: 0 },
        end: { x: 0.5, y: 1 },
      },
      {
        orientation: "horizontal",
        start: { x: 0.1, y: 0.4 },
        end: { x: 0.9, y: 0.45 },
      },
      {
        orientation: "vertical",
        start: { x: 0.25, y: 0.1 },
        end: { x: 0.3, y: 0.9 },
      },
      {
        orientation: "horizontal",
        start: { x: 0.1, y: 0.8 },
        end: { x: 0.9, y: 0.85 },
      },
    ];

    const restored = normalizeCatalogEditState(state);

    expect(restored.geometry.guides).toEqual([
      {
        orientation: "horizontal",
        start: { x: 0, y: 0.2 },
        end: { x: 1, y: 0.22 },
      },
      {
        orientation: "vertical",
        start: { x: 0.7, y: 0.1 },
        end: { x: 0.72, y: 0.9 },
      },
      {
        orientation: "horizontal",
        start: { x: 0.1, y: 0.4 },
        end: { x: 0.9, y: 0.45 },
      },
      {
        orientation: "vertical",
        start: { x: 0.25, y: 0.1 },
        end: { x: 0.3, y: 0.9 },
      },
    ]);
  });

  it("uses the fallback guides when a legacy recipe has no guides array", () => {
    const fallback = createDefaultEditState();
    fallback.geometry.guides = [{
      orientation: "vertical",
      start: { x: 0.35, y: 0.1 },
      end: { x: 0.36, y: 0.9 },
    }];
    const legacy = structuredClone(createDefaultEditState()) as unknown as {
      geometry: Record<string, unknown>;
    };
    delete legacy.geometry.guides;

    const restored = normalizeCatalogEditState(legacy, fallback);

    expect(restored.geometry.guides).toEqual(fallback.geometry.guides);
    expect(restored.geometry.guides).not.toBe(fallback.geometry.guides);
  });

  it("round-trips combined people features and migrates a legacy region", () => {
    const state = createDefaultEditState();
    const combined = makeMaskComponent("people");
    combined.people = {
      region: "all",
      features: ["eyes", "lips", "teeth"],
      personId: "person-1",
    };
    state.masks = [
      {
        id: "people-combined",
        name: "Person 1 · Eyes + Lips + Teeth",
        kind: "people",
        enabled: true,
        inverted: false,
        opacity: 1,
        overlayColor: "#43b9c7",
        adjustments: { ...DEFAULT_LOCAL_ADJUSTMENTS },
        people: combined.people,
        components: [combined],
      },
      {
        id: "people-legacy",
        name: "Legacy skin",
        kind: "people",
        enabled: true,
        inverted: false,
        opacity: 1,
        overlayColor: "#e95f66",
        adjustments: { ...DEFAULT_LOCAL_ADJUSTMENTS },
        people: { region: "skin" },
      },
    ];

    const restored = normalizeCatalogEditState(structuredClone(state));

    expect(restored.masks[0].components?.[0].people).toEqual({
      region: "all",
      features: ["eyes", "lips", "teeth"],
      personId: "person-1",
    });
    expect(restored.masks[1].components?.[0].people).toEqual({
      region: "skin",
      features: ["faceSkin", "bodySkin"],
      personId: "person-1",
    });
  });
});
