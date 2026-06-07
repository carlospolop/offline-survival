import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureLibrary, openState } from "../app/backend/state.mjs";
import net from "node:net";
import { assertOllamaMemoryAllowed, detectRuntime, findAvailablePort, KIWIX_PORT, KIWIX_PORT_COUNT, LOCAL_STATIC_PORT, LOCAL_STATIC_PORT_COUNT, serviceStatus, startOllama, stopService } from "../app/backend/services.mjs";
import { estimateModelRamBytes, recommendAi } from "../app/backend/system.mjs";

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

  it("detects bundled sidecars when SCA_SIDECAR_DIR is set", async () => {
    const old = process.env.SCA_SIDECAR_DIR;
    const bin = path.join(root, "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "kiwix-serve"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.SCA_SIDECAR_DIR = bin;
    expect(await detectRuntime("kiwix-serve")).toBe(true);
    if (old === undefined) delete process.env.SCA_SIDECAR_DIR;
    else process.env.SCA_SIDECAR_DIR = old;
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

  it("refuses to start Local AI without an installed chat model for the RAM guard", async () => {
    const db = openState(root);
    await expect(startOllama(db)).rejects.toThrow(/requires an installed chat model/);
    db.close();
  });

  it("uses bounded per-model RAM estimates for chat and embedding models", () => {
    const gib = 1024 ** 3;
    expect(estimateModelRamBytes({ role: "chat", expected_size_bytes: 3.3e9 })).toBeGreaterThanOrEqual(6 * gib);
    expect(estimateModelRamBytes({ role: "chat", expected_size_bytes: 5.6e9 })).toBeLessThan(12 * gib);
    expect(estimateModelRamBytes({ role: "chat", expected_size_bytes: 15e9 })).toBeGreaterThan(24 * gib);
    expect(estimateModelRamBytes({ role: "embedding", expected_size_bytes: 300e6 })).toBe(3 * gib);
  });

  it("only recommends Local AI models that fit the per-model RAM budget", () => {
    const gib = 1024 ** 3;
    const models = [
      { id: "gemma3-4b", pull: "gemma3:4b", role: "chat", expected_size_bytes: 3.3e9 },
      { id: "qwen3-8b", pull: "qwen3:8b", role: "chat", expected_size_bytes: 5.6e9 },
      { id: "bge-m3", pull: "bge-m3", role: "embedding", expected_size_bytes: 1.3e9 },
      { id: "nomic-embed-text", pull: "nomic-embed-text", role: "embedding", expected_size_bytes: 300e6 },
      { id: "mistral-small-24b", pull: "mistral-small", role: "chat", expected_size_bytes: 15e9 }
    ];
    expect(recommendAi(8 * gib, models)).toEqual(["gemma3:4b", "nomic-embed-text"]);
    expect(recommendAi(16 * gib, models)).toEqual(["qwen3:8b", "bge-m3"]);
    expect(recommendAi(32 * gib, models)).toEqual(["mistral-small", "qwen3:8b", "bge-m3"]);
  });
});
