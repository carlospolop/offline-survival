import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadCatalog } from "./catalog.mjs";
import { downloadProfile, downloadSource, pauseDownload, retryDownload, verifySource } from "./downloader.mjs";
import { indexDownloadedSources, normalizeAndIndex, search, semanticSearch } from "./indexer.mjs";
import { exportManifest, integrityReport, writeLock } from "./archive.mjs";
import { openSearchResult, openSourceWithAdapter, prepareSourceForUse, refreshAdapters, sourceOpenPlan } from "./adapters.mjs";
import { writeAttributionReport } from "./license.mjs";
import { installRecommendedAi, ollamaInstallPlan, pullModel, refreshModels } from "./models.mjs";
import { cleanupPartials, reconcileLibrary, writeKiwixLibraryXml } from "./recovery.mjs";
import { buildPortableLayout, buildSharePackage, writeReleaseChecksums } from "./release.mjs";
import { reviewSource, sourceReviewSummary } from "./review.mjs";
import { importExtraKnowledgeFiles, scanExtraKnowledgeFolder, supportedExtraKnowledgeExtensions } from "./extraKnowledge.mjs";
import { askOllama, serviceStatus, startKiwix, startOllama, stopService, upsertService } from "./services.mjs";
import { systemInfo } from "./system.mjs";
import { defaultLibraryRoot, ensureLibrary, markInterruptedDownloads, openState, removeSourcesNotInCatalog, setSetting, summarizeState, upsertModel, upsertSource } from "./state.mjs";
import { refreshCatalogSnapshot, updateStatus } from "./updates.mjs";

const port = Number(process.env.PORT ?? 8787);
const root = process.cwd();
const backendDir = path.dirname(fileURLToPath(import.meta.url));
const staticDirCandidates = [
  path.join(root, "app/ui/dist"),
  path.join(root, "ui/dist"),
  path.join(backendDir, "../ui/dist")
];
const devIndexCandidates = [
  path.join(root, "app/ui/index.html"),
  path.join(root, "ui/index.html"),
  path.join(backendDir, "../ui/index.html")
];
const cleanableLibraryDirs = ["raw", "opened", "normalized", "chunks", "indexes", "services", "logs", "tmp"];
const allDownloadedShareProfileId = "all-downloaded";
const execFileAsync = promisify(execFile);

let libraryRoot = process.env.SCA_LIBRARY_ROOT ? path.resolve(process.env.SCA_LIBRARY_ROOT) : defaultLibraryRoot();
await ensureLibrary(libraryRoot);
configureManagedRuntimes();
{
  const db = openState(libraryRoot);
  markInterruptedDownloads(db);
  db.close();
}
await syncCatalog();

async function syncCatalog() {
  configureManagedRuntimes();
  const catalog = await loadCatalog();
  const db = openState(libraryRoot);
  removeSourcesNotInCatalog(db, catalog.sources);
  for (const source of catalog.sources) upsertSource(db, source);
  for (const model of catalog.models) upsertModel(db, model);
  refreshAdapters(db, catalog.sources);
  setSetting(db, "libraryRoot", libraryRoot);
  const settings = db.prepare("SELECT key FROM settings WHERE key='lanSharing'").get();
  if (!settings) setSetting(db, "lanSharing", { enabled: false, bind: "127.0.0.1" });
  db.close();
}

function configureManagedRuntimes() {
  const ollamaBin = managedOllamaPath(libraryRoot);
  if (ollamaBin && fsSync.existsSync(ollamaBin)) process.env.SCA_OLLAMA_BIN = ollamaBin;
  else if (process.env.SCA_OLLAMA_BIN?.includes(path.join("raw", "runtimes", "ollama"))) delete process.env.SCA_OLLAMA_BIN;
  process.env.SCA_OLLAMA_MODELS = path.join(libraryRoot, "raw", "models", "ollama");
}

function managedOllamaPath(root) {
  try {
    return path.join(root, "raw", "runtimes", "ollama", ollamaInstallPlan(process.platform, process.arch).bin);
  } catch {
    return null;
  }
}

async function json(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function send(res, status, body, headers = {}) {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json",
    ...headers
  });
  res.end(data);
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function validateProfileLanguage(profiles, language) {
  if (!language) return;
  if (!["en", "es", "both"].includes(String(language))) throw new Error(`Invalid content language ${language}`);
  const mismatches = profiles.filter((profile) => profile.language !== language);
  if (mismatches.length) throw new Error(`Selected profiles do not match content language ${language}: ${mismatches.map((profile) => profile.id).join(", ")}`);
}

