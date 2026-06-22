import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureLibrary, openState } from "../app/backend/state.mjs";
import net from "node:net";
import { ollamaInstallPlan, refreshModels } from "../app/backend/models.mjs";
import { askOllama, assertOllamaMemoryAllowed, detectRuntime, ensureOllamaRuntimePermissions, findAvailablePort, KIWIX_PORT, KIWIX_PORT_COUNT, LOCAL_STATIC_PORT, LOCAL_STATIC_PORT_COUNT, resolveRuntime, runtimeCandidates, serviceStatus, startOllama, stopService } from "../app/backend/services.mjs";
import { estimateModelRamBytes, parseDarwinVmStat, recommendAi } from "../app/backend/system.mjs";

let root;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sca-services-"));
  await ensureLibrary(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("services", () => {
  it("records kiwix and ollama availability without requiring them", async () => {
    const db = openState(root);
    const services = await serviceStatus(db);
    expect(services.map((service) => service.name).sort()).toEqual(["kiwix", "ollama"]);
    expect(["available", "missing", "running"]).toContain(services[0].status);
    stopService(db, "kiwix");
    const stopped = db.prepare("SELECT * FROM services WHERE name='kiwix'").get();
    expect(stopped.status).toBe("stopped");
    db.close();
  });

  it("detects bundled Kiwix resources when SCA_KIWIX_DIR is set", async () => {
    const old = process.env.SCA_KIWIX_DIR;
    const bin = path.join(root, "kiwix");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "kiwix-serve"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.SCA_KIWIX_DIR = bin;
    expect(await detectRuntime("kiwix-serve")).toBe(true);
    if (old === undefined) delete process.env.SCA_KIWIX_DIR;
    else process.env.SCA_KIWIX_DIR = old;
  });

  it("resolves Kiwix resource binaries with Windows executable names", () => {
    const env = {
      SCA_KIWIX_DIR: "C:\\Offline Survival\\resources\\kiwix",
      SCA_SIDECAR_DIR: "C:\\Offline Survival\\bin"
    };
    expect(runtimeCandidates("kiwix-serve", { platform: "win32", env, home: "C:\\Users\\Test" })).toEqual(expect.arrayContaining([
      "C:\\Offline Survival\\resources\\kiwix/kiwix-serve.exe",
      "C:\\Offline Survival\\bin/kiwix-serve.exe",
      "kiwix-serve.exe"
    ]));
  });

  it("knows common Ollama install locations on every supported OS", () => {
    const home = path.join(root, "home");
    const env = {
      SCA_OLLAMA_BIN: path.join(root, "managed", "ollama"),
      LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local"
    };
    expect(runtimeCandidates("ollama", { platform: "darwin", home, env })).toEqual(expect.arrayContaining([
      path.join(home, "Applications", "Ollama.app", "Contents", "Resources", "ollama"),
      "/Applications/Ollama.app/Contents/Resources/ollama",
      "/opt/homebrew/bin/ollama"
    ]));
    expect(runtimeCandidates("ollama", { platform: "linux", home, env })).toEqual(expect.arrayContaining([
      "/usr/local/bin/ollama",
      "/usr/bin/ollama",
      path.join(home, ".local", "bin", "ollama")
    ]));
    expect(runtimeCandidates("ollama", { platform: "win32", home, env })).toEqual(expect.arrayContaining([
      "C:\\Users\\Test\\AppData\\Local/Programs/Ollama/ollama.exe",
      "C:\\Program Files\\Ollama\\ollama.exe",
      "ollama.exe"
    ]));
  });

  it("prefers an existing managed Ollama runtime before falling back to PATH", async () => {
    const managed = path.join(root, "raw", "runtimes", "ollama", "bin", "ollama");
    await fs.mkdir(path.dirname(managed), { recursive: true });
    await fs.writeFile(managed, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(resolveRuntime("ollama", { env: { SCA_OLLAMA_BIN: managed }, platform: "linux", home: root })).toBe(managed);
  });

  it("repairs executable permissions for nested managed Ollama helpers", async () => {
    if (process.platform === "win32") return;
    const resources = path.join(root, "raw", "runtimes", "ollama", "Ollama.app", "Contents", "Resources");
    const ollama = path.join(resources, "ollama");
    const helperDir = path.join(resources, "lib");
    const helper = path.join(helperDir, "llama-server");
    await fs.mkdir(helperDir, { recursive: true });
    await fs.writeFile(ollama, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    await fs.writeFile(helper, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    await ensureOllamaRuntimePermissions(ollama);
    expect((await fs.stat(ollama)).mode & 0o111).toBeTruthy();
    expect((await fs.stat(helper)).mode & 0o111).toBeTruthy();
  });

  it("does not recurse through unrelated system binary directories when repairing Ollama permissions", async () => {
    if (process.platform === "win32") return;
    const bin = path.join(root, "system-bin");
    const ollama = path.join(bin, "ollama");
    const neighbor = path.join(bin, "other-tool");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(ollama, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    await fs.writeFile(neighbor, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    await ensureOllamaRuntimePermissions(ollama);
    expect((await fs.stat(ollama)).mode & 0o111).toBeTruthy();
    expect((await fs.stat(neighbor)).mode & 0o111).toBeFalsy();
  });

  it("selects a later port when the requested port is busy", async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const busy = server.address().port;
    const available = await findAvailablePort(busy);
    expect(available).toBeGreaterThan(busy);
    await new Promise((resolve) => server.close(resolve));
  });

  it("keeps Kiwix and local static reader port ranges separate", () => {
    expect(KIWIX_PORT + KIWIX_PORT_COUNT - 1).toBeLessThan(LOCAL_STATIC_PORT);
    expect(LOCAL_STATIC_PORT + LOCAL_STATIC_PORT_COUNT - 1).toBeLessThan(9000);
  });

  it("blocks Local AI startup when available RAM is unsafe for the selected model", async () => {
    const db = openState(root);
    await expect(assertOllamaMemoryAllowed(db, {
      title: "Impossible Test Model",
      pull: "impossible:test",
      expected_size_bytes: 10_000_000_000_000
    })).rejects.toThrow(/does not currently have enough safe RAM/);
    const service = db.prepare("SELECT * FROM services WHERE name='ollama'").get();
    expect(service.status).toBe("blocked");
    db.close();
  });

  it("returns a clear timeout when Ollama generation does not finish", async () => {
    const oldTimeout = process.env.SCA_OLLAMA_GENERATE_TIMEOUT_MS;
    process.env.SCA_OLLAMA_GENERATE_TIMEOUT_MS = "1";
    try {
      const result = await askOllama({
        question: "How do I store water?",
        contexts: [{ source_id: "test", title: "Test Source", path: "water.md", snippet: "Store water in clean sealed containers." }],
        model: "test-chat",
        fetchImpl: (_url, options = {}) => new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        })
      });
      expect(result.timedOut).toBe(true);
      expect(result.answer).toMatch(/did not answer/);
    } finally {
      if (oldTimeout === undefined) delete process.env.SCA_OLLAMA_GENERATE_TIMEOUT_MS;
      else process.env.SCA_OLLAMA_GENERATE_TIMEOUT_MS = oldTimeout;
    }
  });

  it("returns a clear timeout when Ollama generation headers arrive but the body stalls", async () => {
    const oldTimeout = process.env.SCA_OLLAMA_GENERATE_TIMEOUT_MS;
    process.env.SCA_OLLAMA_GENERATE_TIMEOUT_MS = "1";
    try {
      const result = await askOllama({
        question: "How do I store water?",
        contexts: [{ source_id: "test", title: "Test Source", path: "water.md", snippet: "Store water in clean sealed containers." }],
        model: "test-chat",
        fetchImpl: (_url, options = {}) => Promise.resolve(new Response(new ReadableStream({
          start(controller) {
            options.signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              controller.error(error);
            });
          }
        }), { status: 200, headers: { "content-type": "application/json" } }))
      });
      expect(result.timedOut).toBe(true);
      expect(result.answer).toMatch(/did not answer/);
    } finally {
      if (oldTimeout === undefined) delete process.env.SCA_OLLAMA_GENERATE_TIMEOUT_MS;
      else process.env.SCA_OLLAMA_GENERATE_TIMEOUT_MS = oldTimeout;
    }
  });

  it("returns a clear canceled answer when Ollama generation is canceled", async () => {
    const controller = new AbortController();
    const resultPromise = askOllama({
      question: "How do I store water?",
      contexts: [{ source_id: "test", title: "Test Source", path: "water.md", snippet: "Store water in clean sealed containers." }],
      model: "test-chat",
      abortSignal: controller.signal,
      fetchImpl: (_url, options = {}) => Promise.resolve(new Response(new ReadableStream({
        start(streamController) {
          options.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            streamController.error(error);
          });
        }
      }), { status: 200, headers: { "content-type": "application/json" } }))
    });
    controller.abort();
    const result = await resultPromise;
    expect(result.canceled).toBe(true);
    expect(result.answer).toMatch(/canceled/i);
  });

  it("includes previous chat turns in the Ollama prompt", async () => {
    let payload = null;
    const result = await askOllama({
      question: "What about it next?",
      history: [{ question: "How do I store water?", answer: "Use clean sealed containers." }],
      contexts: [{ source_id: "test", title: "Water Source", path: "water.md", snippet: "Rotate stored water and keep containers sealed." }],
      model: "test-chat",
      fetchImpl: async (_url, options = {}) => {
        payload = JSON.parse(options.body);
        return new Response(JSON.stringify({ response: "Use the same sealed-container guidance." }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });
    expect(result.unsupported).toBe(false);
    expect(payload.prompt).toContain("Recent conversation:");
    expect(payload.prompt).toContain("User: How do I store water?");
    expect(payload.prompt).toContain("Assistant: Use clean sealed containers.");
    expect(payload.prompt).toContain("Question: What about it next?");
  });

  it("reports generated token progress while reading Ollama streams", async () => {
    const progress = [];
    const encoder = new TextEncoder();
    const result = await askOllama({
      question: "How do I store water?",
      contexts: [{ source_id: "test", title: "Water Source", path: "water.md", snippet: "Store water in clean sealed containers." }],
      model: "test-chat",
      onProgress: (event) => progress.push(event),
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(JSON.stringify({ response: "Use" }) + "\n"));
          controller.enqueue(encoder.encode(JSON.stringify({ response: " sealed" }) + "\n"));
          controller.enqueue(encoder.encode(JSON.stringify({ response: " containers.", done: true, eval_count: 3 }) + "\n"));
          controller.close();
        }
      }), { status: 200, headers: { "content-type": "application/x-ndjson" } })
    });
    expect(result.answer).toContain("Use sealed containers.");
    expect(result.generatedTokens).toBe(3);
    expect(progress.some((event) => event.generatedTokens >= 1 && !event.done)).toBe(true);
    expect(progress.at(-1)).toMatchObject({ generatedTokens: 3, done: true });
  });

  it("bounds Ollama model refresh probes", async () => {
    const oldTimeout = process.env.SCA_OLLAMA_TAGS_TIMEOUT_MS;
    process.env.SCA_OLLAMA_TAGS_TIMEOUT_MS = "1";
    const db = openState(root);
    try {
      const models = await refreshModels(db, [], (_url, options = {}) => new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }));
      expect(models).toEqual([]);
    } finally {
      db.close();
      if (oldTimeout === undefined) delete process.env.SCA_OLLAMA_TAGS_TIMEOUT_MS;
      else process.env.SCA_OLLAMA_TAGS_TIMEOUT_MS = oldTimeout;
    }
  });

  it("refuses to start Local AI without an installed chat model for the RAM guard", async () => {
    const db = openState(root);
    await expect(startOllama(db)).rejects.toThrow(/requires an installed chat model/);
    db.close();
  });

  it("uses bounded per-model RAM estimates for chat and embedding models", () => {
    const gib = 1024 ** 3;
    expect(estimateModelRamBytes({ role: "chat", expected_size_bytes: 986e6 })).toBeLessThan(3 * gib);
    expect(estimateModelRamBytes({ role: "chat", expected_size_bytes: 3.3e9 })).toBeGreaterThanOrEqual(6 * gib);
    expect(estimateModelRamBytes({ role: "chat", expected_size_bytes: 5.6e9 })).toBeLessThan(12 * gib);
    expect(estimateModelRamBytes({ role: "chat", expected_size_bytes: 15e9 })).toBeGreaterThan(24 * gib);
    expect(estimateModelRamBytes({ role: "embedding", expected_size_bytes: 300e6 })).toBe(3 * gib);
  });

  it("counts macOS reclaimable memory as available for the Local AI guard", () => {
    const gib = 1024 ** 3;
    const snapshot = parseDarwinVmStat(`
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               20480.
Pages inactive:                          327680.
Pages speculative:                       65536.
Pages purgeable:                         32768.
File-backed pages:                       262144.
`, 16 * gib);
    expect(snapshot.freeBytes).toBeGreaterThanOrEqual(320 * 1024 ** 2);
    expect(snapshot.availableBytes).toBeGreaterThan(7 * gib);
    expect(snapshot.availableBytes).toBeLessThanOrEqual(16 * gib);
  });

  it("only recommends Local AI models that fit the per-model RAM budget", () => {
    const gib = 1024 ** 3;
    const models = [
      { id: "qwen2_5-1_5b", pull: "qwen2.5:1.5b", role: "chat", expected_size_bytes: 986e6 },
      { id: "gemma3-4b", pull: "gemma3:4b", role: "chat", expected_size_bytes: 3.3e9 },
      { id: "qwen3-8b", pull: "qwen3:8b", role: "chat", expected_size_bytes: 5.6e9 },
      { id: "bge-m3", pull: "bge-m3", role: "embedding", expected_size_bytes: 1.3e9 },
      { id: "nomic-embed-text", pull: "nomic-embed-text", role: "embedding", expected_size_bytes: 300e6 },
      { id: "mistral-small-24b", pull: "mistral-small", role: "chat", expected_size_bytes: 15e9 }
    ];
    expect(recommendAi(4 * gib, models)).toEqual(["qwen2.5:1.5b"]);
    expect(recommendAi(8 * gib, models)).toEqual(["qwen2.5:1.5b", "gemma3:4b", "nomic-embed-text"]);
    expect(recommendAi(16 * gib, models)).toEqual(["qwen2.5:1.5b", "qwen3:8b", "bge-m3"]);
    expect(recommendAi(32 * gib, models)).toEqual(["qwen2.5:1.5b", "mistral-small", "qwen3:8b", "bge-m3"]);
  });

  it("has managed Ollama install plans for Linux, macOS, and Windows", () => {
    expect(ollamaInstallPlan("linux", "x64")).toMatchObject({ asset: "ollama-linux-amd64.tar.zst", bin: path.join("bin", "ollama") });
    expect(ollamaInstallPlan("linux", "arm64")).toMatchObject({ asset: "ollama-linux-arm64.tar.zst", bin: path.join("bin", "ollama") });
    expect(ollamaInstallPlan("darwin", "arm64")).toMatchObject({ asset: "Ollama-darwin.zip", bin: path.join("Ollama.app", "Contents", "Resources", "ollama") });
    expect(ollamaInstallPlan("win32", "x64")).toMatchObject({ asset: "install.ps1", bin: "ollama.exe" });
    expect(() => ollamaInstallPlan("freebsd", "x64")).toThrow(/Unsupported operating system/);
  });
});
