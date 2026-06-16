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
});