async function withDb(work) {
  const db = openState(libraryRoot);
  try {
    return await work(db);
  } finally {
    db.close();
  }
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "OPTIONS") return send(res, 204, "");
    if (url.pathname === "/api/health") return send(res, 200, {
      status: "ok",
      pid: process.pid,
      port,
      packaged: process.env.SCA_PACKAGED === "1",
      token: process.env.SCA_BACKEND_TOKEN ?? "",
      backendDir
    });
    if (url.pathname === "/api/catalog") return send(res, 200, await loadCatalog());
    if (url.pathname === "/api/system") {
      const catalog = await loadCatalog();
      return send(res, 200, await systemInfo(libraryRoot, catalog.profiles, catalog.models));
    }
    if (url.pathname === "/api/state") {
      const state = await withDb((db) => summarizeState(db));
      return send(res, 200, state);
    }
    if (url.pathname === "/api/library" && req.method === "POST") {
      const body = await json(req);
      libraryRoot = path.resolve(body.path || defaultLibraryRoot());
      await ensureLibrary(libraryRoot);
      await syncCatalog();
      return send(res, 200, { libraryRoot });
    }
    if (url.pathname === "/api/settings/network" && req.method === "POST") {
      const body = await json(req);
      if (body.enabled) throw new Error("LAN sharing is intentionally disabled in this v1 build; services remain bound to 127.0.0.1.");
      await withDb((db) => setSetting(db, "lanSharing", { enabled: false, bind: "127.0.0.1" }));
      return send(res, 200, { enabled: false, bind: "127.0.0.1" });
    }
    if (url.pathname === "/api/download" && req.method === "POST") {
      const body = await json(req);
      const catalog = await loadCatalog();
      const source = catalog.sources.find((item) => item.id === body.sourceId);
      if (!source) throw new Error(`Unknown source ${body.sourceId}`);
      const result = await withDb((db) => downloadSource({ db, libraryRoot, source, diskBudgetBytes: optionalNumber(body.diskBudgetBytes) }));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/profile/download" && req.method === "POST") {
      const body = await json(req);
      const catalog = await loadCatalog();
      const profile = catalog.profiles.find((item) => item.id === body.profileId);
      if (!profile) throw new Error(`Unknown profile ${body.profileId}`);
      validateProfileLanguage([profile], body.contentLanguage);
      const result = await withDb((db) => downloadProfile({ db, libraryRoot, profile, sources: catalog.sources, diskBudgetBytes: optionalNumber(body.diskBudgetBytes), concurrency: Number(body.concurrency ?? 4) }));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/easy-install" && req.method === "POST") {
      const body = await json(req);
      const catalog = await loadCatalog();
      const selectedProfiles = (Array.isArray(body.profileIds) ? body.profileIds : [])
        .map((id) => catalog.profiles.find((profile) => profile.id === id))
        .filter(Boolean);
      if (!selectedProfiles.length && !body.installAi) throw new Error("Select at least one profile or Local AI install");
      validateProfileLanguage(selectedProfiles, body.contentLanguage);
      const result = await withDb((db) => easyInstall({ db, catalog, selectedProfiles, installAi: Boolean(body.installAi), concurrency: Number(body.concurrency ?? 4) }));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/clean-sources" && req.method === "POST") {
      const result = await withDb((db) => cleanSources(db));
      await ensureLibrary(libraryRoot);
      await syncCatalog();
      return send(res, 200, result);
    }
    if (url.pathname === "/api/download/pause" && req.method === "POST") {
      const body = await json(req);
      const result = await withDb((db) => pauseDownload(db, body.sourceId));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/download/retry" && req.method === "POST") {
      const body = await json(req);
      const catalog = await loadCatalog();
      const source = catalog.sources.find((item) => item.id === body.sourceId);
      if (!source) throw new Error(`Unknown source ${body.sourceId}`);
      const result = await withDb((db) => retryDownload({ db, libraryRoot, source, diskBudgetBytes: optionalNumber(body.diskBudgetBytes) }));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/verify" && req.method === "POST") {
      const body = await json(req);
      const result = await withDb((db) => verifySource({ db, libraryRoot, sourceId: body.sourceId }));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/index" && req.method === "POST") {
      const body = await json(req);
      const catalog = await loadCatalog();
      const result = await withDb((db) => normalizeAndIndex({ db, libraryRoot, sourceId: body.sourceId, sourceConfig: sourceConfigForRequest(db, catalog, body.sourceId) }));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/index/downloaded" && req.method === "POST") {
      const catalog = await loadCatalog();
      const result = await withDb((db) => indexDownloadedSources({ db, libraryRoot, catalogSources: catalog.sources }));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/search") {
      const results = await withDb((db) => search(db, url.searchParams.get("q") ?? "", Number(url.searchParams.get("limit") ?? 20), {
        sourceId: url.searchParams.get("sourceId") || undefined,
        license: url.searchParams.get("license") || undefined,
        category: url.searchParams.get("category") || undefined
      }));
      return send(res, 200, { results });
    }
    if (url.pathname === "/api/search/semantic") {
      const results = await withDb((db) => semanticSearch(db, url.searchParams.get("q") ?? "", Number(url.searchParams.get("limit") ?? 20)));
      return send(res, 200, { results });
    }
    if (url.pathname === "/api/search/open" && req.method === "POST") {
      const body = await json(req);
      const catalog = await loadCatalog();
      const result = await withDb((db) => openSearchResult({
        db,
        libraryRoot,
        source: sourceConfigForRequest(db, catalog, body.sourceId),
        resultPath: body.path
      }));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/source/open" && req.method === "POST") {
      const body = await json(req);
      const catalog = await loadCatalog();
      const result = await withDb((db) => openSourceWithAdapter({ db, libraryRoot, source: sourceConfigForRequest(db, catalog, body.sourceId) }));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/source/open-plan" && req.method === "POST") {
      const body = await json(req);
      const catalog = await loadCatalog();
      const result = await withDb((db) => sourceOpenPlan({ db, libraryRoot, source: sourceConfigForRequest(db, catalog, body.sourceId) }));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/extra-knowledge/supported") {
      return send(res, 200, { extensions: supportedExtraKnowledgeExtensions() });
    }
    if (url.pathname === "/api/folder/pick" && req.method === "POST") {
      return send(res, 200, await pickFolder());
    }
    if (url.pathname === "/api/extra-knowledge/scan" && req.method === "POST") {
      const body = await json(req);
      const result = await scanExtraKnowledgeFolder({ folderPath: body.folderPath, maxFiles: Number(body.maxFiles ?? 5000) });
      return send(res, 200, result);
    }
    if (url.pathname === "/api/extra-knowledge/import" && req.method === "POST") {
      const body = await json(req);
      const result = await withDb(async (db) => {
        const imported = await importExtraKnowledgeFiles({ db, libraryRoot, files: Array.isArray(body.files) ? body.files : [], index: body.index !== false });
        refreshAdapters(db, imported.imported);
        return imported;
      });
      return send(res, 200, result);
    }
    if (url.pathname === "/api/adapters/refresh") {
      const catalog = await loadCatalog();
      const adapters = await withDb((db) => refreshAdapters(db, catalog.sources));
      return send(res, 200, { adapters });
    }
    if (url.pathname === "/api/services") {
      const services = await withDb((db) => serviceStatus(db));
      return send(res, 200, { services });
    }
    if (url.pathname === "/api/models/refresh") {
      const catalog = await loadCatalog();
      const models = await withDb(async (db) => {
        for (const model of catalog.models) upsertModel(db, model);
        return refreshModels(db, catalog.models);
      });
      return send(res, 200, { models });
    }
    if (url.pathname === "/api/model/pull" && req.method === "POST") {
      const body = await json(req);
      const catalog = await loadCatalog();
      const model = catalog.models.find((item) => item.id === body.modelId);
      if (!model) throw new Error(`Unknown model ${body.modelId}`);
      const result = await withDb((db) => pullModel(db, model));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/ai/install-recommended" && req.method === "POST") {
      const body = await json(req);
      const catalog = await loadCatalog();
      const requestedIds = Array.isArray(body.modelIds) ? body.modelIds : [];
      let models = requestedIds.map((id) => catalog.models.find((item) => item.id === id)).filter(Boolean);
      if (!models.length) {
        const info = await systemInfo(libraryRoot, catalog.profiles, catalog.models);
        const recommended = new Set(info.aiRecommendation ?? []);
        models = catalog.models.filter((model) => recommended.has(model.id) || recommended.has(model.pull));
      }
      if (!models.length) throw new Error("No recommended models were selected for installation");
      const { result, refreshed } = await withDb(async (db) => {
        for (const model of catalog.models) upsertModel(db, model);
        const result = await installRecommendedAi({ db, libraryRoot, models });
        const refreshed = await refreshModels(db, catalog.models);
        return { result, refreshed };
      });
      return send(res, 200, { ...result, catalogModels: refreshed });
    }
    if (url.pathname === "/api/kiwix/start" && req.method === "POST") {
      const body = await json(req);
      const result = await withDb(async (db) => {
        const zimPaths = db.prepare("SELECT local_path FROM sources WHERE type='zim' AND local_path IS NOT NULL").all().map((row) => path.join(libraryRoot, row.local_path));
        return startKiwix(db, zimPaths, Number(body.port ?? 8089), { logPath: path.join(libraryRoot, "logs", "kiwix.log") });
      });
      return send(res, 200, result);
    }
    if (url.pathname === "/api/ollama/start" && req.method === "POST") {
      const body = await json(req);
      const catalog = await loadCatalog();
      try {
        const result = await withDb(async (db) => {
          for (const model of catalog.models) upsertModel(db, model);
          await refreshModels(db, catalog.models);
          const model = selectedChatModel(db, body.model, catalog.models);
          if (!model) throw new Error("Install a chat model before starting Local AI.");
          return startOllama(db, {
            modelsDir: path.join(libraryRoot, "raw", "models", "ollama"),
            logPath: path.join(libraryRoot, "logs", "ollama.log"),
            model
          });
        });
        return send(res, 200, result);
      } catch (error) {
        if (error.code !== "SCA_OLLAMA_MEMORY_BLOCKED") throw error;
        return send(res, 200, {
          status: "blocked",
          message: String(error.message ?? error),
          memory: error.memory,
          requiredBytes: error.requiredBytes
        });
      }
    }
    if (url.pathname === "/api/service/stop" && req.method === "POST") {
      const body = await json(req);
      const result = await withDb((db) => stopService(db, body.name));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/ask" && req.method === "POST") {
      const body = await json(req);
      const catalog = await loadCatalog();
      const contexts = await withDb((db) => retrieveAskContexts(db, body));
      if (!contexts.length) return send(res, 200, await askOllama({ question: body.question, contexts, model: body.model ?? "qwen3:8b" }));
      let model;
      try {
        model = await withDb(async (db) => {
          for (const model of catalog.models) upsertModel(db, model);
          await refreshModels(db, catalog.models);
          const chatModel = selectedChatModel(db, body.model);
          if (!chatModel) return body.model ?? "qwen3:8b";
          try {
            await startOllama(db, {
              modelsDir: path.join(libraryRoot, "raw", "models", "ollama"),
              logPath: path.join(libraryRoot, "logs", "ollama.log"),
              model: chatModel
            });
          } catch (error) {
            if (error.code === "SCA_OLLAMA_MEMORY_BLOCKED") throw error;
            return body.model ?? chatModel.pull ?? "qwen3:8b";
          }
          await refreshModels(db, catalog.models);
          return body.model ?? installedChatModelPull(db) ?? chatModel.pull ?? "qwen3:8b";
        });
      } catch (error) {
        if (error.code !== "SCA_OLLAMA_MEMORY_BLOCKED") throw error;
        return send(res, 200, {
          answer: String(error.message ?? error),
          citations: contexts.map((context, index) => ({ index: index + 1, source_id: context.source_id, title: context.title, path: context.path })),
          unsupported: true,
          memoryBlocked: true,
          memory: error.memory,
          requiredBytes: error.requiredBytes
        });
      }
      return send(res, 200, await askOllama({ question: body.question, contexts, model }));
    }
    if (url.pathname === "/api/lock" && req.method === "POST") {
      const body = await json(req);
      const catalog = await loadCatalog();
      const profile = catalog.profiles.find((item) => item.id === body.profileId);
      if (!profile) throw new Error(`Unknown profile ${body.profileId}`);
      const result = await withDb((db) => writeLock({ db, libraryRoot, profile, sources: catalog.sources }));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/integrity") {
      const result = await withDb((db) => integrityReport({ db, libraryRoot }));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/export") {
      const result = await withDb((db) => exportManifest({ db, libraryRoot }));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/license/report") {
      const catalog = await loadCatalog();
      const result = await withDb((db) => writeAttributionReport({ db, libraryRoot, catalog }));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/reconcile") {
      const result = await withDb((db) => reconcileLibrary({ db, libraryRoot }));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/partials/cleanup" && req.method === "POST") {
      const result = await withDb((db) => cleanupPartials({ db, libraryRoot }));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/kiwix/library") {
      const result = await withDb((db) => writeKiwixLibraryXml({ db, libraryRoot }));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/release/checksums") {
      const appImage = path.join(root, "app/src-tauri/target/release/bundle/appimage/Offline Survival_0.1.0_amd64.AppImage");
      const result = await withDb((db) => writeReleaseChecksums({ db, libraryRoot, files: [appImage] }));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/portable/layout") {
      const result = await withDb((db) => buildPortableLayout({ db, libraryRoot }));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/share/package" && req.method === "POST") {
      const body = await json(req);
      const catalog = await loadCatalog();
      try {
        const result = await withDb((db) => {
          const profile = shareProfileFromRequest(db, catalog, body.profileId);
          return buildSharePackage({
            db,
            libraryRoot,
            projectRoot: root,
            profile: { ...profile, primaryOs: body.primaryOs },
            catalogSources: catalog.sources,
            appBundlePath: body.appBundlePath
          });
        });
        return send(res, 200, result);
      } catch (error) {
        await withDb((db) => setSetting(db, "sharePackageProgress", {
          status: "failed",
          phase: "failed",
          detail: String(error.message ?? error),
          percent: 0,
          updatedAt: Date.now()
        }));
        throw error;
      }
    }
    if (url.pathname === "/api/review/summary") {
      const result = await withDb((db) => sourceReviewSummary(db));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/review/source" && req.method === "POST") {
      const body = await json(req);
      const result = await withDb((db) => reviewSource(db, body));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/updates/status") {
      const catalog = await loadCatalog();
      const result = await withDb((db) => updateStatus({ db, catalog }));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/catalog/refresh" && req.method === "POST") {
      await syncCatalog();
      const result = await withDb((db) => refreshCatalogSnapshot(db));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/logs") {
      const logs = await withDb((db) => db.prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT ?").all(Number(url.searchParams.get("limit") ?? 200)));
      return send(res, 200, { logs });
    }
    return await serveUi(url, res);
  } catch (error) {
    send(res, 500, { error: String(error.message ?? error) });
  }
}

