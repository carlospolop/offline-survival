import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { loadCatalog } from "../app/backend/catalog.mjs";
import { ensureLibrary, openState, upsertSource } from "../app/backend/state.mjs";

const execFileAsync = promisify(execFile);

it("checks the entire catalog and fails for a missing source or corrupt file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sca-check-"));
  try {
    await ensureLibrary(root);
    const catalog = await loadCatalog();
    const db = openState(root);
    const payload = "fixture";
    const sha256 = crypto.createHash("sha256").update(payload).digest("hex");
    try {
      for (const source of catalog.sources) {
        const local = `raw/${source.id}.txt`;
        await fs.writeFile(path.join(root, local), payload);
        upsertSource(db, source, { local_path: local, size_bytes: payload.length, sha256, status: "downloaded" });
      }
    } finally { db.close(); }
    const args = ["--experimental-sqlite", "tools/library-check.mjs", `--root=${root}`, "--verify"];
    await execFileAsync(process.execPath, args);
    const reportFile = path.join(root, "logs/library-check.json");
    const complete = JSON.parse(await fs.readFile(reportFile, "utf8"));
    expect(complete.ok).toBe(true);
    expect(complete.sources).toHaveLength(catalog.sources.length);
    await fs.rm(path.join(root, `raw/${catalog.sources[0].id}.txt`));
    await fs.writeFile(path.join(root, `raw/${catalog.sources[1].id}.txt`), "changed");
    await expect(execFileAsync(process.execPath, args)).rejects.toMatchObject({ code: 1 });
    const broken = JSON.parse(await fs.readFile(reportFile, "utf8"));
    expect(broken.ok).toBe(false);
    expect(broken.sources.filter((source) => !source.ok).map((source) => source.id)).toEqual(catalog.sources.slice(0, 2).map((source) => source.id));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 20_000);
