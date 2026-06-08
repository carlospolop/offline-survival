import fs from "node:fs/promises";
import path from "node:path";
import { loadCatalog, readYaml } from "../app/backend/catalog.mjs";

const root = process.cwd();
const ids = new Set();
const errors = [];
const catalog = await loadCatalog();

for (const source of catalog.sources) {
  for (const field of ["id", "title", "type", "license", "language", "url", "expected_size_bytes", "runtime", "profiles"]) {
    if (source[field] === undefined || source[field] === null) errors.push(`${source.id ?? "unknown"} missing ${field}`);
  }
  if (source.language && !/^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(source.language)) errors.push(`${source.id} has invalid language ${source.language}`);
  if (ids.has(source.id)) errors.push(`duplicate source id ${source.id}`);
  ids.add(source.id);
}

for (const profile of catalog.profiles) {
  if (!["en", "es", "both"].includes(profile.language)) errors.push(`${profile.id} has invalid or missing language ${profile.language ?? "missing"}`);
  if (profile.expectedSizeBytes > profile.disk_budget_gb * 1_000_000_000) {
    errors.push(`${profile.id} expected size exceeds its declared disk budget`);
  }
}

const profileFiles = await fs.readdir(path.join(root, "manifests/profiles"));
for (const file of profileFiles) {
  const profile = await readYaml(path.join(root, "manifests/profiles", file));
  for (const sourceId of profile.sources ?? []) {
    if (!ids.has(sourceId)) errors.push(`${profile.id} references missing source ${sourceId}`);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`Validated ${catalog.sources.length} sources and ${catalog.profiles.length} profiles.`);