async function easyInstall({ db, catalog, selectedProfiles, installAi, concurrency }) {
  const startedAt = Date.now();
  const selectedIds = [...new Set(selectedProfiles.flatMap((profile) => profile.sourceIds))];
  const profileIds = selectedProfiles.map((profile) => profile.id);
  let downloadResult = { results: [] };
  let prepared = [];
  let indexed = { results: [] };
  let ai = null;
  try {
    setEasyInstallProgress(db, {
      status: "running",
      phase: "download",
      detail: installAi ? "Downloading selected profile sources while Local AI installs in parallel." : "Downloading selected profile sources.",
      startedAt,
      profileIds,
      sourceCount: selectedIds.length,
      percent: 0
    });
    let aiModels = [];
    if (installAi) {
      const info = await systemInfo(libraryRoot, catalog.profiles, catalog.models);
      const recommended = new Set(info.aiRecommendation ?? []);
      aiModels = catalog.models.filter((model) => recommended.has(model.id) || recommended.has(model.pull));
      for (const model of catalog.models) upsertModel(db, model);
      for (const model of aiModels) {
        db.prepare("UPDATE models SET status=?, updated_at=datetime('now') WHERE id=? AND status != 'installed'").run("queued", model.id);
      }
      upsertService(db, {
        name: "ollama",
        status: "installing",
        port: 11434,
        url: "http://127.0.0.1:11434",
        message: "Queued by Easy Install"
      });
      setSetting(db, "aiInstallProgress", {
        status: "running",
        phase: "queued",
        item: "Local AI setup",
        detail: "Local AI install is queued and will run in parallel with source downloads.",
        startedAt,
        currentBytes: 0,
        totalBytes: aiModels.reduce((sum, model) => sum + Number(model.expected_size_bytes ?? 0), 0),
        percent: 0,
        etaSeconds: null,
        updatedAt: Date.now()
      });
    }

    const sourceTask = (async () => {
      if (selectedIds.length) {
        const profile = { id: "easy-install", title: "Easy Install", sourceIds: selectedIds };
        let downloadProgressTimer = null;
        try {
          updateEasyDownloadProgress(db, { selectedIds, selectedProfiles, installAi, startedAt, profileIds });
          downloadProgressTimer = setInterval(() => {
            try {
              updateEasyDownloadProgress(db, { selectedIds, selectedProfiles, installAi, startedAt, profileIds });
            } catch {
              // Keep the download running even if a transient progress update fails.
            }
          }, 1000);
          downloadResult = await downloadProfile({ db, libraryRoot, profile, sources: catalog.sources, concurrency });
          updateEasyDownloadProgress(db, { selectedIds, selectedProfiles, installAi, startedAt, profileIds });
        } finally {
          if (downloadProgressTimer) clearInterval(downloadProgressTimer);
        }
      }

      const selectedSources = selectedIds.map((id) => catalog.sources.find((source) => source.id === id)).filter(Boolean);
      setEasyInstallProgress(db, {
        status: "running",
        phase: "prepare",
        detail: installAi ? "Preparing downloaded sources while Local AI continues installing." : "Preparing downloaded sources for offline use.",
        startedAt,
        profileIds,
        sourceCount: selectedIds.length,
        percent: 45
      });
      for (const source of selectedSources) {
        const row = db.prepare("SELECT local_path FROM sources WHERE id=?").get(source.id);
        if (!row?.local_path) continue;
        prepared.push(await prepareSourceForUse({ db, libraryRoot, source }));
      }

      setEasyInstallProgress(db, {
        status: "running",
        phase: "index",
        detail: installAi ? "Indexing downloaded sources while Local AI continues installing." : "Indexing downloaded sources for Search and Local AI context.",
        startedAt,
        profileIds,
        sourceCount: selectedIds.length,
        percent: 65
      });
      indexed = await indexDownloadedSources({ db, libraryRoot, catalogSources: catalog.sources });
      if (indexed.remainingUnindexed?.length) {
        throw new Error(`Indexing incomplete: ${indexed.remainingUnindexed.length} downloaded sources still have no search/AI index entry`);
      }
      if (installAi) {
        setEasyInstallProgress(db, {
          status: "running",
          phase: "ai",
          detail: "Source setup is done; Local AI is still installing in parallel.",
          startedAt,
          profileIds,
          sourceCount: selectedIds.length,
          percent: 80
        });
      }
    })();

    const aiTask = (async () => {
      if (!installAi) return null;
      if (!aiModels.length) return { status: "skipped", reason: "No recommended Local AI models for this PC" };
      return installRecommendedAi({ db, libraryRoot, models: aiModels });
    })();

    const [sourceOutcome, aiOutcome] = await Promise.allSettled([sourceTask, aiTask]);
    if (sourceOutcome.status === "rejected" || aiOutcome.status === "rejected") {
      const messages = [sourceOutcome, aiOutcome]
        .filter((outcome) => outcome.status === "rejected")
        .map((outcome) => String(outcome.reason?.message ?? outcome.reason));
      throw new Error(messages.join("; "));
    }
    ai = aiOutcome.value;

    const result = { status: "complete", downloaded: downloadResult.results.length, prepared, indexed, ai };
    setEasyInstallProgress(db, {
      status: "complete",
      phase: "complete",
      detail: "Easy Install completed.",
      startedAt,
      profileIds,
      sourceCount: selectedIds.length,
      percent: 100,
      result
    });
    return result;
  } catch (error) {
    setEasyInstallProgress(db, {
      status: "failed",
      phase: "failed",
      detail: String(error.message ?? error),
      startedAt,
      profileIds,
      sourceCount: selectedIds.length,
      percent: 0
    });
    throw error;
  }
}

