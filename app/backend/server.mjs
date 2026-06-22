import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadCatalog } from "./catalog.mjs";
import { downloadProfile, downloadSource, pauseDownload, retryDownload, verifySource } from "./downloader.mjs";
import { indexDownloadedSources, normalizeAndIndex, repairCorruptRepoArchiveIndexes, search, semanticSearch } from "./indexer.mjs";
import { exportManifest, integrityReport, writeLock } from "./archive.mjs";
import { openSearchResult, openSourceWithAdapter, prepareSourceForUse, refreshAdapters, sourceOpenPlan } from "./adapters.mjs";
import { writeAttributionReport } from "./license.mjs";
import { installRecommendedAi, ollamaInstallPlan, pullModel, refreshModels } from "./models.mjs";
import { cleanupPartials, reconcileLibrary, writeKiwixLibraryXml } from "./recovery.mjs";
import { buildPortableLayout, buildSharePackage, writeReleaseChecksums } from "./release.mjs";
import { reviewSource, sourceReviewSummary } from "./review.mjs";
import { importExtraKnowledgeFiles, scanExtraKnowledgeFolder, supportedExtraKnowledgeExtensions } from "./extraKnowledge.mjs";
import { askOllama, ensureOllamaRuntimePermissions, serviceStatus, startKiwix, startOllama, stopService, upsertService } from "./services.mjs";
import { estimateModelRamBytes, memorySnapshot, systemInfo } from "./system.mjs";
import { defaultLibraryRoot, ensureLibrary, markInterruptedDownloads, now, openState, pruneOldEvents, pruneOldLogFiles, recordEvent, removeSourcesNotInCatalog, setSetting, summarizeState, upsertModel, upsertSource } from "./state.mjs";

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
await pruneOldLogFiles(libraryRoot);
configureManagedRuntimes();
{
  const db = openState(libraryRoot);
  markInterruptedDownloads(db);
  pruneOldEvents(db);
  db.close();
}
await syncCatalog();
scheduleStartupIndexRepair();

let shuttingDown = false;
let server = null;
const backgroundJobs = new Map();

async function syncCatalog() {
  configureManagedRuntimes();
  const catalog = await loadCatalog();
  const db = openState(libraryRoot);
  removeSourcesNotInCatalog(db, catalog.sources);
  for (const source of catalog.sources) upsertSource(db, source);
  for (const model of catalog.models) upsertModel(db, model);
  refreshAdapters(db, catalog.sources);
  setSetting(db, "libraryRoot", libraryRoot);
  db.close();
}

