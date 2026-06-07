import { now, recordEvent, setSetting } from "./state.mjs";

export function updateStatus({ db, catalog }) {
  const last = db.prepare("SELECT value FROM settings WHERE key='lastCatalogRefresh'").get();
  const snapshot = {
    checked_at: now(),
    app_update: "manual-release-check",
    manifest_update: last ? "current-local-snapshot" : "not_refreshed",
    content_snapshot_update: "user_approved_only",
    runtime_update: "manual",
    model_update: "manual",
    source_count: catalog.sources.length,
    model_count: catalog.models.length
  };
  setSetting(db, "lastUpdateCheck", snapshot);
  recordEvent(db, "updates", "Checked update channels", snapshot);
  return snapshot;
}

export function refreshCatalogSnapshot(db) {
  const value = { refreshed_at: now(), mode: "local-manifest-snapshot" };
  setSetting(db, "lastCatalogRefresh", value);
  recordEvent(db, "catalog-refresh", "Refreshed local catalog snapshot", value);
  return value;
}
