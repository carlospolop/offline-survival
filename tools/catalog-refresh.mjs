import fs from "node:fs/promises";
import { loadCatalog } from "../app/backend/catalog.mjs";

const catalog = await loadCatalog();
const snapshot = {
  generated_at: new Date().toISOString(),
  profiles: catalog.profiles.map((profile) => ({
    id: profile.id,
    title: profile.title,
    source_count: profile.sourceIds.length,
    expected_size_bytes: profile.expectedSizeBytes
  })),
  sources: catalog.sources.map((source) => ({
    id: source.id,
    title: source.title,
    type: source.type,
    url: source.url,
    expected_size_bytes: source.expected_size_bytes,
    license: source.license
  }))
};
await fs.mkdir("manifests/locks", { recursive: true });
await fs.writeFile("manifests/locks/catalog-snapshot.json", JSON.stringify(snapshot, null, 2));
console.log(`Wrote manifests/locks/catalog-snapshot.json with ${snapshot.sources.length} sources.`);
