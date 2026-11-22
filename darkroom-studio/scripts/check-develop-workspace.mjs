/**
 * Develop-workspace regression check against either Vite or a production build.
 * PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
 *   node scripts/check-develop-workspace.mjs http://127.0.0.1:4174
 * Optional E2E_SCREENSHOT sets the screenshot destination (default below).
 * Playwright is optional tooling, not an application dependency. All photographs
 * are generated in an isolated browser context; your existing catalog is untouched.
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const url = process.argv[2] || "http://127.0.0.1:4174";
const screenshot = resolve(process.env.E2E_SCREENSHOT || "/tmp/darkroom-develop-e2e.png");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
const page = await context.newPage();
page.setDefaultTimeout(20_000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const checks = [];

async function checkActive(name) {
  await page.locator(`canvas[aria-label="Editing ${name}"]`).waitFor({ state: "visible" });
  await page.waitForFunction((expected) => {
    const frames = document.querySelectorAll('.filmstrip [aria-current="true"]');
    if (frames.length !== 1) return false;
    const frame = frames[0];
    const rail = frame.closest(".filmstrip__rail");
    if (!rail || frame.getAttribute("aria-label") !== expected || frame.getAttribute("aria-selected") !== "true") return false;
    const imageBounds = frame.getBoundingClientRect();
    const railBounds = rail.getBoundingClientRect();
    return imageBounds.left >= railBounds.left - 1 && imageBounds.right <= railBounds.right + 1;
  }, name);
  assert.equal(await page.locator(".filmstrip__filename").textContent(), name);
}

async function savedEdits(name) {
  return page.evaluate((photoName) => new Promise((resolve, reject) => {
    const request = indexedDB.open("darkroom-catalog");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction("photos", "readonly").objectStore("photos").getAll();
      read.onerror = () => { database.close(); reject(read.error); };
      read.onsuccess = () => {
        const photo = read.result.find((candidate) => candidate.name === photoName);
        database.close();
        resolve(photo ? { profile: photo.edits.profile, exposure: photo.edits.global.exposure } : null);
      };
    };
  }), name);
}

async function expectSaved(name, expected) {
  const deadline = Date.now() + 15_000;
  let actual;
  do {
    actual = await savedEdits(name);
    if (actual && Object.entries(expected).every(([key, value]) => actual[key] === value)) return actual;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.deepEqual(actual, expected, `Saved adjustments for ${name}`);
}

try {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.locator(".blocking-status").waitFor({ state: "hidden" });
  const dismissReminder = page.getByRole("button", { name: "Dismiss GitHub reminder", exact: true });
  if (await dismissReminder.isVisible()) await dismissReminder.click();
  const fixtures = await page.evaluate(() => Array.from({ length: 40 }, (_, index) => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 400;
    const ctx = canvas.getContext("2d");
    const sky = ctx.createLinearGradient(0, 0, 0, 400);
    sky.addColorStop(0, `hsl(${205 + index}, 32%, 40%)`);
    sky.addColorStop(0.65, `hsl(${25 + index}, 54%, 74%)`);
    sky.addColorStop(1, "#19313b");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, 640, 400);
    for (let ridge = 0; ridge < 3; ridge++) {
      ctx.fillStyle = ["#65808b", "#3b5664", "#213844"][ridge];
      ctx.beginPath();
      ctx.moveTo(0, 400);
      for (let x = 0; x <= 640; x += 40) {
        ctx.lineTo(x, 180 + ridge * 53 + Math.sin(x / 67 + index / 8 + ridge) * 45);
      }
      ctx.lineTo(640, 400);
      ctx.fill();
    }
    ctx.fillStyle = "#fff";
    ctx.font = "16px sans-serif";
    ctx.fillText(`Photograph ${index + 1}`, 24, 370);
    return {
      name: `photo-${String(index + 1).padStart(3, "0")}.png`,
      data: canvas.toDataURL("image/png").split(",")[1],
    };
  }));
  await page.locator('input[type="file"]').first().setInputFiles(fixtures.map(({ name, data }) => ({
    name, mimeType: "image/png", buffer: Buffer.from(data, "base64"),
  })));
  await page.getByRole("dialog", { name: "Import Photos" }).getByRole("button", { name: "Import", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".photo-card").length === 40, null, { timeout: 60_000 });
  assert.equal(await page.locator(".filmstrip__frame").count(), 40);
  checks.push("Imported 40 distinct generated photographs through the import dialog");

  await page.getByLabel("Sort photos").selectOption("name-asc");
  await page.locator(".photo-card").filter({ has: page.getByAltText("photo-033.png", { exact: true }) }).dblclick();
  await checkActive("photo-033.png");
  assert.ok(await page.locator(".filmstrip__rail").evaluate((rail) => rail.scrollLeft > 0));
  checks.push("Opening a distant library photograph selects and reveals the matching filmstrip frame");

  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.locator(".filmstrip__rail").evaluate((rail) => { rail.scrollLeft = 0; });
  await page.getByRole("button", { name: "Develop", exact: true }).click();
  await checkActive("photo-033.png");
  checks.push("Entering Develop restores visibility after manually scrolling away in Library");

  await page.locator('.filmstrip [aria-current="true"]').press("ArrowRight");
  await checkActive("photo-034.png");
  checks.push("Keyboard navigation updates the main image and selected filmstrip frame together");

  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Set 5 star rating", exact: true }).click();
  await page.getByLabel("Sort photos").selectOption("rating-desc");
  await page.waitForFunction(() => document.querySelector(".filmstrip__frame")?.getAttribute("aria-label") === "photo-034.png");
  await page.getByRole("button", { name: "Develop", exact: true }).click();
  await checkActive("photo-034.png");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByLabel("Sort photos").selectOption("name-asc");
  await page.getByLabel("Search photos").fill("photo-03");
  await page.waitForFunction(() => document.querySelectorAll(".filmstrip__frame").length === 10);
  await page.locator(".photo-card").filter({ has: page.getByAltText("photo-039.png", { exact: true }) }).dblclick();
  await checkActive("photo-039.png");
  checks.push("Sorting, rating-based reordering and filtering preserve the current photograph");

  const selectionModifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.locator('.filmstrip [aria-label="photo-038.png"]').click({ modifiers: [selectionModifier] });
  await checkActive("photo-038.png");
  await page.locator('.filmstrip [aria-label="photo-037.png"]').click({ modifiers: [selectionModifier] });
  await checkActive("photo-037.png");
  await page.locator('.filmstrip [aria-label="photo-038.png"]').click({ modifiers: [selectionModifier] });
  await checkActive("photo-037.png");
  await page.locator('.filmstrip [aria-label="photo-037.png"]').click({ modifiers: [selectionModifier] });
  await checkActive("photo-039.png");
  checks.push("Deselecting a nonactive frame preserves the active image; deselecting the active frame selects another");

  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByLabel("Search photos").fill("photo-001.png");
  await page.waitForFunction(() => document.querySelectorAll(".filmstrip__frame").length === 1);
  await page.getByRole("button", { name: "Develop", exact: true }).click();
  await checkActive("photo-001.png");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByLabel("Search photos").fill("photo-03");
  await page.locator(".photo-card").filter({ has: page.getByAltText("photo-039.png", { exact: true }) }).dblclick();
  await checkActive("photo-039.png");
  checks.push("Filtering out the previous selection still selects the photograph when entering Develop");

  const left = page.getByRole("complementary", { name: "Navigator and presets" });
  const right = page.getByRole("complementary", { name: "Develop adjustments" });
  const profileNames = ["Color", "Vivid", "Portrait", "Landscape", "Monochrome"].map((suffix) => `Darkroom ${suffix}`);
  for (const name of profileNames) {
    assert.equal(await left.getByRole("button", { name: new RegExp(`^${name}\\b`) }).count(), 1);
    assert.equal(await right.getByRole("button", { name: new RegExp(`^${name}\\b`) }).count(), 0);
  }
  assert.equal(await right.getByRole("button", { name: "Presets", exact: true }).count(), 0);
  assert.equal(await page.getByRole("combobox", { name: "Profile", exact: true }).count(), 0);
  assert.equal(await page.locator('select').evaluateAll((elements) => elements.filter((select) =>
    Array.from(select.options).some((option) => option.text === "Darkroom Landscape")).length), 0);
  checks.push("All five color profiles are left-side presets, with no right-side presets or profile selector");

  await right.getByRole("button", { name: "Set Exposure value", exact: true }).click();
  await right.getByRole("spinbutton", { name: "Exposure value", exact: true }).fill("1.25");
  await right.getByRole("spinbutton", { name: "Exposure value", exact: true }).press("Enter");
  await expectSaved("photo-039.png", { profile: "Darkroom Color", exposure: 1.25 });
  await left.getByRole("button", { name: /^Darkroom Landscape\b/ }).click();
  await expectSaved("photo-039.png", { profile: "Darkroom Landscape", exposure: 1.25 });
  assert.equal(await right.getByRole("slider", { name: "Exposure", exact: true }).inputValue(), "1.25");
  assert.equal(await left.getByRole("slider", { name: "Preset amount", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expectSaved("photo-039.png", { profile: "Darkroom Color", exposure: 1.25 });
  assert.equal(await left.getByRole("button", { name: /^Darkroom Color\b/ }).getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expectSaved("photo-039.png", { profile: "Darkroom Landscape", exposure: 1.25 });
  assert.equal(await left.getByRole("button", { name: /^Darkroom Landscape\b/ }).getAttribute("aria-pressed"), "true");
  checks.push("Applying a profile preserves manual exposure and supports Undo/Redo");

  await right.getByRole("button", { name: "B&W", exact: true }).click();
  await expectSaved("photo-039.png", { profile: "Darkroom Monochrome", exposure: 1.25 });
  assert.equal(await left.getByRole("button", { name: /^Darkroom Monochrome\b/ }).getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expectSaved("photo-039.png", { profile: "Darkroom Landscape", exposure: 1.25 });
  assert.equal(await left.getByRole("button", { name: /^Darkroom Landscape\b/ }).getAttribute("aria-pressed"), "true");
  checks.push("Basic B&W and Undo keep the left preset selection synchronized");

  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".blocking-status").waitFor({ state: "hidden" });
  await page.getByLabel("Search photos").fill("photo-039.png");
  await page.locator(".photo-card").filter({ has: page.getByAltText("photo-039.png", { exact: true }) }).dblclick();
  await checkActive("photo-039.png");
  await expectSaved("photo-039.png", { profile: "Darkroom Landscape", exposure: 1.25 });
  assert.equal(await right.getByRole("slider", { name: "Exposure", exact: true }).inputValue(), "1.25");
  assert.equal(await left.getByRole("button", { name: /^Darkroom Landscape\b/ }).getAttribute("aria-pressed"), "true");
  checks.push("The profile and manual adjustments survive a full page reload");

  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByLabel("Search photos").fill("");
  await page.waitForFunction(() => document.querySelectorAll(".filmstrip__frame").length === 40);
  await page.getByRole("button", { name: "Develop", exact: true }).click();
  await checkActive("photo-039.png");
  await page.setViewportSize({ width: 1180, height: 820 });
  await checkActive("photo-039.png");
  await page.setViewportSize({ width: 1512, height: 982 });
  await checkActive("photo-039.png");
  const layout = await page.evaluate(() => {
    const bounds = (selector) => {
      const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      left: bounds(".left-sidebar"), center: bounds(".workspace-center"),
      right: bounds(".right-inspector"), rail: bounds(".filmstrip__rail"),
      viewport: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  assert.ok(layout.left.x + layout.left.width <= layout.center.x + 1);
  assert.ok(layout.center.x + layout.center.width <= layout.right.x + 1);
  assert.ok(layout.rail.width > layout.viewport * 0.95, "Develop filmstrip should span the full workspace");
  assert.equal(layout.overflow, false);
  checks.push("Three-panel layout and full-width filmstrip remain synchronized after resizing");
  await mkdir(dirname(screenshot), { recursive: true });
  await page.screenshot({ path: screenshot, fullPage: true });
  assert.deepEqual(errors, [], "Unexpected browser errors");
  console.log(JSON.stringify({ url, checks, layout, screenshot, browserErrors: errors }, null, 2));
} catch (error) {
  await mkdir(dirname(screenshot), { recursive: true });
  await page.screenshot({ path: screenshot.replace(/\.png$/, "-failure.png"), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ completedChecks: checks, browserErrors: errors }, null, 2));
  throw error;
} finally {
  await context.close();
  await browser.close();
}
