import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { openPath } from "./system.mjs";
import { findAvailablePort, LOCAL_STATIC_PORT, LOCAL_STATIC_PORT_COUNT, startKiwix } from "./services.mjs";
import { now, recordEvent } from "./state.mjs";

const execFileAsync = promisify(execFile);
const runningFileServers = new Map();
const requireFromAppRoot = createRequire(path.join(process.cwd(), "package.json"));
const MarkdownIt = requireFromAppRoot("markdown-it");
const markdownRenderer = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true
});

export function adapterFor(source) {
  const action = source.open?.action;
  if (action === "kiwix_serve" || source.type === "zim") return "kiwix-zim";
  if (action === "extract_serve") return "local-static";
  if (action === "extract_open") return "extract-open";
  if (source.type === "pdf") return "pdf";
  if (source.type === "epub") return "epub";
  if (source.type === "repo-archive") return "archive";
  if (source.type === "html") return "html-static";
  return "file";
}

export function refreshAdapters(db, sources) {
  for (const source of sources) {
    const row = db.prepare("SELECT local_path, status FROM sources WHERE id=?").get(source.id);
    const adapter = adapterFor(source);
    const status = !row?.local_path ? "not_ready" : adapter === "kiwix-zim" ? "ready_for_kiwix" : "ready";
    db.prepare(`
      INSERT INTO adapters (source_id, adapter, status, local_url, port, last_probe_at, last_error)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(source_id) DO UPDATE SET
        adapter=excluded.adapter,
        status=excluded.status,
        local_url=excluded.local_url,
        port=excluded.port,
        last_probe_at=excluded.last_probe_at,
        last_error=NULL
    `).run(source.id, adapter, status, null, null, now());
  }
  return db.prepare("SELECT * FROM adapters ORDER BY source_id").all();
}

export async function sourceOpenPlan({ db, libraryRoot, source }) {
  const row = db.prepare("SELECT * FROM sources WHERE id=?").get(source.id);
  if (!row?.local_path) throw new Error(`Source ${source.id} is not downloaded`);
  const localPath = path.join(libraryRoot, row.local_path);
  const action = source.open?.action ?? defaultOpenAction(source);
  const extractDir = path.join(libraryRoot, "opened", source.id);
  const extractedBytes = action.startsWith("extract_") ? await estimateArchiveBytes(localPath) : 0;
  const existingExtractedBytes = action.startsWith("extract_") ? await directoryBytes(extractDir) : 0;
  const additionalBytes = Math.max(0, extractedBytes - existingExtractedBytes);
  const steps = buildSteps(source, action, {
    localPath: row.local_path,
    extractDir: path.relative(libraryRoot, extractDir),
    entry: source.open?.entry,
    extractedBytes,
    additionalBytes
  });
  return {
    sourceId: source.id,
    title: source.title,
    action,
    adapter: adapterFor(source),
    steps,
    localPath: row.local_path,
    finalTarget: finalTargetDescription(source, action, extractDir),
    extractedBytes,
    additionalBytes
  };
}

