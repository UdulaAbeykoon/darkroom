import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // LibRaw's pthread-enabled WASM build must stay out of dependency
  // pre-bundling so its worker and WASM URLs remain package-relative.
  optimizeDeps: {
    exclude: ["libraw-wasm"],
  },
  server: {
    host: "127.0.0.1",
    port: 4174,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4174,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
