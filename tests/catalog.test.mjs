import { describe, expect, it } from "vitest";
import { artifactName, loadCatalog } from "../app/backend/catalog.mjs";

describe("catalog", () => {
  it("loads profiles with inherited source ids and sizes", async () => {
    const catalog = await loadCatalog();
    expect(catalog.profiles.map((profile) => profile.id)).toContain("survival-essential");
    const core = catalog.profiles.find((profile) => profile.id === "civilization-core");
    expect(core.sourceIds).toContain("survivalmanual-wiki");
    expect(core.sourceIds).toContain("wikibooks-zim");
    expect(core.expectedSizeBytes).toBeGreaterThan(0);
  });

  it("orders profiles from smallest to largest archive", async () => {
    const catalog = await loadCatalog();
    expect(catalog.profiles.map((profile) => profile.id)).toEqual([
      "survival-essential",
      "survival-plus",
      "civilization-core",
      "civilization-rebuild",
      "civilization-max"
    ]);
    expect(catalog.profiles[0].description).toMatch(/Small emergency archive/);
    expect(catalog.profiles.at(-1).description).toMatch(/Deep preservation profile/);
  });

  it("keeps every profile within its declared budget", async () => {
    const catalog = await loadCatalog();
    for (const profile of catalog.profiles) {
      expect(profile.expectedSizeBytes).toBeLessThanOrEqual(profile.disk_budget_gb * 1_000_000_000);
    }
  });

  it("uses source type extensions for extensionless URLs", () => {
    expect(artifactName({ id: "page", type: "html", url: "https://example.com/" })).toBe("page-page.html");
    expect(artifactName({ id: "manual", type: "pdf", url: "https://example.com/download" })).toBe("manual.pdf");
  });
});
