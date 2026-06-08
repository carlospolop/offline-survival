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
    expect(source).toContain("document.documentElement.lang = uiLanguage");
    expect(source).toContain('<option value="es">');

    const withoutTranslationMap = source.replace(/const uiText:[\s\S]*?\n  \};\n\n  \$:/, "TRANSLATION_MAP_REMOVED\n\n  $:");
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
    expect(select).toBeTruthy();
    expect(select.querySelector("option[value='es']").textContent).toBe("Español");
    expect(document.documentElement.lang).toBe("en");

    select.value = "es";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.documentElement.lang).toBe("es");
    expect(localStorage.getItem("offline-survival-ui-language")).toBe("es");
    expect(document.querySelector("[data-i18n='downloadLatest']").textContent).toBe("Descargar ultima version");
    expect(document.querySelector("[data-i18n='heroTitle']").textContent).toContain("internet");

    select.value = "en";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.documentElement.lang).toBe("en");
    expect(document.querySelector("[data-i18n='downloadLatest']").textContent).toBe("Download latest");
  });
});
