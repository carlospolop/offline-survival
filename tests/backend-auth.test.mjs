import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let child, root, origin;
let downloaderPid;
const token = randomUUID();
const headers = { "x-sca-backend-token": token };

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sca-auth-"));
  const bin = path.join(root, "bin");
  await fs.mkdir(bin);
  // An owned fake downloader exercises shutdown without network transfers. It
  // ignores SIGTERM so the backend must wait for its forced termination.
  await fs.writeFile(path.join(bin, "aria2c"), `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(process.env.SCA_FAKE_ARIA_PID_FILE, String(process.pid));\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--experimental-sqlite", "app/backend/server.mjs"], {
    env: { ...process.env, PORT: String(port), SCA_LIBRARY_ROOT: root, SCA_PACKAGED: "1", SCA_BACKEND_TOKEN: token, SCA_NO_OPEN: "1", SCA_DOWNLOAD_TRANSPORT: "aria2", PATH: bin + path.delimiter + process.env.PATH, SCA_FAKE_ARIA_PID_FILE: path.join(root, "downloader.pid") },
    stdio: "ignore"
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${origin}/api/health`, { headers, signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Protected backend did not start");
}, 10000);

afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  }
  if (downloaderPid) {
    try { process.kill(downloaderPid, "SIGKILL"); } catch {}
  }
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("desktop backend authorization", () => {
  it.each(["/api/health", "/api/catalog", "/api/state"])("rejects unauthenticated reads of %s", async (route) => {
    const response = await fetch(origin + route);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(token);
  });
  it("rejects unauthorized actions without modifying the library", async () => {
    const response = await fetch(`${origin}/api/clean-sources`, {
      method: "POST", headers: { "x-sca-backend-token": "incorrect" }
    });
    expect(response.status).toBe(403);
    const state = await (await fetch(`${origin}/api/state`, { headers })).json();
    expect(state.settings.libraryRoot).toBe(root);
    expect(state.sources.length).toBeGreaterThan(0);
  });
  it("supports authenticated startup and CORS preflight without disclosing the token", async () => {
    const preflight = await fetch(`${origin}/api/state`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    const health = await fetch(`${origin}/api/health`, { headers });
    expect(health.ok).toBe(true);
    expect(await health.json()).toMatchObject({ status: "ok", packaged: true });
    const catalog = await fetch(`${origin}/api/catalog`, { headers });
    expect(catalog.ok).toBe(true);
    expect((await catalog.json()).sources.length).toBeGreaterThan(0);
    const text = await (await fetch(`${origin}/api/health`, { headers })).text();
    expect(text).not.toContain(token);
  });

  it("protects active downloads from cleanup and stops their processes before acknowledging shutdown", async () => {
    const catalog = await (await fetch(`${origin}/api/catalog`, { headers })).json();
    const source = catalog.sources.find((source) => source.type === "zim");
    const download = await fetch(`${origin}/api/download`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ sourceId: source.id })
    });
    expect(download.ok).toBe(true);
    for (let i = 0; i < 40; i++) {
      const pid = await fs.readFile(path.join(root, "downloader.pid"), "utf8").catch(() => "");
      if (pid) { downloaderPid = Number(pid); break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(downloaderPid).toBeGreaterThan(0);
    for (const route of ["/api/clean-sources", "/api/library"]) {
      const response = await fetch(origin + route, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ path: path.join(root, "other-library") })
      });
      expect(response.ok).toBe(false);
      expect((await response.json()).error).toContain("Wait for active");
    }
    const response = await fetch(`${origin}/api/shutdown`, { method: "POST", headers });
    expect(response.ok).toBe(true);
    expect(() => process.kill(downloaderPid, 0)).toThrow();
    downloaderPid = null;
  }, 10000);
});