async function cleanSources(db) {
  stopService(db, "kiwix");
  stopService(db, "ollama");
  for (const dir of cleanableLibraryDirs) await fs.rm(path.join(libraryRoot, dir), { recursive: true, force: true });
  db.exec(`
    DELETE FROM downloads;
    DELETE FROM blobs;
    DELETE FROM documents;
    DELETE FROM chunks;
    DELETE FROM fts;
    DELETE FROM adapters WHERE source_id LIKE 'extra-%';
    DELETE FROM sources WHERE id LIKE 'extra-%';
    DELETE FROM events;
    UPDATE sources SET status='missing', size_bytes=0, sha256=NULL, local_path=NULL, duplicate_of=NULL, updated_at=datetime('now');
    UPDATE models SET status='missing', updated_at=datetime('now');
    UPDATE adapters SET status='not_ready', local_url=NULL, port=NULL, last_error=NULL, last_probe_at=datetime('now');
    DELETE FROM settings WHERE key IN ('aiInstallProgress', 'easyInstallProgress', 'sharePackageProgress');
  `);
  setSetting(db, "libraryRoot", libraryRoot);
  setSetting(db, "lanSharing", { enabled: false, bind: "127.0.0.1" });
  return { status: "cleaned", removed: cleanableLibraryDirs };
}

