# Product research notes

Early interaction research used a publicly available walkthrough of Adobe
Lightroom Classic as one reference for established desktop photo-editing
workflows. The reference was the
[Lightroom Classic 2026 walkthrough](https://www.youtube.com/watch?v=KhocKi5a0Ho).

This repository is an independent, local clean-room implementation. Product
names are used only to identify the interface being studied; no Adobe source
code, proprietary assets, camera profiles, or machine-learning models are
included.

## Reference chapters and acceptance surface

| Time | Chapter | Required surface |
| --- | --- | --- |
| 0:36 | Import Process | Three-pane Import workspace; Source rail; Copy as DNG, Copy, Move, and Add method selector; checked contact sheet; File Handling, File Renaming, Apply During Import, and Destination panels; Import/Cancel footer. |
| 2:59 | Develop Tab | Black Classic module bar; Library/Develop modules; Navigator and Presets on the left; image on a neutral-gray matte; histogram, horizontal tool row, stacked inspector, and filmstrip. |
| 5:29 | Basic | Profile, WB, Tone, and Presence groups, neutral diamond slider handles, Auto and B&W actions. |
| 11:33 | Tone Curve | Editable composite RGB curve plus independently editable red, green, and blue channel curves. |
| 13:45 | Color Mixer | Eight-channel Hue/Saturation/Luminance mixer and functional Point Color range adjustments. |
| 17:24 | Color Grading | Shadows, Midtones, and Highlights color wheels with Hue, Saturation, Luminance, Blending, and Balance. |
| 20:52 | Detail | Sharpening Amount/Radius/Detail/Masking; luminance NR Amount/Detail/Contrast; color NR Amount/Detail/Smoothness. |
| 25:01 | Lens Corrections | Profile and Manual views; chromatic aberration and profile toggles; lens profile fields; distortion, vignette, midpoint, and purple/green defringe. |
| 26:25 | Transform | Upright actions and manual Vertical, Horizontal, Rotate, Aspect, Scale, X Offset, and Y Offset controls. |
| 27:15 | Lens Blur | Apply, Amount, bokeh selection, Boost, focal-range visualization, focus placement, and refinement workflow. |
| 29:18 | Camera Calibration | Current process version, Shadows Tint, and Hue/Saturation for red, green, and blue primaries. |
| 32:01 | Crop | Aspect selector, angle/straighten controls, constrained crop, overlay, reset/close, draggable crop frame. |
| 34:02 | Remove | Heal/Clone modes, Size/Feather/Opacity, image spots and sources, removal, and source repositioning. |
| 36:33 | Masking | Subject/Sky/Background/Object/People/Landscape estimates; Brush, Linear, Radial, Color, Luminance, and Depth ranges; Add/Subtract/Intersect; local adjustments and overlay modes. |
| 39:41 | Presets | Grouped preset browser, preview/application, Amount, snapshots, history, and non-destructive reset. |
| 43:45 | Sync Settings | Copy/Paste and multi-photo Synchronize Settings checklist, including the expanded Develop categories. |
| 44:25 | Export Settings | Left preset list and stacked Export Location, File Naming, File Settings, Image Sizing, Output Sharpening, Metadata, Watermarking, and Post-Processing sections. |

## Visual measurements from the reference

- Top module bar: approximately 31 px, near-black.
- Develop left rail: approximately 260 px.
- Develop right rail: approximately 340 px.
- Right histogram: approximately 174 px high.
- Horizontal tool row: approximately 42 px.
- Filmstrip: approximately 60–62 px.
- Develop matte: neutral middle gray; panels use dark graphite with restrained
  one-pixel separators and blue for active/focused state.
- Inspector order is fixed: Basic, Tone Curve, Color Mixer, Color Grading,
  Detail, Lens Corrections, Transform, Lens Blur, Effects, Calibration.
- The module list is Library, Develop, Map, Book, Slideshow, Print, Web. Modules
  outside the browser implementation remain visible so the shell matches, but
  are disabled rather than represented as working.

The tutorial itself contains presenter picture-in-picture, captions, title
cards, and YouTube chrome. Those are video overlays and must never be reproduced
as application UI.

## Current browser architecture and honest native boundaries

The app stores catalog records, local working copies, metadata, and edit recipes
in IndexedDB. It uses a WebGL2 editing pipeline with a Canvas2D fallback and
keeps imported source files untouched. Browser-decodable JPEG, PNG, WebP, GIF,
BMP, and browser-supported TIFF/HEIC files can be edited and exported locally.

Native RAW demosaic, proprietary camera/lens profile databases, 16-bit
wide-gamut output, tethered capture, panorama/HDR merge, map tiles, printing,
and proprietary segmentation/depth models require a native/WASM integration or
licensed data that this clean-room browser build does not contain. Browser-local
features remain functional approximations and must not claim integrations they
do not provide.

## Open-source and licensing notes

- [Open Darkroom](https://github.com/ajzat34/darkroom) has no recognized
  repository license; its code was not copied.
- [RapidRAW](https://github.com/CyberTimon/RapidRAW) is AGPL-3.0 and was not used
  as a code source.
- darktable and RawTherapee documentation may inform generic photo-processing
  concepts, but GPL implementation code is not copied.
