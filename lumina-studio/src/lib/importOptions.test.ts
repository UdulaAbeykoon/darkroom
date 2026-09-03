import { describe, expect, it } from "vitest";

import {
  normalizeImportKeywords,
  normalizeImportOptions,
} from "./catalog";

describe("import option normalization", () => {
  it("uses safe Lightroom-style import defaults", () => {
    expect(normalizeImportOptions()).toEqual({
      method: "add",
      duplicateHandling: "skip",
      keywords: [],
      collectionId: null,
    });
  });

  it("trims and de-duplicates imported keywords case-insensitively", () => {
    expect(
      normalizeImportKeywords([
        "  Toronto street  ",
        "PORTRAIT",
        "portrait",
        "night   light",
        "",
      ]),
    ).toEqual(["Toronto street", "PORTRAIT", "night light"]);
  });

  it("preserves an explicit copy and duplicate-inclusion request", () => {
    expect(
      normalizeImportOptions({
        method: "copy",
        duplicateHandling: "include",
        keywords: [" travel ", "Travel", "2026"],
        collectionId: "  collection-toronto  ",
      }),
    ).toEqual({
      method: "copy",
      duplicateHandling: "include",
      keywords: ["travel", "2026"],
      collectionId: "collection-toronto",
    });
  });
});
