import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSettings, now, recordEvent, setSetting } from "./state.mjs";
import { ensureOllamaRuntimePermissions, resolveRuntime, startOllama, upsertService } from "./services.mjs";
import { extractZipToDir } from "./zip.mjs";

export async function refreshModels(db, catalogModels, fetchImpl = fetch) {
  let installed = localInstalledModelAliases();
  const settings = getSettings(db);
  const aiInstalling = settings.aiInstallProgress?.status === "running";
  try {
    const response = await fetchImpl("http://127.0.0.1:11434/api/tags");
    if (response.ok) {
      const data = await response.json();
      installed = [...new Set([...installed, ...(data.models ?? []).flatMap((model) => modelNameAliases(model.name))])];
    }
  } catch {
    // Offline manifest scan above still lets the app know which models are installed
    // without starting Ollama just to query /api/tags.
  }
  for (const model of catalogModels) {
    const existing = db.prepare("SELECT status FROM models WHERE id=?").get(model.id);
  const status = installed.includes(model.pull)
      ? "installed"
      : aiInstalling && ["queued", "pulling"].includes(String(existing?.status ?? ""))
        ? existing.status
        : "missing";
    db.prepare("UPDATE models SET status=?, updated_at=? WHERE id=?").run(status, now(), model.id);
  }
  return db.prepare("SELECT * FROM models ORDER BY title").all();
}

function localInstalledModelAliases() {
  const modelsDir = process.env.SCA_OLLAMA_MODELS;
  if (!modelsDir) return [];
  const root = path.join(modelsDir, "manifests", "registry.ollama.ai", "library");
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const tagsDir = path.join(root, entry.name);
        return fs.readdirSync(tagsDir, { withFileTypes: true })
          .filter((tag) => tag.isFile())
          .flatMap((tag) => modelNameAliases(`${entry.name}:${tag.name}`));
      });
  } catch {
    return [];
  }
}

export async function pullModel(db, model) {
  const runtime = resolveRuntime("ollama");
  await ensureOllamaRuntimePermissions(runtime);
  const child = spawn(runtime, ["pull", model.pull], { env: ollamaEnv(), stdio: "ignore" });
  db.prepare("UPDATE models SET status=?, updated_at=? WHERE id=?").run("pulling", now(), model.id);
  recordEvent(db, "model-pull", `Started pulling ${model.pull}`, { modelId: model.id, pull: model.pull, pid: child.pid });
  child.on("exit", (code) => {
    try {
      db.prepare("UPDATE models SET status=?, updated_at=? WHERE id=?").run(code === 0 ? "installed" : "failed", now(), model.id);
    } catch {
      // The request database handle may be closed; refreshModels will repair state next time.
    }
  });
  return { modelId: model.id, pull: model.pull, status: "pulling", pid: child.pid };
}

export async function installRecommendedAi({ db, libraryRoot, models }) {
  const startedAt = Date.now();
  const totalModelBytes = models.reduce((sum, model) => sum + Number(model.expected_size_bytes ?? 0), 0);
  try {
    updateAiProgress(db, {
      status: "running",
      phase: "starting",
      item: "Local AI setup",
      detail: "Preparing app-managed Ollama and recommended models.",
      startedAt,
      currentBytes: 0,
      totalBytes: totalModelBytes,
      percent: 0,
      etaSeconds: null
    });
    await ensureOllamaInstalled({ db, libraryRoot, progress: { startedAt, totalModelBytes } });
    const modelsDir = path.join(libraryRoot, "raw", "models", "ollama");
    await fsp.mkdir(modelsDir, { recursive: true });
    process.env.SCA_OLLAMA_MODELS = modelsDir;
    updateAiProgress(db, {
      status: "running",
      phase: "starting-ollama",
      item: "Ollama runtime",
      detail: "Starting local Ollama service.",
      startedAt,
      currentBytes: 0,
      totalBytes: totalModelBytes,
      percent: 0,
      etaSeconds: null
    });
    await startOllama(db, { modelsDir, logPath: path.join(libraryRoot, "logs", "ollama.log"), skipModelGuard: true });

    const installed = [];
    let completedModelBytes = 0;
    for (const model of models) {
      if (await modelIsInstalled(model.pull)) {
        db.prepare("UPDATE models SET status=?, updated_at=? WHERE id=?").run("installed", now(), model.id);
        completedModelBytes += Number(model.expected_size_bytes ?? 0);
        installed.push(model.id);
        updateAiProgress(db, modelProgressPayload(model, { startedAt, completedModelBytes, totalModelBytes }, 0, 0, `${model.pull} is already installed.`));
        continue;
      }
      await pullModelAndWait(db, libraryRoot, model, { startedAt, completedModelBytes, totalModelBytes });
      completedModelBytes += Number(model.expected_size_bytes ?? 0);
      installed.push(model.id);
    }
    updateAiProgress(db, {
      status: "complete",
      phase: "complete",
      item: "Recommended Local AI setup",
      detail: "All recommended Local AI components are installed.",
      startedAt,
      currentBytes: totalModelBytes,
      totalBytes: totalModelBytes,
      percent: 100,
      etaSeconds: 0
    });
    recordEvent(db, "ai-install-recommended", "Installed recommended Local AI runtime and models", { models: installed });
    return { status: "installed", models: installed, ollama: process.env.SCA_OLLAMA_BIN ?? resolveRuntime("ollama") };
  } catch (error) {
    updateAiProgress(db, {
      status: "failed",
      phase: "failed",
      item: "Local AI setup",
      detail: String(error.message ?? error),
      startedAt,
      currentBytes: 0,
      totalBytes: totalModelBytes,
      percent: 0,
      etaSeconds: null
    });
    throw error;
  }
}