function shareProfileFromRequest(db, catalog, profileId) {
  if (profileId === allDownloadedShareProfileId) {
    const rows = db.prepare(`
      SELECT id
      FROM sources
      WHERE local_path IS NOT NULL
        AND status NOT IN ('missing', 'queued', 'downloading', 'resuming', 'paused', 'failed', 'broken')
      ORDER BY title COLLATE NOCASE, id
    `).all();
    if (!rows.length) throw new Error("No downloaded sources are available to share.");
    return {
      id: allDownloadedShareProfileId,
      title: "All Downloaded Sources",
      description: "Every downloaded source currently present in this library.",
      sourceIds: rows.map((row) => row.id)
    };
  }
  const profile = catalog.profiles.find((item) => item.id === profileId);
  if (!profile) throw new Error(`Unknown profile ${profileId}`);
  return profile;
}

function sourceConfigForRequest(db, catalog, sourceId) {
  const catalogSource = catalog.sources.find((item) => item.id === sourceId);
  if (catalogSource) return catalogSource;
  const row = db.prepare("SELECT * FROM sources WHERE id=?").get(sourceId);
  if (!row) throw new Error(`Unknown source ${sourceId}`);
  return {
    id: row.id,
    title: row.title,
    description: row.source_url ?? "",
    type: row.type,
    category: "extra-knowledge",
    license: row.license,
    runtime: row.type === "zim" ? ["reader", "index", "search", "local-ai"] : ["index", "search", "local-ai"],
    expected_size_bytes: row.expected_size_bytes,
    source_url: row.source_url
  };
}

