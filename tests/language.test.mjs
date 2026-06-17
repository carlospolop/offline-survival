import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

function collectObjectKeys(source, marker) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.includes(`${marker}: {`));
  if (start < 0) throw new Error(`Could not find ${marker} object`);
  const keys = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s{4}},?\s*$/.test(line)) break;
    const match = line.match(/^\s+([A-Za-z0-9_]+):/);
    if (match) keys.push(match[1]);
  }
  return keys;
}

function duplicates(values) {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

describe("language selectors", () => {
  it("keeps app English and Spanish translation keys in sync", async () => {
    const source = await fs.readFile("app/ui/src/App.svelte", "utf8");
    const en = collectObjectKeys(source, "en");
    const es = collectObjectKeys(source, "es");
    expect(duplicates(en)).toEqual([]);
    expect(duplicates(es)).toEqual([]);
    expect(es.filter((key) => !en.includes(key))).toEqual([]);
    expect(en.filter((key) => !es.includes(key))).toEqual([]);
    expect(source).toContain("offline-survival-ui-language");
    expect(source).toContain("offline-survival-content-language");
    expect(source).toContain("document.documentElement.lang = uiLanguage");
    expect(source).toContain("contentLanguage = nextLanguage");
    expect(source).toContain("$: contentProfiles = profilesForContentLanguage(contentLanguage, catalogProfiles);");
    expect(source).toContain("$: selectedEasyProfiles = contentProfiles.filter");
    expect(source).toContain("profileIds: selectedEasyProfiles.map");
    expect(source).toContain('<option value="es">');
    expect(source).toContain('<option value="both">{t("bilingual")}</option>');
    expect(source).toContain('spanish: "Español"');
    expect(source).toContain('if (language === "both") return profileLang === "both";');

    const withoutTranslationMap = source.replace(/const uiText:[\s\S]*?\n  \};\s+const catalogText/, "TRANSLATION_MAP_REMOVED\n\n  const catalogText");
    const forbiddenDynamicEnglish = [
      "Verification passed",
      "The app will remove the current searchable index",
      "The app will index every downloaded source",
      "The app will prepare this source",
      "This deletes downloaded sources",
      "Use this for semantic search",
      "Downloading profile sources with up to 4 parallel downloads",
      "Download every source needed",
      "Open ${source.title}"
    ];
    for (const phrase of forbiddenDynamicEnglish) expect(withoutTranslationMap).not.toContain(phrase);
    expect(source).toContain("function profileTitle(profile");
    expect(source).toContain("function sourceTitle(source");
    expect(source).toContain('\"survival-essential-es\":');
    expect(source).toContain('title: \"Supervivencia esencial ES\"');
    expect(source).toContain('\"wikipedia-es-top-zim\":');
    expect(source).toContain('title: \"Wikipedia en español Top sin imágenes ZIM\"');
    expect(source).not.toMatch(/\{(?:profile|source|model|result|citation)\.(?:title|description|category)\}/);
    expect(source).not.toMatch(/\{(?:profile|source)\.status\}/);
    expect(source).not.toContain("{#each catalog.profiles");

    const markup = source.slice(source.indexOf("</script>") + 9);
    const rawText = [...markup.matchAll(/>\s*([^<{#:@][^<{}]*[A-Za-z][^<{}]*)\s*</g)]
      .map((match) => match[1].replace(/\s+/g, " ").trim())
      .filter(Boolean);
    expect([...new Set(rawText)].sort()).toEqual(["Kiwix", "Offline Survival"]);
  });

  it("switches the website language and covers every tagged Spanish string", async () => {
    const html = await fs.readFile("site/index.html", "utf8");
    const keys = [
      ...html.matchAll(/data-i18n="([^"]+)"/g),
      ...html.matchAll(/data-i18n-html="([^"]+)"/g)
    ].map((match) => match[1]);
    const esKeys = collectObjectKeys(html, "es");
    expect(duplicates(esKeys)).toEqual([]);
    expect([...new Set(keys)].filter((key) => !esKeys.includes(key))).toEqual([]);

    const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://offline-survival.test/" });
    const { document, localStorage, Event } = dom.window;
    const select = document.getElementById("language-select");
    const downloadSelect = document.getElementById("download-os-select");
    const bottomDownloadSelect = document.getElementById("download-os-select-bottom");
    const primaryDownload = document.querySelector("[data-download-link]");
    expect(select).toBeTruthy();
    expect(downloadSelect).toBeTruthy();
    expect(bottomDownloadSelect).toBeTruthy();
    expect(select.querySelector("option[value='es']").textContent).toBe("Español");
    expect(document.documentElement.lang).toBe("en");
    expect(primaryDownload.getAttribute("href")).toMatch(/releases\/latest\/download\/Offline-Survival-(windows|macos|linux)-/);

    downloadSelect.value = "macos-arm64";
    downloadSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(primaryDownload.getAttribute("href")).toBe("https://github.com/carlospolop/offline-survival/releases/latest/download/Offline-Survival-macos-arm64.zip");
    expect(bottomDownloadSelect.value).toBe("macos-arm64");
    expect(localStorage.getItem("offline-survival-download-os")).toBe("macos-arm64");

    bottomDownloadSelect.value = "linux-x64";
    bottomDownloadSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(primaryDownload.getAttribute("href")).toBe("https://github.com/carlospolop/offline-survival/releases/latest/download/Offline-Survival-linux-x64.zip");
    expect(downloadSelect.value).toBe("linux-x64");

    select.value = "es";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.documentElement.lang).toBe("es");
    expect(localStorage.getItem("offline-survival-ui-language")).toBe("es");
    expect(document.querySelector("[data-i18n='downloadLatest']").textContent).toBe("Descargar última versión");
    expect(document.querySelector("[data-i18n='downloadFor']").textContent).toBe("Descargar para");
    expect(primaryDownload.getAttribute("href")).toBe("https://github.com/carlospolop/offline-survival/releases/latest/download/Offline-Survival-linux-x64.zip");
    expect(document.querySelector("[data-i18n='profileEssentialName']").textContent).toBe("Supervivencia esencial");
    expect(document.querySelector("[data-i18n='heroTitle']").textContent).toContain("internet");

    select.value = "en";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.documentElement.lang).toBe("en");
    expect(document.querySelector("[data-i18n='downloadLatest']").textContent).toBe("Download latest");
  });
});
