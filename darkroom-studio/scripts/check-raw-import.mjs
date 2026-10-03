/**
 * Real-camera integration check. Start Vite first, then run:
 * PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
 *   node scripts/check-raw-import.mjs /path/to/photo.NEF http://127.0.0.1:4174
 * Playwright is optional test tooling, not an application dependency.
 * Uses an isolated browser context; never accesses your existing catalog.
 */
import assert from "node:assert/strict";
const [fixture, url = "http://127.0.0.1:4174"] = process.argv.slice(2);
if (!fixture) throw new Error("Pass a local RAW fixture path.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(url);
  await page.locator('input[type="file"]').first().setInputFiles(fixture);
  const result = await page.evaluate(async () => {
    const source = document.querySelector('input[type="file"]').files[0];
    const catalog = await import("/src/lib/catalog.ts");
    const raw = await import("/src/lib/rawImage.ts");
    const { ImageEngine } = await import("/src/lib/imageEngine.ts");
    const count = 20;
    const files = Array.from({ length: count }, (_, i) => new File([source], `card-${i}-${source.name}`, { type: source.type }));
    const start = performance.now();
    let firstPhotosMs;
    const imported = await catalog.importFiles(files, { duplicateHandling: "include" }, undefined, {
      onPhotos: () => { firstPhotosMs ??= performance.now() - start; },
    });
    const importMs = performance.now() - start;
    if (imported.rejected.length) throw new Error(JSON.stringify(imported.rejected));
    const hash = async blob => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))).join(",");
    const sourceHash = await hash(source);
    let originalsPreserved = true;
    for (const photo of await catalog.loadPhotos()) {
      if (await hash(photo.blob) !== sourceHash) originalsPreserved = false;
    }
    const duplicate = await catalog.importFiles([source]);
    const photo = imported.photos[0];
    const decodeStart = performance.now();
    const full = await raw.fullRenderBlobForPhoto(photo);
    const fullDecodeMs = performance.now() - decodeStart;
    const bitmap = await createImageBitmap(full);
    const engine = new ImageEngine(document.createElement("canvas"));
    const settings = {
      format: "image/png", quality: 1, resizeMode: "original", longEdge: 2048,
      width: 2048, height: 2048, fileName: "test", includeMetadata: false,
      watermarkEnabled: false, watermarkText: "", watermarkOpacity: 1, watermarkPosition: "center",
    };
    let exported;
    let limitsRejected = false;
    try {
      exported = await createImageBitmap(await engine.export(full, photo.edits, settings));
      try {
        await engine.export(full, photo.edits, { ...settings, resizeMode: "dimensions", width: 100000, height: 100000 });
      } catch (error) { limitsRejected = /rendering limit/.test(error.message); }
    } finally { engine.destroy(); }
    const result = {
      count, imported: imported.photos.length, bytesPerPhoto: source.size,
      importMs, firstPhotosMs, fullDecodeMs, originalsPreserved,
      duplicateSkipped: duplicate.photos.length === 0 && duplicate.rejected.length === 1,
      fullType: full.type, fullWidth: bitmap.width, fullHeight: bitmap.height,
      exportWidth: exported.width, exportHeight: exported.height, limitsRejected,
    };
    bitmap.close(); exported.close();
    return result;
  });
  assert.equal(result.imported, result.count);
  assert.equal(result.originalsPreserved, true);
  assert.equal(result.duplicateSkipped, true);
  assert.equal(result.fullType, "image/png");
  assert.equal(result.exportWidth, result.fullWidth);
  assert.equal(result.exportHeight, result.fullHeight);
  assert.equal(result.limitsRejected, true);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