function retrieveAskContexts(db, body) {
  const question = String(body.question ?? "").trim();
  if (!question) return [];
  const filters = { sourceId: body.sourceId || undefined, license: body.license || undefined };
  const lexical = [
    ...search(db, question, 8, filters),
    ...search(db, askKeywordQuery(question), 12, filters)
  ];
  const byKey = new Map();
  for (const context of lexical) {
    const key = `${context.source_id}:${context.path}:${context.snippet}`;
    if (!byKey.has(key)) byKey.set(key, enrichAskContext(db, context));
  }
  return [...byKey.values()].slice(0, 5);
}

function enrichAskContext(db, context) {
  const chunk = db.prepare(`
    SELECT body
    FROM chunks
    WHERE source_id=? AND path=?
    ORDER BY token_estimate DESC
    LIMIT 1
  `).get(context.source_id, context.path);
  return {
    ...context,
    snippet: cleanPromptText(chunk?.body || context.snippet || "")
  };
}

function cleanPromptText(text) {
  return String(text)
    .replace(/<\/?mark>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function askKeywordQuery(question) {
  const stop = new Set(["about", "according", "after", "again", "against", "also", "before", "being", "between", "could", "from", "have", "into", "local", "should", "source", "that", "their", "there", "these", "thing", "this", "what", "when", "where", "which", "with", "would", "wikem"]);
  const terms = String(question).toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [];
  const important = [...new Set(terms.filter((term) => term.length >= 4 && !stop.has(term)))].slice(0, 8);
  return important.length ? important.map((term) => `"${term.replace(/"/g, "")}"`).join(" OR ") : question;
}

function installedChatModelPull(db) {
  return installedChatModel(db)?.pull ?? null;
}

function installedChatModel(db) {
  const row = db.prepare(`
    SELECT *
    FROM models
    WHERE role='chat' AND status='installed'
    ORDER BY expected_size_bytes ASC
    LIMIT 1
  `).get();
  return row ?? null;
}

function selectedChatModel(db, requested) {
  if (requested) {
    return db.prepare("SELECT * FROM models WHERE role='chat' AND status='installed' AND (id=? OR pull=?)").get(requested, requested) ?? null;
  }
  return installedChatModel(db);
}

async function pickFolder() {
  const candidates = [
    { command: "zenity", args: ["--file-selection", "--directory", "--title=Choose Extra Knowledge Folder"] },
    { command: "kdialog", args: ["--getexistingdirectory", process.env.HOME ?? "."] },
    { command: "yad", args: ["--file-selection", "--directory", "--title=Choose Extra Knowledge Folder"] }
  ];
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate.command, candidate.args, { timeout: 120000 });
      const selected = stdout.trim();
      if (!selected) return { canceled: true };
      const stat = await fs.stat(selected).catch(() => null);
      if (!stat?.isDirectory()) throw new Error(`Selected path is not a folder: ${selected}`);
      return { path: selected, canceled: false };
    } catch (error) {
      const code = error?.code;
      const exitCode = error?.code === "ENOENT" ? null : error?.code;
      if (exitCode === 1) return { canceled: true };
      if (code === "ENOENT") lastError = error;
      else lastError = error;
    }
  }
  throw new Error("No folder picker is available. Install zenity, kdialog, or yad, or paste the folder path manually.");
}