async function ensureOllamaInstalled({ db, libraryRoot, progress }) {
  const existing = resolveRuntime("ollama");
  if (existing !== "ollama" || await commandWorks(existing)) {
    await ensureOllamaRuntimePermissions(existing);
    process.env.SCA_OLLAMA_BIN = existing;
    updateAiProgress(db, {
      status: "running",
      phase: "runtime-ready",
      item: "Ollama runtime",
      detail: "Ollama is already available.",
      startedAt: progress.startedAt,
      currentBytes: 0,
      totalBytes: progress.totalModelBytes,
      percent: 0,
      etaSeconds: null
    });
    return { status: "available", path: existing };
  }

  const plan = ollamaInstallPlan(process.platform, os.arch());
  const installDir = path.join(libraryRoot, "raw", "runtimes", "ollama");
  const archive = path.join(libraryRoot, "tmp", plan.asset);
  await fsp.rm(installDir, { recursive: true, force: true });
  await fsp.mkdir(installDir, { recursive: true });
  await fsp.mkdir(path.dirname(archive), { recursive: true });
  upsertService(db, { name: "ollama", status: "installing", port: 11434, url: "http://127.0.0.1:11434", message: `Downloading ${plan.asset}` });
  updateAiProgress(db, {
    status: "running",
    phase: "runtime-download",
    item: "Ollama runtime",
    detail: `Downloading ${plan.asset}.`,
    startedAt: progress.startedAt,
    currentBytes: 0,
    totalBytes: progress.totalModelBytes,
    percent: 0,
    etaSeconds: null
  });
  recordEvent(db, "ollama-install", "Downloading app-managed Ollama runtime", { url: plan.url, installDir, platform: process.platform, arch: os.arch() });
  await downloadFile(plan.url, archive, ({ received, total }) => {
    updateAiProgress(db, {
      status: "running",
      phase: "runtime-download",
      item: "Ollama runtime",
      detail: `Downloading ${plan.asset}.`,
      startedAt: progress.startedAt,
      currentBytes: 0,
      totalBytes: progress.totalModelBytes,
      runtimeBytesReceived: received,
      runtimeBytesTotal: total,
      percent: 0,
      etaSeconds: etaSeconds(progress.startedAt, received, total)
    });
  });
  upsertService(db, { name: "ollama", status: "installing", port: 11434, url: "http://127.0.0.1:11434", message: plan.mode === "windows-script" ? "Installing Ollama runtime" : "Extracting Ollama runtime" });
  updateAiProgress(db, {
    status: "running",
    phase: plan.mode === "windows-script" ? "runtime-install" : "runtime-extract",
    item: "Ollama runtime",
    detail: plan.mode === "windows-script" ? "Installing Ollama runtime." : "Extracting Ollama runtime.",
    startedAt: progress.startedAt,
    currentBytes: 0,
    totalBytes: progress.totalModelBytes,
    percent: 0,
    etaSeconds: null
  });
  await installOllamaRuntime({ archive, installDir, plan });
  await fsp.rm(archive, { force: true });

  const ollamaBin = path.join(installDir, plan.bin);
  await ensureOllamaRuntimePermissions(ollamaBin);
  process.env.SCA_OLLAMA_BIN = ollamaBin;
  recordEvent(db, "ollama-install", "Installed app-managed Ollama runtime", { ollamaBin });
  return { status: "installed", path: ollamaBin };
}

