/**
 * Real UI import/edit/export checks in a fresh browser catalog.
 * PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
 * RAW_EXPECTED_DIMENSIONS=6048x4032 \
 *   node scripts/check-photo-quality.mjs /path/to/photo.NEF http://127.0.0.1:4175
 * Add --preview-only=/path/to/unsupported-compression.NEF to verify that its
 * exact original remains downloadable while full-quality rendered export fails.
 * For multiple RAWs, RAW_EXPECTED_DIMENSIONS may be a JSON object mapping each
 * basename to [width, height]. Supply independently verified full dimensions.
 * QUALITY_OUTPUT_DIR defaults to /tmp/darkroom-photo-quality. Downloads, a
 * screenshot and a JSON report remain there. No application source imports,
 * existing browser profile, external image service, or added dependency is used.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2);
const url = args.find((arg) => /^https?:\/\//.test(arg)) || "http://127.0.0.1:4175";
const rawPaths = args.filter((arg) => !/^https?:\/\//.test(arg) && !arg.startsWith("--preview-only=")).map((path) => resolve(path));
const previewPaths = args.filter((arg) => arg.startsWith("--preview-only=")).map((arg) => resolve(arg.slice("--preview-only=".length)));
assert.ok(rawPaths.length + previewPaths.length, "Pass at least one real camera RAW fixture path.");
const expectedInput = process.env.RAW_EXPECTED_DIMENSIONS || "";
const expectedDimensions = /^\d+x\d+$/.test(expectedInput)
  ? { [basename(rawPaths[0])]: expectedInput.split("x").map(Number) }
  : expectedInput ? JSON.parse(expectedInput) : {};
for (const path of rawPaths) assert.ok(expectedDimensions[basename(path)]?.length === 2,
  `Supply independently verified full dimensions for ${basename(path)} in RAW_EXPECTED_DIMENSIONS.`);
const outputDir = resolve(process.env.QUALITY_OUTPUT_DIR || "/tmp/darkroom-photo-quality");
await mkdir(outputDir, { recursive: true });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const rawFixtures = await Promise.all([...rawPaths, ...previewPaths].map(async (path) => {
  const buffer = await readFile(path);
  return { path, name: basename(path), buffer, sha256: sha256(buffer), dimensions: expectedDimensions[basename(path)], previewOnly: previewPaths.includes(path) };
}));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true,
  args: process.env.QUALITY_CHROMIUM_ARGS ? JSON.parse(process.env.QUALITY_CHROMIUM_ARGS) : [] });
const context = await browser.newContext({ viewport: { width: 1512, height: 982 }, acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(30_000);
const browserErrors = [];
const consoleErrors = [];
page.on("pageerror", (error) => browserErrors.push(error.message));
page.on("crash", () => { browserErrors.push("Browser page crashed"); console.error("BROWSER: page crashed"); });
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
const checks = [];
const metrics = { raw: [], synthetic: {} };
const completed = (message) => {
  checks.push(message);
  console.log(`PASS: ${message}`);
  writeFileSync(join(outputDir, "progress.json"), JSON.stringify({ url, checks, metrics, browserErrors }, null, 2));
};
let inspectionContext;
let inspectionPage;
let downloadIndex = 0;

async function storedPhoto(name) {
  return page.evaluate((name) => new Promise((resolve, reject) => {
    const request = indexedDB.open("darkroom-catalog");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction("photos", "readonly").objectStore("photos").getAll();
      read.onerror = () => { db.close(); reject(read.error); };
      read.onsuccess = () => {
        const photo = read.result.find((item) => item.name === name);
        db.close();
        resolve(photo ? { id: photo.id, name: photo.name, width: photo.width, height: photo.height,
          edits: photo.edits, count: read.result.length, originalBytes: photo.blob.size,
          renderBytes: photo.renderBlob?.size ?? null, renderType: photo.renderBlob?.type ?? null,
          renderKind: photo.renderKind ?? null } : null);
      };
    };
  }), name);
}

async function waitStored(name, predicate, message) {
  const deadline = Date.now() + 30_000;
  let photo;
  do {
    photo = await storedPhoto(name);
    if (photo && predicate(photo)) return photo;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(photo)}`);
}

async function openPhoto(name) {
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByLabel("Search photos").fill(name);
  await page.locator(".photo-card").filter({ has: page.getByAltText(name, { exact: true }) }).dblclick();
  await page.locator(`canvas[aria-label="Editing ${name}"]`).waitFor({ state: "visible" });
  await page.locator(".canvas-loading").waitFor({ state: "hidden" });
  const active = page.locator('.filmstrip [aria-current="true"]');
  assert.equal(await active.getAttribute("aria-label"), name);
  assert.equal(await active.getAttribute("aria-selected"), "true");
}

async function setAdjustment(label, value) {
  const right = page.getByRole("complementary", { name: "Develop adjustments" });
  await right.getByRole("button", { name: `Set ${label} value`, exact: true }).click();
  const input = right.getByRole("spinbutton", { name: `${label} value`, exact: true });
  await input.fill(String(value));
  await input.press("Enter");
}

async function takeDownload(action, label) {
  const start = performance.now();
  console.log(`START: ${label}`);
  const exportFailure = page.locator(".toast--error").filter({ hasText: /export.*failed/i }).last();
  await exportFailure.waitFor({ state: "hidden" });
  let monitoring = true;
  const failed = (async () => {
    while (monitoring) {
      if (await exportFailure.isVisible()) {
        const message = await exportFailure.textContent();
        await page.screenshot({ path: join(outputDir, "export-failure.png"), fullPage: true });
        throw new Error(`Export rejected for ${label}: ${message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  })();
  void failed.catch(() => {});
  let download;
  try {
    [download] = await Promise.all([
      Promise.race([page.waitForEvent("download", { timeout: 180_000 }), failed]),
      action(),
    ]);
  } finally { monitoring = false; }
  const suggestedFilename = download.suggestedFilename();
  const path = join(outputDir, `${String(++downloadIndex).padStart(2, "0")}-${basename(suggestedFilename)}`);
  await download.saveAs(path);
  assert.equal(await download.failure(), null, `${label}: browser download completed`);
  const buffer = await readFile(path);
  assert.ok(buffer.length > 0, `${label}: nonempty download`);
  const mime = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png" : buffer[0] === 0xff && buffer[1] === 0xd8 ? "image/jpeg"
      : buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP" ? "image/webp"
        : "application/octet-stream";
  const artifact = { path, suggestedFilename, bytes: buffer.length, sha256: sha256(buffer), mime,
    downloadMs: Math.round(performance.now() - start) };
  return artifact;
}

async function downloadOriginal(name, via = "export") {
  if (via === "context-menu") {
    await page.locator(`.filmstrip [aria-label="${name}"]`).click({ button: "right" });
    return takeDownload(() => page.getByRole("menuitem", { name: "Download Original…", exact: true }).click(), `Original ${name}`);
  }
  const dialog = await openExport();
  await dialog.getByLabel("Image Format:", { exact: false }).selectOption("original");
  const result = await takeDownload(() => dialog.getByRole("button", { name: "Export", exact: true }).click(), `Original ${name}`);
  await dialog.waitFor({ state: "hidden" });
  return result;
}

async function openExport() {
  await page.locator('.filmstrip [aria-current="true"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Export…(?:\s|$)/ }).click();
  const dialog = page.getByRole("dialog", { name: "Export One File", exact: true });
  await dialog.waitFor();
  return dialog;
}

async function exportImage(format, fileName, sizing = null) {
  const dialog = await openExport();
  await dialog.getByLabel("Image Format:", { exact: false }).selectOption(format);
  await dialog.getByLabel("Rename To:", { exact: true }).fill(fileName);
  if (format !== "image/png") {
    await dialog.getByRole("slider", { name: /^Quality:/ }).press("End");
    assert.equal(await dialog.getByRole("slider", { name: /^Quality:/ }).inputValue(), "100");
  }
  await dialog.getByRole("checkbox", { name: "Resize to Fit:", exact: true }).setChecked(Boolean(sizing));
  if (sizing) {
    await dialog.getByLabel("Resize method", { exact: true }).selectOption(sizing.mode);
    if (sizing.mode === "long-edge") await dialog.getByLabel("Long Edge:", { exact: false }).fill(String(sizing.longEdge));
    else {
      await dialog.getByLabel("W:", { exact: true }).fill(String(sizing.width));
      await dialog.getByLabel("H:", { exact: true }).fill(String(sizing.height));
    }
  }
  await dialog.getByRole("checkbox", { name: "Add a text watermark", exact: true }).uncheck();
  const result = await takeDownload(() => dialog.getByRole("button", { name: "Export", exact: true }).click(), fileName);
  await dialog.waitFor({ state: "hidden", timeout: 180_000 });
  assert.equal(result.mime, format, `${fileName}: file signature matches requested encoding`);
  return result;
}

async function inspectImage(artifact) {
  if (!inspectionPage) {
    inspectionContext = await browser.newContext();
    inspectionPage = await inspectionContext.newPage();
    await inspectionPage.setContent('<input type="file" aria-label="Inspect downloaded image">');
  }
  // Large D850 PNGs can exceed 90 MB. A native file input avoids encoding the
  // entire download into a base64 CDP response and keeps inspection outside
  // the app renderer/catalog. Only the small sampled pixels cross the protocol.
  await inspectionPage.getByLabel("Inspect downloaded image").setInputFiles(artifact.path);
  const decoded = await inspectionPage.evaluate(async () => {
    const input = document.querySelector("input");
    const blob = input.files[0];
    const bitmap = await createImageBitmap(blob);
    const width = bitmap.width, height = bitmap.height;
    const canvas = document.createElement("canvas");
    canvas.width = 128; canvas.height = 128;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, 128, 128);
    bitmap.close();
    const rgba = ctx.getImageData(0, 0, 128, 128).data;
    canvas.width = 1; canvas.height = 1;
    input.value = "";
    const rgb = [];
    let sum = 0, sumSquares = 0, minimum = 255, maximum = 0, opaque = 0;
    for (let index = 0; index < rgba.length; index += 4) {
      const luminance = 0.2126 * rgba[index] + 0.7152 * rgba[index + 1] + 0.0722 * rgba[index + 2];
      rgb.push(rgba[index], rgba[index + 1], rgba[index + 2]);
      sum += luminance; sumSquares += luminance * luminance;
      minimum = Math.min(minimum, luminance); maximum = Math.max(maximum, luminance);
      if (rgba[index + 3] === 255) opaque++;
    }
    const count = rgba.length / 4;
    return { width, height, sampleSize: [128, 128], meanLuminance: sum / count,
      luminanceStdDev: Math.sqrt(Math.max(0, sumSquares / count - (sum / count) ** 2)),
      minimumLuminance: minimum, maximumLuminance: maximum, opaqueFraction: opaque / count, rgb };
  });
  assert.ok(decoded.width > 0 && decoded.height > 0);
  assert.ok(decoded.luminanceStdDev > 0, `${artifact.suggestedFilename}: image contains visible variation`);
  assert.ok(decoded.maximumLuminance > decoded.minimumLuminance);
  assert.equal(decoded.opaqueFraction, 1, `${artifact.suggestedFilename}: export is opaque`);
  return { ...artifact, ...decoded };
}

function imageDifference(a, b) {
  assert.equal(a.rgb.length, b.rgb.length);
  let absolute = 0, maximum = 0, changed = 0;
  for (let index = 0; index < a.rgb.length; index++) {
    const difference = Math.abs(a.rgb[index] - b.rgb[index]);
    absolute += difference; maximum = Math.max(maximum, difference);
    if (difference) changed++;
  }
  return { meanAbsoluteChannelDifference: absolute / a.rgb.length, maximumChannelDifference: maximum,
    changedChannelFraction: changed / a.rgb.length, comparison: "128×128 decoded RGB samples, values 0–255" };
}

function reportImage(image) {
  const { rgb, ...report } = image;
  return report;
}

try {
  await page.goto(url, { waitUntil: "networkidle" });
  metrics.browser = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return { webgl2: false };
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const result = { webgl2: true, maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxViewport: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS)),
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return result;
  });
  console.log(`BROWSER: ${JSON.stringify(metrics.browser)}`);
  await page.locator(".blocking-status").waitFor({ state: "hidden" });
  const reminder = page.getByRole("button", { name: "Dismiss GitHub reminder", exact: true });
  if (await reminder.isVisible()) await reminder.click();
  const synthetic = await page.evaluate(() => [
    { name: "quality-landscape.png", width: 1600, height: 1000, type: "image/png" },
    { name: "quality-portrait.png", width: 800, height: 1200, type: "image/png" },
    { name: "quality-square.jpg", width: 1200, height: 1200, type: "image/jpeg" },
  ].map((fixture, fixtureIndex) => {
    const canvas = document.createElement("canvas");
    canvas.width = fixture.width; canvas.height = fixture.height;
    const ctx = canvas.getContext("2d");
    const gradient = ctx.createLinearGradient(0, 0, fixture.width, fixture.height);
    gradient.addColorStop(0, "#27354e"); gradient.addColorStop(0.5, "#8c7b63"); gradient.addColorStop(1, "#c4bf9b");
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, fixture.width, fixture.height);
    for (let y = 0; y < fixture.height; y += 50) for (let x = 0; x < fixture.width; x += 50) {
      ctx.fillStyle = `rgba(${(x + fixtureIndex * 45) % 255},${y % 255},130,0.32)`;
      ctx.fillRect(x, y, 25, 25);
    }
    ctx.strokeStyle = "#eee"; ctx.lineWidth = 1;
    for (let x = 0; x < fixture.width; x += 13) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + fixture.width / 3, fixture.height); ctx.stroke();
    }
    ctx.fillStyle = "#202020"; ctx.font = "36px sans-serif";
    ctx.fillText(`${fixture.width} × ${fixture.height}`, 45, 65);
    // Asymmetric corner markers make an inverted WebGL readback observable.
    ctx.fillStyle = "#d03030"; ctx.fillRect(0, 0, fixture.width * 0.15, fixture.height * 0.15);
    ctx.fillStyle = "#3050d0"; ctx.fillRect(0, fixture.height * 0.85, fixture.width * 0.15, fixture.height * 0.15);
    return { ...fixture, data: canvas.toDataURL(fixture.type, 1).split(",")[1] };
  }));
  const syntheticBuffers = synthetic.map((fixture) => ({ ...fixture, buffer: Buffer.from(fixture.data, "base64") }));
  const fixtureDir = join(outputDir, "fixtures");
  await mkdir(fixtureDir, { recursive: true });
  const syntheticPaths = await Promise.all(syntheticBuffers.map(async (fixture) => {
    const path = join(fixtureDir, fixture.name);
    await writeFile(path, fixture.buffer);
    return path;
  }));
  const importPaths = [...rawFixtures.map((fixture) => fixture.path), ...syntheticPaths];
  await page.locator('input[type="file"]').first().setInputFiles(importPaths);
  const importStart = performance.now();
  await page.getByRole("dialog", { name: "Import Photos", exact: true }).getByRole("button", { name: "Import", exact: true }).click();
  await page.waitForFunction((count) => document.querySelectorAll(".photo-card").length === count,
    importPaths.length, { timeout: 180_000 });
  metrics.importMs = Math.round(performance.now() - importStart);
  completed(`Imported ${rawFixtures.length} real RAW and ${synthetic.length} mixed-orientation JPEG/PNG photographs through the UI`);

  // A renamed duplicate bypasses filename-based warnings and exercises the
  // content fingerprint, while all mutations still go through the import UI.
  const duplicatePath = join(fixtureDir, `duplicate-${rawFixtures[0].name}`);
  await writeFile(duplicatePath, rawFixtures[0].buffer);
  await page.locator('input[type="file"]').first().setInputFiles(duplicatePath);
  await page.getByRole("dialog", { name: "Import Photos", exact: true }).getByRole("button", { name: "Import", exact: true }).click();
  const duplicateDialog = page.getByRole("dialog", { name: "Some files were not imported", exact: true });
  await duplicateDialog.waitFor({ timeout: 180_000 });
  assert.match(await duplicateDialog.textContent(), /already in the catalog/i);
  await duplicateDialog.getByRole("button", { name: "Done", exact: true }).click();
  assert.equal((await storedPhoto(rawFixtures[0].name)).count, importPaths.length);
  completed("A renamed byte-identical RAW is rejected without creating another catalog record");

  for (const fixture of rawFixtures) {
    await openPhoto(fixture.name);
    const original = await downloadOriginal(fixture.name);
    assert.equal(original.sha256, fixture.sha256);
    assert.equal(original.bytes, fixture.buffer.length);
    assert.equal(original.suggestedFilename, fixture.name);
    const rawMetric = { fixture: fixture.name, sourceBytes: fixture.buffer.length, sourceSha256: fixture.sha256,
      expectedFullDimensions: fixture.dimensions ?? null, previewOnly: fixture.previewOnly,
      original, catalog: await storedPhoto(fixture.name) };
    if (!fixture.previewOnly) {
      assert.equal(rawMetric.catalog.renderType, "image/png", "Supported RAW working images are stored losslessly");
      assert.equal(rawMetric.catalog.renderKind, "full-resolution", "Supported RAW import is a complete decode");
      assert.deepEqual([rawMetric.catalog.width, rawMetric.catalog.height], fixture.dimensions,
        "Persisted RAW catalog dimensions match the independently verified sensor dimensions");
    }
    metrics.raw.push(rawMetric);
    writeFileSync(join(outputDir, "progress.json"), JSON.stringify({ url, checks, metrics, browserErrors, consoleErrors }, null, 2));
    if (fixture.previewOnly) {
      const catalog = await storedPhoto(fixture.name);
      assert.equal(catalog.renderKind, "camera-jpeg");
      assert.equal(await page.locator(".canvas-toolbar").getByText(/camera.*preview/i).isVisible(), true,
        "Unsupported RAW preview is visibly identified in Develop");
      const dialog = await openExport();
      await dialog.getByLabel("Image Format:", { exact: false }).selectOption("image/png");
      const unsupportedDownloads = [];
      const recordDownload = (download) => unsupportedDownloads.push(download.suggestedFilename());
      page.on("download", recordDownload);
      await dialog.getByRole("button", { name: "Export", exact: true }).click();
      const errorToast = page.locator(".toast--error").filter({ hasText: /export.*failed/i }).last();
      await errorToast.waitFor({ timeout: 180_000 });
      const errorMessage = await errorToast.textContent();
      assert.equal(await dialog.isVisible(), true, "Failed export remains open for retry as Original");
      page.off("download", recordDownload);
      assert.deepEqual(unsupportedDownloads, [], "Unsupported RAW compression cannot silently export the embedded preview");
      assert.match(errorMessage, /RAW|compression|preview|decode/i);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      Object.assign(rawMetric, { catalog, renderedExportError: errorMessage });
      completed(`${fixture.name}: unsupported compression keeps an exact downloadable original and rejects rendered PNG without a preview fallback`);
      continue;
    }
    const base = fixture.name.replace(/\.[^.]+$/, "");
    const baseline = await inspectImage(await exportImage("image/png", `${base}-baseline-full`));
    const jpeg = await inspectImage(await exportImage("image/jpeg", `${base}-jpeg100-full`));
    console.log(`MEASURE: ${fixture.name} PNG ${baseline.width}×${baseline.height}, JPEG100 ${jpeg.width}×${jpeg.height}`);
    for (const image of [baseline, jpeg]) assert.deepEqual([image.width, image.height], fixture.dimensions,
      `${fixture.name}: full export must preserve independently verified full RAW dimensions`);
    const jpegDifference = imageDifference(baseline, jpeg);
    await setAdjustment("Exposure", 0.7);
    await waitStored(fixture.name, (photo) => photo.edits.global.exposure === 0.7, "RAW exposure persisted");
    const edited = await inspectImage(await exportImage("image/png", `${base}-edited-full`));
    assert.deepEqual([edited.width, edited.height], fixture.dimensions);
    const editDifference = imageDifference(baseline, edited);
    assert.ok(editDifference.changedChannelFraction > 0, "Exposure changes the exported image pixels");
    assert.ok(edited.meanLuminance > baseline.meanLuminance, "Positive exposure brightens the RAW export");
    const originalAfterEdit = await downloadOriginal(fixture.name, "context-menu");
    assert.equal(originalAfterEdit.sha256, fixture.sha256, "Edits cannot modify downloaded original bytes");
    assert.equal(sha256(await readFile(fixture.path)), fixture.sha256, "Source file remains untouched");
    Object.assign(rawMetric, { originalAfterEdit,
      baselinePng: reportImage(baseline), jpeg100: reportImage(jpeg), jpegVersusPng: jpegDifference,
      editedPng: reportImage(edited), exposureDifference: editDifference, catalog: await storedPhoto(fixture.name) });
    completed(`${fixture.name}: exact originals before/after edits, full-resolution PNG/JPEG100, and measurable exposure rendering`);
  }

  const name = "quality-landscape.png";
  await openPhoto(name);
  const baseline = await inspectImage(await exportImage("image/png", "chart-baseline-full"));
  assert.deepEqual([baseline.width, baseline.height], [1600, 1000]);
  const topMarker = (13 * 128 + 2) * 3;
  const bottomMarker = (115 * 128 + 2) * 3;
  assert.ok(baseline.rgb[topMarker] > baseline.rgb[topMarker + 2], "Red marker stays at the top of the exported image");
  assert.ok(baseline.rgb[bottomMarker + 2] > baseline.rgb[bottomMarker], "Blue marker stays at the bottom of the exported image");
  completed("Known top-red and bottom-blue markers retain their orientation in the PNG export");
  await setAdjustment("Exposure", 0.3);
  await page.getByRole("complementary", { name: "Navigator and presets" })
    .getByRole("button", { name: /^Darkroom Landscape\b/ }).click();
  await waitStored(name, (photo) => photo.edits.profile === "Darkroom Landscape" && photo.edits.global.exposure === 0.3,
    "Preset preserves the exposure adjustment");
  const right = page.getByRole("complementary", { name: "Develop adjustments" });
  await right.getByRole("button", { name: "Crop", exact: true }).click();
  await right.getByLabel("Aspect", { exact: false }).selectOption({ label: "1 × 1" });
  await waitStored(name, (photo) => photo.edits.crop.aspect === "1 × 1", "Square crop persisted");
  await right.getByRole("button", { name: "Mask", exact: true }).click();
  await right.getByRole("button", { name: "Linear Gradient", exact: true }).click();
  const stage = await page.locator(".canvas-stage").boundingBox();
  assert.ok(stage);
  await page.mouse.move(stage.x + stage.width * 0.5, stage.y + stage.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width * 0.5, stage.y + stage.height * 0.65, { steps: 10 });
  await page.mouse.up();
  await setAdjustment("Exposure", -0.6);
  const editedState = await waitStored(name, (photo) => photo.edits.masks.length === 1 &&
    photo.edits.masks[0].adjustments.exposure === -0.6 && photo.edits.masks[0].components?.[0]?.placed,
  "Placed gradient and local adjustment persisted");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await waitStored(name, (photo) => photo.edits.masks[0].adjustments.exposure === 0, "Undo restores local exposure");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await waitStored(name, (photo) => photo.edits.masks[0].adjustments.exposure === -0.6, "Redo reapplies local exposure");
  const cropped = await inspectImage(await exportImage("image/png", "chart-crop-mask-full"));
  assert.deepEqual([cropped.width, cropped.height], [1000, 1000], "Crop exports full remaining pixels without resizing");
  assert.ok(imageDifference(baseline, cropped).changedChannelFraction > 0);
  completed("Preset, exact exposure, square crop, drawn gradient mask and Undo/Redo render into full-size PNG pixels");

  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".blocking-status").waitFor({ state: "hidden" });
  await openPhoto(name);
  assert.deepEqual((await storedPhoto(name)).edits, editedState.edits, "All non-destructive edits survive reload");
  const afterReload = await inspectImage(await exportImage("image/png", "chart-after-reload"));
  assert.deepEqual([afterReload.width, afterReload.height], [1000, 1000]);
  assert.deepEqual(afterReload.rgb, cropped.rgb, "Reload preserves identical decoded export pixels");
  const original = await downloadOriginal(name);
  assert.equal(original.sha256, sha256(syntheticBuffers.find((fixture) => fixture.name === name).buffer));
  const resized = await inspectImage(await exportImage("image/jpeg", "chart-512-jpeg100", { mode: "long-edge", longEdge: 512 }));
  assert.deepEqual([resized.width, resized.height], [512, 512], "Explicit requested resize is honored");
  metrics.synthetic = { baseline: reportImage(baseline), cropped: reportImage(cropped),
    afterReload: reportImage(afterReload), resized: reportImage(resized), original, edits: editedState.edits };
  completed("Reload preserves edit recipes and exported pixels; Original remains exact; explicit 512-pixel JPEG100 resize is honored");

  const oversized = await openExport();
  await oversized.getByLabel("Image Format:", { exact: false }).selectOption("image/png");
  await oversized.getByRole("checkbox", { name: "Resize to Fit:", exact: true }).check();
  await oversized.getByLabel("Resize method", { exact: true }).selectOption("dimensions");
  await oversized.getByLabel("W:", { exact: true }).fill("32000");
  await oversized.getByLabel("H:", { exact: true }).fill("32000");
  const unexpectedDownloads = [];
  const recordUnexpectedDownload = (download) => unexpectedDownloads.push(download.suggestedFilename());
  page.on("download", recordUnexpectedDownload);
  await oversized.getByRole("button", { name: "Export", exact: true }).click();
  const limitError = page.locator(".toast--error").filter({ hasText: /rendering limit/i });
  await limitError.waitFor();
  metrics.renderingLimitMessage = await limitError.textContent();
  assert.equal(await oversized.isVisible(), true, "Limit error keeps export settings available for correction");
  page.off("download", recordUnexpectedDownload);
  assert.deepEqual(unexpectedDownloads, [], "An unsupported size must fail explicitly, never download a silently reduced image");
  assert.match(metrics.renderingLimitMessage, /No reduced-resolution file was created/i);
  await oversized.getByRole("button", { name: "Cancel", exact: true }).click();
  completed("An unsupported 32000×32000 export reports its rendering limit without downloading a silently resized file");

  await right.getByRole("button", { name: "Edit", exact: true }).click();
  await page.screenshot({ path: join(outputDir, "quality-workflow.png"), fullPage: true });
  assert.deepEqual(browserErrors, [], "Unexpected browser exceptions");
  const report = { url, checks, metrics, browserErrors, consoleErrors, outputDir };
  await writeFile(join(outputDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ url, checks, browser: metrics.browser,
    raw: metrics.raw.map((item) => ({ fixture: item.fixture, sourceBytes: item.sourceBytes,
      sourceSha256: item.sourceSha256, expectedFullDimensions: item.expectedFullDimensions,
      originalSha256: item.original.sha256, baselinePng: item.baselinePng,
      jpeg100: item.jpeg100, jpegVersusPng: item.jpegVersusPng,
      exposureDifference: item.exposureDifference, renderedExportError: item.renderedExportError })),
    synthetic: { cropDimensions: metrics.synthetic.cropped && [metrics.synthetic.cropped.width, metrics.synthetic.cropped.height],
      cropSha256: metrics.synthetic.cropped?.sha256, reloadedSha256: metrics.synthetic.afterReload?.sha256 },
    browserErrors, consoleErrors, reportPath: join(outputDir, "report.json") }, null, 2));
} catch (error) {
  await page.screenshot({ path: join(outputDir, "failure.png"), fullPage: true }).catch(() => {});
  await writeFile(join(outputDir, "failure.json"), JSON.stringify({ url, checks, metrics, browserErrors, consoleErrors,
    error: String(error), stack: error.stack }, null, 2));
  console.error(JSON.stringify({ completedChecks: checks, browserErrors, error: String(error), outputDir }, null, 2));
  throw error;
} finally {
  await inspectionContext?.close().catch(() => {});
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}