function setEasyInstallProgress(db, progress) {
  setSetting(db, "easyInstallProgress", { ...progress, updatedAt: Date.now() });
}

function updateEasyDownloadProgress(db, { selectedIds, selectedProfiles, installAi, startedAt, profileIds }) {
  const rows = selectedIds.length
    ? db.prepare(`SELECT source_id, status, bytes_received, total_bytes FROM downloads WHERE source_id IN (${selectedIds.map(() => "?").join(",")})`).all(...selectedIds)
    : [];
  const byId = new Map(rows.map((row) => [row.source_id, row]));
  let currentBytes = 0;
  let totalBytes = 0;
  let done = 0;
  let active = 0;
  for (const id of selectedIds) {
    const source = db.prepare("SELECT status, size_bytes, expected_size_bytes FROM sources WHERE id=?").get(id);
    const download = byId.get(id);
    const complete = ["downloaded", "verified", "indexed", "indexed-original-only"].includes(String(source?.status ?? "")) || download?.status === "complete";
    const total = Math.max(Number(download?.total_bytes ?? 0), Number(source?.expected_size_bytes ?? 0), Number(source?.size_bytes ?? 0));
    const received = complete ? Math.max(Number(source?.size_bytes ?? 0), total) : Number(download?.bytes_received ?? 0);
    currentBytes += received;
    totalBytes += total;
    if (complete) done += 1;
    if (["queued", "downloading", "resuming"].includes(String(download?.status ?? source?.status ?? ""))) active += 1;
  }
  const downloadPercent = totalBytes > 0 ? Math.round((currentBytes / totalBytes) * 100) : done === selectedIds.length ? 100 : 0;
  setEasyInstallProgress(db, {
    status: "running",
    phase: "download",
    detail: installAi ? "Downloading selected profile sources while Local AI installs in parallel." : "Downloading selected profile sources.",
    startedAt,
    profileIds,
    profileTitles: selectedProfiles.map((profile) => profile.title),
    sourceCount: selectedIds.length,
    currentBytes,
    totalBytes,
    done,
    active,
    percent: Math.min(45, Math.round(downloadPercent * 0.45))
  });
}

