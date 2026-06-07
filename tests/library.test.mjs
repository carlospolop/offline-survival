import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Creator, StringItem } from "@openzim/libzim";
import { ensureLibrary, openState, removeSourcesNotInCatalog, upsertSource } from "../app/backend/state.mjs";
import { downloadProfile, downloadSource, verifySource } from "../app/backend/downloader.mjs";
import { indexDownloadedSources, normalizeAndIndex, search } from "../app/backend/indexer.mjs";
import { exportManifest, integrityReport, writeLock } from "../app/backend/archive.mjs";
import { buildSharePackage } from "../app/backend/release.mjs";
import { systemInfo } from "../app/backend/system.mjs";
import { importExtraKnowledgeFiles, scanExtraKnowledgeFolder } from "../app/backend/extraKnowledge.mjs";

let root;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sca-test-"));
  await ensureLibrary(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function response(text) {
  return new Response(text, { status: 200, headers: { "content-length": String(Buffer.byteLength(text)) } });
}

async function writeFakeAllPlatformApps(projectRoot) {
  const root = path.join(projectRoot, "release", "Offline-Survival-all-platforms");
  const files = [
    ["Offline-Survival-linux-x64", "Offline Survival_0.1.0_amd64.AppImage", "fake linux app"],
    ["Offline-Survival-windows-x64", "Offline Survival.msi", "fake windows installer"],
    ["Offline-Survival-macos-arm64", "Offline Survival.dmg", "fake macos dmg"]
  ];
  for (const [folder, file, content] of files) {
    const dir = path.join(root, folder);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, file), content);
  }
}

