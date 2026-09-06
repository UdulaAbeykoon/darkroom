# Darkroom

Darkroom is a free, local-first photo catalog and non-destructive editor that
runs in a desktop browser. Imported photographs remain on the device; the app
has no server, account system, telemetry, upload service, or paid API.

The application source lives in [`darkroom-studio`](darkroom-studio). See the
[application README](darkroom-studio/README.md) for features, browser support,
architecture, setup, and known limitations.

## Development

Requirements: Node.js 20.19 or newer (or Node.js 22.12+) and a current desktop
browser.

```bash
cd darkroom-studio
npm install
npm start
```

Run the verification suite with:

```bash
npm test
npm run build
```

## License

Darkroom is available under the [MIT License](LICENSE). Third-party software
retains its original licensing; see [Third-party notices](THIRD_PARTY_NOTICES.md).

Adobe and Lightroom are trademarks of Adobe. Darkroom is an independent
project and is not affiliated with, endorsed by, or sponsored by Adobe.