export async function openSourceWithAdapter({ db, libraryRoot, source, kiwixPort = 8089 }) {
  const plan = await sourceOpenPlan({ db, libraryRoot, source });
  const row = db.prepare("SELECT * FROM sources WHERE id=?").get(source.id);
  const localPath = path.join(libraryRoot, row.local_path);
  const action = plan.action;
  if (action === "kiwix_serve") {
    await assertUsableFile(localPath, `${source.id} downloaded ZIM`);
    const zimRows = db.prepare("SELECT local_path FROM sources WHERE local_path IS NOT NULL AND type='zim'").all();
    const zimPaths = await usableZimPaths(libraryRoot, zimRows);
    if (!zimPaths.includes(localPath)) throw new Error(`Source ${source.id} is not a usable ZIM file`);
    const service = await startKiwix(db, zimPaths, kiwixPort, { logPath: path.join(libraryRoot, "logs", "kiwix.log") });
    const url = zimContentUrl(service.url, localPath);
    openPath(url);
    db.prepare("UPDATE adapters SET status=?, local_url=?, port=?, last_probe_at=? WHERE source_id=?").run("running", url, service.port, now(), source.id);
    recordEvent(db, "adapter-open", `Opened ${source.title} through Kiwix adapter`, { sourceId: source.id, url, plan });
    return { ...plan, adapter: "kiwix-zim", url };
  }
  if (action === "extract_open" || action === "extract_serve") {
    const extractDir = path.join(libraryRoot, "opened", source.id);
    await extractArchive(localPath, extractDir);
    if (action === "extract_serve") {
      const root = safeJoin(extractDir, source.open?.entry ?? "");
      await assertUsableDirectory(root, `${source.id} configured open entry`);
      const server = await startFileServer(source.id, root);
      const url = server.url;
      openPath(url);
      db.prepare("UPDATE adapters SET status=?, local_url=?, port=?, last_probe_at=? WHERE source_id=?").run("running", url, server.port, now(), source.id);
      recordEvent(db, "adapter-open", `Extracted and served ${source.title}`, { sourceId: source.id, url, plan });
      return { ...plan, adapter: "local-static", url, port: server.port, extractedTo: path.relative(libraryRoot, extractDir) };
    }
    const finalPath = safeJoin(extractDir, source.open?.entry ?? "");
    await assertUsableFile(finalPath, `${source.id} configured open entry`);
    const opened = openPath(finalPath);
    db.prepare("UPDATE adapters SET status=?, last_probe_at=? WHERE source_id=?").run("opened", now(), source.id);
    recordEvent(db, "adapter-open", `Extracted and opened ${source.title}`, { sourceId: source.id, path: path.relative(libraryRoot, finalPath), plan });
    return { ...plan, adapter: "extract-open", opened: path.relative(libraryRoot, finalPath), system: opened };
  }
  await assertUsableFile(localPath, `${source.id} downloaded file`);
  const opened = openPath(localPath);
  db.prepare("UPDATE adapters SET status=?, last_probe_at=? WHERE source_id=?").run("opened", now(), source.id);
  recordEvent(db, "adapter-open", `Opened ${source.title}`, { sourceId: source.id, path: row.local_path, plan });
  return { ...plan, adapter: adapterFor(source), opened: row.local_path, system: opened };
}

export async function openSearchResult({ db, libraryRoot, source, resultPath, kiwixPort = 8089 }) {
  const row = db.prepare("SELECT * FROM sources WHERE id=?").get(source.id);
  if (!row?.local_path) throw new Error(`Source ${source.id} is not downloaded`);
  const relativeResultPath = String(resultPath ?? "");
  const action = source.open?.action ?? defaultOpenAction(source);

  if (action === "kiwix_serve" || source.type === "zim") {
    const localPath = path.join(libraryRoot, row.local_path);
    const entryPath = zimEntryPathFromSearchPath(relativeResultPath, row.local_path);
    if (!entryPath) return openSourceWithAdapter({ db, libraryRoot, source, kiwixPort });
    await assertUsableFile(localPath, `${source.id} downloaded ZIM`);
    const zimRows = db.prepare("SELECT local_path FROM sources WHERE local_path IS NOT NULL AND type='zim'").all();
    const zimPaths = await usableZimPaths(libraryRoot, zimRows);
    const service = await startKiwix(db, zimPaths, kiwixPort, { logPath: path.join(libraryRoot, "logs", "kiwix.log") });
    const url = `${zimContentUrl(service.url, localPath)}/${encodePosixPathForUrl(entryPath)}`;
    openPath(url);
    db.prepare("UPDATE adapters SET status=?, local_url=?, port=?, last_probe_at=? WHERE source_id=?").run("running", url, service.port, now(), source.id);
    recordEvent(db, "search-open", `Opened ZIM search result for ${source.title}`, { sourceId: source.id, path: relativeResultPath, url });
    return { sourceId: source.id, title: source.title, action: "open_search_result", adapter: "kiwix-zim", path: relativeResultPath, url };
  }

  const target = relativeResultPath ? safeJoin(libraryRoot, relativeResultPath) : null;
  const targetStat = target ? await fsp.stat(target).catch(() => null) : null;

  if (action === "extract_serve") {
    const localPath = path.join(libraryRoot, row.local_path);
    const extractDir = path.join(libraryRoot, "opened", source.id);
    await extractArchive(localPath, extractDir);
    const root = safeJoin(extractDir, source.open?.entry ?? "");
    await assertUsableDirectory(root, `${source.id} configured open entry`);
    const server = await startFileServer(source.id, root);
    const url = targetStat && target.startsWith(root)
      ? `${server.url}${encodePathForUrl(path.relative(root, target))}${targetStat.isDirectory() ? "/" : ""}`
      : server.url;
    openPath(url);
    db.prepare("UPDATE adapters SET status=?, local_url=?, port=?, last_probe_at=? WHERE source_id=?").run("running", url, server.port, now(), source.id);
    recordEvent(db, "search-open", `Opened search result for ${source.title}`, { sourceId: source.id, path: relativeResultPath, url });
    return { sourceId: source.id, title: source.title, action: "open_search_result", adapter: "local-static", path: relativeResultPath, url, port: server.port };
  }

  if (targetStat?.isFile()) {
    const opened = openPath(target);
    db.prepare("UPDATE adapters SET status=?, last_probe_at=? WHERE source_id=?").run("opened", now(), source.id);
    recordEvent(db, "search-open", `Opened search result file for ${source.title}`, { sourceId: source.id, path: relativeResultPath });
    return { sourceId: source.id, title: source.title, action: "open_search_result", adapter: adapterFor(source), path: relativeResultPath, system: opened };
  }

  return openSourceWithAdapter({ db, libraryRoot, source, kiwixPort });
}

