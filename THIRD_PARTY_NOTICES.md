# Third-party notices

Darkroom is distributed under the MIT License. Its npm dependencies retain
their own licenses, as recorded in `darkroom-studio/package-lock.json` and the
packages' published license files.

## LibRaw WASM

Darkroom uses `libraw-wasm` 1.6.0 for local camera RAW decoding.

- The JavaScript wrapper is copyright its authors and distributed under the
  ISC License: <https://github.com/ybouane/LibRaw-Wasm>
- The bundled LibRaw decoder is copyright LibRaw LLC and other contributors.
  Darkroom elects to use and distribute it under the Common Development and
  Distribution License 1.0 (CDDL-1.0):
  <https://opensource.org/license/cddl-1-0>
- LibRaw source and licensing information are available from
  <https://github.com/LibRaw/LibRaw> and <https://www.libraw.org/about>.

Darkroom does not modify the bundled LibRaw decoder. RAW decoding runs locally;
selected photographs are not uploaded by the application.

## Other direct dependencies

- `exifr` — MIT License
- `lucide-react` — ISC License
- `react` and `react-dom` — MIT License

The corresponding source repositories and complete dependency tree are linked
from the package metadata and lockfile.

## Project artwork

The Darkroom name treatment and application icons in `darkroom-studio/public`
are original project assets and are distributed under the repository's MIT
License.
