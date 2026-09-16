# Darkroom

Darkroom is a free, local-first photo catalog and non-destructive editor for
desktop browsers. It is an independent project and is not affiliated with,
endorsed by, or sponsored by Adobe.

All project files live inside this folder. The app has no filesystem write
handle to imported source photos: it never moves, overwrites, or deletes them.
Browser imports create origin-scoped catalog copies in IndexedDB; exports request
a new file through the browser download flow.

## Run it

Requirements: Node.js 20.19 or newer (or Node.js 22.12+) and a current desktop browser.

```bash
npm install
npm start
```

`npm start` opens the editor in your browser. You can also use `npm run dev` and
open the local URL Vite prints (normally <http://127.0.0.1:4174>). For a
production build:

```bash
npm run build
npm run preview
```

The production build includes a web app manifest and a scope-restricted offline
service worker, so Chromium-based browsers can install it as a standalone app.
For safety, the worker is never registered on localhost or `127.0.0.1`; offline
installation is intended for a dedicated HTTPS deployment origin or subpath.

## What works

- Local IndexedDB catalog with image blobs, previews, metadata, and edit
  instructions, plus JSON backup/restore for catalog metadata and edits
- Review-before-import staging with per-file selection, possible-duplicate
  warnings, album destination, multi-file import, drag-and-drop, Chromium
  folder import, SHA-256 duplicate detection, EXIF readout, and per-file errors
- Local camera RAW import and demosaic for DNG, Canon, Nikon, Sony, Fujifilm,
  Olympus/OM, Panasonic, Pentax, Samsung, and other LibRaw-supported files. The
  exact RAW source and a browser-renderable working image are stored separately.
- Photo Grid, Square Grid, Detail, filmstrip, search, sorting, ratings, flags,
  color labels, keywords in the catalog model, and albums
- WebGL2 editing with Canvas2D fallback
- Exposure, contrast, highlights, shadows, whites, blacks, temperature, tint,
  vibrance, saturation, texture, clarity, dehaze, sharpening, noise reduction,
  vignette, and grain
- Editable composite/red/green/blue tone curves; eight-channel HSL plus Point
  Color; interactive three-way color grading; detailed sharpening
  and noise-reduction groups
- Functional Lens Corrections, Transform, Lens Blur, Effects, and Calibration
  recipes, including local profile/manual correction approximations, focal
  placement, bokeh selection, and RGB primary calibration
- Geometry, rotation, crop presets, draggable crop frame, and ratio locking
- Eight composable mask groups with up to 32 components each. Components include
  Brush, Linear Gradient, Radial Gradient, Luminance Range, and Color Range
- Add, Subtract, and Intersect composition; group/component inversion, opacity,
  enable/delete, rename, duplicate, duplicate-and-invert, five overlay modes,
  brush pressure/flow/density and edge-aware color selection, on-image
  color/luminance sampling, and local tone/color/presence/detail adjustments
- Live mask previews while drawing; gradient movement, resizing, rotation,
  off-image placement, feather handles, Shift constraints, exact numeric values,
  0–200% adjustment amount, local point curves, and local grain controls
- Manual Heal and Clone tools; no AI selection or generative removal controls
- Clone/heal spots with size, feather, opacity, draggable source markers,
  per-spot deletion, and a sixteen-spot preview limit
- Histogram, clipping indicator, before/original preview, zoom, presets,
  named versions, undo/redo history, and keyboard shortcuts
- Cached developed previews throughout Photo Grid, Square Grid, Detail, Filmstrip, and the
  export dialog—edits, crop, masks, and repairs remain visually consistent
- Single or selected-photo batch JPEG, PNG, and WebP export with progress,
  resize, quality, crop, masks, repairs, and text watermark
- Responsive desktop/compact layouts, keyboard focus, and reduced-motion support

## Browser support and honest limits

Chrome or Edge gives the complete browser workflow, including folder selection.
Safari and Firefox can import individual files but do not expose the same folder
API.

The catalog belongs to this browser profile and origin; it is not encrypted or a
replacement for a filesystem backup. The app asks for persistent storage, but the
browser may decline and clearing site data still removes the catalog. Use the
catalog-backup button regularly. Backups contain edit recipes and metadata—not
image pixels—and restore onto matching images already imported in the catalog.
Precise GPS coordinates are deliberately replaced with removal markers in JSON
backups.

This version decodes JPEG, PNG, WebP, GIF, and BMP, plus TIFF/HEIC when the
browser supports them. Camera RAW files are demosaiced locally in a background
LibRaw worker to an 8-bit sRGB working image; the original RAW bytes are kept
unchanged. Files over 48 MB use LibRaw's half-size mode to keep peak browser
memory bounded. RAW support therefore does not claim a native 16-bit linear
pipeline. Older catalogs containing semantic/depth estimates retain their saved
rendering for compatibility, but these tools can no longer be created. There is
no connected AI service. Heal is a luminance-matched clone
approximation. Browser encoders do not preserve EXIF reliably, and very large
exports are bounded by the GPU's texture/viewport limit. Imports are capped at
256 MB per file to avoid exhausting a browser tab.

Those constraints are called out in the interface; originals remain untouched
when a file cannot be decoded or exported.

## Architecture

- React + TypeScript + Vite
- Custom WebGL2 fragment pipeline with a Canvas2D fallback
- IndexedDB catalog and browser persistent-storage request
- `exifr` for metadata
- `libraw-wasm` for local camera RAW decoding in a Web Worker
- `lucide-react` for permissively licensed icons
- No server, account, telemetry, upload, or paid API

The old Open Darkroom code was not reused: it is unmaintained and its repository
does not state a reusable license. This project is a clean-room implementation.
See [docs/PRODUCT_RESEARCH.md](docs/PRODUCT_RESEARCH.md) for the behavioral
research and source list.

## Tests

```bash
npm test
npm run build
```

## Manual masking workflow

Choose **Mask → Add New Mask → Brush, Linear Gradient, or Radial Gradient**.
A new gradient waits for your first drag. Linear gradients fade from full strength
at the start to zero at the end. Move the center pin, drag an outer guide to
change transition width, or use the rotation handle. Radial gradients expose
center, edge, rotation, and feather handles; their proportions remain correct
on rectangular photos. Both gradient types can extend beyond the photograph.

Use **Add**, **Subtract**, or **Intersect** to combine components in one mask.
Each group shares its local adjustments. **Amount** scales the adjustment recipe
from 0–200%; group/component opacity controls selection coverage. Click a slider's
number to enter an exact value, or double-click the slider to reset it. The local
curve and grain controls affect only the combined mask. Brush settings affect
new strokes; Flow builds coverage across strokes and Density limits paint strength.

**O** toggles the overlay; **[ / ]** changes brush size; **Shift [ / ]** changes
feather; **X** switches paint/erase; **Alt/Option** temporarily erases. **Shift**
constrains new gradients and radial resizing. **Escape** cancels the active
gesture, and Undo restores a complete stroke or gradient edit. Adjusting the
local effect hides the overlay so you can judge the photograph.

Behavior references: [TK North's masking walkthrough](https://www.youtube.com/watch?v=xsFMwnSBukU)
and [Adobe's manual masking documentation](https://helpx.adobe.com/lightroom-classic/help/masking.html).
This implementation follows those manual workflows; it does not claim pixel-identical
Adobe processing or complete Lightroom feature parity.

For real-browser renderer checks, run the dev server and open
`/tests/masking.html`. The page renders synthetic images through WebGL and forced
Canvas2D, checks gradient falloff, mask combinations, inversion, amount, local
curves, and PNG export, and reports every assertion in the page. It does not read
or modify the photo catalog and is excluded from the production build.

For repeatable performance measurements, open `/tests/performance.html`. It
exercises a 1200 × 800 preview with 24 saved brush strokes (80 points each),
growing paint/subtract strokes, compound gradient movement, radial rotation,
and exposure changes. The page reports warm median and p95 render times,
including recipe updates, texture uploads, and GPU completion. These are renderer
measurements, not end-to-end input latency; results depend on the device/browser.

Brush rendering retains coverage and processes only newly added dabs. Dirty
regions update single-channel mask textures without rebuilding other masks.
Standalone gradients and base gradients refined with Subtract/Intersect use
direct GPU geometry. Raster caches are bounded; undo, recipe replacement, image
loading, and graphics-context restoration invalidate the affected cache. Preview
revision tokens share immutable subtrees so local sliders do not serialize old
brush strokes on every frame.
