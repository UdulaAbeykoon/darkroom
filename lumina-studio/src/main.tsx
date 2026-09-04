import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

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
    await Promise.all(
      keys
        .filter((key) => key.startsWith("lumina-studio-"))
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
        console.warn("Lumina service worker registration failed.", error);
      });
  });
} else if (isLocalServiceWorkerHost && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void cleanLegacyLocalWorker().catch((error: unknown) => {
      console.warn("Lumina legacy service-worker cleanup failed.", error);
    });
  });
}
