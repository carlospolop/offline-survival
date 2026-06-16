import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { getSettings, now, recordEvent } from "./state.mjs";
import { estimateModelRamBytes, memorySnapshot } from "./system.mjs";

const running = new Map();
const runningMeta = new Map();
export const KIWIX_PORT = 8089;
export const KIWIX_PORT_COUNT = 50;
export const LOCAL_STATIC_PORT = 8195;
export const LOCAL_STATIC_PORT_COUNT = 50;

export function runtimeCandidates(command, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
  const localAppData = env.LOCALAPPDATA ?? (home ? path.join(home, "AppData", "Local") : "");
  const candidates = [
    command === "ollama" ? env.SCA_OLLAMA_BIN : null,
    env.SCA_SIDECAR_DIR ? path.join(env.SCA_SIDECAR_DIR, command) : null,
    env.APPDIR ? path.join(env.APPDIR, "usr", "bin", command) : null,
    ...platformRuntimeCandidates(command, platform, { home, localAppData }),
    command
  ].filter(Boolean);
  return [...new Set(candidates)];
}

export function resolveRuntime(command, options = {}) {
  const candidates = [
    ...runtimeCandidates(command, options)
  ];
  return candidates.find((candidate) => candidate === command || fs.existsSync(candidate)) ?? command;
}

function platformRuntimeCandidates(command, platform, { home, localAppData }) {
  if (command !== "ollama") return [];
  if (platform === "darwin") {
    return [
      path.join(home, "Applications", "Ollama.app", "Contents", "Resources", "ollama"),
      "/Applications/Ollama.app/Contents/Resources/ollama",
      "/usr/local/bin/ollama",
      "/opt/homebrew/bin/ollama",
      "/opt/local/bin/ollama"
    ];
  }
  if (platform === "linux") {
    return [
      "/usr/local/bin/ollama",
      "/usr/bin/ollama",
      "/bin/ollama",
      path.join(home, ".local", "bin", "ollama")
    ];
  }
  if (platform === "win32") {
    return [
      path.join(localAppData, "Programs", "Ollama", "ollama.exe"),
      path.join(localAppData, "Ollama", "ollama.exe"),
      "C:\\Program Files\\Ollama\\ollama.exe",
      "C:\\Program Files (x86)\\Ollama\\ollama.exe",
      "ollama.exe"
    ];
  }
  return [];
}

