import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSourceWithAdapter, refreshAdapters, sourceOpenPlan } from "../app/backend/adapters.mjs";
import { writeAttributionReport } from "../app/backend/license.mjs";
import { cleanupPartials, reconcileLibrary, writeKiwixLibraryXml } from "../app/backend/recovery.mjs";
import { ensureLibrary, openState, upsertSource } from "../app/backend/state.mjs";
import { indexDownloadedSources, normalizeAndIndex, semanticSearch } from "../app/backend/indexer.mjs";
import { KIWIX_PORT, KIWIX_PORT_COUNT, LOCAL_STATIC_PORT, LOCAL_STATIC_PORT_COUNT } from "../app/backend/services.mjs";

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
});

function minimalPdf(text) {
  return `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>
endobj
4 0 obj
<< /Length ${text.length + 20} >>
stream
BT /F1 12 Tf (${text}) Tj ET
endstream
endobj
trailer << /Root 1 0 R >>
%%EOF`;
}