export async function prepareSourceForUse({ db, libraryRoot, source }) {
  const plan = await sourceOpenPlan({ db, libraryRoot, source });
  const row = db.prepare("SELECT * FROM sources WHERE id=?").get(source.id);
  const localPath = path.join(libraryRoot, row.local_path);
  if (plan.action === "kiwix_serve") {
    await assertUsableFile(localPath, `${source.id} downloaded ZIM`);
    db.prepare("UPDATE adapters SET status=?, last_probe_at=? WHERE source_id=?").run("ready_for_kiwix", now(), source.id);
    return { sourceId: source.id, action: plan.action, prepared: "kiwix-ready" };
  }
  if (plan.action === "extract_open" || plan.action === "extract_serve") {
    const extractDir = path.join(libraryRoot, "opened", source.id);
    await extractArchive(localPath, extractDir);
    if (plan.action === "extract_serve") {
      const root = safeJoin(extractDir, source.open?.entry ?? "");
      await assertUsableDirectory(root, `${source.id} configured open entry`);
      db.prepare("UPDATE adapters SET status=?, last_probe_at=? WHERE source_id=?").run("ready", now(), source.id);
      return { sourceId: source.id, action: plan.action, prepared: path.relative(libraryRoot, root) };
    }
    const finalPath = safeJoin(extractDir, source.open?.entry ?? "");
    await assertUsableFile(finalPath, `${source.id} configured open entry`);
    db.prepare("UPDATE adapters SET status=?, last_probe_at=? WHERE source_id=?").run("ready", now(), source.id);
    return { sourceId: source.id, action: plan.action, prepared: path.relative(libraryRoot, finalPath) };
  }
  await assertUsableFile(localPath, `${source.id} downloaded file`);
  db.prepare("UPDATE adapters SET status=?, last_probe_at=? WHERE source_id=?").run("ready", now(), source.id);
  return { sourceId: source.id, action: plan.action, prepared: row.local_path };
}

function defaultOpenAction(source) {
  if (source.type === "zim") return "kiwix_serve";
  if (source.type === "repo-archive") return "extract_open";
  return "direct_open";
}