async function serveUi(url, res) {
  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const staticDir = await firstExistingDir(staticDirCandidates);
  const built = staticDir ? path.join(staticDir, requested) : "";
  try {
    const file = await fs.readFile(built);
    res.writeHead(200, { "content-type": contentType(built), ...uiCacheHeaders(built) });
    res.end(file);
  } catch {
    const devIndex = await firstExistingFile(devIndexCandidates);
    if (!devIndex) return send(res, 404, { error: "UI files are not available in this build." });
    const html = await fs.readFile(devIndex, "utf8");
    return send(res, 200, html.replace("/src/main.ts", "/app/ui/src/main.ts").replace("</body>", `<script type="module" src="http://127.0.0.1:5174/@vite/client"></script><script type="module" src="http://127.0.0.1:5174/app/ui/src/main.ts"></script></body>`));
  }
}

async function firstExistingDir(candidates) {
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isDirectory()) return candidate;
    } catch {
      // Try the next packaged/source layout.
    }
  }
  return null;
}

async function firstExistingFile(candidates) {
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next packaged/source layout.
    }
  }
  return null;
}

function uiCacheHeaders(file) {
  if (file.endsWith(".html") || file.endsWith(".js") || file.endsWith(".css")) {
    return { "cache-control": "no-store, max-age=0" };
  }
  return { "cache-control": "no-cache" };
}

function contentType(file) {
  if (file.endsWith(".js")) return "text/javascript";
  if (file.endsWith(".css")) return "text/css";
  if (file.endsWith(".svg")) return "image/svg+xml";
  return "text/html; charset=utf-8";
}

http.createServer(route).listen(port, "127.0.0.1", () => {
  console.log(`Offline Survival API listening at http://127.0.0.1:${port}`);
});
