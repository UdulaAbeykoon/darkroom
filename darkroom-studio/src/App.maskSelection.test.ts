import { describe, expect, it } from "vitest";
import { DEFAULT_LOCAL_ADJUSTMENTS } from "./defaults";
import { makeMaskComponent } from "./lib/maskMath";
import type { Mask } from "./types";
import { resolveMaskSelection } from "./App";

const makeMask = (id: string, componentIds: string[]): Mask => ({
  id,
  name: id,
  kind: "brush",
  enabled: true,
  inverted: false,
  opacity: 1,
  overlayColor: "#ef5350",
  adjustments: { ...DEFAULT_LOCAL_ADJUSTMENTS },
  components: componentIds.map((componentId) => ({
    ...makeMaskComponent("brush"),
    id: componentId,
  })),
});

describe("resolveMaskSelection", () => {
  const masks = [
    makeMask("mask-one", ["component-one", "component-two"]),
    makeMask("mask-last", ["component-last"]),
  ];

  it("preserves the active mask and component when both still exist", () => {
    expect(
      resolveMaskSelection(masks, "mask-one", "component-two"),
    ).toEqual({ maskId: "mask-one", componentId: "component-two" });
  });

  it("falls back to the first component when the remembered component is stale", () => {
    expect(resolveMaskSelection(masks, "mask-one", "missing")).toEqual({
      maskId: "mask-one",
      componentId: "component-one",
    });
  });

  it("selects the last existing mask when no remembered mask is valid", () => {
    expect(resolveMaskSelection(masks, "missing", "component-two")).toEqual({
      maskId: "mask-last",
      componentId: "component-last",
    });
  });

  it("returns an empty selection when the photo has no masks", () => {
    expect(resolveMaskSelection([], null, null)).toEqual({
      maskId: null,
      componentId: null,
    });
  });
});
