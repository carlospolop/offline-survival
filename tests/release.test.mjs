import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("desktop release workflow", () => {
  it("publishes latest releases for main pushes and keeps website download names aligned", async () => {
    const workflow = await fs.readFile(".github/workflows/release.yml", "utf8");
    const site = await fs.readFile("site/index.html", "utf8");

    expect(workflow).toContain("if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/')");
    expect(workflow).toContain('tag="main-${GITHUB_RUN_NUMBER}-${short_sha}"');
    expect(workflow).toContain("make_latest: true");
    expect(workflow).toContain("target_commitish: ${{ github.sha }}");
    expect(workflow).not.toContain("paths:");
    expect(site).toContain('id="download-os-select"');
    expect(site).toContain('id="download-os-select-bottom"');
    expect(site).toContain("function applyDownloadOption(option)");

    for (const label of ["windows-x64", "windows-arm64", "macos-x64", "macos-arm64", "linux-x64", "linux-arm64"]) {
      expect(site).toContain(`releases/latest/download/Offline-Survival-${label}.zip`);
      expect(site).toContain(`data-download-option="${label}"`);
      expect(workflow).toContain(`label: ${label}`);
    }
    expect(site).toContain("releases/latest/download/Offline-Survival-all-platforms.zip");
    expect(workflow).toContain("Offline-Survival-all-platforms.zip");
  });

  it("uses a per-launch packaged backend port instead of stale port 8787", async () => {
    const launcher = await fs.readFile("app/src-tauri/src/main.rs", "utf8");
    const api = await fs.readFile("app/ui/src/lib/api.ts", "utf8");
    const server = await fs.readFile("app/backend/server.mjs", "utf8");

    expect(launcher).toContain("reserve_backend_port()");
    expect(launcher).toContain(".env(\"PORT\", backend_port.to_string())");
    expect(launcher).toContain("window.__SCA_API_PORT");
    expect(launcher).toContain("kill_backend_child");
    expect(launcher).toContain("RunEvent::Exit");
    expect(launcher).toContain("WindowEvent::CloseRequested");
    expect(launcher).not.toContain("std::mem::forget(child)");
    expect(launcher).not.toContain(".env(\"PORT\", \"8787\")");
    expect(api).toContain("function isPackagedTauri()");
    expect(api).toContain("window.__SCA_API_PORT");
    expect(api).toContain("if (isPackagedTauri()) return [];");
    expect(server).toContain("url.pathname === \"/api/health\"");
  });

  it("does not pass catalog model ids to Ollama generation paths", async () => {
    const server = await fs.readFile("app/backend/server.mjs", "utf8");
    const ui = await fs.readFile("app/ui/src/App.svelte", "utf8");

    expect(server).toContain("return activeChatModel.pull ?? activeChatModel.id ?? body.model ?? \"qwen3:8b\"");
    expect(server).toContain("function ollamaChatModelName");
    expect(server).toContain("modelFromCatalog(catalog.models, body.model)?.pull");
    expect(server).not.toContain("return body.model ?? activeChatModel.pull");
    expect(ui).toContain("value={model.pull ?? model.id}");
    expect(ui).toContain("questionModel || startAiModel?.pull || startAiModel?.id");
    expect(ui).not.toContain("value={model.id}>{modelTitle(model)}");
    expect(ui).not.toContain("questionModel || startAiModel?.id || startAiModel?.pull");
  });
});
