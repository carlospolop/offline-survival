import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { candidateUrls } from "../app/backend/downloader.mjs";

const execFileAsync = promisify(execFile);

export async function probeSource(source, fetchImpl = fetch) {
  if (source.download?.action === "git_archive") {
    const { stdout } = await execFileAsync("git", ["ls-remote", source.url, "HEAD"], {
      timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    });
    const commit = stdout.trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw new Error("Git source has no readable HEAD");
    return { git: true, commit };
  }
  const errors = [];
  for (const url of candidateUrls(source)) {
    try { return { ...await rangeProbe(url, source.type, fetchImpl), url }; }
    catch (error) { errors.push(`${url}: ${error.message}`); }
  }
  throw new Error(`All probe mirrors failed: ${errors.join("; ")}`);
}

async function rangeProbe(url, type, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { Range: "bytes=0-31" }, redirect: "follow", signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Probe HTTP ${response.status} ${response.statusText}`);
  }
  // Servers can ignore Range. Never buffer a complete archive for a probe.
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (length < 32) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, 32 - length);
      chunks.push(chunk);
      length += chunk.length;
    }
  } finally {
    await reader.cancel();
  }
  const body = Buffer.concat(chunks);
  if (type === "pdf" && !body.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Expected a PDF, received a different file type");
  if (type === "zim" && (body.length < 4 || body.readUInt32LE(0) !== 0x044d495a)) throw new Error("Expected a ZIM, received a different file type");
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    contentLength: Number(response.headers.get("content-length") ?? 0),
    contentRange: response.headers.get("content-range"),
    signature: body.subarray(0, 8).toString("hex")
  };
}
