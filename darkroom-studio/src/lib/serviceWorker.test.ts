import { describe, expect, it, vi } from "vitest";
import workerSource from "../../public/sw.js?raw";

describe("service-worker cache ownership", () => {
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
    const current = `darkroom-studio-${encodedScope}-app-v4`;
    const staleCurrent = `darkroom-studio-${encodedScope}-app-v3`;
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