describe("library workflows", () => {
  it("downloads, verifies, indexes, and searches a text artifact", async () => {
    const source = {
      id: "test-manual",
      title: "Test Manual",
      type: "html",
      license: "CC0",
      url: "https://example.test/manual.html",
      source_url: "https://example.test",
      expected_size_bytes: 128,
      runtime: ["index", "search"],
      profiles: ["survival-essential"]
    };
    const db = openState(root);
    upsertSource(db, source);
    const result = await downloadSource({
      db,
      libraryRoot: root,
      source,
      diskBudgetBytes: 1024 * 1024,
      fetchImpl: async () => response("<h1>Water</h1><p>Boil water before storage.</p>")
    });
    expect(result.size).toBeGreaterThan(0);
    const verified = await verifySource({ db, libraryRoot: root, sourceId: source.id });
    expect(verified.ok).toBe(true);
    const indexed = await normalizeAndIndex({ db, libraryRoot: root, sourceId: source.id });
    expect(indexed.chunks).toBe(1);
    const results = search(db, "water");
    expect(results[0].title).toBe("Test Manual");
    db.close();
  });

  it("rejects downloads that exceed the configured disk budget", async () => {
    const source = {
      id: "too-large",
      title: "Too Large",
      type: "html",
      license: "CC0",
      url: "https://example.test/large.html",
      expected_size_bytes: 4096,
      runtime: ["index"],
      profiles: ["survival-essential"]
    };
    const db = openState(root);
    upsertSource(db, source);
    await expect(downloadSource({
      db,
      libraryRoot: root,
      source,
      diskBudgetBytes: 128,
      fetchImpl: async () => response("small")
    })).rejects.toThrow(/Disk budget exceeded/);
    db.close();
  });

  it("deduplicates exact duplicate payloads while keeping logical sources", async () => {
    const first = {
      id: "duplicate-a",
      title: "Duplicate A",
      type: "html",
      license: "CC0",
      url: "https://example.test/a.html",
      expected_size_bytes: 16,
      runtime: ["index"],
      profiles: ["survival-essential"]
    };
    const second = { ...first, id: "duplicate-b", title: "Duplicate B", url: "https://example.test/b.html" };
    const db = openState(root);
    upsertSource(db, first);
    upsertSource(db, second);
    await downloadSource({ db, libraryRoot: root, source: first, diskBudgetBytes: 1024 * 1024, fetchImpl: async () => response("same payload") });
    const result = await downloadSource({ db, libraryRoot: root, source: second, diskBudgetBytes: 1024 * 1024, fetchImpl: async () => response("same payload") });
    expect(result.deduped).toBe(true);
    const blobs = db.prepare("SELECT * FROM blobs").all();
    expect(blobs).toHaveLength(1);
    expect(blobs[0].ref_count).toBe(2);
    const sources = db.prepare("SELECT id, local_path FROM sources WHERE id IN ('duplicate-a','duplicate-b') ORDER BY id").all();
    expect(sources[0].local_path).toBe(sources[1].local_path);
    db.close();
  });

  it("downloads a resolved profile and writes archive metadata", async () => {
    const source = {
      id: "profile-source",
      title: "Profile Source",
      type: "html",
      license: "CC0",
      url: "https://example.test/profile.html",
      expected_size_bytes: 32,
      runtime: ["index"],
      profiles: ["survival-essential"]
    };
    const profile = { id: "mini", title: "Mini", sourceIds: [source.id] };
    const db = openState(root);
    upsertSource(db, source);
    const downloaded = await downloadProfile({
      db,
      libraryRoot: root,
      profile,
      sources: [source],
      diskBudgetBytes: 1024 * 1024,
      fetchImpl: async () => response("profile water storage")
    });
    expect(downloaded.results).toHaveLength(1);
    const lock = await writeLock({ db, libraryRoot: root, profile, sources: [source] });
    expect(lock.path).toContain(".lock.yaml");
    const integrity = await integrityReport({ db, libraryRoot: root });
    expect(integrity.ok).toBe(true);
    const exported = await exportManifest({ db, libraryRoot: root });
    expect(exported.manifest.sources.some((item) => item.id === source.id)).toBe(true);
    db.close();
  });

  it("creates a profile-scoped share package from a portable app folder and local library", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sca-project-"));
    await writeFakeAllPlatformApps(projectRoot);
    await fs.mkdir(path.join(root, "raw/html"), { recursive: true });
    await fs.writeFile(path.join(root, "raw/html/shared.html"), "shared content");
    await fs.writeFile(path.join(root, "raw/html/private.html"), "private content");
    await fs.writeFile(path.join(root, "archive-state.sqlite-wal"), "volatile wal");
    await fs.writeFile(path.join(root, "archive-state.sqlite-shm"), "volatile shm");
    const shared = {
      id: "shared-source",
      title: "Shared Source",
      type: "html",
      license: "CC0",
      url: "https://example.test/shared.html",
      expected_size_bytes: 14,
      runtime: ["index"]
    };
    const privateSource = { ...shared, id: "private-source", title: "Private Source", url: "https://example.test/private.html" };
    const profile = { id: "mini", title: "Mini", description: "Small package", sourceIds: [shared.id] };
    const db = openState(root);
    upsertSource(db, shared, { status: "indexed", local_path: "raw/html/shared.html", size_bytes: 14 });
    upsertSource(db, privateSource, { status: "indexed", local_path: "raw/html/private.html", size_bytes: 15 });
    try {
      const result = await buildSharePackage({ db, libraryRoot: root, projectRoot, profile: { ...profile, primaryOs: "windows" }, catalogSources: [shared, privateSource] });
      expect(result.archivePath).toMatch(/OfflineSurvival-mini-Share-.*\.tar\.gz$/);
      expect(result.checksumPath).toBe(`${result.archivePath}.sha256`);
      expect(await fs.readFile(result.checksumPath, "utf8")).toContain(path.basename(result.archivePath));
      expect(result.primaryOs).toBe("windows");
      expect(result.instructions.join(" ")).toContain("Run-Offline-Survival-Windows.bat");
      expect(result.apps.map((app) => app.label).sort()).toEqual(["linux-x64", "macos-arm64", "windows-x64"]);
      const script = await fs.readFile(path.join(result.packageDir, "Run-Offline-Survival-Linux.sh"), "utf8");
      expect(script).toContain("SCA_LIBRARY_ROOT");
      expect(await fs.stat(path.join(result.packageDir, "Run-Offline-Survival-Windows.bat"))).toBeTruthy();
      expect(await fs.stat(path.join(result.packageDir, "Run-Offline-Survival-macOS.command"))).toBeTruthy();
      expect(await fs.stat(path.join(result.packageDir, "OfflineSurvival-Apps/windows-x64/Offline Survival.msi"))).toBeTruthy();
      expect(await fs.stat(path.join(result.packageDir, "OfflineSurvival-Apps/macos-arm64/Offline Survival.dmg"))).toBeTruthy();
      expect(await fs.stat(path.join(result.packageDir, "OfflineSurvival-Apps/linux-x64/Offline Survival_0.1.0_amd64.AppImage"))).toBeTruthy();
      expect(await fs.stat(path.join(result.packageDir, "OfflineSurvival-Library/raw/html/shared.html"))).toBeTruthy();
      await expect(fs.stat(path.join(result.packageDir, "OfflineSurvival-Library/raw/html/private.html"))).rejects.toThrow();
      await expect(fs.stat(path.join(result.packageDir, "OfflineSurvival-Library/archive-state.sqlite-wal"))).rejects.toThrow();
      await expect(fs.stat(path.join(result.packageDir, "OfflineSurvival-Library/archive-state.sqlite-shm"))).rejects.toThrow();
      const sharedDb = openState(path.join(result.packageDir, "OfflineSurvival-Library"));
      expect(sharedDb.prepare("SELECT id FROM sources").all().map((row) => row.id)).toEqual([shared.id]);
      sharedDb.close();
    } finally {
      db.close();
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("creates an all-downloaded share package when given every downloaded source", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sca-project-"));
    await writeFakeAllPlatformApps(projectRoot);
    await fs.mkdir(path.join(root, "raw/html"), { recursive: true });
    await fs.writeFile(path.join(root, "raw/html/first.html"), "first source");
    await fs.writeFile(path.join(root, "raw/html/second.html"), "second source");
    const first = {
      id: "first-downloaded",
      title: "First Downloaded",
      type: "html",
      license: "CC0",
      url: "https://example.test/first.html",
      expected_size_bytes: 12,
      runtime: ["index"]
    };
    const second = { ...first, id: "second-downloaded", title: "Second Downloaded", url: "https://example.test/second.html" };
    const profile = {
      id: "all-downloaded",
      title: "All Downloaded Sources",
      description: "Everything downloaded",
      sourceIds: [first.id, second.id]
    };
    const db = openState(root);
    upsertSource(db, first, { status: "indexed", local_path: "raw/html/first.html", size_bytes: 12 });
    upsertSource(db, second, { status: "verified", local_path: "raw/html/second.html", size_bytes: 13 });
    try {
      const result = await buildSharePackage({ db, libraryRoot: root, projectRoot, profile, catalogSources: [first, second] });
      expect(await fs.stat(path.join(result.packageDir, "OfflineSurvival-Library/raw/html/first.html"))).toBeTruthy();
      expect(await fs.stat(path.join(result.packageDir, "OfflineSurvival-Library/raw/html/second.html"))).toBeTruthy();
      const manifest = JSON.parse(await fs.readFile(path.join(result.packageDir, "share-manifest.json"), "utf8"));
      expect(manifest.profile.id).toBe("all-downloaded");
      expect(manifest.apps_dir).toBe("OfflineSurvival-Apps");
      expect(manifest.apps.map((app) => app.platform).sort()).toEqual(["linux", "macos", "windows"]);
      expect(manifest.sources.map((source) => source.id).sort()).toEqual([first.id, second.id].sort());
    } finally {
      db.close();
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("indexes all downloaded sources that are not indexed yet", async () => {
    const first = {
      id: "bulk-index-a",
      title: "Bulk Index A",
      type: "html",
      license: "CC0",
      url: "https://example.test/a.html",
      expected_size_bytes: 32,
      runtime: ["index"],
      profiles: ["survival-essential"]
    };
    const second = { ...first, id: "bulk-index-b", title: "Bulk Index B", url: "https://example.test/b.html" };
    const db = openState(root);
    await fs.mkdir(path.join(root, "raw/html"), { recursive: true });
    await fs.writeFile(path.join(root, "raw/html/a.html"), "<h1>Water</h1> Store water safely.");
    await fs.writeFile(path.join(root, "raw/html/b.html"), "<h1>Fire</h1> Keep tinder dry.");
    upsertSource(db, first, { status: "downloaded", local_path: "raw/html/a.html" });
    upsertSource(db, second, { status: "downloaded", local_path: "raw/html/b.html" });
    const result = await indexDownloadedSources({ db, libraryRoot: root });
    expect(result.indexed).toBe(2);
    expect(result.remainingUnindexed).toHaveLength(0);
    expect(search(db, "tinder")[0].source_id).toBe(second.id);
    const secondRun = await indexDownloadedSources({ db, libraryRoot: root });
    expect(secondRun.results).toHaveLength(0);
    db.close();
  });

  it("re-indexes a source by clearing stale searchable content first", async () => {
    const source = {
      id: "reindex-source",
      title: "Reindex Source",
      type: "html",
      license: "CC0",
      url: "https://example.test/reindex.html",
      expected_size_bytes: 32,
      runtime: ["index"],
      profiles: ["survival-essential"]
    };
    const db = openState(root);
    await fs.mkdir(path.join(root, "raw/html"), { recursive: true });
    await fs.writeFile(path.join(root, "raw/html/reindex.html"), "<h1>Old</h1> Old keyword only.");
    upsertSource(db, source, { status: "downloaded", local_path: "raw/html/reindex.html" });
    await normalizeAndIndex({ db, libraryRoot: root, sourceId: source.id, sourceConfig: source });
    expect(search(db, "old keyword", 5)[0].source_id).toBe(source.id);

    await fs.writeFile(path.join(root, "raw/html/reindex.html"), "<h1>New</h1> New keyword only.");
    await normalizeAndIndex({ db, libraryRoot: root, sourceId: source.id, sourceConfig: source });

    expect(search(db, "new keyword", 5)[0].source_id).toBe(source.id);
    expect(search(db, "old keyword", 5)).toHaveLength(0);
    expect(db.prepare("SELECT count(*) AS count FROM documents WHERE source_id=?").get(source.id).count).toBe(1);
    db.close();
  });

  it("imports local extra knowledge files and makes them searchable", async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "sca-extra-"));
    await fs.writeFile(path.join(folder, "radio-notes.md"), "# Radio\nKeep a hand-crank radio dry.");
    await fs.writeFile(path.join(folder, "ignore.bin"), Buffer.from([0, 1, 2]));
    const scan = await scanExtraKnowledgeFolder({ folderPath: folder });
    expect(scan.files.map((file) => file.relativePath)).toEqual(["radio-notes.md"]);

    const db = openState(root);
    try {
      const result = await importExtraKnowledgeFiles({ db, libraryRoot: root, files: scan.files.map((file) => file.path), index: true });
      expect(result.imported).toHaveLength(1);
      expect(result.indexed[0].chunks).toBeGreaterThan(0);
      expect(search(db, "radio")[0].source_id).toBe(result.imported[0].id);
      removeSourcesNotInCatalog(db, [{ id: "built-in-source" }]);
      expect(db.prepare("SELECT id FROM sources WHERE id=?").get(result.imported[0].id)).toBeTruthy();
    } finally {
      db.close();
      await fs.rm(folder, { recursive: true, force: true });
    }
  });

  it("registers reader-only sources in the search and AI index", async () => {
    const source = {
      id: "reader-only-zim",
      title: "Reader Only ZIM",
      type: "zim",
      license: "CC0",
      url: "https://example.test/reader.zim",
      expected_size_bytes: 16,
      runtime: ["kiwix"]
    };
    const db = openState(root);
    await fs.mkdir(path.join(root, "raw/zim"), { recursive: true });
    await fs.writeFile(path.join(root, "raw/zim/reader-only-zim.zim"), "fake zim payload");
    upsertSource(db, source, { status: "downloaded", local_path: "raw/zim/reader-only-zim.zim" });
    const indexed = await indexDownloadedSources({ db, libraryRoot: root, catalogSources: [source] });
    expect(indexed.registeredOriginalOnly).toBe(1);
    expect(indexed.remainingUnindexed.map((item) => item.id)).toEqual([source.id]);
    expect(db.prepare("SELECT * FROM documents WHERE source_id=?").get(source.id)).toBeTruthy();
    expect(search(db, "Reader Only", 5)[0].source_id).toBe(source.id);
    db.close();
  });

  it("extracts, indexes, searches, and opens real ZIM article paths", async () => {
    const zimPath = path.join(root, "raw/zim/mini.zim");
    const creator = new Creator()
      .configNbWorkers(1)
      .configIndexing(true, "en")
      .startZimCreation(zimPath);
    await creator.addItem(new StringItem("Water_Purification", "text/html", "Water Purification", { FRONT_ARTICLE: 1, COMPRESS: 1 }, "<h1>Water Purification</h1><p>Boil water before storage.</p>"));
    await creator.addItem(new StringItem("Fire_Safety", "text/html", "Fire Safety", { FRONT_ARTICLE: 1, COMPRESS: 1 }, "<h1>Fire Safety</h1><p>Keep tinder dry and ventilate smoke.</p>"));
    creator.setMainPath("Water_Purification");
    await creator.finishZimCreation();

    const source = {
      id: "mini-zim",
      title: "Mini ZIM",
      type: "zim",
      license: "CC0",
      url: "https://example.test/mini.zim",
      expected_size_bytes: 1024,
      runtime: ["kiwix"]
    };
    const db = openState(root);
    upsertSource(db, source, { status: "downloaded", local_path: "raw/zim/mini.zim" });
    const indexed = await normalizeAndIndex({ db, libraryRoot: root, sourceId: source.id, sourceConfig: source });
    expect(indexed.zim).toBe(true);
    expect(indexed.pages).toBe(2);
    expect(indexed.chunks).toBeGreaterThanOrEqual(2);
    expect(db.prepare("SELECT status FROM sources WHERE id=?").get(source.id).status).toBe("indexed");
    const results = search(db, "tinder", 5);
    expect(results[0].source_id).toBe(source.id);
    expect(results[0].path).toBe("raw/zim/mini.zim#Fire_Safety");
    db.close();
  });

  it("downloads profile sources with bounded parallelism", async () => {
    const sources = Array.from({ length: 5 }, (_, index) => ({
      id: `parallel-${index}`,
      title: `Parallel ${index}`,
      type: "html",
      license: "CC0",
      url: `https://example.test/parallel-${index}.html`,
      expected_size_bytes: 32,
      runtime: ["index"],
      profiles: ["survival-essential"]
    }));
    const profile = { id: "parallel", title: "Parallel", sourceIds: sources.map((source) => source.id) };
    const db = openState(root);
    for (const source of sources) upsertSource(db, source);
    let active = 0;
    let maxActive = 0;
    const downloaded = await downloadProfile({
      db,
      libraryRoot: root,
      profile,
      sources,
      diskBudgetBytes: 1024 * 1024,
      concurrency: 2,
      fetchImpl: async (url) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 250));
        active -= 1;
        return response(`payload for ${url}`);
      }
    });
    expect(downloaded.results).toHaveLength(5);
    expect(maxActive).toBe(2);
    db.close();
  });

  it("reports hardware and profile fit recommendations", async () => {
    const info = await systemInfo(root, [{ id: "tiny", title: "Tiny", expectedSizeBytes: 1, disk_budget_gb: 1 }]);
    expect(info.freeSpaceBytes).toBeGreaterThan(0);
    expect(info.totalDiskBytes).toBeGreaterThanOrEqual(info.freeSpaceBytes);
    expect(info.recommendationLimitBytes).toBe(Math.min(info.recommendationCaps.maxTotalDiskBytes, info.recommendationCaps.maxFreeDiskBytes));
    expect(info.recommendedProfiles[0].id).toBe("tiny");
  });

  it("resumes partial downloads, falls back to mirrors, and verifies checksum URLs", async () => {
    const content = "partial complete payload";
    const digest = "3776afab06712ab322f381c27c22f14eb03a93a3c0081fe3a0e9d323bf89c536";
    const source = {
      id: "resume-source",
      title: "Resume Source",
      type: "html",
      license: "CC0",
      url: "https://bad.example/source.html",
      mirrors: ["https://good.example/source.html"],
      checksum_url: "https://good.example/source.sha256",
      expected_size_bytes: 64,
      runtime: ["index"],
      profiles: ["survival-essential"]
    };
    await fs.writeFile(path.join(root, "tmp", `${source.id}.part`), "partial ");
    const db = openState(root);
    upsertSource(db, source);
    const calls = [];
    const result = await downloadSource({
      db,
      libraryRoot: root,
      source,
      diskBudgetBytes: 1024 * 1024,
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, range: options.headers?.Range });
        if (url.includes("bad.example")) return new Response("no", { status: 503 });
        if (url.endsWith(".sha256")) return response(`${digest}  source.html`);
        if (options.headers?.Range === "bytes=8-") {
          return new Response(content.slice(8), { status: 206, headers: { "content-length": String(content.length - 8) } });
        }
        return response(content);
      }
    });
    expect(result.sha256).toBe(digest);
    expect(calls.some((call) => call.url.includes("good.example") && call.range === "bytes=8-")).toBe(true);
    db.close();
  });

  it("keeps partial bytes and resumes after an interrupted response stream", async () => {
    const source = {
      id: "stream-retry-source",
      title: "Stream Retry Source",
      type: "html",
      license: "CC0",
      url: "https://example.test/retry.html",
      expected_size_bytes: 14,
      runtime: ["index"],
      profiles: ["survival-essential"]
    };
    const db = openState(root);
    upsertSource(db, source);
    const calls = [];
    let first = true;
    const result = await downloadSource({
      db,
      libraryRoot: root,
      source,
      diskBudgetBytes: 1024 * 1024,
      fetchImpl: async (_url, options = {}) => {
        calls.push(options.headers?.Range ?? "");
        if (first) {
          first = false;
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("hello "));
              setTimeout(() => controller.error(new Error("terminated")), 5);
            }
          });
          return new Response(stream, { status: 200, headers: { "content-length": "14" } });
        }
        return new Response("offline!", { status: 206, headers: { "content-length": "8" } });
      }
    });
    expect(result.size).toBe(14);
    expect(calls).toEqual(["", "bytes=6-"]);
    expect(await fs.readFile(path.join(root, result.path), "utf8")).toBe("hello offline!");
    db.close();
  });
});