function buildSteps(source, action, context) {
  if (action === "kiwix_serve") {
    return [
      `Use downloaded ZIM file ${context.localPath}.`,
      "Start or reuse the local Kiwix server bound to 127.0.0.1.",
      "Open the local Kiwix URL in your browser."
    ];
  }
  if (action === "extract_serve") {
    return [
      `Extract ${context.localPath} into ${context.extractDir}.`,
      `Serve ${context.entry ?? "the extracted folder"} on 127.0.0.1 with a local static server.`,
      "Open the local browser URL."
    ];
  }
  if (action === "extract_open") {
    return [
      `Extract ${context.localPath} into ${context.extractDir}.`,
      `Open ${context.entry ?? "the configured extracted file"} with the system viewer.`
    ];
  }
  return [`Open ${context.localPath} with the system viewer.`];
}

function finalTargetDescription(source, action, extractDir) {
  if (action === "kiwix_serve") return "Local Kiwix browser page";
  if (action === "extract_serve") return `Local static browser page for ${source.open?.entry ?? "extracted content"}`;
  if (action === "extract_open") return path.join(path.relative(process.cwd(), extractDir), source.open?.entry ?? "");
  return "Downloaded file";
}

function zimContentUrl(baseUrl, zimPath) {
  const contentId = path.basename(zimPath, path.extname(zimPath));
  return `${baseUrl.replace(/\/$/, "")}/content/${encodeURIComponent(contentId)}`;
}

function zimEntryPathFromSearchPath(resultPath, localPath) {
  const prefix = `${localPath}#`;
  if (!resultPath.startsWith(prefix)) return "";
  return resultPath.slice(prefix.length).replace(/^\/+/, "");
}

async function estimateArchiveBytes(file) {
  if (!file.endsWith(".zip")) return (await fsp.stat(file)).size;
  const { stdout } = await execFileAsync("unzip", ["-l", file], { maxBuffer: 20 * 1024 * 1024 });
  const lines = stdout.trim().split(/\r?\n/).reverse();
  const summary = lines.find((line) => /\d+\s+files?$/.test(line));
  const match = summary?.match(/^\s*(\d+)\s+/);
  return match ? Number(match[1]) : (await fsp.stat(file)).size;
}

async function extractArchive(file, destination) {
  if (!file.endsWith(".zip")) throw new Error(`Cannot extract unsupported archive type: ${path.extname(file)}`);
  await fsp.mkdir(destination, { recursive: true });
  await execFileAsync("unzip", ["-oq", file, "-d", destination], { maxBuffer: 20 * 1024 * 1024 });
}

async function directoryBytes(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(full);
    if (entry.isFile()) total += (await fsp.stat(full)).size;
  }
  return total;
}

async function usableZimPaths(libraryRoot, rows) {
  const paths = [];
  for (const row of rows) {
    const file = path.join(libraryRoot, row.local_path);
    if (path.extname(file).toLowerCase() !== ".zim") continue;
    const stat = await fsp.stat(file).catch(() => null);
    if (stat?.isFile() && stat.size > 0) paths.push(file);
  }
  return paths;
}

async function assertUsableFile(file, label) {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat) throw new Error(`${label} does not exist: ${file}`);
  if (!stat.isFile()) throw new Error(`${label} is not a file: ${file}`);
  if (stat.size <= 0) throw new Error(`${label} is empty: ${file}`);
}

async function assertUsableDirectory(dir, label) {
  const stat = await fsp.stat(dir).catch(() => null);
  if (!stat) throw new Error(`${label} does not exist: ${dir}`);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${dir}`);
  if (!(await hasUsableContent(dir))) throw new Error(`${label} has no usable content: ${dir}`);
}

async function hasUsableContent(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isFile() && (await fsp.stat(full)).size > 0) return true;
    if (entry.isDirectory() && await hasUsableContent(full)) return true;
  }
  return false;
}

function safeJoin(root, relativePath) {
  const full = path.resolve(root, relativePath || ".");
  const resolvedRoot = path.resolve(root);
  if (full !== resolvedRoot && !full.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Unsafe open path ${relativePath}`);
  return full;
}

function encodePathForUrl(relativePath) {
  return relativePath.split(path.sep).filter(Boolean).map(encodeURIComponent).join("/");
}

