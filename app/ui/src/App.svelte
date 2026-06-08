<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { api, gb, statusTone, type Profile, type Source } from "./lib/api";

  type State = {
    settings: Record<string, unknown>;
    sources: Array<Record<string, any>>;
    downloads: Array<Record<string, any>>;
    services: Array<Record<string, any>>;
    adapters: Array<Record<string, any>>;
    models: Array<Record<string, any>>;
    blobs: Array<Record<string, any>>;
    documents: Array<Record<string, any>>;
    events: Array<Record<string, any>>;
  };

  let catalog: { sources: Source[]; profiles: Profile[]; models: any[] } = { sources: [], profiles: [], models: [] };
  let state: State = { settings: {}, sources: [], downloads: [], services: [], adapters: [], models: [], blobs: [], documents: [], events: [] };
  let system: any = null;
  let shareProfile = "";
  let sharePrimaryOs = "linux";
  let shareAppsPath = "";
  let activeTab = "dashboard";
  let filter = "";
  let query = "";
  let searchSource = "";
  let searchLicense = "";
  let question = "";
  let questionSource = "";
  let answer: any = null;
  let integrity: any = null;
  let licenseReport: any = null;
  let recovery: any = null;
  let review: any = null;
  let updates: any = null;
  let sharePackage: any = null;
  let logs: any[] = [];
  let logsPoller = 0;
  let logsRefreshing = false;
  let searchResults: any[] = [];
  let busy = "";
  let error = "";
  let catalogError = "";
  let loadingCatalog = true;
  let libraryPath = "";
  let easyInstallAi = true;
  let easyProfileSelections: Record<string, boolean> = {};
  let verifyFeedback: Record<string, { ok: boolean; message: string }> = {};
  const verifyFeedbackTimers = new Map<string, number>();
  let maintenanceFeedback: { ok: boolean; message: string } | null = null;
  let maintenanceFeedbackTimer = 0;
  let confirmDialog: any = null;
  let confirmResolve: ((accepted: boolean) => void) | null = null;
  let extraFolderPath = "";
  let extraScan: any = null;
  let extraSelections: Record<string, boolean> = {};
  let extraIndexOnImport = true;
  let extraImportResult: any = null;

  $: catalogSources = Array.isArray(catalog.sources) ? catalog.sources : [];
  $: catalogProfiles = Array.isArray(catalog.profiles) ? catalog.profiles : [];
  $: catalogModels = Array.isArray(catalog.models) ? catalog.models.filter(Boolean) : [];
  $: stateSettings = state.settings ?? {};
  $: stateSources = Array.isArray(state.sources) ? state.sources.filter(Boolean) : [];
  $: stateDownloads = Array.isArray(state.downloads) ? state.downloads.filter(Boolean) : [];
  $: stateServices = Array.isArray(state.services) ? state.services.filter(Boolean) : [];
  $: stateModels = Array.isArray(state.models) ? state.models.filter(Boolean) : [];
  $: sourceState = new Map(stateSources.map((source) => [source.id, source]));
  $: downloadState = new Map(stateDownloads.map((download) => [download.source_id, download]));
  $: sourceCatalog = new Map(catalogSources.map((source) => [source.id, source]));
  $: downloadedBytes = stateSources.reduce((sum, source) => sum + Number(source.size_bytes ?? 0), 0);
  $: licenseOptions = [...new Set([...catalogSources, ...stateSources].map((source) => source.license).filter(Boolean))].sort();
  $: indexedSources = stateSources.filter((source) => source.status === "indexed");
  $: fullyIndexedSourceIds = new Set(indexedSources.map((source) => source.id));
  $: searchableSources = stateSources.filter((source) => fullyIndexedSourceIds.has(source.id));
  $: if (searchSource && !searchableSources.some((source) => source.id === searchSource)) searchSource = "";
  $: activeDownloadSources = stateDownloads
    .filter((download) => ["queued", "downloading", "resuming"].includes(String(download.status ?? "")))
    .map((download) => sourceCatalog.get(download.source_id))
    .filter((source): source is Source => Boolean(source));
  $: notSearchableDownloads = stateSources.filter((source) => {
    const downloaded = ["downloaded", "verified", "downloaded_unverified", "indexed-original-only"].includes(String(source.status ?? "")) && source.local_path;
    return downloaded && !fullyIndexedSourceIds.has(source.id);
  });
  $: indexableDownloadedSources = notSearchableDownloads.filter((source) => !["queued", "downloading", "resuming"].includes(String(downloadState.get(source.id)?.status ?? "")));
  $: extraFiles = Array.isArray(extraScan?.files) ? extraScan.files : [];
  $: selectedExtraFiles = extraFiles.filter((file) => extraSelections[file.path]);
  $: extraImportedSources = stateSources.filter((source) => String(source.id ?? "").startsWith("extra-"));
  $: profileDownloadBusy = busy.startsWith("profile-");
  $: aiServices = stateServices.filter((service) => service.name === "ollama");
  $: aiServiceCards = aiServices.length ? aiServices : [{
    name: "ollama",
    status: aiInstallProgress?.status === "running" ? "installing" : "missing",
    port: 11434,
    url: "http://127.0.0.1:11434",
    message: aiInstallProgress?.detail
  }];
  $: kiwixService = stateServices.find((service) => service.name === "kiwix") ?? {
    name: "kiwix",
    status: "missing",
    port: 8089,
    url: "http://127.0.0.1:8089"
  };
  $: availableModels = stateModels.length ? stateModels : catalogModels.map((model) => ({ ...model, status: "missing" }));
  $: recommendedChatModel = recommendedModel(system, availableModels, "chat");
  $: recommendedEmbeddingModel = recommendedModel(system, availableModels, "embedding");
  $: recommendedAiModels = recommendedModels(system, availableModels, recommendedChatModel, recommendedEmbeddingModel);
  $: installedChatModels = availableModels.filter((model) => model.role === "chat" && model.status === "installed");
  $: startAiModel = [...installedChatModels].sort((a, b) => Number(a.expected_size_bytes ?? 0) - Number(b.expected_size_bytes ?? 0))[0] ?? null;
  $: startAiRequiredBytes = estimateAiRamBytes(startAiModel);
  $: startAiSwapPressure = Boolean(system?.swapTotalBytes > 0 && system?.swapFreeBytes < Math.max(1024 ** 3, system.swapTotalBytes * 0.4));
  $: startAiAllowed = Boolean(startAiModel && system?.availableMemBytes >= startAiRequiredBytes && !startAiSwapPressure);
  $: recommendedSetupProfile = recommendedProfile(system, catalogProfiles);
  $: aiInstallProgress = progressObject(stateSettings.aiInstallProgress);
  $: easyInstallProgress = progressObject(stateSettings.easyInstallProgress);
  $: sharePackageProgress = progressObject(stateSettings.sharePackageProgress);
  $: showEasyAiProgress = Boolean(aiInstallProgress) && (easyInstallProgress?.phase === "ai" || aiInstallProgress?.status === "running");
  $: showAiInstallProgress = Boolean(aiInstallProgress) && (["running", "failed"].includes(String(aiInstallProgress?.status ?? "")) || busy === "ai-install");
  $: aiInstallComplete = aiInstallProgress?.status === "complete";
  $: selectedEasyProfiles = catalogProfiles.filter((profile) => easyProfileSelections[profile.id]);
  $: selectedEasySourceIds = [...new Set(selectedEasyProfiles.flatMap((profile) => profile.sourceIds ?? []))];
  $: selectedEasyDownloadBytes = selectedEasySourceIds.reduce((sum, id) => sum + Number(sourceCatalog.get(id)?.expected_size_bytes ?? 0), 0);
  $: selectedEasyPreparedBytes = selectedEasySourceIds.reduce((sum, id) => {
    const source = sourceCatalog.get(id);
    return sum + Number(source?.prepared_size_bytes ?? source?.expected_size_bytes ?? 0);
  }, 0);
  $: downloadedSourcesForShare = stateSources.filter((source) => sourceIsDownloaded(source));
  $: downloadedShareBytes = downloadedSourcesForShare.reduce((sum, source) => sum + Number(source.size_bytes ?? sourceCatalog.get(source.id)?.prepared_size_bytes ?? sourceCatalog.get(source.id)?.expected_size_bytes ?? 0), 0);
  $: shareableProfiles = catalogProfiles.filter((profile) => profileIsFullyDownloaded(profile));
  $: shareOptions = [
    ...(downloadedSourcesForShare.length ? [{
      id: "all-downloaded",
      title: "All Downloaded Sources",
      sizeBytes: downloadedShareBytes,
      sourceCount: downloadedSourcesForShare.length
    }] : []),
    ...shareableProfiles.map((profile) => ({
      id: profile.id,
      title: profile.title,
      sizeBytes: Number(profile.preparedSizeBytes ?? profile.expectedSizeBytes ?? 0),
      sourceCount: profile.sourceIds?.length ?? 0
    }))
  ];
  $: keepShareProfileValid(shareOptions, shareProfile);
  $: if (activeTab === "settings") startLogsPolling();
  $: if (activeTab !== "settings") stopLogsPolling();

  onMount(load);
  onDestroy(() => {
    stopLogsPolling();
    for (const timer of verifyFeedbackTimers.values()) window.clearTimeout(timer);
    if (maintenanceFeedbackTimer) window.clearTimeout(maintenanceFeedbackTimer);
  });

  function keepShareProfileValid(options: Array<{ id: string }>, current: string) {
    if (!options.length) return;
    if (current && options.some((option) => option.id === current)) return;
    shareProfile = options[0].id;
  }

  async function load() {
    error = "";
    catalogError = "";
    loadingCatalog = true;
    const requestedTab = new URLSearchParams(window.location.search).get("tab");
    if (requestedTab && ["dashboard", "downloads", "search", "extra", "ai", "share", "settings", "easy"].includes(requestedTab)) activeTab = requestedTab;
    try {
      [catalog, state, system] = await Promise.all([api("/api/catalog"), api("/api/state"), api("/api/system")]);
      libraryPath = String(state.settings.libraryRoot ?? "");
      initializeEasyProfiles();
      await refreshServices();
      await refreshModels();
    } catch (err) {
      catalogError = String((err as Error).message ?? err);
      error = `Could not load the local app backend: ${catalogError}`;
    } finally {
      loadingCatalog = false;
    }
  }

  async function refreshState() {
    state = await api("/api/state");
  }

  async function run(label: string, fn: () => Promise<unknown>) {
    busy = label;
    error = "";
    const shouldPoll = label.startsWith("profile-") || label.startsWith("download-") || label.startsWith("retry-") || label.startsWith("model-") || label === "ai-install" || label === "index-all-downloaded" || label === "easy-install" || label === "clean-sources" || label === "share-package";
    const poller = shouldPoll ? window.setInterval(() => {
      refreshState().catch(() => {});
    }, 1000) : 0;
    try {
      await fn();
      await load();
    } catch (err) {
      error = String((err as Error).message ?? err);
    } finally {
      if (poller) window.clearInterval(poller);
      busy = "";
    }
  }

  async function setLibrary() {
    await run("library", () => api("/api/library", { method: "POST", body: JSON.stringify({ path: libraryPath }) }));
  }

  function openEasyInstall() {
    error = "";
    selectRecommendedEasyInstall();
    activeTab = "easy";
    refreshState().catch(() => {});
  }

  async function download(sourceId: string) {
    await run(`download-${sourceId}`, () => api("/api/download", {
      method: "POST",
      body: JSON.stringify({ sourceId })
    }));
  }

  async function pause(sourceId: string) {
    await run(`pause-${sourceId}`, () => api("/api/download/pause", { method: "POST", body: JSON.stringify({ sourceId }) }));
  }

  async function retry(sourceId: string) {
    await run(`retry-${sourceId}`, () => api("/api/download/retry", {
      method: "POST",
      body: JSON.stringify({ sourceId })
    }));
  }

  async function downloadProfile(profile: Profile) {
    markProfileQueued(profile);
    await run(`profile-${profile.id}`, () => api("/api/profile/download", {
      method: "POST",
      body: JSON.stringify({ profileId: profile.id, concurrency: 4 })
    }));
  }

  function markProfileQueued(profile: Profile) {
    const timestamp = new Date().toISOString();
    const downloadableIds = new Set(profile.sourceIds.filter((id) => {
      const existing = sourceState.get(id);
      return !["downloaded", "verified", "indexed"].includes(String(existing?.status ?? ""));
    }));
    if (!downloadableIds.size) return;

    const existingDownloads = new Map(state.downloads.map((download) => [download.source_id, download]));
    const nextDownloads = [...state.downloads];
    for (const id of downloadableIds) {
      const source = sourceCatalog.get(id);
      const existing = existingDownloads.get(id);
      const queued = {
        id,
        source_id: id,
        status: existing?.status === "downloading" ? existing.status : "queued",
        bytes_received: Number(existing?.bytes_received ?? 0),
        total_bytes: Number(existing?.total_bytes ?? source?.expected_size_bytes ?? 0),
        error: null,
        updated_at: timestamp
      };
      if (existing) Object.assign(existing, queued);
      else nextDownloads.unshift(queued);
    }

    state = {
      ...state,
      downloads: nextDownloads,
      sources: state.sources.map((source) => downloadableIds.has(source.id) ? { ...source, status: "queued", updated_at: timestamp } : source)
    };
  }

  async function verify(sourceId: string) {
    let result: any = null;
    await run(`verify-${sourceId}`, async () => {
      result = await api("/api/verify", { method: "POST", body: JSON.stringify({ sourceId }) });
    });
    if (result) showVerifyFeedback(sourceId, result.ok, result.ok ? "Verification passed" : "Verification failed");
  }

  function showVerifyFeedback(sourceId: string, ok: boolean, message: string) {
    const existingTimer = verifyFeedbackTimers.get(sourceId);
    if (existingTimer) window.clearTimeout(existingTimer);
    verifyFeedback = { ...verifyFeedback, [sourceId]: { ok, message } };
    const timer = window.setTimeout(() => {
      const next = { ...verifyFeedback };
      delete next[sourceId];
      verifyFeedback = next;
      verifyFeedbackTimers.delete(sourceId);
    }, 5000);
    verifyFeedbackTimers.set(sourceId, timer);
  }

  async function indexSource(sourceId: string) {
    const source = sourceCatalog.get(sourceId);
    const local = sourceState.get(sourceId);
    const isReindex = fullyIndexedSourceIds.has(sourceId);
    const accepted = await requestConfirm({
      tone: "normal",
      title: `${isReindex ? "Re-index" : "Index"} ${source?.title ?? sourceId}`,
      body: isReindex
        ? "The app will remove the current searchable index for this source, rebuild it from the downloaded file, and keep it available for Search and Local AI context. It will not download anything new."
        : "The app will read this downloaded source and add searchable text to the local index. It will not open the file and it will not download anything new.",
      steps: [
        ...(isReindex ? ["Remove the existing searchable rows and generated index files for this source."] : []),
        "Read the downloaded file from the local library.",
        "Extract searchable text using the configured source reader.",
        "Store the text in the local search database for Search and Local AI context."
      ],
      details: [
        ["Source", source?.title ?? sourceId],
        ["Downloaded file size", gb(Number(local?.size_bytes ?? source?.expected_size_bytes ?? 0))],
        ["Index location", "Local app database"],
        ["Embedding model required", "No. Embeddings are for semantic matching and Local AI retrieval quality after text is indexed."]
      ],
      confirmLabel: isReindex ? "Re-index Source" : "Index Source",
      cancelLabel: "Cancel"
    });
    if (!accepted) return;
    await run(`index-${sourceId}`, () => api("/api/index", { method: "POST", body: JSON.stringify({ sourceId }) }));
  }

  async function indexAllDownloaded() {
    const sources = indexableDownloadedSources;
    const accepted = await requestConfirm({
      tone: "normal",
      title: `Index ${sources.length} Downloaded`,
      body: "The app will index every downloaded source that is not searchable yet. This makes them appear in Search and gives Local AI local context.",
      steps: [
        "Find downloaded sources that are not indexed yet.",
        "Extract searchable text from each source.",
        "Store the results in the local search database."
      ],
      details: [
        ["Sources to index", String(sources.length)],
        ["Downloaded data to scan", gb(sources.reduce((sum, source) => sum + Number(source.size_bytes ?? sourceCatalog.get(source.id)?.expected_size_bytes ?? 0), 0))],
        ["Index location", "Local app database"],
        ["Embedding model required", "No. Embeddings are for semantic matching and Local AI retrieval quality after text is indexed."]
      ],
      confirmLabel: "Index Downloaded Sources",
      cancelLabel: "Cancel"
    });
    if (!accepted) return;
    await run("index-all-downloaded", () => api("/api/index/downloaded", { method: "POST" }));
  }

  async function openOriginal(sourceId: string) {
    const plan: any = await api("/api/source/open-plan", { method: "POST", body: JSON.stringify({ sourceId }) });
    const accepted = await requestConfirm({
      tone: "normal",
      title: `Open ${plan.title}`,
      body: "The app will prepare this source and then open the useful reader or file, not the raw downloaded archive.",
      steps: plan.steps,
      details: [
        ["Final target", plan.finalTarget],
        ["Extra disk needed now", gb(plan.additionalBytes)],
        ["Prepared on-disk size after open", gb(plan.extractedBytes)]
      ],
      confirmLabel: "Open Source",
      cancelLabel: "Cancel"
    });
    if (!accepted) return;
    await run(`open-${sourceId}`, () => api("/api/source/open", { method: "POST", body: JSON.stringify({ sourceId }) }));
  }

  async function refreshServices() {
    const data = await api<{ services: any[] }>("/api/services");
    state = { ...state, services: data.services };
  }

  async function refreshModels() {
    const data = await api<{ models: any[] }>("/api/models/refresh");
    state = { ...state, models: data.models };
  }

  async function pullModel(modelId: string) {
    await run(`model-${modelId}`, () => api("/api/model/pull", { method: "POST", body: JSON.stringify({ modelId }) }));
  }

  async function installRecommendedAi() {
    const modelIds = recommendedAiModels.map((model) => model.id);
    await run("ai-install", () => api("/api/ai/install-recommended", {
      method: "POST",
      body: JSON.stringify({ modelIds })
    }));
  }

  async function easyInstall() {
    await run("easy-install", () => api("/api/easy-install", {
      method: "POST",
      body: JSON.stringify({
        profileIds: selectedEasyProfiles.map((profile) => profile.id),
        installAi: easyInstallAi,
        concurrency: 4
      })
    }));
  }

  async function cleanSources() {
    const accepted = await requestConfirm({
      tone: "danger",
      title: "Clean Sources",
      body: "This deletes downloaded sources, extracted/opened files, indexes, models, managed AI runtimes, partial downloads, and logs.",
      details: [
        ["Catalog", "Kept"],
        ["Settings", "Kept"],
        ["Library payloads", "Deleted"]
      ],
      confirmLabel: "Clean Everything",
      cancelLabel: "Cancel"
    });
    if (!accepted) return;
    await run("clean-sources", () => api("/api/clean-sources", { method: "POST" }));
  }

  function requestConfirm(dialog: any) {
    confirmDialog = dialog;
    return new Promise<boolean>((resolve) => {
      confirmResolve = resolve;
    });
  }

  function answerConfirm(accepted: boolean) {
    confirmResolve?.(accepted);
    confirmResolve = null;
    confirmDialog = null;
  }

  async function startKiwix() {
    await run("kiwix", () => api("/api/kiwix/start", { method: "POST", body: JSON.stringify({ port: 8089 }) }));
  }

  async function startOllama() {
    await run("ollama-start", () => api("/api/ollama/start", {
      method: "POST",
      body: JSON.stringify({ model: startAiModel?.id ?? startAiModel?.pull })
    }));
  }

  async function stop(name: string) {
    await run(`stop-${name}`, () => api("/api/service/stop", { method: "POST", body: JSON.stringify({ name }) }));
  }

  async function searchNow() {
    const params = new URLSearchParams({ q: query, limit: "20" });
    if (searchSource) params.set("sourceId", searchSource);
    if (searchLicense) params.set("license", searchLicense);
    const data = await api<{ results: any[] }>(`/api/search?${params.toString()}`);
    searchResults = data.results;
  }

  async function semanticSearchNow() {
    const data = await api<{ results: any[] }>(`/api/search/semantic?q=${encodeURIComponent(query)}&limit=20`);
    searchResults = data.results;
  }

  async function ask() {
    await run("ask", async () => {
      answer = await api("/api/ask", { method: "POST", body: JSON.stringify({ question, sourceId: questionSource || undefined }) });
    });
  }

  async function openSearchHit(result: any) {
    await run(`open-search-${result.source_id}`, () => api("/api/search/open", {
      method: "POST",
      body: JSON.stringify({ sourceId: result.source_id, path: result.path })
    }));
  }

  async function writeLock() {
    const profile = catalog.profiles[0];
    if (!profile) return;
    await run("lock", () => api("/api/lock", { method: "POST", body: JSON.stringify({ profileId: profile.id }) }));
  }

  async function checkIntegrity() {
    await run("integrity", async () => {
      integrity = await api("/api/integrity");
    });
  }

  async function exportArchive() {
    await run("export", () => api("/api/export"));
  }

  async function licenseSummary() {
    await run("license", async () => {
      licenseReport = await api("/api/license/report");
    });
  }

  async function reconcile() {
    let result: any = null;
    await run("reconcile", async () => {
      result = await api("/api/reconcile");
      recovery = result;
    });
    if (result) {
      const repaired = Number(result.repaired?.length ?? 0);
      const missing = Number(result.missing?.length ?? 0);
      const partials = Number(result.partials?.length ?? 0);
      showMaintenanceFeedback(missing === 0, `Check complete: ${repaired} repaired, ${missing} missing, ${partials} partials`);
    } else if (error) {
      showMaintenanceFeedback(false, "Check failed");
    }
  }

  async function cleanupPartials() {
    await run("partials", () => api("/api/partials/cleanup", { method: "POST" }));
  }

  function showMaintenanceFeedback(ok: boolean, message: string) {
    if (maintenanceFeedbackTimer) window.clearTimeout(maintenanceFeedbackTimer);
    maintenanceFeedback = { ok, message };
    maintenanceFeedbackTimer = window.setTimeout(() => {
      maintenanceFeedback = null;
      maintenanceFeedbackTimer = 0;
    }, 5000);
  }

  async function reviewSummary() {
    await run("review", async () => {
      review = await api("/api/review/summary");
    });
  }

  async function updatesStatus() {
    await run("updates", async () => {
      updates = await api("/api/updates/status");
    });
  }

  async function refreshCatalog() {
    await run("catalog-refresh", () => api("/api/catalog/refresh", { method: "POST" }));
  }

  async function generateSharePackage() {
    if (!shareProfile) return;
    sharePackage = null;
    await run("share-package", async () => {
      sharePackage = await api("/api/share/package", {
        method: "POST",
        body: JSON.stringify({ profileId: shareProfile, primaryOs: sharePrimaryOs, appBundlePath: shareAppsPath })
      });
    });
  }

  async function pickShareAppsFolder() {
    await run("share-apps-folder", async () => {
      const result = await api<{ path?: string; canceled?: boolean }>("/api/folder/pick", { method: "POST" });
      if (result.path) shareAppsPath = result.path;
    });
  }

  async function pickExtraFolder() {
    await run("extra-folder", async () => {
      const result = await api<{ path?: string; canceled?: boolean }>("/api/folder/pick", { method: "POST" });
      if (result.path) {
        extraFolderPath = result.path;
        await scanExtraFolder();
      }
    });
  }

  async function scanExtraFolder() {
    extraImportResult = null;
    await run("extra-scan", async () => {
      extraScan = await api("/api/extra-knowledge/scan", { method: "POST", body: JSON.stringify({ folderPath: extraFolderPath }) });
      extraSelections = Object.fromEntries((extraScan.files ?? []).slice(0, 200).map((file: any) => [file.path, true]));
    });
  }

  function setAllExtraSelections(checked: boolean) {
    extraSelections = Object.fromEntries(extraFiles.map((file: any) => [file.path, checked]));
  }

  async function importSelectedExtraFiles() {
    if (!selectedExtraFiles.length) return;
    await run("extra-import", async () => {
      extraImportResult = await api("/api/extra-knowledge/import", {
        method: "POST",
        body: JSON.stringify({ files: selectedExtraFiles.map((file: any) => file.path), index: extraIndexOnImport })
      });
      await load();
    });
  }

  async function indexImportedExtraFiles() {
    await run("extra-index", async () => {
      for (const source of extraImportedSources.filter((item) => !fullyIndexedSourceIds.has(item.id) && item.local_path)) {
        await api("/api/index", { method: "POST", body: JSON.stringify({ sourceId: source.id }) });
      }
      await load();
    });
  }

  async function keepLocalhostOnly() {
    await run("network", () => api("/api/settings/network", { method: "POST", body: JSON.stringify({ enabled: false }) }));
  }

  async function loadLogs() {
    await run("logs", async () => {
      const data = await api<{ logs: any[] }>("/api/logs?limit=100");
      logs = data.logs;
    });
  }

  function startLogsPolling() {
    if (logsPoller) return;
    refreshLogsQuiet();
    logsPoller = window.setInterval(refreshLogsQuiet, 60_000);
  }

  function stopLogsPolling() {
    if (!logsPoller) return;
    window.clearInterval(logsPoller);
    logsPoller = 0;
  }

  async function refreshLogsQuiet() {
    if (logsRefreshing) return;
    logsRefreshing = true;
    try {
      const data = await api<{ logs: any[] }>("/api/logs?limit=100");
      logs = data.logs;
    } catch {
      // Keep Settings usable even if the backend is restarting.
    } finally {
      logsRefreshing = false;
    }
  }

  function addedSources(profile: Profile) {
    const ids = profile.addedSourceIds?.length ? profile.addedSourceIds : profile.sourceIds;
    const haystackFilter = filter.trim().toLowerCase();
    const sources: Source[] = [];
    for (const id of ids) {
      const source = sourceCatalog.get(id);
      if (!source) continue;
      if (haystackFilter) {
        const haystack = `${source.title} ${source.description} ${source.category} ${source.license} ${(source.tags ?? []).join(" ")}`.toLowerCase();
        if (!haystack.includes(haystackFilter)) continue;
      }
      sources.push(source);
    }
    return sources;
  }

  function sourceProgressInfo(source: Source) {
    const local = sourceState.get(source.id);
    const downloadRow = downloadState.get(source.id);
    const complete = sourceIsDownloaded(local ?? {}) || (downloadRow?.status === "complete" && Boolean(local?.local_path));
    const total = complete
      ? Number(local?.size_bytes || downloadRow?.bytes_received || downloadRow?.total_bytes || source.expected_size_bytes || 0)
      : Number(downloadRow?.total_bytes || source.expected_size_bytes || 0);
    const received = complete ? total : Number(downloadRow?.bytes_received || 0);
    const progress = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : complete ? 100 : 0;
    const totalKnown = complete || received === 0 || total > received;
    const status = complete ? (local?.status === "downloaded_unverified" ? "downloaded" : local?.status ?? "downloaded") : (downloadRow?.status ?? local?.status ?? "missing");
    return { local, downloadRow, complete, total, received, progress, totalKnown, status };
  }

  function profileProgressInfo(profile: Profile) {
    const items = profile.sourceIds.map((id) => sourceCatalog.get(id)).filter((source): source is Source => Boolean(source)).map(sourceProgressInfo);
    const received = items.reduce((sum, item) => sum + item.received, 0);
    const total = items.reduce((sum, item) => sum + item.total, 0);
    const progress = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
    const done = items.filter((item) => item.complete || item.downloadRow?.status === "complete").length;
    const active = items.filter((item) => ["queued", "downloading", "resuming"].includes(String(item.downloadRow?.status ?? ""))).length;
    const failed = items.filter((item) => ["failed", "paused"].includes(String(item.downloadRow?.status ?? ""))).length;
    return { received, total, progress, done, active, failed, count: items.length };
  }

  function sourceIsDownloaded(source: Source | Record<string, any>) {
    return Boolean(source.local_path) && ["downloaded", "verified", "indexed", "indexed-original-only", "downloaded_unverified"].includes(String(source.status ?? ""));
  }

  function profileHasDownloadableSources(profile: Profile) {
    return profile.sourceIds.some((id) => {
      const source = sourceState.get(id);
      return !sourceIsDownloaded(source ?? {});
    });
  }

  function profileIsFullyDownloaded(profile: Profile) {
    return Boolean(profile.sourceIds?.length) && profile.sourceIds.every((id) => {
      const source = sourceState.get(id);
      const download = downloadState.get(id);
      const active = ["queued", "downloading", "resuming"].includes(String(download?.status ?? ""));
      return !active && sourceIsDownloaded(source ?? {});
    });
  }

  function initializeEasyProfiles() {
    if (Object.keys(easyProfileSelections).length || !catalog.profiles.length) return;
    selectRecommendedEasyInstall();
  }

  function selectRecommendedEasyInstall() {
    if (!catalogProfiles.length) return;
    const recommended = recommendedProfile(system, catalogProfiles);
    const recommendedIndex = recommended ? catalogProfiles.findIndex((profile) => profile.id === recommended.id) : -1;
    const lastSelectedIndex = recommendedIndex >= 0 ? recommendedIndex : 0;
    easyProfileSelections = Object.fromEntries(catalogProfiles.map((profile, index) => [profile.id, index <= lastSelectedIndex]));
    easyInstallAi = recommendedAiModels.length > 0;
  }

  function toggleEasyProfile(profileId: string, checked: boolean) {
    easyProfileSelections = { ...easyProfileSelections, [profileId]: checked };
  }

  function progressObject(value: unknown) {
    return value && typeof value === "object" ? value as Record<string, any> : null;
  }

  function recommendedModel(systemInfo: any, modelsCatalog: any[], role: string) {
    const recommendations = systemInfo?.aiRecommendation ?? [];
    const models = modelsCatalog.filter((model) => model.role === role);
    return recommendations
      .map((name: string) => models.find((model) => model.id === name || model.pull === name))
      .find(Boolean) ?? models.sort((a, b) => Number(a.expected_size_bytes ?? 0) - Number(b.expected_size_bytes ?? 0))[0];
  }

  function recommendedModels(systemInfo: any, modelsCatalog: any[], chatModel: any, embeddingModel: any) {
    const byName = new Set(systemInfo?.aiRecommendation ?? []);
    const selected = modelsCatalog.filter((model) => byName.has(model.id) || byName.has(model.pull));
    if (!selected.length) return [chatModel, embeddingModel].filter(Boolean);
    if (chatModel && !selected.some((model) => model.id === chatModel.id)) selected.push(chatModel);
    if (embeddingModel && !selected.some((model) => model.id === embeddingModel.id)) selected.push(embeddingModel);
    return selected;
  }

  function recommendedProfile(systemInfo: any, profilesCatalog: Profile[]) {
    if (systemInfo?.recommendedProfile?.title) return systemInfo.recommendedProfile;
    const profiles = Array.isArray(systemInfo?.recommendedProfiles) ? systemInfo.recommendedProfiles : [];
    return profiles[profiles.length - 1] ?? profilesCatalog[0] ?? null;
  }

  function recommendationReason(model: any) {
    if (!system || !model) return "";
    if (model.role === "embedding") return "Use this for semantic search and Local AI retrieval over indexed files.";
    if (system.tier === "browse-only") return "This is the smallest chat model in the catalog for this machine.";
    if (system.tier === "survival-ai") return "Best fit for this PC without needing a large workstation.";
    if (system.tier === "core-ai") return "Balanced local chat model for your available RAM.";
    return "Strong local chat model for this workstation tier.";
  }

  function estimateAiRamBytes(model: any) {
    const modelBytes = Number(model?.expected_size_bytes ?? 0);
    if (!modelBytes) return 0;
    if (model?.role === "embedding") return Math.ceil(Math.max(3 * 1024 ** 3, modelBytes * 1.2 + 1536 * 1024 ** 2));
    const overheadBytes = modelBytes >= 12 * 1024 ** 3 ? 5 * 1024 ** 3 : 3 * 1024 ** 3;
    const multiplier = modelBytes >= 12 * 1024 ** 3 ? 1.45 : 1.35;
    return Math.ceil(Math.max(6 * 1024 ** 3, modelBytes * multiplier + overheadBytes));
  }

  function recommendedInstallSummary() {
    const parts = recommendedAiModels.map((model) => `${model.title} (${gb(model.expected_size_bytes)})`);
    return parts.join(" + ") || "Calculating recommended models automatically.";
  }

  function preparedSize(source: Source) {
    return Number(source.prepared_size_bytes ?? source.expected_size_bytes ?? 0);
  }

  function progressLine(progress: any) {
    if (!progress) return "";
    const eta = progress.etaSeconds ? ` · about ${duration(progress.etaSeconds)} left` : "";
    if (progress.phase === "runtime-download" && progress.runtimeBytesTotal) {
      return `${gb(progress.runtimeBytesReceived)} / ${gb(progress.runtimeBytesTotal)}${eta}`;
    }
    if (progress.phase === "model-pull" && progress.modelBytesTotal) {
      return `${gb(progress.modelBytesReceived)} / ${gb(progress.modelBytesTotal)} for this model · ${progress.percent ?? 0}% overall${eta}`;
    }
    if (progress.totalBytes) return `${gb(progress.currentBytes ?? 0)} / ${gb(progress.totalBytes)} overall${eta}`;
    return progress.detail ?? "";
  }

  function duration(seconds: number) {
    const value = Math.max(0, Math.round(seconds));
    const minutes = Math.floor(value / 60);
    const rest = value % 60;
    if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${rest}s`;
    return `${rest}s`;
  }

  function easyInstallProgressLine(progress: any) {
    if (!progress) return "";
    if (progress.phase === "download") {
      const bytes = progress.totalBytes ? `${gb(progress.currentBytes ?? 0)} / ${gb(progress.totalBytes)}` : "total size unknown";
      const counts = progress.sourceCount ? `${progress.done ?? 0}/${progress.sourceCount} complete` : "";
      const active = progress.active ? ` · ${progress.active} active` : "";
      return `Downloading profile sources with up to 4 parallel downloads · ${bytes}${counts ? ` · ${counts}` : ""}${active}`;
    }
    if (progress.phase === "prepare") return "Extracting archives and preparing downloaded files for offline use.";
    if (progress.phase === "index") return "Building local search and Local AI context indexes.";
    if (progress.phase === "ai") return "Installing Ollama and recommended models; see the Local AI progress panel for model download details.";
    return progress.detail ?? "";
  }

  function downloadProfileTooltip(profile: Profile) {
    return `Download every source needed for ${profile.title}. Already downloaded sources are skipped, and up to 4 downloads run in parallel.`;
  }

  function downloadTooltip(source: Source | Record<string, any>) {
    return `Download ${source.title} into the local library so it can later be verified, opened, indexed, searched, and used by Local AI.`;
  }

  function verifyTooltip(source: Source | Record<string, any>) {
    return `Verify ${source.title} by checking the downloaded file on disk against its recorded size and checksum when one is available. This does not download new data.`;
  }

  function indexTooltip(source: Source | Record<string, any>) {
    const verb = fullyIndexedSourceIds.has(source.id) ? "Re-index" : "Index";
    return `${verb} ${source.title} by extracting searchable text into the local search database and Local AI retrieval context. This does not open the file for reading or download anything new.`;
  }

  function indexActionLabel(sourceId: string) {
    return fullyIndexedSourceIds.has(sourceId) ? "Re-index" : "Index";
  }

  function openTooltip(source: Source | Record<string, any>) {
    const action = source.open?.action ?? (source.type === "zim" ? "kiwix_serve" : "direct_open");
    if (action === "kiwix_serve") return `Open ${source.title} in the local Kiwix reader. This starts or reuses the localhost Kiwix server for downloaded ZIM files.`;
    if (action === "extract_serve") return `Open ${source.title} by extracting the configured content, serving it on localhost, and opening it in the browser.`;
    if (action === "extract_open") return `Open ${source.title} by extracting the archive and launching the configured file with the system viewer.`;
    return `Open ${source.title} with the system default application for the downloaded file.`;
  }
</script>

<main>
  <aside>
    <h1>Offline Survival</h1>
    <button class="easyInstallButton" type="button" class:active={activeTab === "easy"} on:click={openEasyInstall}>Easy Install</button>
    <div class="meter">
      <span>Downloaded</span>
      <strong>{gb(downloadedBytes)}</strong>
    </div>
    {#if system}
      <div class="meter explainMeter" title="Recommended setup is the largest profile whose prepared disk estimate is no more than 40% of total disk and 20% of currently free disk.">
        <span>
          Recommended setup
          <small>Largest profile within 40% total / 20% free disk</small>
        </span>
        <strong>{recommendedSetupProfile?.title ?? "No profile fits"}</strong>
      </div>
      <div class="meter">
        <span>Recommendation cap</span>
        <strong>{gb(system.recommendationLimitBytes ?? 0)}</strong>
      </div>
      <div class="meter">
        <span>Free space</span>
        <strong>{gb(system.freeSpaceBytes)}</strong>
      </div>
    {/if}
    <label>
      Library path
      <input bind:value={libraryPath} />
    </label>
    <button on:click={setLibrary} disabled={!!busy}>Set Library</button>
    <div class="sidebarService">
      <div>
        <span>Kiwix</span>
        <strong class:ok={statusTone(kiwixService.status) === "ok"} class:warn={statusTone(kiwixService.status) === "warn"} class:bad={statusTone(kiwixService.status) === "bad"}>{kiwixService.status}</strong>
        <small>{kiwixService.url}</small>
      </div>
      {#if kiwixService.status === "running"}
        <button type="button" on:click={() => stop("kiwix")} disabled={!!busy}>Stop Kiwix</button>
      {:else}
        <button type="button" on:click={startKiwix} disabled={!!busy || kiwixService.status === "missing"}>Start Kiwix</button>
      {/if}
    </div>
    <button type="button" class="dangerAction" on:click={cleanSources} disabled={!!busy}>Clean Sources</button>
  </aside>

  <section class="workspace">
    <nav class="tabs" aria-label="Application sections">
      <button type="button" class:active={activeTab === "dashboard"} on:click={() => activeTab = "dashboard"}>Dashboard</button>
      <button type="button" class:active={activeTab === "downloads"} on:click={() => activeTab = "downloads"}>Downloads</button>
      <button type="button" class:active={activeTab === "search"} on:click={() => activeTab = "search"}>Search</button>
      <button type="button" class:active={activeTab === "extra"} on:click={() => activeTab = "extra"}>Extra Knowledge</button>
      <button type="button" class:active={activeTab === "ai"} on:click={() => activeTab = "ai"}>Local AI</button>
      <button type="button" class:active={activeTab === "share"} on:click={() => activeTab = "share"}>Share</button>
      <button type="button" class:active={activeTab === "settings"} on:click={() => activeTab = "settings"}>Settings</button>
    </nav>
    {#if error}<div class="alert">{error}</div>{/if}
    {#if busy}<div class="busy">Working: {busy}</div>{/if}

    {#if activeTab === "easy"}
    <section id="easy-install" class="band">
      <div class="sectionHeader">
        <div>
          <h2>Easy Install</h2>
          <small>Select one or more profiles. Easy Install downloads them, prepares/extracts downloaded sources, indexes searchable content, and can install recommended Local AI.</small>
        </div>
      </div>
      <div class="serviceGrid">
        {#each catalog.profiles as profile}
          <article class:recommendedModel={easyProfileSelections[profile.id]}>
            <label class="checkRow">
              <input type="checkbox" checked={Boolean(easyProfileSelections[profile.id])} on:change={(event) => toggleEasyProfile(profile.id, event.currentTarget.checked)} />
              <span>
                <strong>{profile.title}</strong>
                <small>{gb(profile.preparedSizeBytes ?? profile.expectedSizeBytes)} prepared disk · {gb(profile.expectedSizeBytes)} download · {profile.sourceIds.length} sources</small>
              </span>
            </label>
            <small>{profile.description}</small>
          </article>
        {/each}
        <article class:recommendedModel={easyInstallAi}>
          <label class="checkRow">
            <input type="checkbox" bind:checked={easyInstallAi} />
            <span>
              <strong>Install recommended Local AI</strong>
              <small>{recommendedInstallSummary()}</small>
            </span>
          </label>
          <small>Installs Ollama and every model recommended for this PC.</small>
        </article>
      </div>
      <div class="stats">
        <span>{selectedEasyProfiles.length} profiles selected</span>
        <span>{gb(selectedEasyPreparedBytes)} prepared disk estimate</span>
        <span>{gb(selectedEasyDownloadBytes)} compressed download</span>
        <span>{easyInstallAi ? "Local AI included" : "Local AI skipped"}</span>
      </div>
      <div class="centerAction">
        <button class="primaryAction startEasyInstallButton" type="button" on:click={easyInstall} disabled={!!busy || (!selectedEasyProfiles.length && !easyInstallAi)}>
          {busy === "easy-install" ? "Installing" : "Start Easy Install"}
        </button>
      </div>
      {#if easyInstallProgress}
        <div class="progressPanel">
          <div class="progressHeader">
            <strong>{easyInstallProgress.phase ?? "Easy Install"}</strong>
            <span>{easyInstallProgress.percent ?? 0}%</span>
          </div>
          <progress max="100" value={easyInstallProgress.percent ?? 0}></progress>
          <small>{easyInstallProgress.detail}</small>
          <small>{easyInstallProgressLine(easyInstallProgress)}</small>
        </div>
      {/if}
      {#if showEasyAiProgress}
        <div class="progressPanel aiProgress">
          <div class="progressHeader">
            <strong>{aiInstallProgress.item ?? "Local AI setup"}</strong>
            <span>{aiInstallProgress.phase ?? aiInstallProgress.status}</span>
          </div>
          <progress max="100" value={aiInstallProgress.percent ?? 0}></progress>
          <small>{aiInstallProgress.detail}</small>
          <small>{progressLine(aiInstallProgress)}</small>
        </div>
      {/if}
    </section>
    {/if}

    {#if activeTab === "dashboard"}
    <section class="band">
      <div class="sectionHeader">
        <h2>Profiles</h2>
        <input placeholder="Filter profile sources" bind:value={filter} />
      </div>
      <p>Profiles are ordered from smallest to largest. Each card shows only the sources that profile adds beyond the profile before it; downloading a profile still downloads everything needed for that full tier.</p>
      <div class="stats">
        <span>{catalog.profiles.length} profiles</span>
        <span>{catalog.sources.length} catalog sources</span>
        <span>{state.documents.length} indexed documents</span>
        <span>{state.blobs.length} unique blobs</span>
        <span>{state.services.filter((service) => service.status === "running").length} services running</span>
      </div>
      {#if system}
        <div class="stats">
          <span>{system.platform}/{system.arch}</span>
          <span>{system.cpuCount} CPU threads</span>
          <span>{gb(system.totalMemBytes)} RAM</span>
          <span>AI: {system.aiRecommendation.join(", ") || "none"}</span>
        </div>
      {/if}
    </section>

    {#if loadingCatalog}
      <section class="band emptyState">
        <h2>Loading Profiles</h2>
        <p>Reading the local catalog and library state.</p>
      </section>
    {:else if catalogError}
      <section class="band emptyState">
        <h2>Profiles Could Not Load</h2>
        <p>The local backend is not responding, so the dashboard cannot show the profile catalog yet.</p>
        <small>{catalogError}</small>
        <button type="button" on:click={load}>Retry Loading Profiles</button>
      </section>
    {:else if catalog.profiles.length === 0}
      <section class="band emptyState">
        <h2>No Profiles Found</h2>
        <p>The source catalog loaded, but it did not contain any configured profiles.</p>
        <button type="button" on:click={refreshCatalog}>Refresh Catalog</button>
      </section>
    {:else}
    {#each catalog.profiles as profile, index}
      {@const added = addedSources(profile)}
      {@const progress = profileProgressInfo(profile)}
      {@const hasDownloadableSources = profileHasDownloadableSources(profile)}
      <section class="band profileCard">
        <div class="sectionHeader">
          <div>
            <h2>{profile.title}</h2>
            <small>{index === 0 ? "Base profile" : `Adds to ${catalog.profiles[index - 1]?.title}`}</small>
          </div>
          <span class="tooltipHost" title={downloadProfileTooltip(profile)}>
            <button aria-label={downloadProfileTooltip(profile)} on:click={() => downloadProfile(profile)} disabled={!hasDownloadableSources || (profileDownloadBusy && busy !== `profile-${profile.id}`)}>
              {hasDownloadableSources ? "Download Full Profile" : "Profile Downloaded"}
            </button>
          </span>
        </div>
        <p>{profile.description}</p>
        <div class="stats">
          <span>{added.length} add-on sources shown</span>
          <span>{gb(profile.addedPreparedSizeBytes ?? profile.addedExpectedSizeBytes ?? 0)} prepared add-on disk</span>
          <span>{profile.sourceIds.length} total sources in full profile</span>
          <span>{gb(profile.preparedSizeBytes ?? profile.expectedSizeBytes)} prepared full profile</span>
          <span>{gb(profile.expectedSizeBytes)} compressed download</span>
        </div>
        <div class="progressPanel">
          <div class="progressHeader">
            <strong>Full profile progress</strong>
            <span>{progress.progress}% · {gb(progress.received)} / {gb(progress.total)}</span>
          </div>
          <progress max="100" value={progress.progress}></progress>
          <small>{progress.done} complete · {progress.active} active or queued · {progress.failed} paused or failed · up to 4 downloads run in parallel</small>
        </div>
        <div class="table">
          <div class="row head">
            <span>Add-on source</span><span>Type</span><span>Prepared disk</span><span>Status</span><span>Actions</span>
          </div>
          {#each added as source}
            {@const info = sourceProgressInfo(source)}
            {@const sourceBusy = busy.endsWith(source.id)}
            {@const sourceDownloading = ["queued", "downloading", "resuming"].includes(String(info.downloadRow?.status ?? ""))}
            {@const downloaded = sourceIsDownloaded(info.local ?? {})}
            {@const verifyNotice = verifyFeedback[source.id]}
            <div class="row">
              <span>
                <strong>{source.title}</strong>
                <small>{source.category} · {source.license} · {info.local?.local_path ?? "not downloaded"}</small>
              </span>
              <span>{source.type}</span>
              <span>{gb(preparedSize(source))}</span>
              <span class="sourceProgress">
                <span class:ok={statusTone(info.status) === "ok"} class:warn={statusTone(info.status) === "warn"} class:bad={statusTone(info.status) === "bad"}>{info.status}</span>
                {#if info.totalKnown}
                  <progress max="100" value={info.progress}></progress>
                  <small>{info.progress}% · {gb(info.received)} / {gb(info.total)}</small>
                {:else}
                  <progress></progress>
                  <small>{gb(info.received)} downloaded · total unknown</small>
                {/if}
              </span>
              <span class="actions">
                {#if downloaded}
                  <small>Downloaded</small>
                {:else}
                  <span class="tooltipHost" title={downloadTooltip(source)}>
                    <button aria-label={downloadTooltip(source)} on:click={() => download(source.id)} disabled={profileDownloadBusy || sourceBusy || sourceDownloading}>Download</button>
                  </span>
                {/if}
                <span class="tooltipHost" title={verifyTooltip(source)}>
                  <button aria-label={verifyTooltip(source)} on:click={() => verify(source.id)} disabled={!info.local?.local_path || sourceBusy || sourceDownloading}>Verify</button>
                </span>
                <span class="tooltipHost" title={indexTooltip(source)}>
                  <button aria-label={indexTooltip(source)} on:click={() => indexSource(source.id)} disabled={!info.local?.local_path || sourceBusy || sourceDownloading}>{indexActionLabel(source.id)}</button>
                </span>
                <span class="tooltipHost" title={openTooltip(source)}>
                  <button aria-label={openTooltip(source)} on:click={() => openOriginal(source.id)} disabled={!info.local?.local_path || sourceBusy}>Open</button>
                </span>
                {#if verifyNotice}
                  <small class="inlineFeedback" class:ok={verifyNotice.ok} class:bad={!verifyNotice.ok}>{verifyNotice.message}</small>
                {/if}
              </span>
            </div>
          {:else}
            <div class="row emptyRow">
              <span>No add-on sources match the current filter.</span><span></span><span></span><span></span><span></span>
            </div>
          {/each}
        </div>
      </section>
    {/each}
    {/if}
    {/if}

    {#if activeTab === "downloads"}
    <section id="downloads" class="band">
      <div class="sectionHeader">
        <h2>Downloads</h2>
        <div class="maintenanceActions">
          <span>
            <button on:click={reconcile} disabled={!!busy}>Check Files</button>
            <small>Compare the database with files on disk and mark missing or repaired downloads.</small>
            {#if maintenanceFeedback}
              <small class="inlineFeedback" class:ok={maintenanceFeedback.ok} class:bad={!maintenanceFeedback.ok}>{maintenanceFeedback.message}</small>
            {/if}
          </span>
          <span>
            <button on:click={cleanupPartials} disabled={!!busy}>Remove Partial Files</button>
            <small>Delete unfinished .part files left by paused or interrupted downloads.</small>
          </span>
        </div>
      </div>
      <div class="table">
        <div class="row head">
          <span>Source</span><span>Status</span><span>Progress</span><span>Total</span><span>Actions</span>
        </div>
        {#each state.downloads as downloadRow}
          {@const canPause = ["queued", "downloading", "resuming"].includes(String(downloadRow.status))}
          {@const canRetry = ["failed", "paused"].includes(String(downloadRow.status))}
          {@const downloadReceived = Number(downloadRow.bytes_received || 0)}
          {@const downloadTotal = downloadRow.status === "complete" && !Number(downloadRow.total_bytes || 0) ? downloadReceived : Number(downloadRow.total_bytes || 0)}
          {@const downloadProgress = downloadTotal > 0 ? Math.min(100, Math.round((downloadReceived / downloadTotal) * 100)) : 0}
          {@const downloadTotalKnown = downloadTotal > downloadReceived || downloadRow.status === "complete" || downloadReceived === 0}
          {@const pauseBusy = busy === `pause-${downloadRow.source_id}`}
          {@const retryBusy = busy === `retry-${downloadRow.source_id}`}
          <div class="row">
            <span>{downloadRow.source_id}<small>{downloadRow.error}</small></span>
            <span class:ok={statusTone(downloadRow.status) === "ok"} class:warn={statusTone(downloadRow.status) === "warn"} class:bad={statusTone(downloadRow.status) === "bad"}>{downloadRow.status}</span>
            <span class="sourceProgress">
              {#if downloadTotalKnown}
                <progress max="100" value={downloadProgress}></progress>
                <small>{downloadProgress}% · {gb(downloadReceived)} downloaded</small>
              {:else}
                <progress></progress>
                <small>{gb(downloadReceived)} downloaded · total unknown</small>
              {/if}
            </span>
            <span>{gb(downloadRow.total_bytes)}</span>
            <span class="actions">
              {#if canPause}
                <button on:click={() => pause(downloadRow.source_id)} disabled={pauseBusy}>Pause</button>
              {:else if canRetry}
                <button on:click={() => retry(downloadRow.source_id)} disabled={retryBusy}>Retry</button>
              {:else}
                <small>No action needed</small>
              {/if}
            </span>
          </div>
        {/each}
      </div>
      {#if recovery}
        <article class="answer">
          <strong>Recovery scan</strong>
          <small>{recovery.repaired.length} repaired · {recovery.missing.length} missing · {recovery.partials.length} partials</small>
        </article>
      {/if}
    </section>
    {/if}

    {#if activeTab === "extra"}
    <section id="extra-knowledge" class="band">
      <div class="sectionHeader">
        <div>
          <h2>Extra Knowledge</h2>
          <small>Add local PDFs, EPUBs, text/Markdown/HTML/CSV/JSON files, and ZIM files from another folder.</small>
        </div>
        <span class="actions">
          <button type="button" on:click={indexImportedExtraFiles} disabled={!!busy || !extraImportedSources.some((source) => source.local_path && !fullyIndexedSourceIds.has(source.id))}>Index Imported</button>
        </span>
      </div>
      <div class="pathPicker">
        <input placeholder="/home/you/Documents/offline-notes" bind:value={extraFolderPath} />
        <button type="button" on:click={pickExtraFolder} disabled={!!busy}>Choose Folder</button>
        <button type="button" on:click={scanExtraFolder} disabled={!!busy || !extraFolderPath.trim()}>Scan Folder</button>
      </div>
      {#if extraScan}
        <div class="stats">
          <span>{extraFiles.length} supported files</span>
          <span>{gb(extraScan.totalBytes ?? 0)} selected folder data</span>
          <span>{extraScan.skippedUnsupported ?? 0} unsupported skipped</span>
        </div>
        <article class="infoCard">
          <div class="sectionHeader compactHeader">
            <div>
              <h3>Files Found</h3>
              <small>{selectedExtraFiles.length} selected · imported files are copied into the app library before indexing.</small>
            </div>
            <span class="actions">
              <button type="button" on:click={() => setAllExtraSelections(true)} disabled={!extraFiles.length}>Select All</button>
              <button type="button" on:click={() => setAllExtraSelections(false)} disabled={!extraFiles.length}>Clear</button>
              <label class="inlineCheckbox">
                <input type="checkbox" bind:checked={extraIndexOnImport} />
                <span>Index after import</span>
              </label>
              <button class="primaryAction" type="button" on:click={importSelectedExtraFiles} disabled={!!busy || !selectedExtraFiles.length}>Import Selected</button>
            </span>
          </div>
          <div class="fileList">
            {#each extraFiles as file}
              <label class="fileRow">
                <input type="checkbox" checked={Boolean(extraSelections[file.path])} on:change={(event) => extraSelections = { ...extraSelections, [file.path]: event.currentTarget.checked }} />
                <span>
                  <strong>{file.relativePath}</strong>
                  <small>{file.type} · {file.extension} · {gb(file.sizeBytes)}</small>
                </span>
              </label>
            {:else}
              <small>No supported files found in this folder.</small>
            {/each}
          </div>
        </article>
      {/if}
      {#if extraImportResult}
        <article class="answer">
          <strong>Imported {extraImportResult.imported?.length ?? 0} files</strong>
          <small>{extraImportResult.indexed?.length ?? 0} indexed or registered for search/local AI context.</small>
        </article>
      {/if}
      <article class="infoCard">
        <h3>Imported Local Sources</h3>
        <small class="cardIntro">{extraImportedSources.length ? "These local files are now part of the app library." : "No extra local files imported yet."}</small>
        {#if extraImportedSources.length}
          {#each extraImportedSources as source}
            <div class="resourceRow">
              <span>
                <strong>{source.title}</strong>
                <small>{source.type} · {source.status} · {source.local_path}</small>
              </span>
              <span class="actions">
                <button type="button" on:click={() => openOriginal(source.id)} disabled={!!busy || !source.local_path}>Open</button>
                <button type="button" on:click={() => indexSource(source.id)} disabled={!!busy || !source.local_path}>{indexActionLabel(source.id)}</button>
              </span>
            </div>
          {/each}
        {/if}
      </article>
    </section>
    {/if}

    {#if activeTab === "search"}
    <section id="search" class="band">
      <div class="sectionHeader">
        <h2>Search</h2>
        <span class="actions">
          <span class="tooltipHost" title="Index all downloaded sources that are not indexed yet. This uses built-in text extraction and does not require an embedding model.">
            <button type="button" on:click={indexAllDownloaded} disabled={!!busy || !indexableDownloadedSources.length}>
              {indexableDownloadedSources.length ? `Index ${indexableDownloadedSources.length} Downloaded` : "All Downloaded Indexed"}
            </button>
          </span>
        </span>
        <form on:submit|preventDefault={searchNow}>
          <input placeholder="Search indexed practical content" bind:value={query} />
          <select bind:value={searchSource}>
            <option value="">All searchable resources</option>
            {#each searchableSources as source}
              <option value={source.id}>{source.title}</option>
            {/each}
          </select>
          <select bind:value={searchLicense}>
            <option value="">All licenses</option>
            {#each licenseOptions as license}
              <option value={license}>{license}</option>
            {/each}
          </select>
          <button>Search</button>
          <button type="button" on:click={semanticSearchNow}>Semantic</button>
        </form>
      </div>
      <div class="resourceGrid">
        <article class="infoCard">
          <h3>Searchable Resources</h3>
          <small class="cardIntro">{searchableSources.length ? "Indexed sources that can be searched now." : "No indexed resources yet. Open or index downloaded sources first."}</small>
          {#if searchableSources.length}
            <div class="actions">
              {#each searchableSources as source}
                <button type="button" class:active={searchSource === source.id} on:click={() => searchSource = source.id}>{source.title}</button>
              {/each}
              <button type="button" class:active={!searchSource} on:click={() => searchSource = ""}>All</button>
            </div>
          {/if}
        </article>
        <article class="infoCard">
          <h3>Downloading Now</h3>
          <small class="cardIntro">These resources are still queued, downloading, or resuming. They cannot be opened or indexed until the download completes.</small>
          {#if activeDownloadSources.length}
            {#each activeDownloadSources as source}
              {@const info = sourceProgressInfo(source)}
              <div class="resourceRow">
                <span>
                  <strong>{source.title}</strong>
                  <small>{info.downloadRow?.status ?? "queued"} · {info.progress}% · {gb(info.received)} / {gb(info.total)}</small>
                </span>
                <span class="sourceProgress">
                  <progress max="100" value={info.progress}></progress>
                </span>
              </div>
            {/each}
          {:else}
            <small class="emptyNote">No active downloads.</small>
          {/if}
        </article>
        <article class="infoCard">
          <h3>Downloaded Files Needing Open or Index</h3>
          <small class="cardIntro">These files are actually present on disk. Open prepares them for reading; Index adds prepared text to local search and Local AI context.</small>
          {#if notSearchableDownloads.length}
            {#each notSearchableDownloads as source}
              {@const downloadRow = downloadState.get(source.id)}
              {@const sourceBusy = busy.endsWith(source.id)}
              {@const sourceDownloading = ["queued", "downloading", "resuming"].includes(String(downloadRow?.status ?? ""))}
              {@const verifyNotice = verifyFeedback[source.id]}
              <div class="resourceRow">
                <span>
                  <strong>{source.title}</strong>
                  <small>{source.type === "repo-archive" ? "Open this source to extract the configured content, then index it." : "Index this source before it can be searched."}</small>
                </span>
                <span class="actions">
                  <span class="tooltipHost" title={openTooltip(source)}>
                    <button type="button" aria-label={openTooltip(source)} on:click={() => openOriginal(source.id)} disabled={sourceBusy}>Open</button>
                  </span>
                  <span class="tooltipHost" title={indexTooltip(source)}>
                    <button type="button" aria-label={indexTooltip(source)} on:click={() => indexSource(source.id)} disabled={sourceBusy || sourceDownloading}>{indexActionLabel(source.id)}</button>
                  </span>
                  {#if verifyNotice}
                    <small class="inlineFeedback" class:ok={verifyNotice.ok} class:bad={!verifyNotice.ok}>{verifyNotice.message}</small>
                  {/if}
                </span>
              </div>
            {/each}
          {:else}
            <small>No fully downloaded files are waiting for Open or Index.</small>
          {/if}
        </article>
      </div>
      <div class="results">
        {#each searchResults as result}
          <button
            type="button"
            class="resultCard clickableResult"
            title="Open this result in the matched local resource"
            on:click={() => openSearchHit(result)}
          >
            <h3>{result.title}</h3>
            <p>{@html result.snippet}</p>
            <small>{result.path} · click to open match</small>
          </button>
        {/each}
      </div>
    </section>
    {/if}

    {#if activeTab === "ai"}
    <section id="ai-recommended-setup" class="band">
      <div class="sectionHeader">
        <div>
          <h2>Recommended Local AI Setup</h2>
          <small>Installs the app-managed Ollama runtime if needed, starts it locally, and downloads every model recommended for this PC.</small>
        </div>
        <button class="primaryAction" on:click={installRecommendedAi} disabled={loadingCatalog || (!!busy && busy !== "easy-install")}>
          {busy === "ai-install" ? "Installing All Recommended" : "Install All Recommended"}
        </button>
      </div>
      <div class="stats">
        <span>{recommendedInstallSummary()}</span>
        <span>{system?.tier ?? "machine tier unknown"}</span>
      </div>
      {#if showAiInstallProgress}
        <div class="progressPanel aiProgress">
          <div class="progressHeader">
            <strong>{aiInstallProgress.item ?? "Local AI setup"}</strong>
            <span class:bad={aiInstallProgress.status === "failed"}>{aiInstallProgress.phase ?? aiInstallProgress.status}</span>
          </div>
          <progress max="100" value={aiInstallProgress.percent ?? 0}></progress>
          <small>{aiInstallProgress.detail}</small>
          <small>{progressLine(aiInstallProgress)}</small>
        </div>
      {:else if aiInstallComplete}
        <div class="progressPanel aiProgress">
          <div class="progressHeader">
            <strong>Recommended Local AI setup installed</strong>
            <span class="ok">complete</span>
          </div>
          <progress max="100" value="100"></progress>
          <small>{aiInstallProgress.detail}</small>
        </div>
      {/if}
    </section>

    <section id="ai-service" class="band">
      <div class="sectionHeader">
        <h2>AI Service</h2>
        <button on:click={refreshServices}>Refresh</button>
      </div>
      <div class="serviceGrid">
        {#each aiServiceCards as service}
          {@const serviceRunning = service.status === "running"}
          <article>
            <strong>{service.name}</strong>
            <span class:ok={statusTone(service.status) === "ok"} class:warn={statusTone(service.status) === "warn"} class:bad={statusTone(service.status) === "bad"}>{service.status}</span>
            <small>{service.url}</small>
            {#if serviceRunning}
              <button on:click={() => stop(service.name)} disabled={!!busy}>Stop</button>
            {:else if service.status === "installing" || service.status === "starting"}
              <small>{service.message ?? "Local AI setup is in progress."}</small>
            {:else if service.status === "blocked"}
              <small>{service.message ?? "Local AI is blocked by the RAM safety guard."}</small>
            {:else if service.status === "missing"}
              <small>Use Install Recommended below to download and start the app-managed Ollama runtime.</small>
            {:else if service.name === "ollama" && (service.status === "available" || service.status === "stopped" || service.status === "failed")}
              {#if startAiModel}
                <small>Startup guard: {gb(system?.availableMemBytes ?? 0)} available RAM / {gb(startAiRequiredBytes)} required for {startAiModel.title}.</small>
                {#if startAiSwapPressure}
                  <small>Swap is too full for a safe Local AI start.</small>
                {/if}
              {:else}
                <small>Install a chat model before starting Local AI.</small>
              {/if}
              <button on:click={startOllama} disabled={!!busy || !startAiAllowed}>Start Ollama</button>
            {:else}
              <small>No running service to stop.</small>
            {/if}
          </article>
        {/each}
      </div>
    </section>

    <section id="models" class="band">
      <div class="sectionHeader">
        <h2>Models</h2>
        <button on:click={refreshModels}>Refresh Models</button>
      </div>
      {#if recommendedChatModel || recommendedEmbeddingModel}
        <div class="recommendationPanel">
          {#if recommendedChatModel}
            <article class="recommendedModel">
              <span class="badge">Recommended chat model for this PC</span>
              <strong>{recommendedChatModel.title}</strong>
              <small>{recommendationReason(recommendedChatModel)}</small>
              <small>{recommendedChatModel.pull} · {gb(recommendedChatModel.expected_size_bytes)} · {recommendedChatModel.status}</small>
              <button class="primaryAction" on:click={() => pullModel(recommendedChatModel.id)} disabled={!!busy || recommendedChatModel.status === "pulling" || recommendedChatModel.status === "installed"}>
                {recommendedChatModel.status === "installed" ? "Installed" : "Pull Recommended Chat Model"}
              </button>
            </article>
          {/if}
          {#if recommendedEmbeddingModel}
            <article class="recommendedModel">
              <span class="badge">Recommended embedding model</span>
              <strong>{recommendedEmbeddingModel.title}</strong>
              <small>{recommendationReason(recommendedEmbeddingModel)}</small>
              <small>{recommendedEmbeddingModel.pull} · {gb(recommendedEmbeddingModel.expected_size_bytes)} · {recommendedEmbeddingModel.status}</small>
              <button class="primaryAction" on:click={() => pullModel(recommendedEmbeddingModel.id)} disabled={!!busy || recommendedEmbeddingModel.status === "pulling" || recommendedEmbeddingModel.status === "installed"}>
                {recommendedEmbeddingModel.status === "installed" ? "Installed" : "Pull Recommended Embedding"}
              </button>
            </article>
          {/if}
        </div>
      {/if}
      <div class="serviceGrid">
        {#each availableModels as model}
          <article class:recommendedModel={model.id === recommendedChatModel?.id || model.id === recommendedEmbeddingModel?.id}>
            <strong>{model.title}</strong>
            <span class:ok={statusTone(model.status) === "ok"} class:warn={statusTone(model.status) === "warn"} class:bad={statusTone(model.status) === "bad"}>{model.status}</span>
            <small>Engine: {model.runtime} · {model.pull} · {model.role} · {gb(model.expected_size_bytes)}</small>
            {#if model.id === recommendedChatModel?.id}
              <small>Recommended chat model for {system?.tier ?? "this PC"}.</small>
            {/if}
            {#if model.id === recommendedEmbeddingModel?.id}
              <small>Recommended embedding model for search and Local AI context.</small>
            {/if}
            <button class:primaryAction={model.id === recommendedChatModel?.id || model.id === recommendedEmbeddingModel?.id} on:click={() => pullModel(model.id)} disabled={!!busy || model.status === "pulling" || model.status === "installed"}>
              {model.status === "installed" ? "Installed" : model.id === recommendedChatModel?.id || model.id === recommendedEmbeddingModel?.id ? "Pull Recommended" : "Pull"}
            </button>
          </article>
        {/each}
      </div>
    </section>

    <section id="ai" class="band">
      <div class="sectionHeader">
        <h2>Local AI</h2>
        <span class="actions">
          <span>{indexedSources.length} indexed resources available</span>
          <button type="button" on:click={indexAllDownloaded} disabled={!!busy || !indexableDownloadedSources.length}>
            {indexableDownloadedSources.length ? `Index ${indexableDownloadedSources.length} Downloaded` : "All Downloaded Indexed"}
          </button>
        </span>
      </div>
      <p>The text index makes downloaded sources searchable without an embedding model. The embedding model is used after indexing for semantic matching: finding relevant passages by meaning for Local AI answers and semantic search, even when the exact words differ.</p>
      <form class="ask" on:submit|preventDefault={ask}>
        <select bind:value={questionSource}>
          <option value="">All indexed resources</option>
          {#each indexedSources as source}
            <option value={source.id}>{source.title}</option>
          {/each}
        </select>
        <textarea placeholder="Ask against indexed local documents" bind:value={question}></textarea>
        <button disabled={!!busy || !question.trim()}>Ask Ollama</button>
      </form>
      {#if answer}
        <article class="answer">
          <p>{answer.answer}</p>
          {#each answer.citations as citation}
            <small>[{citation.index}] {citation.title} · {citation.path}</small>
          {/each}
        </article>
      {/if}
    </section>
    {/if}

    {#if activeTab === "share"}
    <section id="share" class="band">
      <div class="sectionHeader">
        <h2>Share</h2>
      </div>
      <p>Share creates one compressed package with the selected downloaded sources, search data, and available app files for Windows, macOS, and Linux.</p>
      <article class="recommendedSetup">
        <div>
          <strong>Generate app + sources package</strong>
          <small>The package includes app files from the extracted all-platforms release folder, downloaded files, prepared/opened files, and search indexes for the selected source set. Unrelated local content is left out.</small>
        </div>
        {#if shareOptions.length}
          <span class="actions">
            <select bind:value={shareProfile} aria-label="Sources to share">
              {#each shareOptions as option}
                <option value={option.id}>{option.title} · {gb(option.sizeBytes)} · {option.sourceCount} sources</option>
              {/each}
            </select>
            <select bind:value={sharePrimaryOs} aria-label="Primary operating system">
              <option value="linux">Primary launcher: Linux</option>
              <option value="windows">Primary launcher: Windows</option>
              <option value="macos">Primary launcher: macOS</option>
            </select>
            <button type="button" on:click={pickShareAppsFolder} disabled={!!busy}>App Bundle Folder</button>
            <button class="primaryAction startEasyInstallButton" on:click={generateSharePackage} disabled={!!busy || !shareProfile}>
              {busy === "share-package" ? "Generating Share Package" : "Generate Share Package"}
            </button>
          </span>
        {/if}
      </article>
      {#if shareAppsPath}
        <small class="pathHint">App bundle folder: {shareAppsPath}</small>
      {:else}
        <small class="pathHint">Optional: choose the extracted Offline-Survival-all-platforms folder before generating a mixed-OS package.</small>
      {/if}
      {#if sharePackageProgress && (busy === "share-package" || ["running", "failed", "complete"].includes(String(sharePackageProgress.status ?? "")))}
        <div class="progressPanel">
          <div class="progressHeader">
            <strong>{sharePackageProgress.profileTitle ?? "Share package"}</strong>
            <span class:bad={sharePackageProgress.status === "failed"} class:ok={sharePackageProgress.status === "complete"}>{sharePackageProgress.phase ?? sharePackageProgress.status}</span>
          </div>
          <progress max="100" value={sharePackageProgress.percent ?? 0}></progress>
          <small>{sharePackageProgress.detail}</small>
          {#if sharePackageProgress.total}
            <small>{sharePackageProgress.current ?? 0} / {sharePackageProgress.total} sources · {sharePackageProgress.percent ?? 0}%</small>
          {:else}
            <small>{sharePackageProgress.percent ?? 0}%</small>
          {/if}
          {#if sharePackageProgress.archivePath}
            <small>{sharePackageProgress.archivePath}</small>
          {/if}
        </div>
      {/if}
      {#if !shareOptions.length}
        <article class="answer">
          <strong>No downloaded sources ready to share</strong>
          <small>Download sources first. Share packages can only include sources already present on disk.</small>
        </article>
      {/if}
      {#if sharePackage}
        <article class="answer">
          <strong>Share package ready</strong>
          {#if sharePackage.profile}
            <small>Profile: {sharePackage.profile.title}</small>
          {/if}
          <small>Archive: {sharePackage.archivePath}</small>
          <small>Folder: {sharePackage.packageDir}</small>
          <small>Size: {gb(sharePackage.sizeBytes)}</small>
          <small>Checksum: {sharePackage.checksum}</small>
          <small>Checksum file: {sharePackage.checksumPath}</small>
          {#if sharePackage.primaryOs}
            <small>Primary launcher: {sharePackage.primaryOs}</small>
          {/if}
          {#if sharePackage.apps?.length}
            <small>Included app folders: {sharePackage.apps.map((app: any) => app.label).join(", ")}</small>
          {/if}
          {#each sharePackage.instructions as instruction}
            <small>{instruction}</small>
          {/each}
        </article>
      {/if}
    </section>

    {/if}

    {#if activeTab === "settings"}
    <section id="settings" class="band">
      <div class="sectionHeader">
        <h2>Settings</h2>
        <span class="actions">
          <button on:click={updatesStatus} disabled={!!busy}>Updates</button>
          <button on:click={refreshCatalog} disabled={!!busy}>Refresh Catalog</button>
          <button on:click={keepLocalhostOnly} disabled={!!busy}>Localhost Only</button>
        </span>
      </div>
      {#if updates}
        <article class="answer">
          <strong>Update channels</strong>
          <small>App: {updates.app_update}</small>
          <small>Manifests: {updates.manifest_update}</small>
          <small>Content: {updates.content_snapshot_update}</small>
          <small>Open services: {updates.runtime_update}</small>
          <small>Models: {updates.model_update}</small>
        </article>
      {/if}
      <article class="answer">
        <strong>Network policy</strong>
        <small>Local services bind to 127.0.0.1. LAN sharing remains disabled in this v1 build.</small>
      </article>
    </section>

    <section id="logs" class="band">
      <div class="sectionHeader">
        <h2>Logs</h2>
        <button on:click={loadLogs} disabled={!!busy}>Refresh Logs</button>
      </div>
      <div class="results">
        {#each logs as log}
          <article>
            <h3>{log.kind}</h3>
            <p>{log.message}</p>
            <small>{log.created_at}</small>
          </article>
        {/each}
      </div>
    </section>
    {/if}
  </section>
</main>

{#if confirmDialog}
  <div class="modalBackdrop" role="presentation" on:click={() => answerConfirm(false)}>
    <div role="dialog" aria-modal="true" class:dangerModal={confirmDialog.tone === "danger"} class="confirmModal" aria-labelledby="confirm-title" on:click|stopPropagation>
      <div class="modalHeader">
        <div>
          <span class="modalKicker">{confirmDialog.tone === "danger" ? "Destructive action" : "Confirmation"}</span>
          <h2 id="confirm-title">{confirmDialog.title}</h2>
        </div>
      </div>
      <p>{confirmDialog.body}</p>
      {#if confirmDialog.steps?.length}
        <ol class="stepList">
          {#each confirmDialog.steps as step}
            <li>{step}</li>
          {/each}
        </ol>
      {/if}
      {#if confirmDialog.details?.length}
        <div class="detailGrid">
          {#each confirmDialog.details as detail}
            <span>{detail[0]}</span>
            <strong>{detail[1]}</strong>
          {/each}
        </div>
      {/if}
      <div class="modalActions">
        <button type="button" on:click={() => answerConfirm(false)}>{confirmDialog.cancelLabel ?? "Cancel"}</button>
        <button type="button" class:dangerAction={confirmDialog.tone === "danger"} class:primaryAction={confirmDialog.tone !== "danger"} on:click={() => answerConfirm(true)}>
          {confirmDialog.confirmLabel ?? "Continue"}
        </button>
      </div>
    </div>
  </div>
{/if}
