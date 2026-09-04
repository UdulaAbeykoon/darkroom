import { describe, expect, it, vi } from "vitest";
import workerSource from "../../public/sw.js?raw";

describe("service-worker cache ownership", () => {
  it("pre-caches every Darkroom application icon", async () => {
    const listeners = new Map<string, (event: { waitUntil: (value: Promise<unknown>) => void }) => void>();
    const addAll = vi.fn(async () => undefined);
    const open = vi.fn(async () => ({ addAll }));
    const skipWaiting = vi.fn(async () => undefined);
    const worker = {
      registration: { scope: "https://example.test/app/" },
      clients: { claim: vi.fn(async () => undefined) },
      skipWaiting,
      addEventListener: (
        name: string,
        listener: (event: { waitUntil: (value: Promise<unknown>) => void }) => void,
      ) => listeners.set(name, listener),
    };
    const cacheStorage = {
      keys: vi.fn(async () => []),
      delete: vi.fn(async () => true),
      open,
    };
    new Function("self", "caches", "fetch", workerSource)(
      worker,
      cacheStorage,
      vi.fn(),
    );

    let completion = Promise.resolve();
    listeners.get("install")?.({
      waitUntil: (value) => {
        completion = value.then(() => undefined);
      },
    });
    await completion;

    expect(open).toHaveBeenCalledWith("darkroom-studio-%2Fapp%2F-app-v5");
    expect(addAll).toHaveBeenCalledWith([
      "https://example.test/app/",
      "https://example.test/app/manifest.webmanifest",
      "https://example.test/app/icon.svg",
      "https://example.test/app/icon-monochrome.svg",
      "https://example.test/app/icon-192.png",
      "https://example.test/app/icon-512.png",
      "https://example.test/app/icon-maskable-192.png",
      "https://example.test/app/icon-maskable-512.png",
      "https://example.test/app/favicon-32.png",
      "https://example.test/app/apple-touch-icon.png",
    ]);
    expect(skipWaiting).toHaveBeenCalledOnce();
  });

  it("deletes only current and exact retired app caches", async () => {
    const listeners = new Map<string, (event: { waitUntil: (value: Promise<unknown>) => void }) => void>();
    const claim = vi.fn(async () => undefined);
    const worker = {
      registration: { scope: "https://example.test/app/" },
      clients: { claim },
      skipWaiting: vi.fn(async () => undefined),
      addEventListener: (
        name: string,
        listener: (event: { waitUntil: (value: Promise<unknown>) => void }) => void,
      ) => listeners.set(name, listener),
    };
    const retiredPrefix = `${atob("bHVtaW5hLXN0dWRpby0=")}`;
    const encodedScope = encodeURIComponent("/app/");
    const current = `darkroom-studio-${encodedScope}-app-v5`;
    const staleCurrent = `darkroom-studio-${encodedScope}-app-v4`;
    const retiredScoped = `${retiredPrefix}${encodedScope}-app-v4`;
    const retiredGlobal = `${retiredPrefix}app-v2`;
    const unrelated = "shared-app-v1";
    const deleted: string[] = [];
    const cacheStorage = {
      keys: async () => [
        current,
        staleCurrent,
        retiredScoped,
        retiredGlobal,
        unrelated,
      ],
      delete: async (key: string) => {
        deleted.push(key);
        return true;
      },
      open: vi.fn(),
    };
    new Function("self", "caches", "fetch", workerSource)(
      worker,
      cacheStorage,
      vi.fn(),
    );

    let completion = Promise.resolve();
    listeners.get("activate")?.({
      waitUntil: (value) => {
        completion = value.then(() => undefined);
      },
    });
    await completion;

    expect(deleted.sort()).toEqual(
      [staleCurrent, retiredScoped, retiredGlobal].sort(),
    );
    expect(deleted).not.toContain(unrelated);
    expect(deleted).not.toContain(current);
    expect(claim).toHaveBeenCalledOnce();
  });
});