function encodePosixPathForUrl(relativePath) {
  return relativePath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

export async function startLocalStaticServerForTest(sourceId, root) {
  return startFileServer(sourceId, root);
}

async function startFileServer(sourceId, root) {
  if (runningFileServers.has(sourceId)) {
    const existing = runningFileServers.get(sourceId);
    if (existing.root === root) return existing;
    existing.server?.close();
    runningFileServers.delete(sourceId);
  }
  const port = await findAvailablePort(LOCAL_STATIC_PORT, "127.0.0.1", LOCAL_STATIC_PORT_COUNT);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const decoded = decodeURIComponent(url.pathname);
      const target = await resolveRequestTarget(root, decoded === "/" ? "" : decoded.slice(1));
      const stat = await fsp.stat(target);
      if (stat.isDirectory()) return sendDirectoryOrIndex(res, root, target, url.pathname);
      const content = await fsp.readFile(target);
      if (path.extname(target).toLowerCase() === ".md") return sendMarkdown(res, root, target, content.toString("utf8"));
      if (isHtmlPath(target)) return sendHtml(res, root, target, content.toString("utf8"));
      res.writeHead(200, { "content-type": contentType(target) });
      res.end(content);
    } catch (error) {
      if (error.code === "SCA_NOT_FOUND") return sendMissingLocalPage(res, root, error.requestPath);
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(error.message ?? error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const info = { port, url: `http://127.0.0.1:${port}/`, root, server };
  runningFileServers.set(sourceId, info);
  return info;
}

async function resolveRequestTarget(root, requestPath) {
  const target = safeJoin(root, requestPath);
  if (await pathExists(target)) return target;
  if (!path.extname(target)) {
    const markdownTarget = safeJoin(root, `${requestPath}.md`);
    if (await pathExists(markdownTarget)) return markdownTarget;
  }
  const error = new Error(`Local wiki page not found: ${requestPath}`);
  error.code = "SCA_NOT_FOUND";
  error.requestPath = requestPath;
  throw error;
}

async function pathExists(file) {
  return Boolean(await fsp.stat(file).catch(() => null));
}

async function sendDirectoryOrIndex(res, root, dir, requestPath) {
  for (const indexName of ["index.html", "Home.md", "README.md"]) {
    const indexPath = path.join(dir, indexName);
    const stat = await fsp.stat(indexPath).catch(() => null);
    if (!stat?.isFile()) continue;
    const content = await fsp.readFile(indexPath);
    if (indexName.endsWith(".md")) return sendMarkdown(res, root, indexPath, content.toString("utf8"));
    return sendHtml(res, root, indexPath, content.toString("utf8"));
  }
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const items = entries.map((entry) => {
    const suffix = entry.isDirectory() ? "/" : "";
    const href = path.posix.join(requestPath, entry.name) + suffix;
    return `<li><a href="${escapeHtml(href)}">${escapeHtml(entry.name)}${suffix}</a></li>`;
  }).join("");
  const title = path.relative(root, dir) || "Index";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(readerDocument({
    title,
    nav: markdownDirectoryNav(root, dir),
    body: `<h1>${escapeHtml(title)}</h1><ul class="directoryList">${items}</ul>`
  }));
}

function sendMissingLocalPage(res, root, requestPath) {
  const nav = markdownDirectoryNav(root, root);
  const title = path.basename(requestPath || "Missing page");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(readerDocument({
    title: `${title} not found`,
    nav,
    body: `<h1>Page not included in this offline source</h1><p>The local link <code>${escapeHtml(requestPath || "/")}</code> points to a page that is not present in the downloaded wiki archive.</p><p>Use the navigation list to continue reading the available offline pages.</p>`
  }));
}

function sendMarkdown(res, root, file, markdown) {
  const title = path.basename(file, ".md");
  const nav = markdownDirectoryNav(root, path.dirname(file));
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(readerDocument({ title, nav, body: markdownRenderer.render(markdown) }));
}

function sendHtml(res, root, file, html) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(enhanceHtmlPage({ html, title: path.basename(file, path.extname(file)), nav: markdownDirectoryNav(root, path.dirname(file)) }));
}

function markdownDirectoryNav(root, dir) {
  try {
    const files = fs.readdirSync(dir).filter((name) => name.endsWith(".md") && !name.startsWith("_")).sort();
    return files.map((name) => `<a href="${escapeHtml(relativeHref(root, path.join(dir, name)))}">${escapeHtml(path.basename(name, ".md"))}</a>`).join("");
  } catch {
    return "";
  }
}

function relativeHref(root, file) {
  return `/${path.relative(root, file).split(path.sep).map(encodeURIComponent).join("/")}`;
}

function isHtmlPath(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === ".html" || ext === ".htm" || ext === ".xhtml";
}

function enhanceHtmlPage({ html, title, nav }) {
  if (!/<html[\s>]/i.test(html)) return readerDocument({ title, nav, body: html });
  const style = `<style id="offline-survival-reader-style">${readerCss()}</style>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${style}</head>`);
  return html.replace(/<body[^>]*>/i, (match) => `${match}${style}`);
}

