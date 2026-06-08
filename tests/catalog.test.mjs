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
      "survival-essential-es",
      "survival-essential-bilingual",
      "survival-plus",
      "survival-plus-es",
      "survival-plus-bilingual",
      "civilization-core",
      "civilization-core-es",
      "civilization-core-bilingual",
      "civilization-rebuild",
      "civilization-rebuild-es",
      "civilization-rebuild-bilingual",
      "civilization-max",
      "civilization-max-es",
      "civilization-max-bilingual"
    ]);
    expect(catalog.profiles[0].description).toMatch(/Small emergency archive/);
    expect(catalog.profiles.at(-1).description).toMatch(/deep preservation profile/i);
  });

  it("keeps every profile within its declared budget", async () => {
    const catalog = await loadCatalog();
    for (const profile of catalog.profiles) {
      expect(profile.expectedSizeBytes).toBeLessThanOrEqual(profile.disk_budget_gb * 1_000_000_000);
    }
  });

  it("includes English, Spanish, and bilingual profile families", async () => {
    const catalog = await loadCatalog();
    const byLanguage = (language) => catalog.profiles.filter((profile) => profile.language === language);
    expect(byLanguage("en")).toHaveLength(5);
    expect(byLanguage("es")).toHaveLength(5);
    expect(byLanguage("both")).toHaveLength(5);
    expect(catalog.sources.filter((source) => source.language === "en")).toHaveLength(34);
    expect(catalog.sources.filter((source) => source.language === "es")).toHaveLength(18);
    expect(catalog.sources.filter((source) => !source.language)).toHaveLength(0);
  });

  it("keeps profile source sets aligned with the selected content language", async () => {
    const catalog = await loadCatalog();
    const sources = new Map(catalog.sources.map((source) => [source.id, source]));
    const expectedSourceLanguages = {
      en: ["en"],
      es: ["es"],
      both: ["en", "es"]
    };

    for (const profile of catalog.profiles) {
      const allowed = expectedSourceLanguages[profile.language];
      expect(allowed, `${profile.id} has unsupported language ${profile.language}`).toBeTruthy();
      for (const sourceId of profile.sourceIds) {
        const source = sources.get(sourceId);
        expect(source, `${profile.id} references missing source ${sourceId}`).toBeTruthy();
        expect(allowed, `${profile.id} includes ${sourceId}:${source.language}`).toContain(source.language);
      }
    }
  });

  it("uses source type extensions for extensionless URLs", () => {
    expect(artifactName({ id: "page", type: "html", url: "https://example.com/" })).toBe("page-page.html");
    expect(artifactName({ id: "manual", type: "pdf", url: "https://example.com/download" })).toBe("manual.pdf");
  });
});
