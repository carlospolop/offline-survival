import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openState, upsertSource } from "../app/backend/state.mjs";

const port = 9876;
let child;
let root;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sca-http-"));
  child = spawn(process.execPath, ["app/backend/server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), SCA_LIBRARY_ROOT: root, SCA_NO_OPEN: "1" },
    stdio: "ignore"
  });
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/catalog`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("server did not start");
});

afterAll(async () => {
  child?.kill();
  await fs.rm(root, { recursive: true, force: true });
});

describe("HTTP API", () => {
  it("serves catalog, system, adapters, license report, and integrity", async () => {
    const catalog = await (await fetch(`http://127.0.0.1:${port}/api/catalog`)).json();
    expect(catalog.profiles).toHaveLength(5);
    const system = await (await fetch(`http://127.0.0.1:${port}/api/system`)).json();
    expect(system.freeSpaceBytes).toBeGreaterThan(0);
    const adapters = await (await fetch(`http://127.0.0.1:${port}/api/adapters/refresh`)).json();
    expect(adapters.adapters).toHaveLength(catalog.sources.length);
    const licenses = await (await fetch(`http://127.0.0.1:${port}/api/license/report`)).json();
    expect(licenses.report.entries).toHaveLength(catalog.sources.length);
    const integrity = await (await fetch(`http://127.0.0.1:${port}/api/integrity`)).json();
    expect(integrity.ok).toBe(true);
    const review = await (await fetch(`http://127.0.0.1:${port}/api/review/summary`)).json();
    expect(review.byReview.length).toBeGreaterThan(0);
    const updates = await (await fetch(`http://127.0.0.1:${port}/api/updates/status`)).json();
    expect(updates.source_count).toBe(catalog.sources.length);
    const catalogRefresh = await (await fetch(`http://127.0.0.1:${port}/api/catalog/refresh`, { method: "POST" })).json();
    expect(catalogRefresh.mode).toBe("local-manifest-snapshot");
    const portable = await (await fetch(`http://127.0.0.1:${port}/api/portable/layout`)).json();
    expect(portable.readme).toBe("README-FIRST.txt");
    const network = await (await fetch(`http://127.0.0.1:${port}/api/settings/network`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false })
    })).json();
    expect(network.bind).toBe("127.0.0.1");
    const ask = await (await fetch(`http://127.0.0.1:${port}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "How do I store water?" })
    })).json();
    expect(ask.unsupported).toBe(true);
    const logs = await (await fetch(`http://127.0.0.1:${port}/api/logs?limit=10`)).json();
    expect(Array.isArray(logs.logs)).toBe(true);
  });

  it("validates Easy Install input and cleans source payload state", async () => {
    const emptyEasyInstall = await (await fetch(`http://127.0.0.1:${port}/api/easy-install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileIds: [], installAi: false })
    })).json();
    expect(emptyEasyInstall.error).toMatch(/Select at least one profile/);

    const extraDir = await fs.mkdtemp(path.join(os.tmpdir(), "sca-http-extra-"));
    await fs.writeFile(path.join(extraDir, "notes.md"), "# Local Notes\nStore batteries cool and dry.");
    const scan = await (await fetch(`http://127.0.0.1:${port}/api/extra-knowledge/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folderPath: extraDir })
    })).json();
    expect(scan.files).toHaveLength(1);
    const imported = await (await fetch(`http://127.0.0.1:${port}/api/extra-knowledge/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: scan.files.map((file) => file.path), index: true })
    })).json();
    expect(imported.imported).toHaveLength(1);
    const search = await (await fetch(`http://127.0.0.1:${port}/api/search?q=batteries&limit=1`)).json();
    expect(search.results[0].source_id).toBe(imported.imported[0].id);
    const openedSearchHit = await (await fetch(`http://127.0.0.1:${port}/api/search/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: search.results[0].source_id, path: search.results[0].path })
    })).json();
    expect(openedSearchHit.action).toBe("open_search_result");
    expect(openedSearchHit.path).toBe(search.results[0].path);
    const askImported = await (await fetch(`http://127.0.0.1:${port}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "How should I store batteries?" })
    })).json();
    expect(askImported.unsupported).toBe(true);
    expect(askImported.citations.some((citation) => citation.source_id === imported.imported[0].id)).toBe(true);

    const cleaned = await (await fetch(`http://127.0.0.1:${port}/api/clean-sources`, { method: "POST" })).json();
    expect(cleaned.status).toBe("cleaned");

    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    expect(state.sources).toHaveLength(34);
    expect(state.sources.some((source) => source.id === imported.imported[0].id)).toBe(false);
    expect(state.sources.every((source) => !source.local_path && source.status === "missing")).toBe(true);
    expect(state.downloads).toHaveLength(0);
    expect(state.documents).toHaveLength(0);
    expect(state.settings.libraryRoot).toBe(root);
    await fs.rm(extraDir, { recursive: true, force: true });
  });

  it("removes stale source rows when the catalog is refreshed", async () => {
    const db = openState(root);
    upsertSource(db, {
      id: "stale-source-from-old-manifest",
      title: "Stale Source From Old Manifest",
      type: "html",
      license: "test-only",
      expected_size_bytes: 1,
      url: "https://example.invalid/stale.html"
    });
    db.close();

    const before = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    expect(before.sources.some((source) => source.id === "stale-source-from-old-manifest")).toBe(true);

    const refreshed = await (await fetch(`http://127.0.0.1:${port}/api/catalog/refresh`, { method: "POST" })).json();
    expect(refreshed.mode).toBe("local-manifest-snapshot");

    const after = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    expect(after.sources).toHaveLength(34);
    expect(after.sources.some((source) => source.id === "stale-source-from-old-manifest")).toBe(false);
  });
});
