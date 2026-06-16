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

async function apiOrigins() {
  const configuredPort = await packagedBackendPort();
  if (configuredPort) return [`http://127.0.0.1:${configuredPort}`, `http://localhost:${configuredPort}`];
  if (isPackagedTauri()) return [];

  const origins = ["http://127.0.0.1:8787", "http://localhost:8787"];
  if (typeof window === "undefined" || !window.location.origin.startsWith("http")) return origins;
  return [window.location.origin, ...origins.filter((origin) => origin !== window.location.origin)];
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const targets = path.startsWith("/api") ? (await apiOrigins()).map((origin) => `${origin}${path}`) : [path];
  let lastError: unknown = null;

  if (!targets.length) throw new Error("Could not connect to the packaged backend: the app did not provide a backend port.");

  for (let attempt = 0; attempt < 8; attempt += 1) {
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
      }
    }
    await wait(Math.min(250 * (attempt + 1), 1000));
  }

  throw new Error(readableApiError(lastError));
}

async function packagedBackendPort() {
  const existing = backendPortFromWindow();
  if (existing) return existing;
  if (!isPackagedTauri()) return 0;
  return await waitForBackendPort();
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
