import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openState } from "../app/backend/state.mjs";
import { upsertService } from "../app/backend/services.mjs";

const port = 9876;
let child;
let root;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sca-http-"));
  child = spawn(process.execPath, ["--experimental-sqlite", "app/backend/server.mjs"], {
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

function waitForExit(childProcess) {
  return new Promise((resolve) => {
    if (childProcess.exitCode !== null || childProcess.signalCode !== null) return resolve();
    childProcess.once("exit", resolve);
  });
}

async function waitForProcessGone(pid) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

describe("HTTP API", () => {
  it("serves catalog, system, adapters, license report, and integrity", async () => {
    const catalog = await (await fetch(`http://127.0.0.1:${port}/api/catalog`)).json();
    expect(catalog.profiles).toHaveLength(15);
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
    const portable = await (await fetch(`http://127.0.0.1:${port}/api/portable/layout`)).json();
    expect(portable.readme).toBe("README-FIRST.txt");
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

    const mismatchedEasyInstall = await (await fetch(`http://127.0.0.1:${port}/api/easy-install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileIds: ["survival-essential"], contentLanguage: "es", installAi: false })
    })).json();
    expect(mismatchedEasyInstall.error).toMatch(/do not match content language es/);

    const mismatchedProfileDownload = await (await fetch(`http://127.0.0.1:${port}/api/profile/download`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: "survival-essential", contentLanguage: "es" })
    })).json();
    expect(mismatchedProfileDownload.error).toMatch(/do not match content language es/);

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
    const db = openState(root);
    try {
      const duplicateBody = "Duplicate battery context should appear only once.";
      const insertChunk = db.prepare("INSERT INTO chunks (id, source_id, title, path, heading_path, body, token_estimate, vector, safety_class, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const insertFts = db.prepare("INSERT INTO fts (source_id, title, body, path) VALUES (?, ?, ?, ?)");
      for (const suffix of ["a", "b"]) {
        const pathName = `duplicate-${suffix}.md`;
        insertChunk.run(`duplicate-${suffix}`, imported.imported[0].id, "Duplicate Battery Context", pathName, "", duplicateBody, 8, "[]", "general", new Date().toISOString());
        insertFts.run(imported.imported[0].id, "Duplicate Battery Context", duplicateBody, pathName);
      }
    } finally {
      db.close();
    }
    const askDuplicateContext = await (await fetch(`http://127.0.0.1:${port}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "What does the duplicate battery context say?", model: "missing-test-model:latest" })
    })).json();
    expect(askDuplicateContext.citations.filter((citation) => String(citation.path).startsWith("duplicate-"))).toHaveLength(1);
    const askImported = await (await fetch(`http://127.0.0.1:${port}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "How should I store batteries?", model: "missing-test-model:latest" })
    })).json();
    expect(askImported.unsupported).toBe(true);
    expect(askImported.citations.some((citation) => citation.source_id === imported.imported[0].id)).toBe(true);

    const catalog = await (await fetch(`http://127.0.0.1:${port}/api/catalog`)).json();
    const alreadyDownloadedId = catalog.sources[0].id;
    const dbDownloaded = openState(root);
    try {
      dbDownloaded.prepare("UPDATE sources SET status='downloaded', updated_at=datetime('now') WHERE id=?").run(alreadyDownloadedId);
    } finally {
      dbDownloaded.close();
    }
    const skippedDownload = await (await fetch(`http://127.0.0.1:${port}/api/download`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: alreadyDownloadedId })
    })).json();
    expect(skippedDownload).toMatchObject({ sourceId: alreadyDownloadedId, skipped: true, background: false, started: false });

    const alreadyDownloadedProfile = catalog.profiles.find((profile) => profile.id === "survival-essential");
    const dbProfileDownloaded = openState(root);
    try {
      for (const [index, sourceId] of alreadyDownloadedProfile.sourceIds.entries()) {
        const status = index === 0 ? "indexed-original-only" : index === 1 ? "downloaded_unverified" : "downloaded";
        dbProfileDownloaded.prepare("UPDATE sources SET status=?, local_path=COALESCE(local_path, ?), updated_at=datetime('now') WHERE id=?")
          .run(status, `raw/test/${sourceId}.dat`, sourceId);
      }
    } finally {
      dbProfileDownloaded.close();
    }
    const skippedProfileDownload = await (await fetch(`http://127.0.0.1:${port}/api/profile/download`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: alreadyDownloadedProfile.id })
    })).json();
    expect(skippedProfileDownload).toMatchObject({ profileId: alreadyDownloadedProfile.id, background: false, started: false });
    expect(skippedProfileDownload.queued).toHaveLength(0);
    expect(skippedProfileDownload.skipped).toHaveLength(alreadyDownloadedProfile.sourceIds.length);
    expect(skippedProfileDownload.skipped.some((item) => item.status === "indexed-original-only")).toBe(true);
    expect(skippedProfileDownload.skipped.some((item) => item.status === "downloaded_unverified")).toBe(true);

    const cleaned = await (await fetch(`http://127.0.0.1:${port}/api/clean-sources`, { method: "POST" })).json();
    expect(cleaned.status).toBe("cleaned");

    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    expect(state.sources).toHaveLength(52);
    expect(state.sources.some((source) => source.id === imported.imported[0].id)).toBe(false);
    expect(state.sources.every((source) => !source.local_path && source.status === "missing")).toBe(true);
    expect(state.downloads).toHaveLength(0);
    expect(state.documents).toHaveLength(0);
    expect(state.settings.libraryRoot).toBe(root);
    const jobs = await (await fetch(`http://127.0.0.1:${port}/api/jobs`)).json();
    expect(Array.isArray(jobs.jobs)).toBe(true);
    await fs.rm(extraDir, { recursive: true, force: true });
  });

  it("returns JSON 404 for removed maintenance endpoints", async () => {
    for (const [endpoint, options] of [
      ["/api/updates/status"],
      ["/api/catalog/refresh", { method: "POST" }],
      ["/api/settings/network", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) }]
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, options);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Unknown API endpoint" });
    }
  });

  it("stops Kiwix and Ollama service processes before backend shutdown", async () => {
    const kiwix = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const ollama = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const db = openState(root);
    try {
      upsertService(db, { name: "kiwix", status: "running", pid: kiwix.pid });
      upsertService(db, { name: "ollama", status: "running", pid: ollama.pid });
    } finally {
      db.close();
    }

    const response = await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: "POST" });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.status).toBe("shutting_down");

    await waitForExit(child);
    expect(await waitForProcessGone(kiwix.pid)).toBe(true);
    expect(await waitForProcessGone(ollama.pid)).toBe(true);
    child = null;
  });
});
