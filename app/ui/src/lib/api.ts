export type Source = {
  id: string;
  title: string;
  description: string;
  type: string;
  category: string;
  tags?: string[];
  license: string;
  expected_size_bytes: number;
  prepared_size_bytes?: number;
  runtime: string[];
};

export type Profile = {
  id: string;
  title: string;
  language?: "en" | "es" | "both" | string;
  variant?: "english" | "spanish" | "bilingual" | string;
  description: string;
  target_size_gb: [number, number];
  disk_budget_gb: number;
  sourceIds: string[];
  addedSourceIds: string[];
  expectedSizeBytes: number;
  addedExpectedSizeBytes: number;
  preparedSizeBytes?: number;
  addedPreparedSizeBytes?: number;
};

declare global {
  interface Window {
    __SCA_API_PORT?: number;
    __SCA_API_TOKEN?: string;
    __TAURI_INTERNALS__?: unknown;
  }
}

let cachedBackendPort = 0;
const failedBackendPorts = new Set<number>();

async function apiOrigins() {
  const configuredPort = await packagedBackendPort();
  if (configuredPort) return [`http://127.0.0.1:${configuredPort}`, `http://localhost:${configuredPort}`];
  if (isPackagedTauri()) return [];

  const origins = ["http://127.0.0.1:8787", "http://localhost:8787"];
  if (typeof window === "undefined" || !window.location.origin.startsWith("http")) return origins;
  return [window.location.origin, ...origins.filter((origin) => origin !== window.location.origin)];
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const targets = path.startsWith("/api") ? (await apiOrigins()).map((origin) => `${origin}${path}`) : [path];
    if (!targets.length) throw new Error("Could not connect to the packaged backend: the app did not provide a backend port.");

    for (const target of targets) {
      try {
        const response = await fetch(target, {
          ...options,
          headers: { "content-type": "application/json", ...(options.headers ?? {}) }
        });
        const data = await parseJson(response);
        if (!response.ok || data.error) throw new Error(data.error ?? response.statusText);
        return data as T;
      } catch (err) {
        lastError = err;
        markBackendPortFailed(target);
      }
    }
    await wait(Math.min(250 * (attempt + 1), 1000));
  }

  throw new Error(readableApiError(lastError));
}

async function packagedBackendPort() {
  if (!isPackagedTauri()) return 0;
  const existing = backendPortFromWindow();
  if (existing && !failedBackendPorts.has(existing)) {
    cachedBackendPort = existing;
    return existing;
  }
  if (cachedBackendPort && !failedBackendPorts.has(cachedBackendPort)) return cachedBackendPort;

  const injected = await waitForBackendPort(1000);
  if (injected && !failedBackendPorts.has(injected)) {
    cachedBackendPort = injected;
    return injected;
  }

  const discovered = await discoverPackagedBackendPort(existing || cachedBackendPort);
  if (discovered) {
    cachedBackendPort = discovered;
    failedBackendPorts.delete(discovered);
    return discovered;
  }
  return injected || existing || cachedBackendPort;
}

function backendPortFromWindow() {
  if (typeof window === "undefined") return 0;
  const port = Number(window.__SCA_API_PORT ?? 0);
  return Number.isInteger(port) && port > 0 ? port : 0;
}

function isPackagedTauri() {
  if (typeof window === "undefined") return false;
  const origin = window.location.origin;
  return Boolean(window.__TAURI_INTERNALS__) || window.location.protocol === "tauri:" || origin.includes("tauri.localhost");
}

function waitForBackendPort(timeoutMs = 5000) {
  return new Promise<number>((resolve) => {
    const ready = backendPortFromWindow();
    if (ready) return resolve(ready);

    let settled = false;
    const finish = (port: number) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("sca-backend-configured", onConfigured);
      window.clearTimeout(timer);
      resolve(port);
    };
    const onConfigured = () => finish(backendPortFromWindow());
    const timer = window.setTimeout(() => finish(backendPortFromWindow()), timeoutMs);
    window.addEventListener("sca-backend-configured", onConfigured, { once: true });
  });
}

async function discoverPackagedBackendPort(hint = 0) {
  const ports = backendPortCandidates(hint);
  const batchSize = 96;
  for (let index = 0; index < ports.length; index += batchSize) {
    const found = (await Promise.all(ports.slice(index, index + batchSize).map(probeBackendPort))).find(Boolean);
    if (found) return found;
  }
  return 0;
}

function backendPortCandidates(hint = 0) {
  const ports: number[] = [];
  const add = (port: number) => {
    if (Number.isInteger(port) && port > 0 && port <= 65535 && !ports.includes(port)) ports.push(port);
  };
  add(hint);
  if (hint) {
    for (let offset = 1; offset <= 4096; offset += 1) {
      add(hint + offset);
      add(hint - offset);
    }
  } else {
    for (let port = 62000; port <= 65535; port += 1) add(port);
    for (let port = 49152; port < 62000; port += 1) add(port);
  }
  return ports;
}

async function probeBackendPort(port: number) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 150);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
    if (!response.ok) return 0;
    const health = await response.json();
    if (health?.status !== "ok" || !health?.packaged) return 0;
    window.__SCA_API_PORT = Number(health.port ?? port);
    window.__SCA_API_TOKEN = String(health.token ?? "");
    window.dispatchEvent(new CustomEvent("sca-backend-configured"));
    return Number(health.port ?? port);
  } catch {
    return 0;
  } finally {
    window.clearTimeout(timeout);
  }
}

function markBackendPortFailed(target: string) {
  if (!isPackagedTauri()) return;
  let port = 0;
  try {
    port = Number(new URL(target).port);
  } catch {
    return;
  }
  if (!port) return;
  failedBackendPorts.add(port);
  if (cachedBackendPort === port) cachedBackendPort = 0;
  if (backendPortFromWindow() === port) window.__SCA_API_PORT = 0;
}

async function parseJson(response: Response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 180)}`);
  }
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function readableApiError(err: unknown) {
  const message = String((err as Error)?.message ?? err);
  if (message === "Load failed" || message === "Failed to fetch") {
    return "Could not connect to the local backend after several retries.";
  }
  return message;
}

export function gb(bytes: number) {
  if (!bytes) return "0 GB";
  return `${(bytes / 1_000_000_000).toFixed(bytes > 10_000_000_000 ? 1 : 2)} GB`;
}

export function statusTone(status?: string) {
  if (status === "downloaded" || status === "verified" || status === "indexed" || status === "running" || status === "installed" || status === "complete" || status === "ready" || status === "opened") return "ok";
  if (status === "missing" || status === "available" || status === "stopped" || status === "indexed-original-only" || status === "pulling" || status === "paused" || status === "queued" || status === "installing" || status === "starting" || status === "ready_for_kiwix" || status === "not_ready" || status === "downloaded_unverified") return "warn";
  if (status === "broken" || status === "failed" || status === "corrupt" || status === "blocked") return "bad";
  return "neutral";
}
