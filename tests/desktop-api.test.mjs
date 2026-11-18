import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => {
  vi.resetModules();
  invoke.mockReset();
  vi.stubGlobal("window", {
    __TAURI_INTERNALS__: {},
    location: { origin: "tauri://localhost", protocol: "tauri:" }
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function json(value) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

describe("desktop backend startup", () => {
  it("recovers a missed launch injection through one native request for parallel dashboard calls", async () => {
    invoke.mockResolvedValue([41255, "this-window-token"]);
    const fetch = vi.fn(async (_url, options) => {
      expect(options.headers.get("x-sca-backend-token")).toBe("this-window-token");
      return json({ ready: true });
    });
    vi.stubGlobal("fetch", fetch);
    const { api } = await import("../app/ui/src/lib/api.ts");
    const paths = ["/api/catalog", "/api/state", "/api/system", "/api/jobs"];
    expect(await Promise.all(paths.map((path) => api(path)))).toEqual(paths.map(() => ({ ready: true })));
    expect(invoke).toHaveBeenCalledExactlyOnceWith("backend_config");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(paths.map((path) => `http://127.0.0.1:41255${path}`));
    // A document reload can discard injected globals; the native state survives.
    delete window.__SCA_API_PORT;
    delete window.__SCA_API_TOKEN;
    await api("/api/catalog");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("keeps the configured connection after a transient HTTP failure", async () => {
    window.__SCA_API_PORT = 41255;
    window.__SCA_API_TOKEN = "this-window-token";
    const fetch = vi.fn().mockRejectedValueOnce(new Error("Load failed")).mockResolvedValueOnce(json({ ready: true }));
    vi.stubGlobal("fetch", fetch);
    const { api } = await import("../app/ui/src/lib/api.ts");
    expect(await api("/api/catalog")).toEqual({ ready: true });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:41255/api/catalog", "http://localhost:41255/api/catalog"
    ]);
    expect(window.__SCA_API_PORT).toBe(41255);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports an unavailable native bridge instead of scanning thousands of ports indefinitely", async () => {
    vi.useFakeTimers();
    invoke.mockReturnValue(new Promise(() => {}));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { api } = await import("../app/ui/src/lib/api.ts");
    const result = api("/api/catalog").catch((error) => error);
    await vi.advanceTimersByTimeAsync(3000);
    expect((await result).message).toContain("backend connection details");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not discover or invoke native commands in a browser", async () => {
    delete window.__TAURI_INTERNALS__;
    window.location = { origin: "http://127.0.0.1:5173", protocol: "http:" };
    const fetch = vi.fn(async () => json({ ready: true }));
    vi.stubGlobal("fetch", fetch);
    const { api } = await import("../app/ui/src/lib/api.ts");
    await api("/api/catalog");
    expect(fetch.mock.calls[0][0]).toBe("http://127.0.0.1:5173/api/catalog");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("bounds an unresponsive dashboard request without restarting the timeout on every retry", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    window.__SCA_API_PORT = 41255;
    window.__SCA_API_TOKEN = "this-window-token";
    const fetch = vi.fn(async (_url, options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      throw new DOMException("Timed out", "AbortError");
    });
    vi.stubGlobal("fetch", fetch);
    const { api } = await import("../app/ui/src/lib/api.ts");
    await expect(api("/api/catalog")).rejects.toThrow("timed out or was cancelled");
    expect(timeout).toHaveBeenCalledExactlyOnceWith(15_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