function readerDocument({ title, nav, body }) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${readerCss()}</style>
</head>
<body>
  <main class="offlineReader">
    <nav class="readerNav">${nav || "<span>Offline source</span>"}</nav>
    <article class="readerArticle">${body}</article>
  </main>
</body>
</html>`;
}

function readerCss() {
  return `
    :root{color-scheme:light;--bg:#f5f7f2;--paper:#fff;--ink:#17201a;--muted:#5e6b60;--line:#d9e0d5;--accent:#286044;--accent-soft:#e8f1eb;--code:#eef3ea}
    body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.62 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .offlineReader{display:grid;grid-template-columns:minmax(190px,280px) minmax(0,920px);gap:28px;box-sizing:border-box;max-width:1280px;margin:0 auto;padding:24px}
    .readerNav{position:sticky;top:0;align-self:start;max-height:calc(100vh - 48px);overflow:auto;border-right:1px solid var(--line);padding:4px 18px 4px 0;color:var(--muted)}
    .readerNav a{display:block;color:var(--accent);text-decoration:none;border-radius:6px;padding:4px 6px;margin:1px 0;overflow-wrap:anywhere}
    .readerNav a:hover,.readerNav a:focus{background:var(--accent-soft);outline:none}
    .readerArticle{min-width:0;background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:28px;box-shadow:0 1px 2px rgba(20,30,20,.04)}
    .readerArticle>:first-child{margin-top:0}
    h1,h2,h3,h4,h5,h6{line-height:1.22;margin:1.35em 0 .55em;color:#102018}
    h1{font-size:2rem;border-bottom:1px solid var(--line);padding-bottom:.35em} h2{font-size:1.55rem} h3{font-size:1.25rem}
    a{color:var(--accent)} p,ul,ol,blockquote,pre,table{margin:0 0 1em}
    ul,ol{padding-left:1.45em} li+li{margin-top:.25em}
    blockquote{border-left:4px solid var(--line);padding:.3em 0 .3em 1em;color:var(--muted);background:#fafbf8}
    code{background:var(--code);border:1px solid #dfe7da;border-radius:4px;padding:.1em .28em;font-size:.92em}
    pre{overflow:auto;background:#101713;color:#edf5ee;border-radius:8px;padding:14px} pre code{background:transparent;border:0;color:inherit;padding:0}
    table{border-collapse:collapse;width:100%;display:block;overflow:auto} th,td{border:1px solid var(--line);padding:7px 9px;text-align:left} th{background:var(--accent-soft)}
    img,video,iframe{max-width:100%;height:auto} hr{border:0;border-top:1px solid var(--line);margin:2em 0}
    .directoryList{columns:2;list-style:none;padding:0}.directoryList li{break-inside:avoid;margin:0 0 .35em}
    @media(max-width:820px){.offlineReader{grid-template-columns:1fr;padding:14px}.readerNav{position:static;max-height:220px;border-right:0;border-bottom:1px solid var(--line);padding:0 0 12px}.readerArticle{padding:18px}h1{font-size:1.65rem}.directoryList{columns:1}}
  `;
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".html" || ext === ".xhtml") return "text/html; charset=utf-8";
  if (ext === ".md" || ext === ".txt") return "text/plain; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]));
}
