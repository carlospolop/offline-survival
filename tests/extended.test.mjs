import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSourceWithAdapter, refreshAdapters, sourceOpenPlan } from "../app/backend/adapters.mjs";
import { writeAttributionReport } from "../app/backend/license.mjs";
import { cleanupPartials, reconcileLibrary, writeKiwixLibraryXml } from "../app/backend/recovery.mjs";
import { ensureLibrary, openState, upsertSource } from "../app/backend/state.mjs";
import { indexDownloadedSources, normalizeAndIndex, repairCorruptRepoArchiveIndexes, semanticSearch } from "../app/backend/indexer.mjs";
import { KIWIX_PORT, KIWIX_PORT_COUNT, LOCAL_STATIC_PORT, LOCAL_STATIC_PORT_COUNT } from "../app/backend/services.mjs";
import { zipDirectoryToFile } from "../app/backend/zip.mjs";

let root;
const execFileAsync = promisify(execFile);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sca-extended-"));
  await ensureLibrary(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("extended archive services", () => {
  it("refreshes adapters and writes license report", async () => {
    const source = {
      id: "adapter-source",
      title: "Adapter Source",
      type: "html",
      license: "CC-BY-4.0",
      url: "https://example.test/a.html",
      expected_size_bytes: 1,
      runtime: ["browse"],
      profiles: ["survival-essential"],
      attribution: "Example Attribution"
    };
    const db = openState(root);
    upsertSource(db, source, { status: "downloaded", local_path: "raw/html/a.html" });
    const adapters = refreshAdapters(db, [source]);
    expect(adapters[0].adapter).toBe("html-static");
    expect(adapters[0].status).toBe("ready");
    const report = await writeAttributionReport({ db, libraryRoot: root, catalog: { sources: [source] } });
    expect(report.report.summary["CC-BY-4.0"]).toBe(1);
    db.close();
  });

  it("plans and extracts configured archive open targets", async () => {
    const db = openState(root);
    const source = {
      id: "ebook-zip",
      title: "Ebook Zip",
      type: "repo-archive",
      license: "CC0",
      url: "https://example.test/ebook.zip",
      expected_size_bytes: 1,
      runtime: ["browse"],
      profiles: ["survival-essential"],
      open: {
        action: "extract_open",
        entry: "ebook/index.html"
      }
    };
    const fixture = path.join(root, "fixture");
    const archive = path.join(root, "raw/repos/ebook.zip");
    await fs.mkdir(path.join(fixture, "ebook"), { recursive: true });
    await fs.writeFile(path.join(fixture, "ebook/index.html"), "<h1>Ready</h1>");
    await fs.mkdir(path.dirname(archive), { recursive: true });
    await execFileAsync("zip", ["-qr", archive, "ebook"], { cwd: fixture });
    upsertSource(db, source, { status: "downloaded", local_path: "raw/repos/ebook.zip" });
    refreshAdapters(db, [source]);
    const plan = await sourceOpenPlan({ db, libraryRoot: root, source });
    expect(plan.steps[0]).toContain("Extract");
    expect(plan.additionalBytes).toBeGreaterThan(0);
    const opened = await openSourceWithAdapter({ db, libraryRoot: root, source });
    expect(opened.opened).toBe(path.join("opened", source.id, "ebook/index.html"));
    expect(await fs.readFile(path.join(root, opened.opened), "utf8")).toContain("Ready");
    db.close();
  });

  it("opens old app-created ZIP archives with zero CRC headers", async () => {
    const db = openState(root);
    const source = {
      id: "old-zero-crc-wiki",
      title: "Old Zero CRC Wiki",
      type: "repo-archive",
      license: "CC0",
      url: "https://example.test/wiki.zip",
      expected_size_bytes: 1,
      runtime: ["browse"],
      profiles: ["survival-essential"],
      open: {
        action: "extract_serve",
        entry: "wiki"
      }
    };
    const fixture = path.join(root, "fixture-zero-crc");
    const archive = path.join(root, "raw/repos/zero-crc.zip");
    await fs.mkdir(path.join(fixture, "wiki"), { recursive: true });
    await fs.writeFile(path.join(fixture, "wiki/Home.md"), "# Home\n\nOld archive still opens.");
    await fs.mkdir(path.dirname(archive), { recursive: true });
    await zipDirectoryToFile(fixture, archive);
    const buffer = await fs.readFile(archive);
    zeroZipCrcFields(buffer);
    await fs.writeFile(archive, buffer);
    await expect(execFileAsync("unzip", ["-t", archive])).rejects.toThrow(/bad CRC|unzip/);

    upsertSource(db, source, { status: "downloaded", local_path: "raw/repos/zero-crc.zip" });
    refreshAdapters(db, [source]);
    const opened = await openSourceWithAdapter({ db, libraryRoot: root, source });
    const html = await (await fetch(opened.url)).text();
    expect(html).toContain("Old archive still opens.");
    db.close();
  });

  it("indexes repo ZIP entries whose deflated bytes are marked as stored", async () => {
    const db = openState(root);
    const source = {
      id: "stored-method-deflated-wiki",
      title: "Stored Method Deflated Wiki",
      type: "repo-archive",
      license: "CC0",
      url: "https://example.test/wiki.zip",
      expected_size_bytes: 1,
      runtime: ["index"],
      profiles: ["survival-essential"],
      open: {
        action: "extract_serve",
        entry: "wiki"
      }
    };
    const fixture = path.join(root, "fixture-stored-method-deflated");
    const archive = path.join(root, "raw/repos/stored-method-deflated.zip");
    await fs.mkdir(path.join(fixture, "wiki"), { recursive: true });
    await fs.writeFile(path.join(fixture, "wiki/Home.md"), "# Home\n\nUse a signal mirror.");
    await fs.mkdir(path.dirname(archive), { recursive: true });
    await fs.writeFile(archive, storedMethodDeflatedZip([{ name: "wiki/Home.md", data: Buffer.from("# Home\n\nUse a signal mirror.") }]));

    upsertSource(db, source, { status: "downloaded", local_path: "raw/repos/stored-method-deflated.zip" });
    const indexed = await normalizeAndIndex({ db, libraryRoot: root, sourceId: source.id, sourceConfig: source });
    expect(indexed.chunks).toBe(1);
    const chunk = db.prepare("SELECT body FROM chunks WHERE source_id=?").get(source.id);
    expect(chunk.body).toContain("Use a signal mirror.");
    db.close();
  });

  it("repairs already-indexed repo archives that contain decoded ZIP garbage", async () => {
    const db = openState(root);
    const source = {
      id: "repair-garbage-wiki",
      title: "Repair Garbage Wiki",
      type: "repo-archive",
      license: "CC0",
      url: "https://example.test/wiki.zip",
      expected_size_bytes: 1,
      runtime: ["index"],
      profiles: ["survival-essential"],
      open: {
        action: "extract_serve",
        entry: "wiki"
      }
    };
    const archiveRel = "raw/repos/repair-garbage.zip";
    const archive = path.join(root, archiveRel);
    await fs.mkdir(path.dirname(archive), { recursive: true });
    await fs.writeFile(archive, storedMethodDeflatedZip([{ name: "wiki/Home.md", data: Buffer.from("# Home\n\nRepair with clean text.") }]));
    upsertSource(db, source, { status: "indexed", local_path: archiveRel });
    db.prepare("INSERT INTO documents (id, source_id, title, path, text_path, chunk_count, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(source.id, source.id, source.title, archiveRel, `normalized/text/${source.id}.txt`, 1, new Date().toISOString());
    db.prepare("INSERT INTO chunks (id, source_id, title, path, heading_path, body, token_estimate, vector, safety_class, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(`${source.id}:0`, source.id, source.title, archiveRel, "", "\uFFFD\uFFFD\uFFFD compressed bytes", 4, "[]", "general", new Date().toISOString());

    const repaired = await indexDownloadedSources({ db, libraryRoot: root, catalogSources: [source] });
    expect(repaired.indexed).toBe(1);
    const chunk = db.prepare("SELECT body FROM chunks WHERE source_id=?").get(source.id);
    expect(chunk.body).toContain("Repair with clean text.");
    db.close();
  });

  it("startup repair fixes only corrupted repo archive indexes", async () => {
    const db = openState(root);
    const source = {
      id: "startup-repair-wiki",
      title: "Startup Repair Wiki",
      type: "repo-archive",
      license: "CC0",
      url: "https://example.test/wiki.zip",
      expected_size_bytes: 1,
      runtime: ["index"],
      profiles: ["survival-essential"],
      open: {
        action: "extract_serve",
        entry: "wiki"
      }
    };
    const archiveRel = "raw/repos/startup-repair.zip";
    const archive = path.join(root, archiveRel);
    await fs.mkdir(path.dirname(archive), { recursive: true });
    await fs.writeFile(archive, storedMethodDeflatedZip([{ name: "wiki/Home.md", data: Buffer.from("# Home\n\nStartup repair clean text.") }]));
    upsertSource(db, source, { status: "indexed", local_path: archiveRel });
    db.prepare("INSERT INTO chunks (id, source_id, title, path, heading_path, body, token_estimate, vector, safety_class, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(`${source.id}:0`, source.id, source.title, archiveRel, "", "\uFFFD bad startup bytes", 4, "[]", "general", new Date().toISOString());

    const repaired = await repairCorruptRepoArchiveIndexes({ db, libraryRoot: root, catalogSources: [source] });
    expect(repaired.repaired).toBe(1);
    const chunk = db.prepare("SELECT body FROM chunks WHERE source_id=?").get(source.id);
    expect(chunk.body).toContain("Startup repair clean text.");
    db.close();
  });

  it("writes app-created ZIP archives with valid CRC headers", async () => {
    const fixture = path.join(root, "fixture-good-crc");
    const archive = path.join(root, "raw/repos/good-crc.zip");
    await fs.mkdir(path.join(fixture, "wiki"), { recursive: true });
    await fs.writeFile(path.join(fixture, "wiki/Home.md"), "# Home\n\nNew archive validates.");
    await fs.mkdir(path.dirname(archive), { recursive: true });
    await zipDirectoryToFile(fixture, archive);
    const tested = await execFileAsync("unzip", ["-t", archive]);
    expect(tested.stdout).toContain("No errors detected");
  });

  it("rejects extracted static sources that do not contain usable content", async () => {
    const db = openState(root);
    const source = {
      id: "empty-wiki",
      title: "Empty Wiki",
      type: "repo-archive",
      license: "CC0",
      url: "https://example.test/empty.zip",
      expected_size_bytes: 1,
      runtime: ["browse"],
      profiles: ["survival-essential"],
      open: {
        action: "extract_serve",
        entry: "wiki"
      }
    };
    const fixture = path.join(root, "fixture-empty");
    const archive = path.join(root, "raw/repos/empty.zip");
    await fs.mkdir(path.join(fixture, "wiki"), { recursive: true });
    await fs.mkdir(path.dirname(archive), { recursive: true });
    await execFileAsync("zip", ["-qr", archive, "wiki"], { cwd: fixture });
    upsertSource(db, source, { status: "downloaded", local_path: "raw/repos/empty.zip" });
    refreshAdapters(db, [source]);
    await expect(openSourceWithAdapter({ db, libraryRoot: root, source })).rejects.toThrow(/no usable content/);
    db.close();
  });

  it("serves extensionless GitHub wiki links from extracted Markdown sources", async () => {
    const db = openState(root);
    const source = {
      id: "markdown-wiki",
      title: "Markdown Wiki",
      type: "repo-archive",
      license: "CC0",
      url: "https://example.test/wiki.zip",
      expected_size_bytes: 1,
      runtime: ["browse"],
      profiles: ["survival-essential"],
      open: {
        action: "extract_serve",
        entry: "wiki"
      }
    };
    const fixture = path.join(root, "fixture-wiki");
    const archive = path.join(root, "raw/repos/wiki.zip");
    await fs.mkdir(path.join(fixture, "wiki"), { recursive: true });
    await fs.writeFile(path.join(fixture, "wiki/Home.md"), "### [Introduction](Introduction)\n\n| Item | Use |\n| --- | --- |\n| Water | Storage |\n\n<div class=\"note\">HTML note renders</div>\n\n```sh\necho ready\n```");
    await fs.writeFile(path.join(fixture, "wiki/Introduction.md"), "# Introduction\n\nOffline page works.\n\n- first\n  - nested");
    await fs.mkdir(path.dirname(archive), { recursive: true });
    await execFileAsync("zip", ["-qr", archive, "wiki"], { cwd: fixture });
    upsertSource(db, source, { status: "downloaded", local_path: "raw/repos/wiki.zip" });
    refreshAdapters(db, [source]);
    const opened = await openSourceWithAdapter({ db, libraryRoot: root, source });
    expect(opened.port).toBeGreaterThanOrEqual(LOCAL_STATIC_PORT);
    expect(opened.port).toBeLessThan(LOCAL_STATIC_PORT + LOCAL_STATIC_PORT_COUNT);
    expect(opened.port).toBeGreaterThanOrEqual(KIWIX_PORT + KIWIX_PORT_COUNT);
    const response = await fetch(`${opened.url}Introduction`);
    expect(response.status).toBe(200);
    const introHtml = await response.text();
    expect(introHtml).toContain("Offline page works.");
    expect(introHtml).toContain("readerArticle");
    expect(introHtml).toContain("<li>nested</li>");
    const homeHtml = await (await fetch(opened.url)).text();
    expect(homeHtml).toContain("<table>");
    expect(homeHtml).toContain('<div class="note">HTML note renders</div>');
    expect(homeHtml).toContain("<pre><code class=\"language-sh\">");
    db.close();
  });

  it("injects the offline reader stylesheet into extracted HTML pages", async () => {
    const db = openState(root);
    const source = {
      id: "html-static-wiki",
      title: "HTML Static Wiki",
      type: "repo-archive",
      license: "CC0",
      url: "https://example.test/html-wiki.zip",
      expected_size_bytes: 1,
      runtime: ["browse"],
      profiles: ["survival-essential"],
      open: {
        action: "extract_serve",
        entry: "site"
      }
    };
    const fixture = path.join(root, "fixture-html-wiki");
    const archive = path.join(root, "raw/repos/html-wiki.zip");
    await fs.mkdir(path.join(fixture, "site"), { recursive: true });
    await fs.writeFile(path.join(fixture, "site/index.html"), "<!doctype html><html><head><title>Site</title></head><body><main><h1>Raw HTML</h1><p>Readable page.</p></main></body></html>");
    await fs.mkdir(path.dirname(archive), { recursive: true });
    await execFileAsync("zip", ["-qr", archive, "site"], { cwd: fixture });
    upsertSource(db, source, { status: "downloaded", local_path: "raw/repos/html-wiki.zip" });
    refreshAdapters(db, [source]);
    const opened = await openSourceWithAdapter({ db, libraryRoot: root, source });
    const html = await (await fetch(opened.url)).text();
    expect(html).toContain("offline-survival-reader-style");
    expect(html).toContain("Readable page.");
    db.close();
  });

  it("indexes text from configured extracted Markdown archive sources", async () => {
    const db = openState(root);
    const source = {
      id: "indexable-markdown-wiki",
      title: "Indexable Markdown Wiki",
      type: "repo-archive",
      license: "CC0",
      url: "https://example.test/indexable-wiki.zip",
      expected_size_bytes: 1,
      runtime: ["browse", "index"],
      profiles: ["survival-essential"],
      open: {
        action: "extract_serve",
        entry: "wiki"
      }
    };
    const fixture = path.join(root, "fixture-indexable-wiki");
    const archive = path.join(root, "raw/repos/indexable-wiki.zip");
    await fs.mkdir(path.join(fixture, "wiki"), { recursive: true });
    await fs.writeFile(path.join(fixture, "wiki/Home.md"), "# Home\n\nWater storage and fire safety.");
    await fs.writeFile(path.join(fixture, "wiki/Water.md"), "# Water\n\nBoil water before storage.");
    await fs.mkdir(path.dirname(archive), { recursive: true });
    await execFileAsync("zip", ["-qr", archive, "wiki"], { cwd: fixture });
    upsertSource(db, source, { status: "downloaded", local_path: "raw/repos/indexable-wiki.zip" });
    const indexed = await indexDownloadedSources({ db, libraryRoot: root, catalogSources: [source] });
    expect(indexed.indexed).toBe(1);
    expect(semanticSearch(db, "boil water", 1)[0].source_id).toBe(source.id);
    db.close();
  });

  it("does not index script or stylesheet files from extracted archive sources", async () => {
    const db = openState(root);
    const source = {
      id: "style-script-free-wiki",
      title: "Style Script Free Wiki",
      type: "repo-archive",
      license: "CC0",
      url: "https://example.test/style-script-free.zip",
      expected_size_bytes: 1,
      runtime: ["browse", "index"],
      profiles: ["survival-essential"],
      open: {
        action: "extract_serve",
        entry: "wiki"
      }
    };
    const fixture = path.join(root, "fixture-style-script-free");
    const archive = path.join(root, "raw/repos/style-script-free.zip");
    await fs.mkdir(path.join(fixture, "wiki/assets"), { recursive: true });
    await fs.writeFile(path.join(fixture, "wiki/Home.md"), "# Home\n\nUseful clean water notes.");
    await fs.writeFile(path.join(fixture, "wiki/assets/app.js"), "const secretScriptToken = 'do not index';");
    await fs.writeFile(path.join(fixture, "wiki/assets/site.css"), ".secretStyleToken { color: red; }");
    await fs.writeFile(path.join(fixture, "wiki/assets/theme.scss"), "$secretScssToken: red;");
    await fs.mkdir(path.dirname(archive), { recursive: true });
    await execFileAsync("zip", ["-qr", archive, "wiki"], { cwd: fixture });
    upsertSource(db, source, { status: "downloaded", local_path: "raw/repos/style-script-free.zip" });

    const indexed = await normalizeAndIndex({ db, libraryRoot: root, sourceId: source.id, sourceConfig: source });
    expect(indexed.chunks).toBe(1);
    const normalized = await fs.readFile(path.join(root, "normalized/text", `${source.id}.txt`), "utf8");
    expect(normalized).toContain("Useful clean water notes.");
    expect(normalized).not.toContain("secretScriptToken");
    expect(normalized).not.toContain("secretStyleToken");
    expect(normalized).not.toContain("secretScssToken");
    expect(semanticSearch(db, "clean water", 1)[0].source_id).toBe(source.id);
    db.close();
  });

  it("rejects configured extracted files that are missing", async () => {
    const db = openState(root);
    const source = {
      id: "missing-ebook-entry",
      title: "Missing Ebook Entry",
      type: "repo-archive",
      license: "CC0",
      url: "https://example.test/missing.zip",
      expected_size_bytes: 1,
      runtime: ["browse"],
      profiles: ["survival-essential"],
      open: {
        action: "extract_open",
        entry: "ebook/book.epub"
      }
    };
    const fixture = path.join(root, "fixture-missing");
    const archive = path.join(root, "raw/repos/missing.zip");
    await fs.mkdir(path.join(fixture, "ebook"), { recursive: true });
    await fs.writeFile(path.join(fixture, "ebook/README.md"), "not the book");
    await fs.mkdir(path.dirname(archive), { recursive: true });
    await execFileAsync("zip", ["-qr", archive, "ebook"], { cwd: fixture });
    upsertSource(db, source, { status: "downloaded", local_path: "raw/repos/missing.zip" });
    refreshAdapters(db, [source]);
    await expect(openSourceWithAdapter({ db, libraryRoot: root, source })).rejects.toThrow(/does not exist/);
    db.close();
  });

  it("rejects empty direct-open files", async () => {
    const db = openState(root);
    const source = {
      id: "empty-pdf",
      title: "Empty PDF",
      type: "pdf",
      license: "CC0",
      url: "https://example.test/empty.pdf",
      expected_size_bytes: 1,
      runtime: ["browse"],
      profiles: ["survival-essential"]
    };
    await fs.mkdir(path.join(root, "raw/pdf"), { recursive: true });
    await fs.writeFile(path.join(root, "raw/pdf/empty.pdf"), "");
    upsertSource(db, source, { status: "downloaded", local_path: "raw/pdf/empty.pdf" });
    refreshAdapters(db, [source]);
    await expect(openSourceWithAdapter({ db, libraryRoot: root, source })).rejects.toThrow(/is empty/);
    db.close();
  });

  it("reconciles missing files, partials, kiwix XML, and semantic chunks", async () => {
    const db = openState(root);
    const html = {
      id: "semantic-source",
      title: "Semantic Source",
      type: "html",
      license: "CC0",
      url: "https://example.test/semantic.html",
      expected_size_bytes: 1,
      runtime: ["index"],
      profiles: ["survival-essential"]
    };
    const zim = { ...html, id: "zim-source", title: "ZIM Source", type: "zim" };
    await fs.mkdir(path.join(root, "raw/html"), { recursive: true });
    await fs.writeFile(path.join(root, "raw/html/semantic.html"), "<h1>Seeds</h1> Store grain seeds in dry containers.");
    upsertSource(db, html, { status: "downloaded", local_path: "raw/html/semantic.html" });
    upsertSource(db, zim, { status: "downloaded", local_path: "raw/zim/missing.zim" });
    await normalizeAndIndex({ db, libraryRoot: root, sourceId: html.id });
    expect(semanticSearch(db, "grain storage", 1)[0].source_id).toBe(html.id);
    const reconciled = await reconcileLibrary({ db, libraryRoot: root });
    expect(reconciled.missing).toContain("zim-source");
    await fs.writeFile(path.join(root, "tmp", "semantic-source.123.part"), "partial");
    expect((await reconcileLibrary({ db, libraryRoot: root })).partials).toHaveLength(1);
    expect((await cleanupPartials({ db, libraryRoot: root })).removed).toBe(1);
    const kiwix = await writeKiwixLibraryXml({ db, libraryRoot: root });
    expect(kiwix.path).toBe(path.join("indexes", "kiwix-library.xml"));
    db.close();
  });

  it("extracts born-digital PDF text into searchable chunks", async () => {
    const db = openState(root);
    const source = {
      id: "pdf-source",
      title: "PDF Source",
      type: "pdf",
      license: "CC0",
      url: "https://example.test/source.pdf",
      expected_size_bytes: 1,
      runtime: ["index"],
      profiles: ["survival-essential"]
    };
    await fs.mkdir(path.join(root, "raw/pdf"), { recursive: true });
    await fs.writeFile(path.join(root, "raw/pdf/source.pdf"), minimalPdf("Boil water before storage"));
    upsertSource(db, source, { status: "downloaded", local_path: "raw/pdf/source.pdf" });
    const indexed = await normalizeAndIndex({ db, libraryRoot: root, sourceId: source.id });
    expect(indexed.chunks).toBeGreaterThan(0);
    expect(semanticSearch(db, "water storage", 1)[0].source_id).toBe(source.id);
    db.close();
  });

  it("extracts EPUB text into searchable chunks", async () => {
    const db = openState(root);
    const source = {
      id: "epub-source",
      title: "EPUB Source",
      type: "epub",
      license: "CC0",
      url: "https://example.test/source.epub",
      expected_size_bytes: 1,
      runtime: ["index"],
      profiles: ["survival-essential"]
    };
    await fs.mkdir(path.join(root, "raw/epub"), { recursive: true });
    await fs.writeFile(path.join(root, "raw/epub/source.epub"), minimalEpub("Purify water with iodine tablets"));
    upsertSource(db, source, { status: "downloaded", local_path: "raw/epub/source.epub" });
    const indexed = await normalizeAndIndex({ db, libraryRoot: root, sourceId: source.id });
    expect(indexed.chunks).toBeGreaterThan(0);
    expect(semanticSearch(db, "iodine water", 1)[0].source_id).toBe(source.id);
    db.close();
  });
});

function zeroZipCrcFields(buffer) {
  for (let index = 0; index <= buffer.length - 4; index += 1) {
    const signature = buffer.readUInt32LE(index);
    if (signature === 0x04034b50 && index + 18 <= buffer.length) buffer.writeUInt32LE(0, index + 14);
    if (signature === 0x02014b50 && index + 20 <= buffer.length) buffer.writeUInt32LE(0, index + 16);
  }
}

function storedMethodDeflatedZip(files) {
  const locals = [];
  const chunks = [];
  let pos = 0;
  for (const { name, data } of files) {
    const nb = Buffer.from(name, "utf8");
    const deflated = zlib.deflateRawSync(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(0, 10);
    lh.writeUInt32LE(0, 14);
    lh.writeUInt32LE(deflated.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nb.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push({ offset: pos, nb, compSize: deflated.length, size: data.length });
    chunks.push(lh, nb, deflated);
    pos += 30 + nb.length + deflated.length;
  }
  const cdStart = pos;
  for (const { nb, offset, compSize, size } of locals) {
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x0014, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(0, 12);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(compSize, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nb.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    chunks.push(cd, nb);
    pos += 46 + nb.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(locals.length, 8);
  eocd.writeUInt16LE(locals.length, 10);
  eocd.writeUInt32LE(pos - cdStart, 12);
  eocd.writeUInt32LE(cdStart, 16);
  chunks.push(eocd);
  return Buffer.concat(chunks);
}

function minimalPdf(text) {
  // Build a structurally valid PDF so pdf-parse can parse it correctly.
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    `1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj`,
    `2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj`,
    `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj`,
    `4 0 obj<</Length ${stream.length}>>\nstream\n${stream}\nendstream\nendobj`,
    `5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>endobj`
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  for (const o of objs) { offsets.push(out.length); out += o + "\n"; }
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

function minimalEpub(text) {
  return buildZipBuffer([
    { name: "mimetype", data: Buffer.from("application/epub+zip") },
    { name: "chapter1.html", data: Buffer.from(`<html><body><p>${text}</p></body></html>`) }
  ]);
}

function buildZipBuffer(files) {
  const locals = [];
  const chunks = [];
  let pos = 0;
  for (const { name, data } of files) {
    const nb = Buffer.from(name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8);        // STORE (no compression)
    lh.writeUInt32LE(0, 10);       // mod time+date (not checked)
    lh.writeUInt32LE(0, 14);       // CRC (not verified by reader)
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nb.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push({ offset: pos, nb, size: data.length });
    chunks.push(lh, nb, data);
    pos += 30 + nb.length + data.length;
  }
  const cdStart = pos;
  for (let i = 0; i < files.length; i++) {
    const { nb, offset, size } = locals[i];
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x0014, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(0, 16);       // CRC
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nb.length, 28);
    cd.writeUInt32LE(offset, 42);
    chunks.push(cd, nb);
    pos += 46 + nb.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(pos - cdStart, 12);
  eocd.writeUInt32LE(cdStart, 16);
  chunks.push(eocd);
  return Buffer.concat(chunks);
}
