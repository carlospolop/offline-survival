import { performance } from "node:perf_hooks";
import { defaultLibraryRoot, openState } from "../app/backend/state.mjs";
import { search } from "../app/backend/indexer.mjs";

const query = process.argv.slice(2).join(" ") || "water";
const db = openState(process.env.SCA_LIBRARY_ROOT || defaultLibraryRoot());
const start = performance.now();
const results = search(db, query, 20);
const elapsedMs = performance.now() - start;
db.close();
console.log(JSON.stringify({ query, elapsedMs: Number(elapsedMs.toFixed(3)), resultCount: results.length }, null, 2));
