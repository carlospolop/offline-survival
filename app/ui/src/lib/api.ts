import { invoke } from "@tauri-apps/api/core";

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

let backendConfigRequest: Promise<number> | null = null;

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
  const signal = options.signal ?? (isStartupRequest(path) ? AbortSignal.timeout(15_000) : undefined);
  const retryable = ["GET", "HEAD"].includes(String(options.method ?? "GET").toUpperCase());

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const targets = path.startsWith("/api") ? (await apiOrigins()).map((origin) => `${origin}${path}`) : [path];
    if (!targets.length) throw new Error("Could not connect to the packaged backend: the app did not provide a backend port.");

    for (const target of targets) {
      let response: Response;
      try {
        response = await fetch(target, {
          ...options,
          headers: apiHeaders(options.headers),
          signal
        });
      } catch (err) {
        if (signal?.aborted) throw new Error("The local backend request timed out or was cancelled. Please retry.");
        // A failed response can follow a successful action. Retrying a POST can
        // duplicate imports, generation, or package creation on the server.
        if (!retryable) throw new Error(readableApiError(err));
        lastError = err;
        continue;
      }
      const data = await parseJson(response);
      // Application errors are definitive responses, not connection failures.
      if (!response.ok || data?.error) throw new Error(data?.error ?? response.statusText);
      return data as T;
    }
    await wait(Math.min(250 * (attempt + 1), 1000));
  }

  throw new Error(readableApiError(lastError));
}

function apiHeaders(headers: HeadersInit | undefined) {
  const next = new Headers(headers);
  if (!next.has("content-type")) next.set("content-type", "application/json");
  const token = backendTokenFromWindow();
  if (token && !next.has("x-sca-backend-token")) next.set("x-sca-backend-token", token);
  return next;
}

function backendTokenFromWindow() {
  if (typeof window === "undefined") return "";
  return String(window.__SCA_API_TOKEN ?? "");
}

async function packagedBackendPort() {
  if (!isPackagedTauri()) return 0;
  const existing = backendPortFromWindow();
  if (existing && backendTokenFromWindow()) return existing;

  // Ask the native process directly rather than scanning local ports. The
  // launch-time eval may have happened before the current document existed.
  if (!backendConfigRequest) {
    backendConfigRequest = requestBackendConfig().finally(() => {
      backendConfigRequest = null;
    });
  }
  return backendConfigRequest;
}

async function requestBackendConfig() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [port, token] = await Promise.race([
      invoke<[number, string]>("backend_config"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("The desktop app did not provide its backend connection details.")), 3000);
      })
    ]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || !token) {
      throw new Error("The desktop app provided invalid backend connection details.");
    }
    window.__SCA_API_PORT = port;
    window.__SCA_API_TOKEN = token;
    return port;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isStartupRequest(path: string) {
  return ["/api/catalog", "/api/state", "/api/system", "/api/jobs"].includes(path);
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
