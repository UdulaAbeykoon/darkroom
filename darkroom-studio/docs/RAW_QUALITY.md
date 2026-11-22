# RAW quality and Lightroom comparison

Audited on 2026-11-22 using public camera files and isolated Chromium catalogs.
The Lightroom comparison is based on Adobe documentation, not a pixel comparison
against exports made by Lightroom.

## What “lossless” means here

Darkroom stores the imported file separately from working pixels and edit recipes.
**Original file** exports those exact bytes, including embedded metadata, without
applying edits. It does not generate an Adobe XMP sidecar; catalog backup preserves
Darkroom edit recipes separately.

Supported RAW files are demosaiced at full resolution into an **8-bit sRGB PNG**.
PNG avoids an additional lossy JPEG generation. It does not preserve the RAW
sensor bit depth, recover clipped channels, or provide wide-gamut RAW editing.
Edited PNG export is lossless relative to the rendered pixels, not the sensor data.
JPEG at quality 100 is still lossy.

Previously, working images used JPEG quality 96, RAW files over 48 MiB were decoded
at half size, Develop loaded at most 4096 pixels per side, and unsupported export
dimensions could silently shrink. The quality changes remove those paths. Old
RAW working images are rebuilt from the preserved original when opened in Develop
or exported. Zoom allocates enough preview pixels for display density and zoom,
within the browser's allocation limits.

The audit also reproduced Chromium shrinking an 8288 × 5520 default WebGL drawing
buffer to 7057 × 4700 despite a 16384-pixel GPU dimension limit. Edited exports now
render into an explicitly sized texture framebuffer, validate allocation/readback,
and preserve row orientation. The D850 exported at the full 8288 × 5520 dimensions.
Ordinary zoom previews reconcile their actual allocated buffer with their viewport
so browser memory limits do not clip the image or misalign crop/pointer coordinates.

Nikon high-efficiency NEFs that the decoder cannot demosaic are marked **Camera
JPEG preview**. Edited export is blocked instead of presenting that embedded JPEG
as full-quality RAW output. Original export remains exact.

## Comparison

| Area | Darkroom | Lightroom Classic |
| --- | --- | --- |
| Original RAW | Preserved separately; exact Original download | Non-destructive catalog; Original RAW export with metadata changes in a sidecar |
| Working color | 8-bit sRGB working image | Develop previews use ProPhoto RGB |
| Best current edited export | Full-size 8-bit PNG; JPEG preset uses quality 100 | 16-bit TIFF/PNG and selectable, tagged output color spaces |
| Rendered metadata | Source metadata omitted | Export metadata controls |
| Output sharpening | Existing Develop sharpening | Additional output sharpening for screen and print |
| Limits | 256 MB import, 50 MP RAW decode, 64 MP export, GPU-dependent dimensions | Different desktop processing and export limits |

Adobe documents [non-destructive catalogs](https://helpx.adobe.com/lightroom-classic/desktop/manage-catalogs-and-files/lightroom-catalog-basics.html),
[Develop color management](https://helpx.adobe.com/lightroom-classic/desktop/workspace/color-management.html),
and [export formats, bit depth, color profiles, sharpening, and metadata](https://helpx.adobe.com/lightroom-classic/desktop/export-photos/export-files-disk-or-cd.html).
Its [external editing guidance](https://helpx.adobe.com/lightroom-classic/desktop/work-with-external-editors/external-editing-preferences.html)
recommends 16-bit ProPhoto RGB for retaining color detail between editors.

For archiving, keep the original NEF. For the best edited output currently available
in Darkroom, use full-size PNG. A high-bit-depth, color-managed RAW processing and
export pipeline remains a separate architectural improvement; changing only the
output file extension or encoder bit depth would not recover already-quantized data.

## Reproducible browser checks

`scripts/check-photo-quality.mjs` imports through the UI into a new browser context.
It compares original-download SHA-256 hashes, inspects decoded PNG/JPEG dimensions,
checks real exposure changes, and exercises crop, masks, undo/redo, reload, resizing,
duplicate detection, and oversized-export rejection. It saves downloads, a screenshot,
progress checkpoints, and a JSON report. It never reads the user's browser catalog.

Fixtures are CC0 records from [raw.pixls.us](https://raw.pixls.us/). Full decoder
dimensions include sensor margins and can differ from the camera's active crop.

| Fixture | Source bytes | Full decoder dimensions | SHA-256 |
| --- | ---: | --- | --- |
| [Nikon D750, lossless 14-bit](https://raw.pixls.us/data/Nikon/D750/lossless_compressed_14_bit.NEF) | 26,336,302 | 6032 × 4032 | `f90deb2819863f5a6ca9913c255fdd83a94963f4284eb88df9d389da7a6c7665` |
| [Nikon D850, lossless 14-bit](https://raw.pixls.us/data/Nikon/D850/Nikon-D850-14bit-lossless-compressed.NEF) | 55,196,715 | 8288 × 5520 | `0c9438258ddae5260b9f5a1aace6658a723f1cb1acace3a6cb507116dc6da4f2` |
| [Nikon Z8, high efficiency](https://raw.pixls.us/data/Nikon/Z%208/Nikon_Z8_high_efficiency_low.NEF) | 24,384,512 | Preview-only; exact Original export | `82df041542b8d328738443bb5ff3373b396e406ecc8cbe7dc3b35252790c53e7` |

Save them locally with the names used below, then run against a development server
or served production build:

```bash
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
RAW_EXPECTED_DIMENSIONS='{"nikon-d750-14bit.NEF":[6032,4032],"nikon-d850-14bit.NEF":[8288,5520]}' \
QUALITY_OUTPUT_DIR=/tmp/darkroom-photo-quality \
node scripts/check-photo-quality.mjs \
  /path/to/nikon-d750-14bit.NEF \
  /path/to/nikon-d850-14bit.NEF \
  --preview-only=/path/to/nikon-z8-he.NEF \
  http://127.0.0.1:4175
```

The harness records GPU limits. Chromium's default headless SwiftShader renderer
can expose an 8192-pixel texture limit, which cannot hold the D850's 8288-pixel
source. On a supported Mac, set `QUALITY_CHROMIUM_ARGS='["--use-angle=metal"]'`
to test the native GPU. An unsupported GPU must produce an explicit error;
a smaller file is not a passing full-resolution result.

JPEG-versus-PNG pixel differences in the report measure encoder differences on
sampled rendered pixels. They are not a perceptual quality score, a comparison
against the original sensor samples, or evidence of Lightroom rendering parity.
