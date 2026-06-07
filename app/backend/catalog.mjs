import fs from "node:fs/promises";
import path from "node:path";
import YAML from "./vendor/yaml/browser/index.js";

const root = process.cwd();
const profileOrder = [
  "survival-essential",
  "survival-plus",
  "civilization-core",
  "civilization-rebuild",
  "civilization-max"
];

export async function readYaml(file) {
  return YAML.parse(await fs.readFile(file, "utf8"));
}

export async function loadCatalog() {
  const catalog = await readYaml(path.join(root, "manifests/sources/catalog.yaml"));
  const profileDir = path.join(root, "manifests/profiles");
  const files = (await fs.readdir(profileDir)).filter((name) => name.endsWith(".yaml")).sort();
  const profiles = await Promise.all(files.map((file) => readYaml(path.join(profileDir, file))));
  const sourceMap = new Map(catalog.sources.map((source) => [source.id, source]));
  const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));

  function expandProfile(id, seen = new Set()) {
    if (seen.has(id)) return [];
    seen.add(id);
    const profile = profileMap.get(id);
    if (!profile) throw new Error(`Unknown profile ${id}`);
    const inherited = (profile.includes ?? []).flatMap((parent) => expandProfile(parent, seen));
    return [...inherited, ...(profile.sources ?? [])];
  }

  const preparedSources = catalog.sources.map((source) => ({
    ...source,
    prepared_size_bytes: preparedSizeBytes(source)
  }));
  const preparedSourceMap = new Map(preparedSources.map((source) => [source.id, source]));

  const resolvedProfiles = profiles.map((profile) => {
    const ids = [...new Set(expandProfile(profile.id))];
    const addedIds = profile.sources ?? [];
    const sources = ids.map((id) => {
      const source = preparedSourceMap.get(id);
      if (!source) throw new Error(`Profile ${profile.id} references missing source ${id}`);
      return source;
    });
    for (const id of addedIds) {
      if (!sourceMap.has(id)) throw new Error(`Profile ${profile.id} references missing source ${id}`);
    }
    const expectedSizeBytes = sources.reduce((sum, source) => sum + Number(source.expected_size_bytes ?? 0), 0);
    const addedExpectedSizeBytes = addedIds.reduce((sum, id) => sum + Number(sourceMap.get(id)?.expected_size_bytes ?? 0), 0);
    const preparedSizeBytes = sources.reduce((sum, source) => sum + Number(source.prepared_size_bytes ?? source.expected_size_bytes ?? 0), 0);
    const addedPreparedSizeBytes = addedIds.reduce((sum, id) => {
      const source = preparedSourceMap.get(id);
      return sum + Number(source?.prepared_size_bytes ?? source?.expected_size_bytes ?? 0);
    }, 0);
    return { ...profile, sourceIds: ids, addedSourceIds: addedIds, expectedSizeBytes, addedExpectedSizeBytes, preparedSizeBytes, addedPreparedSizeBytes };
  }).sort((a, b) => profileOrder.indexOf(a.id) - profileOrder.indexOf(b.id));

  return { sources: preparedSources, models: catalog.models ?? [], profiles: resolvedProfiles };
}

export function preparedSizeBytes(source) {
  const downloaded = Number(source.expected_size_bytes ?? 0);
  if (!String(source.open?.action ?? "").startsWith("extract_")) return downloaded;
  const extracted = Number(source.expected_extracted_size_bytes ?? source.uncompressed_size_bytes ?? downloaded);
  return downloaded + Math.max(0, extracted);
}

export function classifySourcePath(source) {
  if (source.type === "zim") return "raw/zim";
  if (source.type === "pdf") return "raw/pdf";
  if (source.type === "epub") return "raw/epub";
  if (source.type === "repo-archive") return "raw/repos";
  if (source.type === "html") return "raw/html";
  if (source.type === "model") return "raw/models";
  return "raw";
}

export function artifactName(source) {
  if (source.artifact_name) return source.artifact_name;
  const parsed = new URL(source.url, "https://example.invalid/");
  const base = path.basename(parsed.pathname);
  const extension = path.extname(base);
  const fallbackExt = defaultExtension(source.type);
  const safeBase = base && base !== "/" ? base : `${source.id}${fallbackExt}`;
  return safeBase.includes(".") ? `${source.id}-${safeBase}` : `${source.id}${extension || fallbackExt}`;
}

function defaultExtension(type) {
  if (type === "html") return ".html";
  if (type === "pdf") return ".pdf";
  if (type === "epub") return ".epub";
  if (type === "zim") return ".zim";
  if (type === "repo-archive") return ".zip";
  return ".dat";
}
