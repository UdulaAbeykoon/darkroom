import { createRoot } from "react-dom/client";
import App from "../src/App";
import { deletePhotos, importFiles, initializeCatalog, loadPhotos } from "../src/lib/catalog";
import type { PhotoRecord } from "../src/types";
import { getImportGroups } from "../src/lib/importHistory";
import "../src/styles.css";
import "../src/theme.css";

const prefix = "__import_history_check__";
const status = document.querySelector<HTMLElement>("#status")!;
const results = document.querySelector<HTMLOListElement>("#results")!;
const rootElement = document.querySelector<HTMLElement>("#root")!;
let root = createRoot(rootElement);

function report(message: string) {
  const result = document.createElement("li");
  result.className = "pass";
  result.textContent = message;
  results.append(result);
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
  report(message);
}
async function until(predicate: () => unknown, label: string) {
  const deadline = performance.now() + 8000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
function button(text: string) {
  const result = [...rootElement.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.textContent?.trim() === text);
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}
function cards() { return [...rootElement.querySelectorAll<HTMLElement>(".photo-card")]; }
async function file(name: string, color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 96; canvas.height = 64;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color; context.fillRect(0, 0, 96, 64);
  context.fillStyle = "#eee"; context.fillText(name, 4, 30);
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
  return new File([blob], `${prefix}${name}.png`, {type: "image/png"});
}
async function storedPhotos(): Promise<PhotoRecord[]> {
  const database = await initializeCatalog();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("photos", "readonly");
    const request = transaction.objectStore("photos").getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function mount() {
  root.render(<App />);
  await until(() => !rootElement.querySelector(".blocking-status") && rootElement.querySelector(".library-toolbar"), "catalog opened");
}
async function run() {
  // Keep this destructive fixture workflow on a dedicated local test origin.
  if (!["127.0.0.1", "localhost"].includes(location.hostname) || location.port !== "4190") {
    throw new Error("Run with npm run dev -- --port 4190 --strictPort on a dedicated local test origin.");
  }
  const database = await initializeCatalog();
  const existing = await loadPhotos();
  if (existing.some((photo) => !photo.name.startsWith(prefix))) {
    throw new Error("Refusing to modify a catalog containing non-fixture photos.");
  }
  await deletePhotos(existing.map((photo) => photo.id));
  const first = await importFiles(await Promise.all([file("first-a", "#46637c"), file("first-b", "#486744"), file("first-c", "#845547")]));
  const second = await importFiles([await file("second", "#866b36")]);
  const old = await importFiles([await file("legacy", "#655080")]);
  // Seed a pre-batch record in the guarded fixture database, retaining real pixels.
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("photos", "readwrite");
    const store = transaction.objectStore("photos");
    const request = store.get(old.photos[0].id);
    request.onsuccess = () => {
      const record = request.result;
      delete record.importBatch;
      record.importedAt = "2025-01-14T12:00:00.000Z";
      store.put(record);
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  check(first.photos.length === 3 && second.photos.length === 1, "Real image imports succeeded");
  const groups = getImportGroups(await loadPhotos());
  check(groups.length === 3 && groups.some((group) => group.legacy), "Separate imports and older catalog records retain distinct groups");
  await mount();
  await until(() => cards().length === 5, "five photos visible");
  const disclosure = rootElement.querySelector<HTMLButtonElement>('[aria-expanded][aria-controls="previous-imports-list"]')
    ?? [...rootElement.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes("Previous Imports"))!;
  if (disclosure.getAttribute("aria-expanded") !== "true") disclosure.click();
  await until(() => rootElement.querySelectorAll(".import-history__group").length === 3, "import history expanded");
  report("Expandable history includes both batches and legacy photos");
  const rows = [...rootElement.querySelectorAll<HTMLElement>(".import-history__group")];
  const firstGroup = rows.find((row) => row.querySelector("small")?.textContent === "3 photos")!;
  firstGroup.querySelector<HTMLButtonElement>("button")!.click();
  await until(() => cards().length === 3, "batch page filtered");
  check(cards().every((card) => card.textContent?.includes("first-")), "Batch navigation contains only that import's photos");
  firstGroup.querySelector<HTMLButtonElement>("button")!.click();
  await until(() => cards().some((card) => card.tabIndex === 0), "same source keeps active photo");
  report("Reopening the active batch preserves keyboard navigation");
  cards()[0].click();
  cards()[2].dispatchEvent(new MouseEvent("click", {bubbles:true, shiftKey:true}));
  await until(() => rootElement.querySelectorAll('.photo-card[aria-selected="true"]').length === 3, "range selected");
  report("Shift-click selects a photo range");
  button("Delete selected (3)…").click();
  await until(() => rootElement.querySelector('[role="dialog"]'), "delete confirmation");
  check(rootElement.querySelector('[role="dialog"]')!.textContent?.includes("original files on disk stay untouched"), "Confirmation states cache scope and preserves originals");
  button("Cancel").click();
  await until(() => !rootElement.querySelector('[role="dialog"]'), "cancelled");
  check((await storedPhotos()).length === 5, "Cancel leaves every stored photo intact");
  cards()[0].click();
  cards()[1].dispatchEvent(new MouseEvent("click", {bubbles:true, ctrlKey:true}));
  await until(() => rootElement.querySelectorAll('.photo-card[aria-selected="true"]').length === 2, "multiple selected");
  button("Delete selected (2)…").click();
  await until(() => rootElement.querySelector('[role="dialog"]'), "bulk confirmation");
  button("Delete 2 photos").click();
  await until(() => !rootElement.querySelector('[role="dialog"]') && cards().length === 1, "bulk delete finished");
  check((await storedPhotos()).length === 3, "Bulk deletion removes only selected stored records");
  const activeRow = rootElement.querySelector<HTMLElement>(".import-history__group.is-active")!;
  activeRow.dispatchEvent(new MouseEvent("contextmenu", {bubbles:true, clientX:100, clientY:220}));
  await until(() => document.querySelector('[role="menu"]'), "right-click menu");
  report("Right-click exposes the import deletion menu");
  (document.querySelector('[role="menuitem"]') as HTMLElement).click();
  await until(() => rootElement.querySelector('[role="dialog"]'), "batch confirmation");
  button("Delete 1 photo").click();
  await until(() => !rootElement.querySelector('[role="dialog"]') && cards().length === 2, "batch deleted");
  const remaining = await storedPhotos();
  check(!remaining.some((photo) => first.photos.some((item) => item.id === photo.id)), "Deleting a batch removes all of its remaining photos");
  check(getImportGroups(remaining).length === 2, "Deleted batches disappear while other imports remain");
  root.unmount(); root = createRoot(rootElement);
  await mount();
  await until(() => cards().length === 2, "remounted persisted catalog");
  report("Fresh app mount reloads only surviving photos from IndexedDB");
  button("Select all").click();
  await until(() => rootElement.querySelectorAll('.photo-card[aria-selected="true"]').length === 2, "select all");
  button("Delete selected (2)…").click();
  await until(() => rootElement.querySelector('[role="dialog"]'), "final confirmation");
  button("Delete 2 photos").click();
  await until(() => !rootElement.querySelector('[role="dialog"]') && !!rootElement.querySelector(".empty-library"), "empty catalog");
  check((await storedPhotos()).length === 0, "Select all and delete empties the catalog without leaving phantom imports");
  status.textContent = "PASS — import history browser checks";
}
run().catch((error) => {
  status.textContent = "FAIL — import history browser checks";
  const item = document.createElement("li"); item.className = "fail";
  item.textContent = error instanceof Error ? error.message : String(error); results.append(item);
  console.error(error);
});
