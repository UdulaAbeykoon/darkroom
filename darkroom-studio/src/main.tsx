import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { RETIRED_STUDIO_NAMESPACE } from "./lib/retiredIdentity";
import "./components/ExportDialog.css";
import "./components/ImportDialog.css";
import "./styles.css";
import "./theme.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

const serviceWorkerHostname = window.location.hostname.toLowerCase();
const isLocalServiceWorkerHost =
  serviceWorkerHostname === "localhost" ||
  serviceWorkerHostname.endsWith(".localhost") ||
  /^127(?:\.\d{1,3}){3}$/.test(serviceWorkerHostname) ||
  serviceWorkerHostname === "::1" ||
  serviceWorkerHostname === "[::1]";
const appBaseUrl = new URL(import.meta.env.BASE_URL, window.location.origin);

async function cleanLegacyLocalWorker(): Promise<void> {
  const expectedWorkerUrl = new URL("./sw.js", appBaseUrl).href;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(
    registrations
      .filter((registration) =>
        [
          registration.active,
          registration.waiting,
          registration.installing,
        ].some((worker) => worker?.scriptURL === expectedWorkerUrl),
      )
      .map((registration) => registration.unregister()),
  );
  if ("caches" in window) {
    const keys = await caches.keys();
    const encodedScope = encodeURIComponent(appBaseUrl.pathname);
    const currentNamespace = `darkroom-studio-${encodedScope}-`;
    const retiredNamespace = `${RETIRED_STUDIO_NAMESPACE}-${encodedScope}-`;
    const retiredGlobalNames = new Set([
      `${RETIRED_STUDIO_NAMESPACE}-v1`,
      `${RETIRED_STUDIO_NAMESPACE}-app-v2`,
    ]);
    await Promise.all(
      keys
        .filter((key) =>
          key.startsWith(currentNamespace) ||
          key.startsWith(retiredNamespace) ||
          retiredGlobalNames.has(key),
        )
        .map((key) => caches.delete(key)),
    );
  }
}

if (
  import.meta.env.PROD &&
  !isLocalServiceWorkerHost &&
  "serviceWorker" in navigator
) {
  window.addEventListener("load", () => {
    const serviceWorkerUrl = new URL("./sw.js", appBaseUrl);
    void navigator.serviceWorker
      .register(serviceWorkerUrl.href, { scope: appBaseUrl.pathname })
      .catch((error: unknown) => {
        console.warn("Darkroom service worker registration failed.", error);
      });
  });
} else if (isLocalServiceWorkerHost && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void cleanLegacyLocalWorker().catch((error: unknown) => {
      console.warn("Darkroom legacy service-worker cleanup failed.", error);
    });
  });
}