export function ollamaInstallPlan(platform = process.platform, arch = os.arch()) {
  if (platform === "linux") {
    const asset = arch === "x64" ? "ollama-linux-amd64.tar.zst" : arch === "arm64" ? "ollama-linux-arm64.tar.zst" : null;
    if (!asset) throw new Error(`Unsupported CPU architecture for managed Ollama install: ${arch}`);
    return { platform, arch, mode: "tar", asset, url: `https://ollama.com/download/${asset}`, bin: path.join("bin", "ollama") };
  }
  if (platform === "darwin") {
    if (!["x64", "arm64"].includes(arch)) throw new Error(`Unsupported CPU architecture for managed Ollama install: ${arch}`);
    const asset = "Ollama-darwin.zip";
    return { platform, arch, mode: "macos-zip", asset, url: `https://ollama.com/download/${asset}`, bin: path.join("Ollama.app", "Contents", "Resources", "ollama") };
  }
  if (platform === "win32") {
    if (!["x64", "arm64"].includes(arch)) throw new Error(`Unsupported CPU architecture for managed Ollama install: ${arch}`);
    const asset = "install.ps1";
    return { platform, arch, mode: "windows-script", asset, url: `https://ollama.com/${asset}`, bin: "ollama.exe" };
  }
  throw new Error(`Unsupported operating system for managed Ollama install: ${platform}`);
}

async function pullModelAndWait(db, libraryRoot, model, progress) {
  db.prepare("UPDATE models SET status=?, updated_at=? WHERE id=?").run("pulling", now(), model.id);
  recordEvent(db, "model-pull", `Pulling ${model.pull}`, { modelId: model.id, pull: model.pull });
  let lastError = null;
  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await startOllama(db, { modelsDir: path.join(libraryRoot, "raw", "models", "ollama"), logPath: path.join(libraryRoot, "logs", "ollama.log"), skipModelGuard: true });
        await pullModelWithProgress(db, model, progress, attempt);
        db.prepare("UPDATE models SET status=?, updated_at=? WHERE id=?").run("installed", now(), model.id);
        return;
      } catch (error) {
        lastError = error;
        recordEvent(db, "model-pull-retry", `Model pull attempt ${attempt} failed for ${model.pull}`, { modelId: model.id, pull: model.pull, error: String(error.message ?? error) });
        if (attempt >= 3) throw error;
        updateAiProgress(db, {
          status: "running",
          phase: "model-pull",
          item: model.title,
          detail: `${String(error.message ?? error)}. Restarting Ollama and resuming ${model.pull} (${attempt + 1}/3).`,
          startedAt: progress.startedAt,
          currentBytes: progress.completedModelBytes,
          totalBytes: progress.totalModelBytes,
          percent: progressPercent(progress.completedModelBytes, progress.totalModelBytes),
          etaSeconds: null
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  } catch {
    const detail = String(lastError?.message ?? lastError ?? "Model pull failed");
    updateAiProgress(db, {
      status: "failed",
      phase: "model-pull",
      item: model.title,
      detail,
      startedAt: progress.startedAt,
      currentBytes: progress.completedModelBytes,
      totalBytes: progress.totalModelBytes,
      percent: progressPercent(progress.completedModelBytes, progress.totalModelBytes),
      etaSeconds: null
    });
    db.prepare("UPDATE models SET status=?, updated_at=? WHERE id=?").run("failed", now(), model.id);
    throw lastError;
  }
}

async function pullModelWithProgress(db, model, progress, attempt = 1) {
  updateAiProgress(db, modelProgressPayload(model, progress, 0, Number(model.expected_size_bytes ?? 0), `Pulling ${model.pull}${attempt > 1 ? `, attempt ${attempt}/3` : ""}.`));
  const response = await fetch("http://127.0.0.1:11434/api/pull", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: model.pull, stream: true })
  });
  if (!response.ok) throw new Error(`Ollama pull failed for ${model.pull}: HTTP ${response.status}`);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.error) throw new Error(event.error);
      const completed = Number(event.completed ?? 0);
      const total = Number(event.total ?? model.expected_size_bytes ?? 0);
      updateAiProgress(db, modelProgressPayload(model, progress, completed, total, event.status ?? `Pulling ${model.pull}.`));
    }
  }
  if (buffer.trim()) {
    const event = JSON.parse(buffer);
    if (event.error) throw new Error(event.error);
    updateAiProgress(db, modelProgressPayload(model, progress, Number(event.completed ?? model.expected_size_bytes ?? 0), Number(event.total ?? model.expected_size_bytes ?? 0), event.status ?? `Finished ${model.pull}.`));
  }
}

