import { classifyLicense } from "./license.mjs";
import { now, recordEvent } from "./state.mjs";

const allowedReviewStates = new Set([
  "candidate",
  "needs_license_review",
  "needs_safety_review",
  "approved_personal",
  "approved_redistributable",
  "approved_metadata_only",
  "excluded"
]);

export function sourceReviewSummary(db) {
  return {
    byReview: db.prepare("SELECT review_status AS status, count(*) AS count FROM sources GROUP BY review_status ORDER BY review_status").all(),
    byLicense: db.prepare("SELECT license, count(*) AS count FROM sources GROUP BY license ORDER BY license").all(),
    restricted: db.prepare("SELECT id, title, license, review_status FROM sources WHERE license LIKE '%NC%' OR review_status LIKE 'needs_%' OR review_status='excluded' ORDER BY title").all()
  };
}

export function reviewSource(db, { sourceId, reviewStatus }) {
  if (!allowedReviewStates.has(reviewStatus)) throw new Error(`Invalid review status ${reviewStatus}`);
  const source = db.prepare("SELECT * FROM sources WHERE id=?").get(sourceId);
  if (!source) throw new Error(`Unknown source ${sourceId}`);
  const rules = classifyLicense(source.license);
  db.prepare("UPDATE sources SET review_status=?, license_status=?, updated_at=? WHERE id=?")
    .run(reviewStatus, rules.redistribution === "unclear" ? "needs_review" : "classified", now(), sourceId);
  recordEvent(db, "review", `Marked ${source.title} as ${reviewStatus}`, { sourceId, reviewStatus });
  return { sourceId, reviewStatus, rules };
}
