import fs from "node:fs/promises";
import path from "node:path";
import { now, recordEvent } from "./state.mjs";

const licenseRules = {
  "CC-BY-SA-4.0": { redistribution: "allowed", commercial_use: "allowed", attribution_required: true, llm_ingestion_allowed: "unknown" },
  "CC-BY-4.0": { redistribution: "allowed", commercial_use: "allowed", attribution_required: true, llm_ingestion_allowed: "unknown" },
  "CC-BY-NC-SA-3.0": { redistribution: "personal-only", commercial_use: "non-commercial-only", attribution_required: true, llm_ingestion_allowed: "restricted" },
  "CC-BY-NC-SA-3.0-IGO": { redistribution: "personal-only", commercial_use: "non-commercial-only", attribution_required: true, llm_ingestion_allowed: "restricted" },
  "public-domain-us": { redistribution: "allowed", commercial_use: "allowed", attribution_required: false, llm_ingestion_allowed: "allowed" },
  "public-domain-derived": { redistribution: "allowed", commercial_use: "allowed", attribution_required: true, llm_ingestion_allowed: "allowed" },
  "Apache-2.0": { redistribution: "allowed", commercial_use: "allowed", attribution_required: true, llm_ingestion_allowed: "allowed" },
  "MIT": { redistribution: "allowed", commercial_use: "allowed", attribution_required: true, llm_ingestion_allowed: "allowed" }
};

export function classifyLicense(expression) {
  return licenseRules[expression] ?? { redistribution: "unclear", commercial_use: "unclear", attribution_required: true, llm_ingestion_allowed: "unknown" };
}

export async function writeAttributionReport({ db, libraryRoot, catalog }) {
  const rows = db.prepare("SELECT * FROM sources ORDER BY title").all();
  const byId = new Map(catalog.sources.map((source) => [source.id, source]));
  const entries = rows.map((row) => {
    const manifest = byId.get(row.id) ?? {};
    return {
      id: row.id,
      title: row.title,
      license: row.license,
      rules: classifyLicense(row.license),
      attribution: manifest.attribution ?? row.title,
      source_url: row.source_url,
      status: row.status
    };
  });
  const summary = entries.reduce((acc, entry) => {
    acc[entry.license] = (acc[entry.license] ?? 0) + 1;
    return acc;
  }, {});
  const report = { generated_at: now(), summary, entries };
  const rel = "attribution-report.json";
  await fs.writeFile(path.join(libraryRoot, rel), JSON.stringify(report, null, 2));
  recordEvent(db, "license", "Wrote attribution and license report", { path: rel });
  return { path: rel, report };
}