async function modelIsInstalled(pullName) {
  try {
    const response = await fetch("http://127.0.0.1:11434/api/tags");
    if (!response.ok) return false;
    const data = await response.json();
    return (data.models ?? []).some((model) => modelNameAliases(model.name).includes(pullName));
  } catch {
    return false;
  }
}

function modelNameAliases(name) {
  if (!name) return [];
  if (name.endsWith(":latest")) return [name, name.slice(0, -":latest".length)];
  return [name];
}

function ollamaEnv() {
  return {
    ...process.env,
    OLLAMA_HOST: "127.0.0.1:11434",
    ...(process.env.SCA_OLLAMA_MODELS ? { OLLAMA_MODELS: process.env.SCA_OLLAMA_MODELS } : {})
  };
}

function commandWorks(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function downloadFile(url, target, onProgress = null) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed for ${url}: HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length") ?? 0);
  let received = 0;
  const file = fs.createWriteStream(target);
  try {
    for await (const chunk of response.body) {
      received += chunk.byteLength;
      if (!file.write(chunk)) await new Promise((resolve) => file.once("drain", resolve));
      onProgress?.({ received, total });
    }
  } finally {
    await new Promise((resolve, reject) => file.end((error) => (error ? reject(error) : resolve())));
  }
}

function modelProgressPayload(model, progress, completed, total, detail) {
  const expected = Number(model.expected_size_bytes ?? 0);
  const boundedCompleted = total > 0 ? Math.min(completed, total) : completed;
  const effectiveCompleted = total > 0 && expected > 0 ? Math.round((boundedCompleted / total) * expected) : boundedCompleted;
  const currentBytes = Math.min(progress.completedModelBytes + effectiveCompleted, progress.totalModelBytes || progress.completedModelBytes + effectiveCompleted);
  return {
    status: "running",
    phase: "model-pull",
    item: model.title,
    detail,
    startedAt: progress.startedAt,
    currentBytes,
    totalBytes: progress.totalModelBytes,
    modelBytesReceived: boundedCompleted,
    modelBytesTotal: total || expected,
    percent: progressPercent(currentBytes, progress.totalModelBytes),
    etaSeconds: etaSeconds(progress.startedAt, currentBytes, progress.totalModelBytes)
  };
}

function updateAiProgress(db, progress) {
  setSetting(db, "aiInstallProgress", { ...progress, updatedAt: Date.now() });
}

function progressPercent(current, total) {
  return total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
}

function etaSeconds(startedAt, current, total) {
  if (!startedAt || !current || !total || current >= total) return null;
  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  if (elapsedSeconds <= 0) return null;
  const bytesPerSecond = current / elapsedSeconds;
  return bytesPerSecond > 0 ? Math.max(1, Math.round((total - current) / bytesPerSecond)) : null;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", ...options });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`)));
  });
}

async function installOllamaRuntime({ archive, installDir, plan }) {
  if (plan.mode === "windows-script") {
    const powershell = await findPowerShell();
    await runCommand(powershell, [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", archive
    ], {
      env: {
        ...process.env,
        OLLAMA_INSTALL_DIR: installDir
      }
    });
    return;
  }
  if (plan.mode === "macos-zip") {
    await extractZipToDir(archive, installDir);
    return;
  }
  await extractOllamaArchive(archive, installDir);
}

async function extractOllamaArchive(archive, installDir) {
  if (archive.endsWith(".tar.zst")) {
    await runCommand("tar", ["--zstd", "-xf", archive, "-C", installDir]);
    return;
  }
  if (archive.endsWith(".tgz") || archive.endsWith(".tar.gz")) {
    await runCommand("tar", ["-xzf", archive, "-C", installDir]);
    return;
  }
  throw new Error(`Unsupported Ollama archive format: ${path.basename(archive)}`);
}

async function findPowerShell() {
  const candidates = ["pwsh", "powershell.exe", "powershell"];
  for (const candidate of candidates) {
    if (await commandWorks(candidate)) return candidate;
  }
  throw new Error("PowerShell is required to install Ollama on Windows.");
}