function scheduleStartupIndexRepair() {
  setTimeout(async () => {
    try {
      const catalog = await loadCatalog();
      const repaired = await withDb((db) => repairCorruptRepoArchiveIndexes({ db, libraryRoot, catalogSources: catalog.sources }));
      if (repaired.repaired) console.log(`Repaired ${repaired.repaired} corrupted repo archive search index(es).`);
    } catch (error) {
      console.warn(`Startup index repair skipped: ${String(error.message ?? error)}`);
    }
  }, 1500).unref?.();
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

function startBackgroundJob(key, work) {
  if (backgroundJobs.has(key)) return false;
  const promise = Promise.resolve()
    .then(work)
    .catch((error) => {
      console.warn(`Background job ${key} failed: ${String(error.message ?? error)}`);
    })
    .finally(() => backgroundJobs.delete(key));
  backgroundJobs.set(key, promise);
  return true;
}

function queueSourceDownload(db, source) {
  const row = db.prepare("SELECT status FROM sources WHERE id=?").get(source.id);
  if (["downloaded", "verified", "indexed"].includes(String(row?.status ?? ""))) {
    return { sourceId: source.id, status: row.status, skipped: true };
  }
  if (["queued", "downloading", "resuming"].includes(String(row?.status ?? ""))) {
    return { sourceId: source.id, status: row.status, alreadyRunning: true };
  }
  db.prepare("INSERT INTO downloads (id, source_id, status, total_bytes, error, updated_at) VALUES (?, ?, ?, ?, NULL, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, total_bytes=excluded.total_bytes, error=NULL, updated_at=excluded.updated_at")
    .run(source.id, source.id, "queued", Number(source.expected_size_bytes ?? 0), now());
  db.prepare("UPDATE sources SET status=?, updated_at=? WHERE id=? AND status NOT IN ('downloaded', 'verified', 'indexed')")
    .run("queued", now(), source.id);
  recordEvent(db, "download-queued", `${source.title} download queued`, { sourceId: source.id });
  return { sourceId: source.id, status: "queued" };
}

function queueProfileDownloads(db, profile, sources) {
  const queued = [];
  const skipped = [];
  for (const source of sources.filter((item) => profile.sourceIds.includes(item.id))) {
    const result = queueSourceDownload(db, source);
    if (result.skipped) skipped.push(result);
    else queued.push(result);
  }
  recordEvent(db, "profile-download-queued", `${profile.title} profile download queued`, { profileId: profile.id, queued: queued.length, skipped: skipped.length });
  return { profileId: profile.id, status: "queued", queued, skipped };
}

function shutdownAuthorized(req) {
  const token = process.env.SCA_BACKEND_TOKEN ?? "";
  if (!token) return true;
  return req.headers["x-sca-backend-token"] === token;
}

async function stopRuntimeServices() {
  return await withDb(async (db) => {
    const results = [];
    for (const name of ["kiwix", "ollama"]) {
      try {
        results.push(await stopService(db, name));
      } catch (error) {
        results.push({ name, status: "failed", error: String(error.message ?? error) });
      }
    }
    return results;
  });
}

async function shutdownBackend({ exitCode = 0 } = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  await stopRuntimeServices();
  closeBackend(exitCode);
}

function closeBackend(exitCode = 0) {
  server?.close(() => {
    process.exit(exitCode);
  });
  setTimeout(() => process.exit(exitCode), 1000).unref?.();
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
    if (url.pathname === "/api/download" && req.method === "POST") {
      const body = await json(req);
      const catalog = await loadCatalog();
      const source = catalog.sources.find((item) => item.id === body.sourceId);
      if (!source) throw new Error(`Unknown source ${body.sourceId}`);
      const jobRoot = libraryRoot;
      const diskBudgetBytes = optionalNumber(body.diskBudgetBytes);
      const queued = await withDb((db) => queueSourceDownload(db, source));
      const started = queued.skipped
        ? false
        : startBackgroundJob(`download:${jobRoot}:${source.id}`, async () => {
            const db = openState(jobRoot);
            try {
              await downloadSource({ db, libraryRoot: jobRoot, source, diskBudgetBytes });
            } finally {
              db.close();
            }
          });
      return send(res, 200, { ...queued, background: !queued.skipped, started });
    }
    if (url.pathname === "/api/profile/download" && req.method === "POST") {
      const body = await json(req);
      const catalog = await loadCatalog();
      const profile = catalog.profiles.find((item) => item.id === body.profileId);
      if (!profile) throw new Error(`Unknown profile ${body.profileId}`);
      validateProfileLanguage([profile], body.contentLanguage);
      const jobRoot = libraryRoot;
      const diskBudgetBytes = optionalNumber(body.diskBudgetBytes);
      const concurrency = Number(body.concurrency ?? 4);
      const queued = await withDb((db) => queueProfileDownloads(db, profile, catalog.sources));
      const hasPendingDownloads = queued.queued.length > 0;
      const started = hasPendingDownloads
        ? startBackgroundJob(`profile-download:${jobRoot}:${profile.id}`, async () => {
            const db = openState(jobRoot);
            try {
              await downloadProfile({ db, libraryRoot: jobRoot, profile, sources: catalog.sources, diskBudgetBytes, concurrency });
            } finally {
              db.close();
            }
          })
        : false;
      return send(res, 200, { ...queued, background: hasPendingDownloads, started });
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
      const jobRoot = libraryRoot;
      const diskBudgetBytes = optionalNumber(body.diskBudgetBytes);
      const queued = await withDb((db) => {
        db.prepare("UPDATE downloads SET status=?, error=NULL, updated_at=? WHERE id=?").run("queued", now(), source.id);
        db.prepare("UPDATE sources SET status=?, updated_at=? WHERE id=? AND status NOT IN ('downloaded', 'verified', 'indexed')").run("queued", now(), source.id);
        recordEvent(db, "download-retry", `Retrying ${source.title}`, { sourceId: source.id });
        return { sourceId: source.id, status: "queued" };
      });
      const started = startBackgroundJob(`download:${jobRoot}:${source.id}`, async () => {
        const db = openState(jobRoot);
        try {
          await retryDownload({ db, libraryRoot: jobRoot, source, diskBudgetBytes });
        } finally {
          db.close();
        }
      });
      return send(res, 200, { ...queued, background: true, started });
    }
    if (url.pathname === "/api/verify" && req.method === "POST") {
      const body = await json(req);
      const result = await withDb((db) => verifySource({ db, libraryRoot, sourceId: body.sourceId }));
      return send(res, 200, result);
    }
    if (url.pathname === "/api/index" && req.method === "POST") {
      const body = await json(req);
      const catalog = await loadCatalog();
      const result = await withDb(async (db) => {
        const sourceConfig = sourceConfigForRequest(db, catalog, body.sourceId);
        const startedAt = Date.now();
        setIndexingProgress(db, indexProgressPayload({
          stage: "source-start",
          sourceId: body.sourceId,
          title: sourceConfig.title,
          total: 1,
          completed: 0,
          current: 1
        }, { startedAt, queue: [{ sourceId: body.sourceId, title: sourceConfig.title, status: "pending" }] }));
        try {
          const indexed = await normalizeAndIndex({ db, libraryRoot, sourceId: body.sourceId, sourceConfig });
          setIndexingProgress(db, indexProgressPayload({
            stage: "complete",
            total: 1,
            completed: 1,
            current: 1,
            summary: { results: [indexed], indexed: indexed.documents > 0 ? 1 : 0, registeredOriginalOnly: indexed.originalOnly ? 1 : 0, skipped: 0 }
          }, { startedAt, queue: [{ sourceId: body.sourceId, title: sourceConfig.title, status: indexed.originalOnly ? "registered" : "indexed", result: indexed }] }));
          return indexed;
        } catch (error) {
          setIndexingProgress(db, indexProgressPayload({
            stage: "source-failed",
            sourceId: body.sourceId,
            title: sourceConfig.title,
            total: 1,
            completed: 0,
            current: 1,
            error: String(error.message ?? error)
          }, { startedAt, queue: [{ sourceId: body.sourceId, title: sourceConfig.title, status: "failed", error: String(error.message ?? error) }] }));
          throw error;
        }
      });
      return send(res, 200, result);
    }
    if (url.pathname === "/api/index/downloaded" && req.method === "POST") {
      const body = await json(req);
      const catalog = await loadCatalog();
      const result = await withDb((db) => {
        const startedAt = Date.now();
        let queue = [];
        return indexDownloadedSources({
          db,
          libraryRoot,
          catalogSources: catalog.sources,
          reindexAll: Boolean(body.reindexAll),
          onProgress: (progress) => {
            const payload = indexProgressPayload(progress, { startedAt, queue });
            queue = payload.items ?? queue;
            setIndexingProgress(db, payload);
          }
        });
      });
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
          const usableModel = await bestUsableInstalledChatModel(db, model);
          return startOllama(db, {
            modelsDir: path.join(libraryRoot, "raw", "models", "ollama"),
            logPath: path.join(libraryRoot, "logs", "ollama.log"),
            model: usableModel ?? model
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
    if (url.pathname === "/api/shutdown" && req.method === "POST") {
      if (!shutdownAuthorized(req)) return send(res, 403, { error: "Forbidden" });
      shuttingDown = true;
      const services = await stopRuntimeServices();
      send(res, 200, { status: "shutting_down", services });
      setTimeout(() => closeBackend(), 50).unref?.();
      return;
    }
    if (url.pathname === "/api/ask" && req.method === "POST") {
      const body = await json(req);
      const catalog = await loadCatalog();
      const history = normalizeAskHistory(body.history);
      const contexts = await withDb((db) => retrieveAskContexts(db, { ...body, history }));
      const progress = askProgressUpdater({ question: body.question, model: body.model ?? "qwen3:8b" });
      progress({ status: "running", phase: "retrieving", generatedTokens: 0, generatedChars: 0 });
      if (!contexts.length) {
        const result = await askOllama({ question: body.question, contexts, history, model: body.model ?? "qwen3:8b" });
        progress({ status: "complete", phase: "complete", generatedTokens: 0, generatedChars: 0, unsupported: true });
        return send(res, 200, result);
      }
      let model;
      try {
        progress({ status: "running", phase: "starting", generatedTokens: 0, generatedChars: 0 });
        model = await withDb(async (db) => {
          for (const model of catalog.models) upsertModel(db, model);
          await refreshModels(db, catalog.models);
          const chatModel = selectedChatModel(db, body.model);
          if (!chatModel) return body.model ?? "qwen3:8b";
          const usableModel = await bestUsableInstalledChatModel(db, chatModel);
          const activeChatModel = usableModel ?? chatModel;
          try {
            await startOllama(db, {
              modelsDir: path.join(libraryRoot, "raw", "models", "ollama"),
              logPath: path.join(libraryRoot, "logs", "ollama.log"),
              model: activeChatModel
            });
          } catch (error) {
            if (error.code === "SCA_OLLAMA_MEMORY_BLOCKED") throw error;
            return body.model ?? activeChatModel.pull ?? "qwen3:8b";
          }
          await refreshModels(db, catalog.models);
          return activeChatModel.pull ?? activeChatModel.id ?? installedChatModelPull(db) ?? "qwen3:8b";
        });
      } catch (error) {
        if (error.code !== "SCA_OLLAMA_MEMORY_BLOCKED") throw error;
        progress({ status: "failed", phase: "blocked", generatedTokens: 0, generatedChars: 0, error: String(error.message ?? error) });
        return send(res, 200, {
          answer: String(error.message ?? error),
          citations: contexts.map((context, index) => ({ index: index + 1, source_id: context.source_id, title: context.title, path: context.path })),
          unsupported: true,
          memoryBlocked: true,
          memory: error.memory,
          requiredBytes: error.requiredBytes
        });
      }
      const result = await askWithOllamaPermissionRepair({ question: body.question, contexts, history, model, onProgress: progress });
      const finalProgress = {
        status: result.timedOut || result.unsupported ? "failed" : "complete",
        phase: result.timedOut ? "timeout" : "complete",
        generatedChars: result.answer?.length ?? undefined,
        unsupported: Boolean(result.unsupported)
      };
      if (Number.isFinite(Number(result.generatedTokens))) finalProgress.generatedTokens = Number(result.generatedTokens);
      progress(finalProgress, { force: true });
      return send(res, 200, result);
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
    if (url.pathname === "/api/logs") {
      const logs = await withDb((db) => {
        pruneOldEvents(db);
        return db.prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT ?").all(Number(url.searchParams.get("limit") ?? 200));
      });
      return send(res, 200, { logs });
    }
    if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "Unknown API endpoint" });
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
      let indexQueue = [];
      indexed = await indexDownloadedSources({
        db,
        libraryRoot,
        catalogSources: catalog.sources,
        onProgress: (progress) => {
          const indexing = indexProgressPayload(progress, { startedAt, queue: indexQueue });
          indexQueue = indexing.items ?? indexQueue;
          const total = Number(indexing.total ?? 0);
          const completed = Number(indexing.completed ?? 0);
          setIndexingProgress(db, indexing);
          setEasyInstallProgress(db, {
            status: "running",
            phase: "index",
            detail: installAi ? "Indexing downloaded sources while Local AI continues installing." : "Indexing downloaded sources for Search and Local AI context.",
            startedAt,
            profileIds,
            sourceCount: selectedIds.length,
            percent: total > 0 ? 65 + Math.round((completed / total) * 15) : 65,
            indexing
          });
        }
      });
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
  await stopService(db, "kiwix");
  await stopService(db, "ollama");
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
    DELETE FROM settings WHERE key IN ('aiInstallProgress', 'easyInstallProgress', 'sharePackageProgress', 'indexingProgress');
  `);
  setSetting(db, "libraryRoot", libraryRoot);
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
  const contextQuestion = askContextQuery(question, body.history);
  const lexical = [
    ...search(db, contextQuestion, 8, filters),
    ...search(db, askKeywordQuery(contextQuestion), 12, filters)
  ];
  const byKey = new Map();
  for (const context of lexical) {
    const key = `${context.source_id}:${context.path}:${context.snippet}`;
    if (!byKey.has(key)) byKey.set(key, enrichAskContext(db, context));
  }
  return uniqueAskContexts([...byKey.values()]).slice(0, 5);
}

function uniqueAskContexts(contexts) {
  const seen = new Set();
  const unique = [];
  for (const context of contexts) {
    const body = normalizeContextBody(context.snippet || context.body || "");
    if (!body || seen.has(body)) continue;
    seen.add(body);
    unique.push(context);
  }
  return unique;
}

function normalizeAskHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-8).map((turn) => ({
    question: cleanPromptText(turn?.question ?? turn?.user ?? "").slice(0, 1200),
    answer: cleanPromptText(turn?.answer ?? turn?.assistant ?? "").slice(0, 1600)
  })).filter((turn) => turn.question || turn.answer);
}

function askContextQuery(question, history) {
  const priorQuestions = (Array.isArray(history) ? history : [])
    .slice(-3)
    .map((turn) => turn.question)
    .filter(Boolean)
    .join(" ");
  return `${priorQuestions} ${question}`.trim();
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

function normalizeContextBody(text) {
  return cleanPromptText(text).toLowerCase();
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

async function bestUsableInstalledChatModel(db, preferredModel) {
  const memory = await memorySnapshot();
  const swapPressure = memory.swapTotalBytes > 0 && memory.swapFreeBytes < Math.max(1024 ** 3, memory.swapTotalBytes * 0.4);
  if (swapPressure) return preferredModel;
  const preferredRequired = estimateModelRamBytes(preferredModel);
  if (memory.availableBytes >= preferredRequired) return preferredModel;
  const rows = db.prepare(`
    SELECT *
    FROM models
    WHERE role='chat' AND status='installed'
    ORDER BY expected_size_bytes ASC
  `).all();
  return rows.find((model) => estimateModelRamBytes(model) <= memory.availableBytes) ?? preferredModel;
}

function askProgressUpdater({ question, model }) {
  const startedAt = Date.now();
  let lastWrite = 0;
  let last = {};
  return (progress, options = {}) => {
    last = { ...last, ...progress };
    const nowMs = Date.now();
    if (!options.force && nowMs - lastWrite < 500 && !["complete", "failed"].includes(String(last.status ?? ""))) return;
    lastWrite = nowMs;
    const db = openState(libraryRoot);
    try {
      setSetting(db, "askProgress", {
        status: last.status ?? "running",
        phase: last.phase ?? "generating",
        generatedTokens: Number(last.generatedTokens ?? 0),
        generatedChars: Number(last.generatedChars ?? 0),
        question: cleanPromptText(question).slice(0, 160),
        model,
        unsupported: Boolean(last.unsupported),
        error: last.error ?? null,
        startedAt,
        updatedAt: nowMs
      });
    } finally {
      db.close();
    }
  };
}

async function askWithOllamaPermissionRepair({ question, contexts, history, model, onProgress = null }) {
  const first = await askOllama({ question, contexts, history, model, onProgress });
  if (!ollamaPermissionDenied(first)) return first;
  await ensureOllamaRuntimePermissions();
  const retry = await askOllama({ question, contexts, history, model, onProgress });
  return {
    ...retry,
    repairedRuntimePermissions: true
  };
}

function ollamaPermissionDenied(answer) {
  return Boolean(answer?.unsupported && /llama-server/i.test(String(answer.answer ?? "")) && /permission denied/i.test(String(answer.answer ?? "")));
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

function setIndexingProgress(db, progress) {
  setSetting(db, "indexingProgress", { ...progress, updatedAt: Date.now() });
}

function indexProgressPayload(progress, { startedAt, queue = [] }) {
  const total = Number(progress.total ?? queue.length ?? 0);
  const completed = Number(progress.completed ?? 0);
  const current = Number(progress.current ?? (completed ? completed : 0));
  const stage = String(progress.stage ?? "source-start");
  const currentSourceId = progress.sourceId ? String(progress.sourceId) : null;
  const currentTitle = progress.title ?? (currentSourceId ? queue.find((item) => item.sourceId === currentSourceId)?.title : "");
  const result = progress.result ?? null;
  const items = updateIndexQueue(queue, progress);
  const failed = items.filter((item) => item.status === "failed").length;
  const registeredOriginalOnly = items.filter((item) => item.status === "registered").length;
  const indexed = items.filter((item) => item.status === "indexed").length;
  const status = stage === "complete" ? "complete" : stage === "source-failed" ? "failed" : "running";
  const percent = total > 0 ? Math.min(100, Math.round((Math.max(completed, indexed + registeredOriginalOnly) / total) * 100)) : status === "complete" ? 100 : 0;
  return {
    status,
    phase: "index",
    detail: status === "complete" ? "Indexing completed." : currentTitle ? `Indexing ${currentTitle}.` : "Building local search and Local AI context indexes.",
    startedAt,
    total,
    current,
    completed: Math.max(completed, indexed + registeredOriginalOnly),
    failed,
    indexed,
    registeredOriginalOnly,
    percent,
    currentSourceId,
    currentSourceTitle: currentTitle,
    items,
    summary: progress.summary ?? null,
    result,
    error: progress.error ?? null
  };
}

function updateIndexQueue(queue, progress) {
  let next = Array.isArray(queue) ? queue.map((item) => ({ ...item })) : [];
  if (progress.stage === "start") {
    next = (progress.queue ?? []).map((item) => ({ ...item, status: item.status ?? "pending" }));
  }
  const sourceId = progress.sourceId ? String(progress.sourceId) : "";
  if (!sourceId) return next;
  const index = next.findIndex((item) => item.sourceId === sourceId);
  const existing = index >= 0 ? next[index] : { sourceId, title: progress.title ?? sourceId };
  const updated = { ...existing, title: progress.title ?? existing.title };
  if (progress.stage === "source-start") updated.status = "indexing";
  if (progress.stage === "source-complete") {
    updated.status = progress.result?.originalOnly ? "registered" : "indexed";
    updated.result = progress.result;
    updated.chunks = progress.result?.chunks ?? progress.result?.chunkCount ?? null;
    updated.pages = progress.result?.pages ?? null;
  }
  if (progress.stage === "source-failed") {
    updated.status = "failed";
    updated.error = progress.error;
  }
  if (index >= 0) next[index] = updated;
  else next.push(updated);
  return next;
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

process.once("SIGINT", () => {
  shutdownBackend({ exitCode: 130 }).catch((error) => {
    console.error(`Shutdown failed: ${String(error.message ?? error)}`);
    process.exit(130);
  });
});

process.once("SIGTERM", () => {
  shutdownBackend({ exitCode: 143 }).catch((error) => {
    console.error(`Shutdown failed: ${String(error.message ?? error)}`);
    process.exit(143);
  });
});

server = http.createServer(route).listen(port, "127.0.0.1", () => {
  console.log(`Offline Survival API listening at http://127.0.0.1:${port}`);
});