export function detectRuntime(command) {
  return new Promise((resolve) => {
    const child = spawn(resolveRuntime(command), ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

export async function serviceStatus(db) {
  const kiwix = await detectRuntime("kiwix-serve");
  const ollama = await detectRuntime("ollama");
  const ollamaHttp = await ollamaResponds();
  const settings = getSettings(db);
  const aiProgress = settings.aiInstallProgress;
  const aiInstalling = aiProgress?.status === "running";
  const existingOllama = db.prepare("SELECT * FROM services WHERE name='ollama'").get();
  const kiwixService = await currentKiwixService(db, kiwix);
  upsertService(db, kiwixService);
  const ollamaStatus = running.has("ollama") || ollamaHttp
    ? "running"
    : ollama
      ? existingOllama?.status === "blocked" ? "blocked" : "available"
      : aiInstalling
        ? existingOllama?.status === "starting" ? "starting" : "installing"
        : "missing";
  upsertService(db, {
    name: "ollama",
    status: ollamaStatus,
    port: 11434,
    url: "http://127.0.0.1:11434",
    message: aiInstalling ? aiProgress.detail : existingOllama?.status === "blocked" ? existingOllama.message : null
  });
  return db.prepare("SELECT * FROM services ORDER BY name").all();
}

export function upsertService(db, service) {
  db.prepare("INSERT INTO services (name, status, pid, port, url, message, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET status=excluded.status, pid=excluded.pid, port=excluded.port, url=excluded.url, message=excluded.message, updated_at=excluded.updated_at")
    .run(service.name, service.status, service.pid ?? null, service.port ?? null, service.url ?? null, service.message ?? null, now());
}

export async function findAvailablePort(preferred = KIWIX_PORT, host = "127.0.0.1", count = KIWIX_PORT_COUNT) {
  for (let port = preferred; port < preferred + count; port++) {
    if (await canBind(port, host)) return port;
  }
  throw new Error(`No available localhost port found from ${preferred} to ${preferred + count - 1}`);
}

function canBind(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

export async function startKiwix(db, zimPaths = [], port = KIWIX_PORT, options = {}) {
  const existing = await currentKiwixService(db, true);
  if (existing.status === "running") return existing;
  if (!zimPaths.length) throw new Error("No downloaded ZIM files available");
  const actualPort = await findAvailablePort(port, "127.0.0.1", KIWIX_PORT_COUNT);
  if (actualPort !== port) recordEvent(db, "port-conflict", `Port ${port} was busy; Kiwix will use ${actualPort}`, { requested: port, actual: actualPort });
  const logPath = options.logPath ?? null;
  const stdio = logPath ? ["ignore", "ignore", "pipe"] : "ignore";
  const child = spawn(resolveRuntime("kiwix-serve"), ["--port", String(actualPort), "--address", "127.0.0.1", ...zimPaths], { stdio });
  if (logPath && child.stderr) {
    await fsp.mkdir(path.dirname(logPath), { recursive: true });
    child.stderr.on("data", (chunk) => fs.appendFileSync(logPath, chunk));
  }
  running.set("kiwix", child);
  runningMeta.set("kiwix", { status: "starting", pid: child.pid, port: actualPort, url: `http://127.0.0.1:${actualPort}` });
  child.on("error", (error) => {
    running.delete("kiwix");
    runningMeta.delete("kiwix");
    try {
      upsertService(db, { name: "kiwix", status: "failed", port: actualPort, url: `http://127.0.0.1:${actualPort}`, message: String(error.message ?? error) });
    } catch {
      // Request-scoped DB may already be closed.
    }
  });
  child.on("exit", (code) => {
    running.delete("kiwix");
    runningMeta.delete("kiwix");
    try {
      upsertService(db, { name: "kiwix", status: code === 0 ? "stopped" : "failed", message: `Exited with code ${code}` });
    } catch {
      // Request-scoped DB may already be closed.
    }
  });
  upsertService(db, { name: "kiwix", status: "starting", pid: child.pid, port: actualPort, url: `http://127.0.0.1:${actualPort}`, message: logPath ? `stderr: ${logPath}` : null });
  await waitForKiwix(actualPort);
  const service = { name: "kiwix", status: "running", pid: child.pid, port: actualPort, url: `http://127.0.0.1:${actualPort}`, message: logPath ? `stderr: ${logPath}` : null };
  runningMeta.set("kiwix", service);
  upsertService(db, service);
  return service;
}

export function stopService(db, name) {
  const child = running.get(name);
  if (child) child.kill();
  running.delete(name);
  runningMeta.delete(name);
  upsertService(db, { name, status: "stopped" });
  return { name, status: "stopped" };
}

async function currentKiwixService(db, runtimeAvailable) {
  const meta = runningMeta.get("kiwix");
  if (meta?.port && await kiwixResponds(meta.port)) return { ...meta, name: "kiwix", status: "running" };
  if (running.has("kiwix")) {
    const child = running.get("kiwix");
    child.kill();
    running.delete("kiwix");
    runningMeta.delete("kiwix");
  }

  const row = db.prepare("SELECT * FROM services WHERE name='kiwix'").get();
  if (row?.port && await kiwixResponds(Number(row.port))) {
    return { name: "kiwix", status: "running", pid: row.pid ?? null, port: Number(row.port), url: `http://127.0.0.1:${row.port}`, message: row.message ?? null };
  }

  const detectedPort = await findRespondingKiwixPort();
  if (detectedPort) {
    return { name: "kiwix", status: "running", pid: null, port: detectedPort, url: `http://127.0.0.1:${detectedPort}`, message: "Detected existing local Kiwix server" };
  }

  return { name: "kiwix", status: runtimeAvailable ? "available" : "missing", port: KIWIX_PORT, url: `http://127.0.0.1:${KIWIX_PORT}` };
}

async function findRespondingKiwixPort(preferred = KIWIX_PORT) {
  for (let port = preferred; port < preferred + KIWIX_PORT_COUNT; port += 1) {
    if (await kiwixResponds(port)) return port;
  }
  return null;
}

async function kiwixResponds(port, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/catalog/v2/entries`);
    if (response.ok) return true;
  } catch {
    return false;
  }
  return false;
}

async function waitForKiwix(port) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await kiwixResponds(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Kiwix did not start on 127.0.0.1:${port}`);
}

export async function startOllama(db, options = {}) {
  if (!options.model && !options.skipModelGuard) throw new Error("Starting Local AI requires an installed chat model so RAM safety can be checked.");
  if (options.model) await assertOllamaMemoryAllowed(db, options.model);
  if (await ollamaResponds()) {
    upsertService(db, { name: "ollama", status: "running", port: 11434, url: "http://127.0.0.1:11434" });
    return { status: "running", port: 11434, url: "http://127.0.0.1:11434" };
  }
  if (running.has("ollama")) return { status: "starting", port: 11434, url: "http://127.0.0.1:11434" };

  const runtime = resolveRuntime("ollama");
  if (runtime !== "ollama" && !fs.existsSync(runtime)) {
    upsertService(db, { name: "ollama", status: "missing", port: 11434, url: "http://127.0.0.1:11434", message: `Ollama runtime is missing: ${runtime}` });
    throw new Error(`Ollama runtime is missing: ${runtime}`);
  }
  if (runtime === "ollama" && !(await detectRuntime("ollama"))) {
    upsertService(db, { name: "ollama", status: "missing", port: 11434, url: "http://127.0.0.1:11434", message: "Ollama runtime is not installed" });
    throw new Error("Ollama runtime is not installed");
  }

  const logPath = options.logPath ?? null;
  const env = {
    ...process.env,
    OLLAMA_HOST: "127.0.0.1:11434",
    ...(options.modelsDir ? { OLLAMA_MODELS: options.modelsDir } : {})
  };
  const stdio = logPath ? ["ignore", "ignore", "pipe"] : "ignore";
  const child = spawn(runtime, ["serve"], { env, stdio });
  if (logPath && child.stderr) {
    await fsp.mkdir(path.dirname(logPath), { recursive: true });
    child.stderr.on("data", (chunk) => fs.appendFileSync(logPath, chunk));
  }
  running.set("ollama", child);
  child.on("exit", (code) => {
    running.delete("ollama");
    try {
      upsertService(db, { name: "ollama", status: code === 0 ? "stopped" : "failed", message: `Exited with code ${code}` });
    } catch {
      // Request-scoped DB may already be closed.
    }
  });
  upsertService(db, { name: "ollama", status: "starting", pid: child.pid, port: 11434, url: "http://127.0.0.1:11434", message: logPath ? `stderr: ${logPath}` : null });

  await waitForOllama();
  upsertService(db, { name: "ollama", status: "running", pid: child.pid, port: 11434, url: "http://127.0.0.1:11434", message: logPath ? `stderr: ${logPath}` : null });
  return { status: "running", pid: child.pid, port: 11434, url: "http://127.0.0.1:11434" };
}

export async function assertOllamaMemoryAllowed(db, model) {
  const memory = await memorySnapshot();
  const requiredBytes = estimateModelRamBytes(model);
  const swapPressure = memory.swapTotalBytes > 0 && memory.swapFreeBytes < Math.max(1024 ** 3, memory.swapTotalBytes * 0.4);
  if (memory.availableBytes >= requiredBytes && !swapPressure) return { allowed: true, memory, requiredBytes };
  const modelName = model?.pull || model?.title || "the selected chat model";
  const detail = [
    `Local AI was not started because this computer does not currently have enough safe RAM for ${modelName}.`,
    `Available RAM: ${formatBytes(memory.availableBytes)}.`,
    `Required safe RAM: ${formatBytes(requiredBytes)}.`,
    swapPressure ? `Swap is also almost full: ${formatBytes(memory.swapFreeBytes)} free.` : null,
    "You can still download models and sources; close other apps or choose a smaller chat model before starting Local AI."
  ].filter(Boolean).join(" ");
  upsertService(db, {
    name: "ollama",
    status: "blocked",
    port: 11434,
    url: "http://127.0.0.1:11434",
    message: detail
  });
  recordEvent(db, "ollama-memory-blocked", detail, {
    model: modelName,
    availableBytes: memory.availableBytes,
    requiredBytes,
    swapFreeBytes: memory.swapFreeBytes,
    swapTotalBytes: memory.swapTotalBytes
  });
  const error = new Error(detail);
  error.code = "SCA_OLLAMA_MEMORY_BLOCKED";
  error.memory = memory;
  error.requiredBytes = requiredBytes;
  throw error;
}

function formatBytes(bytes) {
  const gb = Number(bytes ?? 0) / 1024 ** 3;
  return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
}

async function ollamaResponds(fetchImpl = fetch) {
  try {
    const response = await fetchImpl("http://127.0.0.1:11434/api/tags");
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForOllama() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await ollamaResponds()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Ollama did not start on 127.0.0.1:11434");
}

export async function askOllama({ question, contexts, model = "qwen3:8b", fetchImpl = fetch }) {
  if (!contexts.length) {
    return {
      answer: "No indexed local source matched that question. Try a more specific question, choose All indexed resources, or index the relevant downloaded source.",
      citations: [],
      unsupported: true
    };
  }
  const prompt = [
    "Answer using only the cited context. If the context is insufficient, say what is missing. Give a complete, practical answer and cite the relevant source numbers inline.",
    "",
    ...contexts.map((context, index) => `[${index + 1}] ${context.title}\n${context.snippet ?? context.body}`),
    "",
    `Question: ${question}`
  ].join("\n");
  let response;
  try {
    response = await fetchImpl("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0.1, num_predict: 384 } })
    });
  } catch {
    return {
      answer: "Local AI found relevant indexed sources, but Ollama is not running. Use Local AI -> Install All Recommended, or start Ollama, then ask again.",
      citations: contexts.map((context, index) => ({ index: index + 1, source_id: context.source_id, title: context.title, path: context.path })),
      unsupported: true
    };
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const missingModel = response.status === 404 || /model|not found|pull/i.test(detail);
    return {
      answer: missingModel
        ? `Local AI found relevant indexed sources, but the chat model "${model}" is not installed. Use Local AI -> Install All Recommended, then ask again.`
        : `Local AI found relevant indexed sources, but Ollama returned HTTP ${response.status}. ${detail}`.trim(),
      citations: contexts.map((context, index) => ({ index: index + 1, source_id: context.source_id, title: context.title, path: context.path })),
      unsupported: true
    };
  }
  const data = await response.json();
  return {
    answer: highRiskPrefix(question) + data.response,
    citations: contexts.map((context, index) => ({ index: index + 1, source_id: context.source_id, title: context.title, path: context.path })),
    unsupported: false
  };
}

function highRiskPrefix(question) {
  return /(medical|medicine|dose|dosage|infection|electrical|chemical|structural|poison|pregnan|surgery|antibiotic)/i.test(question)
    ? "High-risk topic: verify against the cited local sources and seek qualified help when possible.\n\n"
    : "";
}
