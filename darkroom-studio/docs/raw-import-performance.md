# RAW import performance and quality

Import stores the exact original, a browsing preview, a small thumbnail, metadata,
and the SHA-256 signature. It no longer develops every sensor pixel just to add a
photo to the library. This is especially important for an entire SD card.

## Implementation

- A bounded TIFF reader extracts the largest usable embedded JPEG using Blob
  range reads. It follows standard IFD, SubIFD and EXIF offsets, handles both byte
  orders, preserves orientation without JPEG recompression, and limits directory
  counts, array sizes and preview ranges. It works with standard TIFF-based NEFs;
  other layouts fall back to LibRaw's embedded preview API.
- Missing or corrupt previews fall back to full decoding. Original bytes and
  whole-file SHA-256 duplicate detection remain unchanged. Hashing still reads
  the complete original; metadata-only or sampled hashes are not substituted.
- Original copies are committed per photo and read back from IndexedDB before
  display, so the active UI does not retain an SD-card File as its only source.
  UI batches arrive every eight photos or 250 ms, whichever comes first at a
  completed file. Import reports stage, filename, saved/skipped counts, byte
  counts and elapsed time. Stop finishes the current file. Storage exhaustion
  stops the batch instead of reading the rest of a card that cannot be saved.
- Develop and edited thumbnails decode the original on demand. Full decodes are
  serialized to bound WASM memory use, concurrent requests share their decode,
  and only one full decoded result is cached. Unedited browsing uses the camera
  preview and may initially differ from LibRaw's rendering. Decoder dimensions
  replace provisional TIFF dimensions when opening Develop.
- Full decoding keeps the same camera white balance, matrix and demosaic quality,
  removes the previous >48 MiB half-size switch, and uses lossless PNG instead of
  a 96%-quality intermediate JPEG. Legacy JPEG proxies are also bypassed on export.
- Export refuses silent GPU/browser downscaling. Unsupported Nikon HE/HE* RAWs
  can be browsed using their camera JPEG but cannot silently export that JPEG
  as developed RAW. The original-download option bypasses all rendering and
  preserves the original filename, bytes, metadata and sensor bit depth.

## Quality boundary

Rendered editing/export still uses **8-bit sRGB**, as before. PNG preserves those
rendered pixels losslessly; JPEG/WebP obey the user's quality setting. This is
not a new 16-bit/HDR RAW pipeline. Download unchanged originals to preserve all
original sensor data. The 50 MP decoded-pixel and 256 MiB input safety limits
remain; oversized rendered exports now report a limit rather than quietly shrink.
Nikon HE/HE* full sensor decoding remains unsupported by this WASM decoder.

## Measurements and validation (2026-10-03)

Headless Chromium on the development Mac, 20 repetitions of the public
[Nikon D90 fixture](https://github.com/f-spot/raw-samples/blob/master/NEF/RAW_NIKON_D90.NEF),
11,008,655 bytes each, duplicates explicitly included, cached local File data and
an isolated browser catalog. Baseline: `origin/main` at `ed07147`.

| Measurement | Baseline | New path |
| --- | ---: | ---: |
| Import 20 NEFs, including hash/metadata/storage/thumbnail work | 16,440.71 ms | 685.73 ms |
| First committed UI batch | At batch completion | 277.80 ms |
| Imported / rejected | 20 / 0 | 20 / 0 |

This fixture import is **23.98× faster**. It is not a physical SD-card benchmark
or a prediction for every camera. Card bandwidth, browser storage, camera layout,
preview size and lack of embedded previews affect results. Full development work
is deferred until needed, not eliminated. A 4310×2868 original-size PNG export
also passed; portrait previews decoded at 2848×4288 after orientation.

Automated regressions cover TIFF byte orders, orientation, cyclic/truncated
structures, bounded reads, unchanged JPEG payloads, decode cleanup/retry,
concurrent decode coalescing, legacy/full source routing, no half-size decoding,
lossless intermediate pixels, HE export rejection, original persistence,
renamed duplicates, partial failure, cancellation, quota exhaustion, and corrupt
preview fallback. Browser UI checks covered import, reload, Develop, and an
unchanged-original download with SHA-256
`56fab62c37d10905654583307e551e0de3ccf66aa3d663197be05b4c5193b733`.

Run `npm test` and `npm run build`. For a real-camera integration check, start
Vite and run `scripts/check-raw-import.mjs` as documented in that script with a
local fixture and an available Playwright module. Fixtures are not bundled.
The script checks every stored original, duplicate detection, full-size PNG
export and rejection of impossible export dimensions.

## Why not Rust first?

The expensive decoder already runs compiled C++ in WebAssembly and a worker:
[LibRaw-Wasm](https://github.com/ybouane/LibRaw-Wasm). LibRaw exposes
[separate preview extraction and full processing APIs](https://www.libraw.org/docs/API-CXX.html),
with different [allocation lifetimes](https://www.libraw.org/docs/API-notes.html).
Avoiding unnecessary demosaics, full-frame conversions and JPEG encoding during
import addresses the observed bottleneck without introducing a second RAW
implementation or changing demosaic quality. A Rust/native desktop backend could
be evaluated later for streaming hashes, direct filesystem catalogs and a true
16-bit rendering pipeline; this change makes no unsupported speed claim for it.
