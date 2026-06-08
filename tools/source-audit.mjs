import fs from "node:fs/promises";
import path from "node:path";
import { loadCatalog } from "../app/backend/catalog.mjs";
import { openSourceWithAdapter } from "../app/backend/adapters.mjs";
import { downloadSource } from "../app/backend/downloader.mjs";
import { stopService } from "../app/backend/services.mjs";
import { ensureLibrary, openState, upsertSource } from "../app/backend/state.mjs";

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = "1"] = arg.split("=");
  return [key.replace(/^--/, ""), value];
}));

const root = path.resolve(args.get("root") ?? "/tmp/sca-source-audit");
const mode = args.get("mode") ?? "probe";
const maxFullBytes = Number(args.get("max-full-bytes") ?? 250 * 1024 ** 2);
const diskBudgetBytes = Number(args.get("disk-budget-bytes") ?? 50_000_000_000);
const reportPath = path.resolve(args.get("report") ?? "source-audit-report.json");
const only = args.get("only") ? new Set(args.get("only").split(",").map((item) => item.trim()).filter(Boolean)) : null;
const from = args.get("from") ?? null;

const catalog = await loadCatalog();
const results = [];
let fromReached = !from;

for (const source of catalog.sources) {
  if (from && source.id === from) fromReached = true;
  if (!fromReached) continue;
  if (only && !only.has(source.id)) continue;
  const startedAt = new Date().toISOString();
  const result = { sourceId: source.id, title: source.title, type: source.type, startedAt, probe: null, full: "not-run", open: "not-run", cleanup: "not-run", error: null };
  console.log(`source ${results.length + 1}/${catalog.sources.length}: ${source.id}`);
  try {
    result.probe = await rangeProbe(source.url);
    const shouldFull = mode === "full" || (mode === "small" && Number(source.expected_size_bytes ?? 0) <= maxFullBytes);
    if (!shouldFull) {
      result.full = mode === "probe"
        ? "skipped: probe mode"
        : `skipped: expected ${source.expected_size_bytes} bytes exceeds max-full-bytes ${maxFullBytes}`;
      result.cleanup = "not-needed";
      results.push(result);
      console.log(`  probe ok; full skipped`);
      continue;
    }
    if (Number(source.expected_size_bytes ?? 0) > diskBudgetBytes) {
      throw new Error(`Source expected size ${source.expected_size_bytes} exceeds disk budget ${diskBudgetBytes}`);
    }
    await resetRoot(root);
    await ensureLibrary(root);
    const db = openState(root);
    try {
      upsertSource(db, source);
      const downloaded = await downloadSource({ db, libraryRoot: root, source, diskBudgetBytes });
      result.full = { path: downloaded.path, size: downloaded.size, sha256: downloaded.sha256 };
      console.log(`  downloaded ${downloaded.size} bytes`);
      const opened = await openSourceWithAdapter({ db, libraryRoot: root, source });
      result.open = { adapter: opened.adapter, action: opened.action, url: opened.url ?? null, opened: opened.opened ?? null, suppressed: opened.system?.suppressed ?? null };
      console.log(`  opened with ${opened.adapter}`);
      if (source.type === "zim") stopService(db, "kiwix");
    } finally {
      db.close();
    }
    await resetRoot(root);
    result.cleanup = "deleted";
    console.log("  cleanup deleted");
  } catch (error) {
    result.error = String(error.message ?? error);
    console.log(`  failed: ${result.error}`);
    await resetRoot(root).catch(() => {});
  }
  results.push(result);
  await writeReport();
}

await writeReport();
const failed = results.filter((item) => item.error);
console.log(`Audited ${results.length} sources; ${failed.length} failed; report ${reportPath}`);
if (failed.length) {
  for (const item of failed) console.log(`${item.sourceId}: ${item.error}`);
  process.exit(1);
}
process.exit(0);

async function writeReport() {
  await fs.writeFile(reportPath, JSON.stringify({ mode, root, maxFullBytes, diskBudgetBytes, only: only ? [...only] : null, from, generatedAt: new Date().toISOString(), results }, null, 2));
}

async function rangeProbe(url) {
  const response = await fetch(url, { headers: { Range: "bytes=0-31" }, redirect: "follow" });
  const body = new Uint8Array(await response.arrayBuffer());
  if (!response.ok && response.status !== 206) throw new Error(`Probe HTTP ${response.status} ${response.statusText}`);
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    contentLength: Number(response.headers.get("content-length") ?? 0),
    contentRange: response.headers.get("content-range"),
    signature: Buffer.from(body.slice(0, 8)).toString("hex")
  };
}

async function resetRoot(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}
