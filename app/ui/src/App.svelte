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
  let questionModel = "";
  let chatTurns: any[] = [];
  let answer: any = null;
  let integrity: any = null;
  let licenseReport: any = null;
  let recovery: any = null;
  let review: any = null;
  let sharePackage: any = null;
  let showSharePackageProgress = false;
  let logs: any[] = [];
  let logSortKey: "title" | "description" | "date" = "date";
  let logSortDir: "asc" | "desc" = "desc";
  let logsPoller = 0;
  let logsRefreshing = false;
  let statePoller = 0;
  let stateRefreshing = false;
  let searchResults: any[] = [];
  let searching = false;
  let searchMode = "";
  let searchRequestId = 0;
  let busy = new Set<string>();
  let error = "";
  let catalogError = "";
  let loadingCatalog = true;
  let libraryPath = "";
  let easyInstallAi = true;
  let contentLanguage = initialContentLanguage();
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
  let uiLanguage = initialUiLanguage();

  const uiText: Record<string, Record<string, string>> = {
    en: {
      appLanguage: "App language",
      english: "English",
      spanish: "Español",
      bilingual: "Bilingual",
      contentLanguage: "Content language",
      aiRecommendations: "AI",
      englishProfile: "English profile",
      spanishProfile: "Spanish profile",
      bilingualProfile: "Bilingual profile",
      baseProfile: "Base profile",
      addsTo: "Adds to {title}",
      easyInstall: "Easy Install",
      downloaded: "Downloaded",
      recommendedSetup: "Recommended setup",
      recommendationExplain: "Largest profile within 40% total / 20% free disk",
      recommendationTitle: "Recommended setup is the largest profile whose prepared disk estimate is no more than 40% of total disk and 20% of currently free disk.",
      noProfileFits: "No profile fits",
      recommendationCap: "Recommendation cap",
      freeSpace: "Free space",
      libraryPath: "Library path",
      setLibrary: "Set Library",
      stopKiwix: "Stop Kiwix",
      startKiwix: "Start Kiwix",
      cleanSources: "Clean Sources",
      dashboard: "Dashboard",
      downloads: "Downloads",
      search: "Search",
      extraKnowledge: "Extra Knowledge",
      localAi: "Local AI",
      share: "Share",
      settings: "Settings",
      appSections: "Application sections",
      working: "Working: {busy}",
      easyInstallIntro: "Select one or more profiles. Easy Install downloads them, prepares/extracts downloaded sources, indexes searchable content, and can install recommended Local AI.",
      preparedDisk: "prepared disk",
      download: "download",
      sources: "sources",
      installRecommendedAi: "Install recommended Local AI",
      installRecommendedAiHelp: "Installs Ollama and every model recommended for this PC.",
      profilesSelected: "{count} profiles selected",
      preparedDiskEstimate: "{size} prepared disk estimate",
      compressedDownload: "{size} compressed download",
      localAiIncluded: "Local AI included",
      localAiSkipped: "Local AI skipped",
      installing: "Installing",
      startEasyInstall: "Start Easy Install",
      localAiSetup: "Local AI setup",
      profiles: "Profiles",
      filterProfileSources: "Filter profile sources",
      profilesHelp: "Profiles are ordered from smallest to largest. Each card shows only the sources that profile adds beyond the profile before it; downloading a profile still downloads everything needed for that full tier.",
      catalogSources: "catalog sources",
      indexedDocuments: "indexed documents",
      uniqueBlobs: "unique blobs",
      servicesRunning: "services running",
      cpuThreads: "CPU threads",
      aiNone: "none",
      loadingProfiles: "Loading Profiles",
      loadingProfilesHelp: "Reading the local catalog and library state.",
      profilesCouldNotLoad: "Profiles Could Not Load",
      backendNotResponding: "The local backend is not responding, so the dashboard cannot show the profile catalog yet.",
      retryLoadingProfiles: "Retry Loading Profiles",
      noProfilesFound: "No Profiles Found",
      noProfilesFoundHelp: "The source catalog loaded, but it did not contain any configured profiles.",
      downloadFullProfile: "Download Full Profile",
      profileDownloaded: "Profile Downloaded",
      addonSourcesShown: "{count} add-on sources shown",
      preparedAddonDisk: "{size} prepared add-on disk",
      totalSourcesFullProfile: "{count} total sources in full profile",
      preparedFullProfile: "{size} prepared full profile",
      fullProfileProgress: "Full profile progress",
      progressSummary: "{done} complete · {active} active or queued · {failed} paused or failed · up to 4 downloads run in parallel",
      addonSource: "Add-on source",
      type: "Type",
      preparedDiskColumn: "Prepared disk",
      status: "Status",
      actions: "Actions",
      notDownloaded: "not downloaded",
      verify: "Verify",
      open: "Open",
      pause: "Pause",
      retry: "Retry",
      noActionNeeded: "No action needed",
      source: "Source",
      progress: "Progress",
      total: "Total",
      checkFiles: "Check Files",
      checkFilesHelp: "Compare the database with files on disk and mark missing or repaired downloads.",
      removePartialFiles: "Remove Partial Files",
      removePartialFilesHelp: "Delete unfinished .part files left by paused or interrupted downloads.",
      recoveryScan: "Recovery scan",
      chooseFolder: "Choose Folder",
      scanFolder: "Scan Folder",
      indexImported: "Index Imported",
      searchIndexed: "Search indexed practical content",
      allSearchable: "All searchable resources",
      allLicenses: "All licenses",
      semantic: "Semantic",
      searching: "Searching...",
      semanticSearching: "Semantic search...",
      searchInProgress: "Searching indexed resources.",
      searchTooltip: "Keyword search: finds exact words in the local text index and uses the selected resource/license filters.",
      semanticSearchTooltip: "Semantic search: finds passages by meaning across indexed resources, even when the exact words differ.",
      recommendedLocalAiSetup: "Recommended Local AI Setup",
      installAllRecommended: "Install All Recommended",
      installingAllRecommended: "Installing All Recommended",
      aiService: "AI Service",
      refresh: "Refresh",
      models: "Models",
      chatModel: "Chat model",
      refreshModels: "Refresh Models",
      askOllama: "Ask Ollama",
      askingOllama: "Asking Ollama...",
      askInProgress: "Local AI is preparing an answer.",
      askStartingOllama: "Starting Ollama and loading the selected model. The first answer can take longer.",
      askBlockedHelp: "Local AI is blocked by the RAM safety guard. Free memory or install a smaller chat model, then try again.",
      restartConversation: "Restart Conversation",
      askGeneratedTokens: "Generated tokens: {count}",
      sharePackage: "Generate Share Package",
      generatingSharePackage: "Generating Share Package",
      logs: "Logs",
      refreshLogs: "Refresh Logs",
      title: "Title",
      description: "Description",
      date: "Date",
      details: "Details",
      destructiveAction: "Destructive action",
      confirmation: "Confirmation",
      cancel: "Cancel",
      continue: "Continue",
      index: "Index",
      reindex: "Re-index",
      openButton: "Open",
      installed: "Installed",
      pull: "Pull",
      pullRecommended: "Pull Recommended",
      pullRecommendedChatModel: "Pull Recommended Chat Model",
      pullRecommendedEmbedding: "Pull Recommended Embedding",
      indexingAction: "Indexing...",
      reindexingAction: "Re-indexing...",
      indexingLargeFiles: "Indexing... this may take several minutes for large files.",
      indexingSourceProgress: "{status} · {done}/{total} sources",
      downloadedTotalUnknown: "{size} downloaded · total unknown",
      repairedMissingPartials: "{repaired} repaired · {missing} missing · {partials} partials",
      noAddonSourcesMatch: "No add-on sources match the current filter.",
      extraKnowledgeHelp: "Add local PDFs, EPUBs, text/Markdown/HTML/CSV/JSON files, and ZIM files from another folder.",
      supportedFiles: "{count} supported files",
      selectedFolderData: "{size} selected folder data",
      unsupportedSkipped: "{count} unsupported skipped",
      filesFound: "Files Found",
      selectedImportHelp: "{count} selected · imported files are copied into the app library before indexing.",
      selectAll: "Select All",
      clear: "Clear",
      indexAfterImport: "Index after import",
      importSelected: "Import Selected",
      noSupportedFiles: "No supported files found in this folder.",
      importedFiles: "Imported {count} files",
      indexedOrRegistered: "{count} indexed or registered for search/local AI context.",
      importedLocalSources: "Imported Local Sources",
      importedLocalSourcesHelp: "These local files are now part of the app library.",
      importedLocalSourcesEmpty: "No extra local files imported yet.",
      indexAllDownloadedTooltip: "Index all downloaded sources that are not indexed yet. This uses built-in text extraction and does not require an embedding model.",
      reindexAllDownloadedTooltip: "Rebuild the search and Local AI text index for every downloaded source.",
      indexDownloadedCount: "Index {count} Downloaded",
      allDownloadedIndexed: "All Downloaded Indexed",
      reindexAllDownloaded: "Re-Index All",
      searchableResources: "Searchable Resources",
      searchableResourcesReady: "Indexed sources that can be searched now.",
      searchableResourcesEmpty: "No indexed resources yet. Open or index downloaded sources first.",
      all: "All",
      downloadingNow: "Downloading Now",
      downloadingNowHelp: "These resources are still queued, downloading, or resuming. They cannot be opened or indexed until the download completes.",
      noActiveDownloads: "No active downloads.",
      downloadedNeedsIndex: "Downloaded Files Needing Open or Index",
      downloadedNeedsIndexHelp: "These files are actually present on disk. Open prepares them for reading; Index adds prepared text to local search and Local AI context.",
      openThenIndex: "Open this source to extract the configured content, then index it.",
      indexBeforeSearch: "Index this source before it can be searched.",
      noDownloadedNeedsIndex: "No fully downloaded files are waiting for Open or Index.",
      openSearchResultTitle: "Open this result in the matched local resource",
      clickToOpenMatch: "click to open match",
      localAiInstallHelp: "Installs the app-managed Ollama runtime if needed, starts it locally, and downloads every model recommended for this PC.",
      machineTierUnknown: "machine tier unknown",
      localAiSetupInProgress: "Local AI setup is in progress.",
      localAiBlockedByRam: "Local AI is blocked by the RAM safety guard.",
      localAiRuntimeMissingHelp: "Use Install Recommended below to download and start the app-managed Ollama runtime.",
      startupGuard: "Startup guard: {available} available RAM / {required} required for {model}.",
      swapTooFull: "Swap is too full for a safe Local AI start.",
      installChatModelFirst: "Install a chat model before starting Local AI.",
      startOllama: "Start Ollama",
      stop: "Stop",
      noRunningServiceToStop: "No running service to stop.",
      recommendedAiInstalled: "Recommended Local AI setup installed",
      complete: "complete",
      recommendedChatBadge: "Recommended chat model for this PC",
      recommendedEmbeddingBadge: "Recommended embedding model",
      recommendedChatForTier: "Recommended chat model for {tier}.",
      recommendedEmbeddingHelp: "Recommended embedding model for search and Local AI context.",
      engine: "Engine",
      indexedResourcesAvailable: "{count} indexed resources available",
      textIndexHelp: "The text index makes downloaded sources searchable without an embedding model. The embedding model is used after indexing for semantic matching: finding relevant passages by meaning for Local AI answers and semantic search, even when the exact words differ.",
      allIndexedResources: "All indexed resources",
      askPlaceholder: "Ask against indexed local documents",
      shareHelp: "Share creates one compressed package with the selected downloaded sources, search data, and available app files for Windows, macOS, and Linux.",
      generatePackageTitle: "Generate app + sources package",
      generatePackageHelp: "The package includes app files from the extracted all-platforms release folder, downloaded files, prepared/opened files, and search indexes for the selected source set. Unrelated local content is left out.",
      sourcesToShare: "Sources to share",
      primaryOperatingSystem: "Primary operating system",
      primaryLauncherLinux: "Primary launcher: Linux",
      primaryLauncherWindows: "Primary launcher: Windows",
      primaryLauncherMacos: "Primary launcher: macOS",
      appBundleFolder: "App Bundle Folder",
      appBundleFolderValue: "App bundle folder: {path}",
      appBundleFolderHelp: "Optional: choose the extracted Offline-Survival-all-platforms folder before generating a mixed-OS package.",
      sharePackageProgressTitle: "Share package",
      shareProgressSources: "{current} / {total} sources · {percent}%",
      noDownloadedSourcesReady: "No downloaded sources ready to share",
      noDownloadedSourcesReadyHelp: "Download sources first. Share packages can only include sources already present on disk.",
      sharePackageReady: "Share package ready",
      profile: "Profile",
      archive: "Archive",
      folder: "Folder",
      size: "Size",
      checksum: "Checksum",
      checksumFile: "Checksum file",
      primaryLauncher: "Primary launcher",
      includedAppFolders: "Included app folders",
      updateChannels: "Update channels",
      appUpdate: "App",
      manifestsUpdate: "Manifests",
      contentUpdate: "Content",
      openServicesUpdate: "Open services",
      modelsUpdate: "Models",
      networkPolicy: "Network policy",
      networkPolicyHelp: "Local services bind to 127.0.0.1. LAN sharing remains disabled in this v1 build.",
      recommendedBadge: "Recommended",
      loadBackendError: "Could not load the local app backend: {error}",
      verificationPassed: "Verification passed",
      verificationFailed: "Verification failed",
      indexSourceTitle: "Index {title}",
      reindexSourceTitle: "Re-index {title}",
      indexRebuildBody: "The app will remove the current searchable index for this source, rebuild it from the downloaded file, and keep it available for Search and Local AI context. It will not download anything new.",
      indexNewBody: "The app will read this downloaded source and add searchable text to the local index. It will not open the file and it will not download anything new.",
      indexRemoveRowsStep: "Remove the existing searchable rows and generated index files for this source.",
      indexReadStep: "Read the downloaded file from the local library.",
      indexExtractStep: "Extract searchable text using the configured source reader.",
      indexStoreStep: "Store the text in the local search database for Search and Local AI context.",
      downloadedFileSize: "Downloaded file size",
      indexLocation: "Index location",
      localAppDatabase: "Local app database",
      embeddingModelRequired: "Embedding model required",
      embeddingNotRequired: "No. Embeddings are for semantic matching and Local AI retrieval quality after text is indexed.",
      reindexSource: "Re-index Source",
      indexSource: "Index Source",
      indexOriginalOnlyError: "Could not build a full-text index for this source. It is registered for basic search only. {note}",
      indexAllDownloadedTitle: "Index {count} Downloaded",
      indexAllDownloadedBody: "The app will index every downloaded source that is not searchable yet. This makes them appear in Search and gives Local AI local context.",
      reindexAllDownloadedTitle: "Re-Index All Downloaded",
      reindexAllDownloadedBody: "The app will rebuild the searchable index for every downloaded source. It will not download anything new.",
      indexFindDownloadedStep: "Find downloaded sources that are not indexed yet.",
      reindexFindDownloadedStep: "Find every downloaded source.",
      indexResultsStep: "Store the results in the local search database.",
      sourcesToIndex: "Sources to index",
      downloadedDataToScan: "Downloaded data to scan",
      indexDownloadedSources: "Index Downloaded Sources",
      openSourceTitle: "Open {title}",
      openSourceBody: "The app will prepare this source and then open the useful reader or file, not the raw downloaded archive.",
      finalTarget: "Final target",
      extraDiskNeededNow: "Extra disk needed now",
      preparedSizeAfterOpen: "Prepared on-disk size after open",
      openSource: "Open Source",
      cleanSourcesBody: "This deletes downloaded sources, extracted/opened files, indexes, models, managed AI runtimes, partial downloads, and logs.",
      catalog: "Catalog",
      kept: "Kept",
      libraryPayloads: "Library payloads",
      deleted: "Deleted",
      cleanEverything: "Clean Everything",
      maintenanceCheckComplete: "Check complete: {repaired} repaired, {missing} missing, {partials} partials",
      maintenanceCheckFailed: "Check failed",
      embeddingReason: "Use this for semantic search and Local AI retrieval over indexed files.",
      browseOnlyReason: "This is the smallest chat model in the catalog for this machine.",
      survivalAiReason: "Best fit for this PC without needing a large workstation.",
      coreAiReason: "Balanced local chat model for your available RAM.",
      workstationReason: "Strong local chat model for this workstation tier.",
      calculatingRecommendedModels: "Calculating recommended models automatically.",
      etaLeft: "about {duration} left",
      modelProgress: "{current} / {total} for this model · {percent}% overall",
      overallProgress: "{current} / {total} overall",
      totalSizeUnknown: "total size unknown",
      completeCount: "complete",
      activeCount: "{count} active",
      indexingNow: "Indexing Now",
      indexingNowHelp: "Sources currently being prepared for Search and Local AI context.",
      indexingCurrent: "Indexing now",
      indexingQueued: "Queued",
      indexingCompleted: "Indexed",
      indexingRegistered: "Registered for basic search",
      indexingFailed: "Index failed",
      indexProgressSummary: "{done}/{total} indexed · {failed} failed",
      chunksIndexed: "{count} chunks",
      pagesIndexed: "{count} pages",
      easyDownloadLine: "Downloading profile sources with up to 4 parallel downloads",
      easyPrepareLine: "Extracting archives and preparing downloaded files for offline use.",
      easyIndexLine: "Building local search and Local AI context indexes.",
      easyAiLine: "Installing Ollama and recommended models; see the Local AI progress panel for model download details.",
      easyInstallProgressTitle: "Easy Install",
      allDownloadedSources: "All Downloaded Sources",
      downloadProfileTooltip: "Download every source needed for {title}. Already downloaded sources are skipped, and up to 4 downloads run in parallel.",
      downloadTooltip: "Download {title} into the local library so it can later be verified, opened, indexed, searched, and used by Local AI.",
      verifyTooltip: "Verify {title} by checking the downloaded file on disk against its recorded size and checksum when one is available. This does not download new data.",
      indexTooltip: "{verb} {title} by extracting searchable text into the local search database and Local AI retrieval context. This does not open the file for reading or download anything new.",
      openZimTooltip: "Open {title} in the local Kiwix reader. This starts or reuses the localhost Kiwix server for downloaded ZIM files.",
      openExtractServeTooltip: "Open {title} by extracting the configured content, serving it on localhost, and opening it in the browser.",
      openExtractOpenTooltip: "Open {title} by extracting the archive and launching the configured file with the system viewer.",
      openDirectTooltip: "Open {title} with the system default application for the downloaded file.",
      thisPc: "this PC"
    },
    es: {
      appLanguage: "Idioma de la app",
      english: "Inglés",
      spanish: "Español",
      bilingual: "Bilingüe",
      contentLanguage: "Idioma del contenido",
      aiRecommendations: "IA",
      englishProfile: "Perfil en inglés",
      spanishProfile: "Perfil en español",
      bilingualProfile: "Perfil bilingüe",
      baseProfile: "Perfil base",
      addsTo: "Añade a {title}",
      easyInstall: "Instalación fácil",
      downloaded: "Descargado",
      recommendedSetup: "Configuración recomendada",
      recommendationExplain: "Perfil mayor dentro del 40% del disco / 20% libre",
      recommendationTitle: "La configuración recomendada es el perfil mayor cuya estimación preparada no supera el 40% del disco total ni el 20% del espacio libre actual.",
      noProfileFits: "Ningún perfil encaja",
      recommendationCap: "Límite recomendado",
      freeSpace: "Espacio libre",
      libraryPath: "Ruta de biblioteca",
      setLibrary: "Guardar biblioteca",
      stopKiwix: "Parar Kiwix",
      startKiwix: "Iniciar Kiwix",
      cleanSources: "Limpiar fuentes",
      dashboard: "Panel",
      downloads: "Descargas",
      search: "Buscar",
      extraKnowledge: "Conocimiento extra",
      localAi: "IA local",
      share: "Compartir",
      settings: "Ajustes",
      appSections: "Secciones de la aplicación",
      working: "Trabajando: {busy}",
      easyInstallIntro: "Selecciona uno o más perfiles. La instalación fácil los descarga, prepara o extrae las fuentes descargadas, indexa el contenido buscable y puede instalar la IA local recomendada.",
      preparedDisk: "disco preparado",
      download: "descarga",
      sources: "fuentes",
      installRecommendedAi: "Instalar IA local recomendada",
      installRecommendedAiHelp: "Instala Ollama y todos los modelos recomendados para este PC.",
      profilesSelected: "{count} perfiles seleccionados",
      preparedDiskEstimate: "{size} estimados preparados",
      compressedDownload: "{size} de descarga comprimida",
      localAiIncluded: "IA local incluida",
      localAiSkipped: "IA local omitida",
      installing: "Instalando",
      startEasyInstall: "Iniciar instalación fácil",
      localAiSetup: "Configuración de IA local",
      profiles: "Perfiles",
      filterProfileSources: "Filtrar fuentes del perfil",
      profilesHelp: "Los perfiles están ordenados de menor a mayor. Cada tarjeta muestra solo las fuentes que ese perfil añade respecto al perfil anterior; descargar un perfil sigue descargando todo lo necesario para ese nivel completo.",
      catalogSources: "fuentes del catálogo",
      indexedDocuments: "documentos indexados",
      uniqueBlobs: "bloques únicos",
      servicesRunning: "servicios activos",
      cpuThreads: "hilos de CPU",
      aiNone: "ninguna",
      loadingProfiles: "Cargando perfiles",
      loadingProfilesHelp: "Leyendo el catálogo local y el estado de la biblioteca.",
      profilesCouldNotLoad: "No se pudieron cargar los perfiles",
      backendNotResponding: "El backend local no responde, así que el panel aún no puede mostrar el catálogo de perfiles.",
      retryLoadingProfiles: "Reintentar carga",
      noProfilesFound: "No se encontraron perfiles",
      noProfilesFoundHelp: "El catálogo de fuentes cargó, pero no contiene perfiles configurados.",
      downloadFullProfile: "Descargar perfil completo",
      profileDownloaded: "Perfil descargado",
      addonSourcesShown: "{count} fuentes añadidas mostradas",
      preparedAddonDisk: "{size} de disco añadido preparado",
      totalSourcesFullProfile: "{count} fuentes totales en el perfil",
      preparedFullProfile: "{size} perfil preparado",
      fullProfileProgress: "Progreso del perfil completo",
      progressSummary: "{done} completas · {active} activas o en cola · {failed} pausadas o fallidas · hasta 4 descargas en paralelo",
      addonSource: "Fuente añadida",
      type: "Tipo",
      preparedDiskColumn: "Disco preparado",
      status: "Estado",
      actions: "Acciones",
      notDownloaded: "no descargado",
      verify: "Verificar",
      open: "Abrir",
      pause: "Pausar",
      retry: "Reintentar",
      noActionNeeded: "Sin acción necesaria",
      source: "Fuente",
      progress: "Progreso",
      total: "Total",
      checkFiles: "Comprobar archivos",
      checkFilesHelp: "Compara la base de datos con los archivos del disco y marca descargas perdidas o reparadas.",
      removePartialFiles: "Eliminar parciales",
      removePartialFilesHelp: "Borra archivos .part inacabados de descargas pausadas o interrumpidas.",
      recoveryScan: "Escaneo de recuperación",
      chooseFolder: "Elegir carpeta",
      scanFolder: "Escanear carpeta",
      indexImported: "Indexar importados",
      searchIndexed: "Buscar contenido práctico indexado",
      allSearchable: "Todos los recursos buscables",
      allLicenses: "Todas las licencias",
      semantic: "Semántica",
      searching: "Buscando...",
      semanticSearching: "Búsqueda semántica...",
      searchInProgress: "Buscando en recursos indexados.",
      searchTooltip: "Búsqueda por palabras clave: encuentra palabras exactas en el índice local y usa los filtros de recurso/licencia seleccionados.",
      semanticSearchTooltip: "Búsqueda semántica: encuentra pasajes por significado en los recursos indexados, aunque las palabras exactas sean distintas.",
      recommendedLocalAiSetup: "Configuración de IA local recomendada",
      installAllRecommended: "Instalar todo lo recomendado",
      installingAllRecommended: "Instalando lo recomendado",
      aiService: "Servicio de IA",
      refresh: "Actualizar",
      models: "Modelos",
      chatModel: "Modelo de chat",
      refreshModels: "Actualizar modelos",
      askOllama: "Preguntar a Ollama",
      askingOllama: "Preguntando a Ollama...",
      askInProgress: "La IA local está preparando una respuesta.",
      askStartingOllama: "Iniciando Ollama y cargando el modelo seleccionado. La primera respuesta puede tardar más.",
      askBlockedHelp: "La IA local está bloqueada por la protección de RAM. Libera memoria o instala un modelo de chat más pequeño y prueba de nuevo.",
      restartConversation: "Reiniciar conversación",
      askGeneratedTokens: "Tokens generados: {count}",
      sharePackage: "Generar paquete",
      generatingSharePackage: "Generando paquete",
      logs: "Registros",
      refreshLogs: "Actualizar registros",
      title: "Título",
      description: "Descripción",
      date: "Fecha",
      details: "Detalles",
      destructiveAction: "Acción destructiva",
      confirmation: "Confirmación",
      cancel: "Cancelar",
      continue: "Continuar",
      index: "Indexar",
      reindex: "Reindexar",
      openButton: "Abrir",
      installed: "Instalado",
      pull: "Descargar",
      pullRecommended: "Descargar recomendado",
      pullRecommendedChatModel: "Descargar modelo de chat recomendado",
      pullRecommendedEmbedding: "Descargar embeddings recomendados",
      indexingAction: "Indexando...",
      reindexingAction: "Reindexando...",
      indexingLargeFiles: "Indexando... puede tardar varios minutos en archivos grandes.",
      indexingSourceProgress: "{status} · {done}/{total} fuentes",
      downloadedTotalUnknown: "{size} descargados · total desconocido",
      repairedMissingPartials: "{repaired} reparados · {missing} perdidos · {partials} parciales",
      noAddonSourcesMatch: "Ninguna fuente añadida coincide con el filtro actual.",
      extraKnowledgeHelp: "Añade PDFs, EPUBs, texto/Markdown/HTML/CSV/JSON y archivos ZIM locales desde otra carpeta.",
      supportedFiles: "{count} archivos compatibles",
      selectedFolderData: "{size} de datos en la carpeta seleccionada",
      unsupportedSkipped: "{count} no compatibles omitidos",
      filesFound: "Archivos encontrados",
      selectedImportHelp: "{count} seleccionados · los archivos importados se copian a la biblioteca antes de indexarlos.",
      selectAll: "Seleccionar todo",
      clear: "Limpiar",
      indexAfterImport: "Indexar tras importar",
      importSelected: "Importar seleccionados",
      noSupportedFiles: "No se encontraron archivos compatibles en esta carpeta.",
      importedFiles: "{count} archivos importados",
      indexedOrRegistered: "{count} indexados o registrados para búsqueda/contexto de IA local.",
      importedLocalSources: "Fuentes locales importadas",
      importedLocalSourcesHelp: "Estos archivos locales ya forman parte de la biblioteca.",
      importedLocalSourcesEmpty: "Aún no hay archivos locales importados.",
      indexAllDownloadedTooltip: "Indexa todas las fuentes descargadas que aún no están indexadas. Usa extracción de texto integrada y no requiere un modelo de embeddings.",
      reindexAllDownloadedTooltip: "Reconstruye el índice de búsqueda e IA local de todas las fuentes descargadas.",
      indexDownloadedCount: "Indexar {count} descargados",
      allDownloadedIndexed: "Todos los descargados indexados",
      reindexAllDownloaded: "Reindexar todo",
      searchableResources: "Recursos buscables",
      searchableResourcesReady: "Fuentes indexadas que ya se pueden buscar.",
      searchableResourcesEmpty: "Aún no hay recursos indexados. Abre o indexa fuentes descargadas primero.",
      all: "Todos",
      downloadingNow: "Descargando ahora",
      downloadingNowHelp: "Estos recursos siguen en cola, descargándose o reanudándose. No pueden abrirse ni indexarse hasta que termine la descarga.",
      noActiveDownloads: "No hay descargas activas.",
      downloadedNeedsIndex: "Archivos descargados pendientes de abrir o indexar",
      downloadedNeedsIndexHelp: "Estos archivos existen en disco. Abrir los prepara para lectura; Indexar añade texto preparado a la búsqueda local y al contexto de IA local.",
      openThenIndex: "Abre esta fuente para extraer el contenido configurado y luego indéxala.",
      indexBeforeSearch: "Indexa esta fuente antes de poder buscarla.",
      noDownloadedNeedsIndex: "No hay archivos completamente descargados esperando apertura o indexación.",
      openSearchResultTitle: "Abrir este resultado en el recurso local coincidente",
      clickToOpenMatch: "clic para abrir coincidencia",
      localAiInstallHelp: "Instala el runtime Ollama gestionado por la app si hace falta, lo inicia localmente y descarga todos los modelos recomendados para este PC.",
      machineTierUnknown: "nivel de máquina desconocido",
      localAiSetupInProgress: "La configuración de IA local está en progreso.",
      localAiBlockedByRam: "La IA local está bloqueada por la protección de RAM.",
      localAiRuntimeMissingHelp: "Usa Instalar todo lo recomendado para descargar e iniciar el runtime Ollama gestionado por la app.",
      startupGuard: "Protección de arranque: {available} RAM disponible / {required} requerida para {model}.",
      swapTooFull: "La swap está demasiado llena para iniciar IA local con seguridad.",
      installChatModelFirst: "Instala un modelo de chat antes de iniciar IA local.",
      startOllama: "Iniciar Ollama",
      stop: "Parar",
      noRunningServiceToStop: "No hay servicio activo que parar.",
      recommendedAiInstalled: "Configuración de IA local recomendada instalada",
      complete: "completo",
      recommendedChatBadge: "Modelo de chat recomendado para este PC",
      recommendedEmbeddingBadge: "Modelo de embeddings recomendado",
      recommendedChatForTier: "Modelo de chat recomendado para {tier}.",
      recommendedEmbeddingHelp: "Modelo de embeddings recomendado para búsqueda y contexto de IA local.",
      engine: "Motor",
      indexedResourcesAvailable: "{count} recursos indexados disponibles",
      textIndexHelp: "El índice de texto permite buscar fuentes descargadas sin modelo de embeddings. El modelo de embeddings se usa después de indexar para coincidencia semántica: encontrar pasajes relevantes por significado para respuestas de IA local y búsqueda semántica, incluso cuando las palabras exactas difieren.",
      allIndexedResources: "Todos los recursos indexados",
      askPlaceholder: "Pregunta contra documentos locales indexados",
      shareHelp: "Compartir crea un paquete comprimido con las fuentes descargadas seleccionadas, datos de búsqueda y archivos de app disponibles para Windows, macOS y Linux.",
      generatePackageTitle: "Generar paquete app + fuentes",
      generatePackageHelp: "El paquete incluye archivos de app de la carpeta extraída de todas las plataformas, archivos descargados, archivos preparados/abiertos e índices de búsqueda del conjunto seleccionado. El contenido local no relacionado queda fuera.",
      sourcesToShare: "Fuentes para compartir",
      primaryOperatingSystem: "Sistema operativo principal",
      primaryLauncherLinux: "Lanzador principal: Linux",
      primaryLauncherWindows: "Lanzador principal: Windows",
      primaryLauncherMacos: "Lanzador principal: macOS",
      appBundleFolder: "Carpeta del paquete de app",
      appBundleFolderValue: "Carpeta del paquete de app: {path}",
      appBundleFolderHelp: "Opcional: elige la carpeta Offline-Survival-all-platforms extraída antes de generar un paquete mixto para varios sistemas.",
      sharePackageProgressTitle: "Paquete compartido",
      shareProgressSources: "{current} / {total} fuentes · {percent}%",
      noDownloadedSourcesReady: "No hay fuentes descargadas listas para compartir",
      noDownloadedSourcesReadyHelp: "Descarga fuentes primero. Los paquetes compartidos solo pueden incluir fuentes ya presentes en disco.",
      sharePackageReady: "Paquete compartido listo",
      profile: "Perfil",
      archive: "Archivo",
      folder: "Carpeta",
      size: "Tamaño",
      checksum: "Checksum",
      checksumFile: "Archivo checksum",
      primaryLauncher: "Lanzador principal",
      includedAppFolders: "Carpetas de app incluidas",
      updateChannels: "Canales de actualización",
      appUpdate: "App",
      manifestsUpdate: "Manifiestos",
      contentUpdate: "Contenido",
      openServicesUpdate: "Servicios abiertos",
      modelsUpdate: "Modelos",
      networkPolicy: "Política de red",
      networkPolicyHelp: "Los servicios locales se enlazan a 127.0.0.1. Compartir por LAN sigue desactivado en esta versión v1.",
      recommendedBadge: "Recomendado",
      loadBackendError: "No se pudo cargar el backend local de la app: {error}",
      verificationPassed: "Verificación correcta",
      verificationFailed: "Verificación fallida",
      indexSourceTitle: "Indexar {title}",
      reindexSourceTitle: "Reindexar {title}",
      indexRebuildBody: "La app eliminará el índice buscable actual de esta fuente, lo reconstruirá desde el archivo descargado y lo mantendrá disponible para Búsqueda y contexto de IA local. No descargará nada nuevo.",
      indexNewBody: "La app leerá esta fuente descargada y añadirá texto buscable al índice local. No abrirá el archivo ni descargará nada nuevo.",
      indexRemoveRowsStep: "Eliminar filas buscables existentes y archivos de índice generados para esta fuente.",
      indexReadStep: "Leer el archivo descargado desde la biblioteca local.",
      indexExtractStep: "Extraer texto buscable con el lector configurado para la fuente.",
      indexStoreStep: "Guardar el texto en la base de datos de búsqueda local para Búsqueda y contexto de IA local.",
      downloadedFileSize: "Tamaño del archivo descargado",
      indexLocation: "Ubicación del índice",
      localAppDatabase: "Base de datos local de la app",
      embeddingModelRequired: "Modelo de embeddings requerido",
      embeddingNotRequired: "No. Los embeddings son para coincidencia semántica y mejor calidad de recuperación de IA local después de indexar el texto.",
      reindexSource: "Reindexar fuente",
      indexSource: "Indexar fuente",
      indexOriginalOnlyError: "No se pudo crear un índice de texto completo para esta fuente. Queda registrada para búsqueda básica. {note}",
      indexAllDownloadedTitle: "Indexar {count} descargados",
      indexAllDownloadedBody: "La app indexará cada fuente descargada que aún no sea buscable. Así aparece en Búsqueda y da contexto a la IA local.",
      reindexAllDownloadedTitle: "Reindexar todo lo descargado",
      reindexAllDownloadedBody: "La app reconstruirá el índice buscable de cada fuente descargada. No descargará nada nuevo.",
      indexFindDownloadedStep: "Encontrar fuentes descargadas que aún no están indexadas.",
      reindexFindDownloadedStep: "Encontrar todas las fuentes descargadas.",
      indexResultsStep: "Guardar los resultados en la base de datos de búsqueda local.",
      sourcesToIndex: "Fuentes a indexar",
      downloadedDataToScan: "Datos descargados a escanear",
      indexDownloadedSources: "Indexar fuentes descargadas",
      openSourceTitle: "Abrir {title}",
      openSourceBody: "La app preparará esta fuente y luego abrirá el lector o archivo útil, no el archivo bruto descargado.",
      finalTarget: "Destino final",
      extraDiskNeededNow: "Disco extra necesario ahora",
      preparedSizeAfterOpen: "Tamaño preparado en disco tras abrir",
      openSource: "Abrir fuente",
      cleanSourcesBody: "Esto elimina fuentes descargadas, archivos extraídos/abiertos, índices, modelos, runtimes de IA gestionados, descargas parciales y registros.",
      catalog: "Catálogo",
      kept: "Conservado",
      libraryPayloads: "Datos de biblioteca",
      deleted: "Eliminado",
      cleanEverything: "Limpiar todo",
      maintenanceCheckComplete: "Comprobación completa: {repaired} reparados, {missing} perdidos, {partials} parciales",
      maintenanceCheckFailed: "Comprobación fallida",
      embeddingReason: "Usa esto para búsqueda semántica y recuperación de IA local sobre archivos indexados.",
      browseOnlyReason: "Este es el modelo de chat más pequeño del catálogo para esta máquina.",
      survivalAiReason: "Mejor ajuste para este PC sin necesitar una workstation grande.",
      coreAiReason: "Modelo de chat local equilibrado para tu RAM disponible.",
      workstationReason: "Modelo de chat local potente para este nivel de workstation.",
      calculatingRecommendedModels: "Calculando modelos recomendados automáticamente.",
      etaLeft: "quedan aprox. {duration}",
      modelProgress: "{current} / {total} para este modelo · {percent}% total",
      overallProgress: "{current} / {total} total",
      totalSizeUnknown: "tamaño total desconocido",
      completeCount: "completas",
      activeCount: "{count} activas",
      indexingNow: "Indexando ahora",
      indexingNowHelp: "Fuentes que se están preparando para Búsqueda y contexto de IA local.",
      indexingCurrent: "Indexando ahora",
      indexingQueued: "En cola",
      indexingCompleted: "Indexada",
      indexingRegistered: "Registrada para búsqueda básica",
      indexingFailed: "Falló el índice",
      indexProgressSummary: "{done}/{total} indexadas · {failed} fallidas",
      chunksIndexed: "{count} fragmentos",
      pagesIndexed: "{count} páginas",
      easyDownloadLine: "Descargando fuentes del perfil con hasta 4 descargas paralelas",
      easyPrepareLine: "Extrayendo archivos y preparando descargas para uso offline.",
      easyIndexLine: "Creando índices de búsqueda local y contexto de IA local.",
      easyAiLine: "Instalando Ollama y modelos recomendados; mira el panel de IA local para detalles.",
      easyInstallProgressTitle: "Instalación fácil",
      allDownloadedSources: "Todas las fuentes descargadas",
      downloadProfileTooltip: "Descarga todas las fuentes necesarias para {title}. Las ya descargadas se omiten y hasta 4 descargas se ejecutan en paralelo.",
      downloadTooltip: "Descarga {title} en la biblioteca local para poder verificarlo, abrirlo, indexarlo, buscarlo y usarlo con IA local.",
      verifyTooltip: "Verifica {title} comprobando el archivo descargado en disco contra su tamaño y checksum registrados cuando existan. No descarga datos nuevos.",
      indexTooltip: "{verb} {title} extrayendo texto buscable a la base de datos de búsqueda local y al contexto de IA local. No abre el archivo ni descarga nada nuevo.",
      openZimTooltip: "Abre {title} en el lector Kiwix local. Inicia o reutiliza el servidor Kiwix localhost para archivos ZIM descargados.",
      openExtractServeTooltip: "Abre {title} extrayendo el contenido configurado, sirviéndolo en localhost y abriéndolo en el navegador.",
      openExtractOpenTooltip: "Abre {title} extrayendo el archivo y lanzando el archivo configurado con el visor del sistema.",
      openDirectTooltip: "Abre {title} con la aplicación predeterminada del sistema para el archivo descargado.",
      thisPc: "este PC"
    }
  };


  const catalogText: Record<string, any> = {
    es: {
      profiles: {
        "survival-essential": {
          title: "Supervivencia esencial",
          description: "Archivo pequeño de emergencia para discos limitados. Incluye SurvivalManual, el ebook imprimible de SurvivalManual, Wikipedia en inglés simple para referencia básica y Basic Emergency Care de la OMS. Recomendado para agua, refugio, comida, primeros auxilios, saneamiento y búsqueda offline sin necesitar IA."
        },
        "survival-plus": {
          title: "Supervivencia ampliada",
          description: "Archivo para portátil o USB-SSD que amplía Supervivencia esencial con referencias más amplias de Wikipedia, Wikipedia Medicine, conocimiento de reparación de iFixit, biología, viajes/geografía, agricultura, jardinería, cocina, seguridad alimentaria y modelos de IA local recomendados para preguntas basadas en fuentes."
        },
        "civilization-core": {
          title: "Civilización básica",
          description: "Perfil de estación comunitaria de conocimiento para un SSD de clase 512 GB. Añade Wikibooks, Wiktionary, salud pública de CDC, Appropedia, Open Source Ecology, OpenStreetMap, energía, reparación, electrónica, microcontroladores, ingeniería, impresión 3D, carpintería, construcción y mantenimiento de bicicletas para reconstrucción práctica."
        },
        "civilization-rebuild": {
          title: "Reconstrucción civilizatoria",
          description: "Archivo de escala estación de trabajo para una unidad de clase 1 TB. Añade Wikisource, ciencia básica de LibreTexts y un conjunto inicial de Project Gutenberg para educación, ingeniería, ciencia, medicina, agricultura, tecnología apropiada, gobernanza y continuidad cultural."
        },
        "civilization-max": {
          title: "Civilización máxima",
          description: "Perfil de preservación profunda para discos grandes. Añade cobertura de Wikipedia con imágenes y mayor cobertura de Project Gutenberg sobre Reconstrucción civilizatoria, priorizando amplitud, réplica a largo plazo, continuidad cultural y archivado en unidades grandes."
        },
        "survival-essential-es": {
          title: "Supervivencia esencial ES",
          description: "Archivo pequeño de emergencia en español para discos limitados. Incluye cobertura enciclopédica fácil de leer en español, material de atención de emergencia de la OMS en español, formación CERT ante desastres en español y guía de CDC para preparar un kit de emergencia en español."
        },
        "survival-plus-es": {
          title: "Supervivencia ampliada ES",
          description: "Archivo en español para portátil o USB-SSD que amplía Supervivencia esencial ES con Wikipedia compacta en español, referencia médica en español, procedimientos de reparación de iFixit y Wikivoyage en español para viajes y geografía."
        },
        "civilization-core-es": {
          title: "Civilización básica ES",
          description: "Perfil de estación comunitaria de conocimiento en español. Añade Wikibooks ES y Wiktionary ES a la base española de supervivencia y reparación para educación, referencia lingüística y uso comunitario práctico."
        },
        "civilization-rebuild-es": {
          title: "Reconstrucción civilizatoria ES",
          description: "Archivo en español de escala estación de trabajo. Añade Wikisource ES, paquetes temáticos de Wikipedia en español sobre historia, matemáticas, física e informática, además de Project Gutenberg en español para educación profunda y continuidad cultural."
        },
        "civilization-max-es": {
          title: "Civilización máxima ES",
          description: "Perfil grande de archivo en español. Añade la Wikipedia completa en español sin imágenes sobre Reconstrucción civilizatoria ES para referencia amplia en español y preservación a largo plazo."
        },
        "survival-essential-bilingual": {
          title: "Supervivencia esencial bilingüe",
          description: "Archivo pequeño de emergencia en inglés y español. Combina Supervivencia esencial con Supervivencia esencial ES para hogares o equipos que necesitan ambos idiomas sin conexión."
        },
        "survival-plus-bilingual": {
          title: "Supervivencia ampliada bilingüe",
          description: "Archivo bilingüe para portátil o USB-SSD. Combina Supervivencia ampliada con Supervivencia ampliada ES, manteniendo fuentes inglesas para cubrir huecos y añadiendo Wikipedia, medicina, reparación y viajes en español."
        },
        "civilization-core-bilingual": {
          title: "Civilización básica bilingüe",
          description: "Perfil bilingüe de estación comunitaria de conocimiento. Combina Civilización básica con Civilización básica ES para una cobertura más amplia en reparación, educación, lengua, salud pública y reconstrucción en inglés y español."
        },
        "civilization-rebuild-bilingual": {
          title: "Reconstrucción civilizatoria bilingüe",
          description: "Archivo bilingüe de escala estación de trabajo. Combina Reconstrucción civilizatoria con Reconstrucción civilizatoria ES, manteniendo fuentes profundas de STEM y cultura maker en inglés y añadiendo material temático, literario y de referencia en español."
        },
        "civilization-max-bilingual": {
          title: "Civilización máxima bilingüe",
          description: "Perfil de preservación profunda en inglés y español. Combina Civilización máxima con Civilización máxima ES para grandes unidades de archivo bilingües y réplica a largo plazo."
        }
      },
      sources: {
        "survivalmanual-wiki": { title: "Wiki SurvivalManual", description: "Guía de supervivencia offline basada en el manual de supervivencia del Ejército de EE. UU. en dominio público." },
        "survivalmanual-ebook": { title: "Ebook SurvivalManual", description: "Versión de SurvivalManual orientada a impresión y lectores electrónicos." },
        "simplewiki-zim": { title: "Wikipedia en inglés simple ZIM", description: "Paquete enciclopédico de lectura sencilla para educación y referencia general." },
        "who-basic-emergency-care": { title: "Atención básica de emergencia de la OMS", description: "Material de formación en atención de emergencia para proveedores de primer contacto en entornos con recursos limitados." },
        "wikem-zim": { title: "WikEM Medicina de emergencia ZIM", description: "Referencia compacta de medicina de emergencia para consulta clínica rápida." },
        "wikipedia-top1m-zim": { title: "Wikipedia inglesa Top 1M sin imágenes", description: "Subconjunto amplio de Wikipedia en inglés sin imágenes." },
        "wikipedia-medicine-zim": { title: "Wikipedia Medicina ZIM", description: "Subconjunto médico para referencia offline." },
        "ifixit-zim": { title: "iFixit ZIM", description: "Procedimientos de reparación offline para dispositivos y herramientas." },
        "openstax-biology-2e": { title: "Biología LibreTexts ZIM", description: "Biblioteca offline de libros de biología, incluyendo material alineado con OpenStax." },
        "fao-small-agriculture-pack": { title: "Paquete inicial de agricultura FAO", description: "Referencias seleccionadas sobre agricultura, suelo, riego, almacenamiento y ganadería." },
        "wikivoyage-zim": { title: "Wikivoyage inglés sin imágenes ZIM", description: "Referencia offline de viajes, geografía, regiones y rutas útil para orientación y planificación." },
        "gardening-stackexchange-zim": { title: "Gardening Stack Exchange ZIM", description: "Preguntas y respuestas offline sobre jardinería, suelo, compostaje, plagas, semillas y cuidado de plantas." },
        "cooking-stackexchange-zim": { title: "Cooking Stack Exchange ZIM", description: "Preguntas y respuestas offline sobre cocina, seguridad alimentaria, almacenamiento, conservación e ingredientes." },
        "wikibooks-zim": { title: "Wikibooks inglés ZIM", description: "Libros prácticos y libros de texto offline." },
        "wiktionary-zim": { title: "Wiktionary inglés ZIM", description: "Diccionario y referencia lingüística offline." },
        "appropedia-snapshot": { title: "Copia de Appropedia", description: "Copia de la wiki de tecnología apropiada y sostenibilidad." },
        "energypedia-zim": { title: "Energypedia inglés sin imágenes ZIM", description: "Referencia práctica sobre energía renovable, energía aislada, combustible de cocina y sistemas eléctricos." },
        "open-source-ecology": { title: "Open Source Ecology", description: "Archivo ZIM del Global Village Construction Set y documentación de maquinaria abierta." },
        "cdc-public-health-pack": { title: "Paquete de salud pública CDC", description: "Referencias de salud pública y emergencias de EE. UU. en dominio público cuando están disponibles." },
        "openstreetmap-wiki-zim": { title: "Wiki OpenStreetMap sin imágenes ZIM", description: "Documentación offline sobre etiquetado de OpenStreetMap, práctica cartográfica y datos geográficos." },
        "diy-stackexchange-zim": { title: "DIY Stack Exchange ZIM", description: "Preguntas y respuestas offline sobre reparación doméstica, construcción, fontanería, electricidad y mantenimiento." },
        "woodworking-stackexchange-zim": { title: "Woodworking Stack Exchange ZIM", description: "Preguntas y respuestas offline sobre carpintería, uniones, herramientas y taller." },
        "electronics-stackexchange-zim": { title: "Electronics Stack Exchange ZIM", description: "Preguntas y respuestas offline sobre diseño electrónico, diagnóstico, potencia, sensores y reparación." },
        "arduino-stackexchange-zim": { title: "Arduino Stack Exchange ZIM", description: "Preguntas y respuestas offline sobre microcontroladores, sensores, automatización y proyectos de reparación." },
        "engineering-stackexchange-zim": { title: "Engineering Stack Exchange ZIM", description: "Preguntas y respuestas offline sobre ingeniería práctica, mecánica, materiales, sistemas y fabricación." },
        "3dprinting-stackexchange-zim": { title: "3D Printing Stack Exchange ZIM", description: "Preguntas y respuestas offline sobre fabricación aditiva, reparación de impresoras, materiales y fabricación." },
        "bicycles-stackexchange-zim": { title: "Bicycles Stack Exchange ZIM", description: "Preguntas y respuestas offline sobre mantenimiento de bicicletas, reparación, transporte de carga, piezas y herramientas." },
        "wikisource-zim": { title: "Wikisource inglés ZIM", description: "Textos fuente y referencias históricas offline." },
        "libretexts-core-science": { title: "Matemáticas LibreTexts ZIM", description: "Biblioteca offline de libros de texto de matemáticas de LibreTexts." },
        "libretexts-physics": { title: "Física LibreTexts ZIM", description: "Biblioteca offline de libros de texto de física de LibreTexts." },
        "libretexts-chemistry": { title: "Química LibreTexts ZIM", description: "Biblioteca offline de libros de texto de química de LibreTexts." },
        "project-gutenberg-small": { title: "Tecnología Project Gutenberg ZIM", description: "Libros en dominio público sobre tecnología, ingeniería y artes prácticas de Project Gutenberg." },
        "project-gutenberg-large": { title: "Literatura inglesa Project Gutenberg ZIM", description: "Paquete de literatura inglesa en dominio público de Project Gutenberg." },
        "wikipedia-top1m-maxi": { title: "Wikipedia inglesa Top 1M con imágenes", description: "Paquete enriquecido de Wikipedia en inglés con el millón de artículos principales e imágenes para referencia amplia." },
        "vikidia-es-zim": { title: "Vikidia en español sin imágenes ZIM", description: "Paquete enciclopédico en español de lectura sencilla para lectores jóvenes y referencia básica." },
        "who-basic-emergency-care-es": { title: "Atención básica de emergencia OMS en español", description: "Resumen de atención de emergencia de la OMS en español para proveedores de primer contacto en entornos con recursos limitados." },
        "who-bec-quick-cards-es": { title: "Tarjetas rápidas BEC OMS en español", description: "Referencia rápida en español de Basic Emergency Care de la OMS para triaje y atención rápida." },
        "cert-basic-training-es": { title: "Formación básica CERT en español", description: "Manual del participante de Community Emergency Response Team en español para respuesta a desastres, primeros auxilios y preparación." },
        "cdc-build-emergency-kit-es": { title: "Kit de emergencia CDC en español", description: "Guía de CDC en español para preparar un kit de emergencia con suministros básicos." },
        "wikipedia-es-top-zim": { title: "Wikipedia en español Top sin imágenes ZIM", description: "Subconjunto amplio de Wikipedia en español sin imágenes para referencia general compacta." },
        "wikipedia-es-medicine-zim": { title: "Wikipedia Medicina en español sin imágenes ZIM", description: "Subconjunto médico de Wikipedia en español para salud y medicina offline." },
        "ifixit-es-zim": { title: "iFixit en español ZIM", description: "Procedimientos de reparación offline en español para dispositivos, electrodomésticos, herramientas y equipos." },
        "wikivoyage-es-zim": { title: "Wikivoyage en español sin imágenes ZIM", description: "Referencia offline en español de viajes, geografía, regiones y rutas." },
        "wikibooks-es-zim": { title: "Wikibooks en español sin imágenes ZIM", description: "Libros prácticos y libros de texto offline en español de Wikibooks." },
        "wiktionary-es-zim": { title: "Wiktionary en español sin imágenes ZIM", description: "Diccionario y referencia lingüística offline en español." },
        "wikisource-es-zim": { title: "Wikisource en español sin imágenes ZIM", description: "Textos fuente, literatura y referencias históricas offline en español." },
        "wikipedia-es-history-zim": { title: "Wikipedia Historia en español sin imágenes ZIM", description: "Paquete temático de historia de Wikipedia en español para cobertura compacta de humanidades offline." },
        "wikipedia-es-mathematics-zim": { title: "Wikipedia Matemáticas en español sin imágenes ZIM", description: "Paquete temático de matemáticas de Wikipedia en español para referencia STEM compacta offline." },
        "wikipedia-es-physics-zim": { title: "Wikipedia Física en español sin imágenes ZIM", description: "Paquete temático de física de Wikipedia en español para referencia STEM compacta offline." },
        "wikipedia-es-computer-zim": { title: "Wikipedia Informática en español sin imágenes ZIM", description: "Paquete temático de informática de Wikipedia en español para referencia compacta de ordenadores y software offline." },
        "project-gutenberg-es-zim": { title: "Project Gutenberg en español ZIM", description: "Libros en español en dominio público de Project Gutenberg." },
        "wikipedia-es-all-nopic-zim": { title: "Wikipedia en español completa sin imágenes ZIM", description: "Paquete completo de Wikipedia en español sin imágenes para referencia offline amplia en discos grandes." }
      },
      categories: {
        survival: "supervivencia",
        "science-education": "ciencia y educación",
        medicine: "medicina",
        repair: "reparación",
        "food-systems": "sistemas alimentarios",
        geography: "geografía",
        reconstruction: "reconstrucción"
      },
      types: {
        zim: "ZIM",
        pdf: "PDF",
        epub: "EPUB",
        html: "HTML",
        "repo-archive": "archivo de repositorio",
        model: "modelo"
      },
      roles: {
        chat: "chat",
        embedding: "embeddings"
      },
      licenses: {
        "public-domain-derived": "dominio público derivado",
        "public-domain-us": "dominio público de EE. UU.",
        "mixed-free": "licencias libres mixtas"
      },
      statuses: {
        missing: "pendiente",
        queued: "en cola",
        downloading: "descargando",
        resuming: "reanudando",
        paused: "pausado",
        failed: "fallido",
        complete: "completo",
        downloaded: "descargado",
        downloaded_unverified: "descargado sin verificar",
        verified: "verificado",
        indexed: "indexado",
        "indexed-original-only": "registrado para búsqueda básica",
        running: "activo",
        installed: "instalado",
        ready: "listo",
        opened: "abierto",
        available: "disponible",
        stopped: "parado",
        pulling: "descargando",
        installing: "instalando",
        starting: "iniciando",
        blocked: "bloqueado",
        broken: "roto",
        corrupt: "corrupto",
        ready_for_kiwix: "listo para Kiwix",
        not_ready: "no listo"
      },
      phases: {
        download: "Descarga",
        prepare: "Preparación",
        index: "Indexación",
        ai: "IA local",
        "runtime-download": "Descarga del runtime",
        "runtime-ready": "Runtime listo",
        "runtime-extract": "Extracción del runtime",
        "runtime-install": "Instalación del runtime",
        "model-pull": "Descarga del modelo",
        "starting-ollama": "Arranque de Ollama",
        queued: "En cola",
        checking: "Comprobación",
        "copy-app": "Copia de la app",
        "copy-library": "Copia de la biblioteca",
        database: "Base de datos",
        metadata: "Metadatos",
        compress: "Compresión",
        checksum: "Checksum",
        running: "En curso",
        failed: "Fallido",
        complete: "Completado"
      },
      tiers: {
        "browse-only": "solo consulta",
        "survival-ai": "IA de supervivencia",
        "core-ai": "IA básica",
        workstation: "estación de trabajo"
      },
      details: {
        "Downloading selected profile sources while Local AI installs in parallel.": "Descargando fuentes de los perfiles seleccionados mientras la IA local se instala en paralelo.",
        "Downloading selected profile sources.": "Descargando fuentes de los perfiles seleccionados.",
        "Preparing downloaded sources while Local AI continues installing.": "Preparando fuentes descargadas mientras la IA local sigue instalándose.",
        "Preparing downloaded sources for offline use.": "Preparando fuentes descargadas para uso offline.",
        "Indexing downloaded sources while Local AI continues installing.": "Indexando fuentes descargadas mientras la IA local sigue instalándose.",
        "Indexing downloaded sources for Search and Local AI context.": "Indexando fuentes descargadas para Búsqueda y contexto de IA local.",
        "Source setup is done; Local AI is still installing in parallel.": "La preparación de fuentes ha terminado; la IA local sigue instalándose en paralelo.",
        "Easy Install completed.": "Instalación fácil completada.",
        "Local AI install is queued and will run in parallel with source downloads.": "La instalación de IA local está en cola y se ejecutará en paralelo con las descargas de fuentes.",
        "Preparing app-managed Ollama and recommended models.": "Preparando Ollama gestionado por la app y los modelos recomendados.",
        "Starting local Ollama service.": "Iniciando el servicio local de Ollama.",
        "Ollama is already available.": "Ollama ya está disponible.",
        "Extracting Ollama runtime.": "Extrayendo el runtime de Ollama.",
        "Installing Ollama runtime.": "Instalando el runtime de Ollama.",
        "All recommended Local AI components are installed.": "Todos los componentes recomendados de IA local están instalados.",
        "Share package created.": "Paquete compartido creado.",
        "Preparing the included library database.": "Preparando la base de datos de biblioteca incluida.",
        "Writing package manifest and launch instructions.": "Escribiendo el manifiesto del paquete y las instrucciones de inicio.",
        "Compressing the share package. Large packages can stay here for a while.": "Comprimiendo el paquete compartido. Los paquetes grandes pueden quedarse aquí un rato.",
        "Calculating package checksum.": "Calculando el checksum del paquete."
      }
    }
  };

  $: _uiT = uiText[uiLanguage] ?? {};
  $: _catT = catalogText[uiLanguage] ?? {};
  $: _contentCatT = catalogText[uiLanguage] ?? {};
  $: catalogSources = Array.isArray(catalog.sources) ? catalog.sources : [];
  $: catalogProfiles = Array.isArray(catalog.profiles) ? catalog.profiles : [];
  $: contentProfiles = profilesForContentLanguage(contentLanguage, catalogProfiles);
  $: contentSourceIds = new Set(contentProfiles.flatMap((profile) => profile.sourceIds ?? []));
  $: contentSources = catalogSources.filter((source) => contentSourceIds.has(source.id));
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
  $: hasActiveDownloads = activeDownloadSources.length > 0;
  $: notSearchableDownloads = stateSources.filter((source) => {
    const downloaded = ["downloaded", "verified", "downloaded_unverified", "indexed-original-only"].includes(String(source.status ?? "")) && source.local_path;
    return downloaded && !fullyIndexedSourceIds.has(source.id);
  });
  $: indexableDownloadedSources = notSearchableDownloads.filter((source) => !["queued", "downloading", "resuming"].includes(String(downloadState.get(source.id)?.status ?? "")));
  $: downloadedIndexSources = stateSources.filter((source) => {
    const status = String(source.status ?? "");
    return Boolean(source.local_path) && ["downloaded", "verified", "indexed", "indexed-original-only", "downloaded_unverified"].includes(status);
  });
  $: extraFiles = Array.isArray(extraScan?.files) ? extraScan.files : [];
  $: selectedExtraFiles = extraFiles.filter((file) => extraSelections[file.path]);
  $: extraImportedSources = stateSources.filter((source) => String(source.id ?? "").startsWith("extra-"));
  $: aiServices = stateServices.filter((service) => service.name === "ollama");
  $: aiServiceCards = aiServices.length ? aiServices : [{
    name: "ollama",
    status: aiInstallProgress?.status === "running" ? "installing" : "missing",
    port: 11434,
    url: "http://127.0.0.1:11434",
    message: aiInstallProgress?.detail
  }];
  $: ollamaService = aiServiceCards.find((service) => service.name === "ollama") ?? null;
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
  $: keepQuestionModelValid(installedChatModels, questionModel);
  $: startAiModel = [...installedChatModels].sort((a, b) => Number(a.expected_size_bytes ?? 0) - Number(b.expected_size_bytes ?? 0))[0] ?? null;
  $: startAiRequiredBytes = estimateAiRamBytes(startAiModel);
  $: startAiSwapPressure = Boolean(system?.swapTotalBytes > 0 && system?.swapFreeBytes < Math.max(1024 ** 3, system.swapTotalBytes * 0.4));
  $: startAiAllowed = Boolean(startAiModel && system?.availableMemBytes >= startAiRequiredBytes && !startAiSwapPressure);
  $: recommendedSetupProfile = recommendedProfile(system, contentProfiles);
  $: aiInstallProgress = progressObject(stateSettings.aiInstallProgress);
  $: easyInstallProgress = progressObject(stateSettings.easyInstallProgress);
  $: sharePackageProgress = progressObject(stateSettings.sharePackageProgress);
  $: indexingProgress = progressObject(stateSettings.indexingProgress);
  $: askProgress = progressObject(stateSettings.askProgress);
  $: activeIndexingProgress = activeIndexProgress(easyInstallProgress, indexingProgress);
  $: activeIndexItems = Array.isArray(activeIndexingProgress?.items) ? activeIndexingProgress.items : [];
  $: showEasyAiProgress = Boolean(aiInstallProgress) && (easyInstallProgress?.phase === "ai" || aiInstallProgress?.status === "running");
  $: showAiInstallProgress = Boolean(aiInstallProgress) && (["running", "failed"].includes(String(aiInstallProgress?.status ?? "")) || busy.has("ai-install"));
  $: aiInstallComplete = aiInstallProgress?.status === "complete";
  $: showSharePackageProgress = Boolean(sharePackageProgress) && (
    busy.has("share-package") || ["running", "failed", "complete"].includes(String(sharePackageProgress?.status ?? ""))
  );
  $: askBusy = busy.has("ask");
  $: selectedEasyProfiles = contentProfiles.filter((profile) => easyProfileSelections[profile.id]);
  $: selectedEasySourceIds = [...new Set(selectedEasyProfiles.flatMap((profile) => profile.sourceIds ?? []))];
  $: selectedEasyDownloadBytes = selectedEasySourceIds.reduce((sum, id) => sum + Number(sourceCatalog.get(id)?.expected_size_bytes ?? 0), 0);
  $: selectedEasyPreparedBytes = selectedEasySourceIds.reduce((sum, id) => {
    const source = sourceCatalog.get(id);
    return sum + Number(source?.prepared_size_bytes ?? source?.expected_size_bytes ?? 0);
  }, 0);
  $: downloadedSourcesForShare = stateSources.filter((source) => sourceIsDownloaded(source));
  $: downloadedShareBytes = downloadedSourcesForShare.reduce((sum, source) => sum + Number(source.size_bytes ?? sourceCatalog.get(source.id)?.prepared_size_bytes ?? sourceCatalog.get(source.id)?.expected_size_bytes ?? 0), 0);
  $: shareableProfiles = contentProfiles.filter((profile) => profileIsFullyDownloaded(profile));
  $: shareOptions = [
    ...(downloadedSourcesForShare.length ? [{
      id: "all-downloaded",
      title: t("allDownloadedSources"),
      sizeBytes: downloadedShareBytes,
      sourceCount: downloadedSourcesForShare.length
    }] : []),
    ...shareableProfiles.map((profile) => ({
      id: profile.id,
      title: profileTitle(profile),
      sizeBytes: Number(profile.preparedSizeBytes ?? profile.expectedSizeBytes ?? 0),
      sourceCount: profile.sourceIds?.length ?? 0
    }))
  ];
  $: sortedLogs = sortLogs(logs, logSortKey, logSortDir);
  $: keepShareProfileValid(shareOptions, shareProfile);
  $: if (hasActiveDownloads) startStatePolling();
  $: if (!hasActiveDownloads) stopStatePolling();
  $: if (activeTab === "logs") startLogsPolling();
  $: if (activeTab !== "logs") stopLogsPolling();

  onMount(() => {
    setUiLanguage(uiLanguage);
    load();
  });
  onDestroy(() => {
    stopStatePolling();
    stopLogsPolling();
    for (const timer of verifyFeedbackTimers.values()) window.clearTimeout(timer);
    if (maintenanceFeedbackTimer) window.clearTimeout(maintenanceFeedbackTimer);
  });

  function initialUiLanguage() {
    if (typeof window === "undefined") return "en";
    const saved = window.localStorage.getItem("offline-survival-ui-language");
    return saved === "es" ? "es" : "en";
  }

  function initialContentLanguage() {
    if (typeof window === "undefined") return initialUiLanguage();
    const ui = initialUiLanguage();
    const saved = window.localStorage.getItem("offline-survival-content-language");
    if (saved === ui) return saved;
    return ui;
  }

  function setUiLanguage(language: string) {
    const nextLanguage = language === "es" ? "es" : "en";
    uiLanguage = nextLanguage;
    contentLanguage = nextLanguage;
    verifyFeedback = {};
    maintenanceFeedback = null;
    error = catalogError ? t("loadBackendError", { error: catalogError }) : error;
    easyProfileSelections = {};
    selectRecommendedEasyInstall();
    if (typeof window !== "undefined") {
      window.localStorage.setItem("offline-survival-ui-language", uiLanguage);
      window.localStorage.setItem("offline-survival-content-language", contentLanguage);
      document.documentElement.lang = uiLanguage;
    }
  }

  function setContentLanguage(language: string) {
    contentLanguage = language === "both" ? "both" : language === "es" ? "es" : "en";
    easyProfileSelections = {};
    filter = "";
    selectRecommendedEasyInstall();
    if (typeof window !== "undefined") window.localStorage.setItem("offline-survival-content-language", contentLanguage);
  }

  function t(key: string, vars: Record<string, string | number> = {}) {
    const template = _uiT[key] ?? uiText.en?.[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
  }

  function localizedRecord(kind: "profiles" | "sources", id: unknown) {
    return _contentCatT?.[kind]?.[String(id ?? "")] ?? null;
  }

  function profileTitle(profile: Profile | Record<string, any> | null | undefined) {
    if (!profile) return "";
    return localizedRecord("profiles", profile.id)?.title ?? profile.title ?? "";
  }

  function profileDescription(profile: Profile | Record<string, any> | null | undefined) {
    if (!profile) return "";
    return localizedRecord("profiles", profile.id)?.description ?? profile.description ?? "";
  }

  function sourceTitle(source: Source | Record<string, any> | null | undefined) {
    if (!source) return "";
    return localizedRecord("sources", source.id)?.title ?? source.title ?? String(source.id ?? "");
  }

  function sourceDescription(source: Source | Record<string, any> | null | undefined) {
    if (!source) return "";
    return localizedRecord("sources", source.id)?.description ?? source.description ?? "";
  }

  function sourceCategory(source: Source | Record<string, any> | null | undefined) {
    const category = String(source?.category ?? "");
    return _catT?.categories?.[category] ?? category;
  }

  function sourceTypeLabel(type: unknown) {
    const value = String(type ?? "");
    return _catT?.types?.[value] ?? value;
  }

  function modelRoleLabel(role: unknown) {
    const value = String(role ?? "");
    return _catT?.roles?.[value] ?? value;
  }

  function licenseLabel(license: unknown) {
    const value = String(license ?? "");
    return _catT?.licenses?.[value] ?? value;
  }

  function sourceForId(sourceId: unknown) {
    const id = String(sourceId ?? "");
    return sourceCatalog.get(id) ?? stateSources.find((source) => source.id === id) ?? null;
  }

  function sourceTitleById(sourceId: unknown, fallback = "") {
    const source = sourceForId(sourceId);
    return source ? sourceTitle(source) : fallback || String(sourceId ?? "");
  }

  function profileTitleById(profileId: unknown, fallback = "") {
    const id = String(profileId ?? "");
    const profile = catalogProfiles.find((item) => item.id === id);
    return profile ? profileTitle(profile) : fallback || id;
  }

  function statusLabel(status: unknown) {
    const value = String(status ?? "");
    return _catT?.statuses?.[value] ?? value;
  }

  function phaseLabel(phase: unknown) {
    const value = String(phase ?? "");
    return _catT?.phases?.[value] ?? value;
  }

  function tierLabel(tier: unknown) {
    const value = String(tier ?? "");
    return _catT?.tiers?.[value] ?? value;
  }

  function logTitle(log: Record<string, any>) {
    return phaseLabel(log.kind) || String(log.kind ?? "");
  }

  function logDescription(log: Record<string, any>) {
    return detailLabel(log.message);
  }

  function logDateValue(log: Record<string, any>) {
    const parsed = Date.parse(String(log.created_at ?? ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function logDateLabel(log: Record<string, any>) {
    const value = String(log.created_at ?? "");
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return value;
    return new Intl.DateTimeFormat(uiLanguage === "es" ? "es-ES" : "en-US", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(parsed));
  }

  function sortLogs(items: any[], key: "title" | "description" | "date", direction: "asc" | "desc") {
    const multiplier = direction === "asc" ? 1 : -1;
    return [...items].sort((a, b) => {
      let result = 0;
      if (key === "date") result = logDateValue(a) - logDateValue(b);
      else if (key === "title") result = logTitle(a).localeCompare(logTitle(b), uiLanguage);
      else result = logDescription(a).localeCompare(logDescription(b), uiLanguage);
      return result * multiplier || (logDateValue(b) - logDateValue(a));
    });
  }

  function sortLogsBy(key: "title" | "description" | "date") {
    if (logSortKey === key) {
      logSortDir = logSortDir === "asc" ? "desc" : "asc";
      return;
    }
    logSortKey = key;
    logSortDir = key === "date" ? "desc" : "asc";
  }

  function logSortIndicator(key: "title" | "description" | "date") {
    if (logSortKey !== key) return "";
    return logSortDir === "asc" ? " ^" : " v";
  }

  function detailLabel(detail: unknown) {
    const value = String(detail ?? "");
    if (_uiT !== uiText.es) return value; // only map when Spanish is active
    const mapped = catalogText.es?.details?.[value];
    if (mapped) return mapped;
    if (value.startsWith("Indexing ") && value.endsWith(".")) return value.replace("Indexing ", "Indexando ");
    if (value.startsWith("Downloading ")) return value.replace("Downloading ", "Descargando ");
    if (value.startsWith("Pulling ")) return value.replace("Pulling ", "Descargando ");
    if (value.startsWith("Finished ")) return value.replace("Finished ", "Finalizado ");
    if (value.startsWith("Copying ")) return value.replace("Copying ", "Copiando ");
    return value;
  }

  function profileMatchesContentLanguage(profile: Profile | Record<string, any>, language = contentLanguage) {
    const profileLang = String(profile.language ?? "en");
    if (language === "both") return profileLang === "both";
    return profileLang === language;
  }

  function profilesForContentLanguage(language: string, profiles = catalogProfiles) {
    return profiles.filter((profile) => profileMatchesContentLanguage(profile, language));
  }

  function keepShareProfileValid(options: Array<{ id: string }>, current: string) {
    if (!options.length) return;
    if (current && options.some((option) => option.id === current)) return;
    shareProfile = options[0].id;
  }

  function keepQuestionModelValid(models: Array<Record<string, any>>, current: string) {
    if (!models.length) {
      if (current) questionModel = "";
      return;
    }
    if (current && models.some((model) => model.id === current || model.pull === current)) return;
    questionModel = models[0].id;
  }

  async function load() {
    error = "";
    catalogError = "";
    loadingCatalog = true;
    const requestedTab = new URLSearchParams(window.location.search).get("tab");
    if (requestedTab === "settings") activeTab = "logs";
    else if (requestedTab && ["dashboard", "downloads", "search", "extra", "ai", "share", "logs", "easy"].includes(requestedTab)) activeTab = requestedTab;
    try {
      [catalog, state, system] = await Promise.all([api("/api/catalog"), api("/api/state"), api("/api/system")]);
      libraryPath = String(state.settings.libraryRoot ?? "");
      initializeEasyProfiles();
      await refreshServices();
      await refreshModels();
    } catch (err) {
      catalogError = String((err as Error).message ?? err);
      error = t("loadBackendError", { error: catalogError });
    } finally {
      loadingCatalog = false;
    }
  }

  async function refreshState() {
    state = await api("/api/state");
  }

  function startStatePolling() {
    if (statePoller) return;
    statePoller = window.setInterval(refreshStateQuiet, 1000);
  }

  function stopStatePolling() {
    if (!statePoller) return;
    window.clearInterval(statePoller);
    statePoller = 0;
  }

  async function refreshStateQuiet() {
    if (stateRefreshing) return;
    stateRefreshing = true;
    try {
      await refreshState();
    } catch {
      // Transient refresh errors should not stop downloads or other actions.
    } finally {
      stateRefreshing = false;
    }
  }

  async function run(label: string, fn: () => Promise<unknown>) {
    busy = new Set([...busy, label]);
    error = "";
    const shouldPoll = label.startsWith("profile-") || label.startsWith("download-") || label.startsWith("retry-") || label.startsWith("model-") || label.startsWith("index-") || label === "ask" || label === "ai-install" || label === "index-all-downloaded" || label === "easy-install" || label === "clean-sources" || label === "share-package";
    const poller = shouldPoll ? window.setInterval(() => {
      refreshState().catch(() => {});
    }, 1000) : 0;
    let fnError = "";
    try {
      await fn();
    } catch (err) {
      fnError = String((err as Error).message ?? err);
    } finally {
      if (poller) window.clearInterval(poller);
      busy.delete(label);
      busy = busy;
    }
    await load();
    if (fnError) error = fnError;
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
      body: JSON.stringify({ profileId: profile.id, contentLanguage, concurrency: 4 })
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
    if (result) showVerifyFeedback(sourceId, result.ok, result.ok ? t("verificationPassed") : t("verificationFailed"));
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
      title: t(isReindex ? "reindexSourceTitle" : "indexSourceTitle", { title: sourceTitleById(sourceId) }),
      body: t(isReindex ? "indexRebuildBody" : "indexNewBody"),
      steps: [
        ...(isReindex ? [t("indexRemoveRowsStep")] : []),
        t("indexReadStep"),
        t("indexExtractStep"),
        t("indexStoreStep")
      ],
      details: [
        [t("source"), sourceTitleById(sourceId)],
        [t("downloadedFileSize"), gb(Number(local?.size_bytes ?? source?.expected_size_bytes ?? 0))],
        [t("indexLocation"), t("localAppDatabase")],
        [t("embeddingModelRequired"), t("embeddingNotRequired")]
      ],
      confirmLabel: t(isReindex ? "reindexSource" : "indexSource"),
      cancelLabel: t("cancel")
    });
    if (!accepted) return;
    let result: any = null;
    await run(`index-${sourceId}`, async () => {
      result = await api("/api/index", { method: "POST", body: JSON.stringify({ sourceId }) });
    });
    if (result?.originalOnly) {
      error = t("indexOriginalOnlyError", { note: result.note ?? "" }).trim();
    }
  }

  async function indexAllDownloaded() {
    const reindexAll = indexableDownloadedSources.length === 0 && downloadedIndexSources.length > 0;
    const sources = reindexAll ? downloadedIndexSources : indexableDownloadedSources;
    if (!sources.length) return;
    const accepted = await requestConfirm({
      tone: "normal",
      title: reindexAll ? t("reindexAllDownloadedTitle") : t("indexAllDownloadedTitle", { count: sources.length }),
      body: reindexAll ? t("reindexAllDownloadedBody") : t("indexAllDownloadedBody"),
      steps: [
        t(reindexAll ? "reindexFindDownloadedStep" : "indexFindDownloadedStep"),
        t("indexExtractStep"),
        t("indexResultsStep")
      ],
      details: [
        [t("sourcesToIndex"), String(sources.length)],
        [t("downloadedDataToScan"), gb(sources.reduce((sum, source) => sum + Number(source.size_bytes ?? sourceCatalog.get(source.id)?.expected_size_bytes ?? 0), 0))],
        [t("indexLocation"), t("localAppDatabase")],
        [t("embeddingModelRequired"), t("embeddingNotRequired")]
      ],
      confirmLabel: reindexAll ? t("reindexAllDownloaded") : t("indexDownloadedSources"),
      cancelLabel: t("cancel")
    });
    if (!accepted) return;
    await run("index-all-downloaded", () => api("/api/index/downloaded", {
      method: "POST",
      body: JSON.stringify({ reindexAll })
    }));
  }

  async function openOriginal(sourceId: string) {
    const plan: any = await api("/api/source/open-plan", { method: "POST", body: JSON.stringify({ sourceId }) });
    const accepted = await requestConfirm({
      tone: "normal",
      title: t("openSourceTitle", { title: sourceTitleById(sourceId, plan.title) }),
      body: t("openSourceBody"),
      steps: plan.steps,
      details: [
        [t("finalTarget"), plan.finalTarget],
        [t("extraDiskNeededNow"), gb(plan.additionalBytes)],
        [t("preparedSizeAfterOpen"), gb(plan.extractedBytes)]
      ],
      confirmLabel: t("openSource"),
      cancelLabel: t("cancel")
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
        contentLanguage,
        installAi: easyInstallAi,
        concurrency: 4
      })
    }));
  }

  async function cleanSources() {
    const accepted = await requestConfirm({
      tone: "danger",
      title: t("cleanSources"),
      body: t("cleanSourcesBody"),
      details: [
        [t("catalog"), t("kept")],
        [t("settings"), t("kept")],
        [t("libraryPayloads"), t("deleted")]
      ],
      confirmLabel: t("cleanEverything"),
      cancelLabel: t("cancel")
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
      body: JSON.stringify({ model: questionModel || startAiModel?.id || startAiModel?.pull })
    }));
  }

  async function stop(name: string) {
    await run(`stop-${name}`, () => api("/api/service/stop", { method: "POST", body: JSON.stringify({ name }) }));
  }

  async function searchNow() {
    if (!query.trim()) {
      searchResults = [];
      return;
    }
    const params = new URLSearchParams({ q: query, limit: "20" });
    if (searchSource) params.set("sourceId", searchSource);
    if (searchLicense) params.set("license", searchLicense);
    await runSearch("keyword", () => api<{ results: any[] }>(`/api/search?${params.toString()}`));
  }

  async function semanticSearchNow() {
    if (!query.trim()) {
      searchResults = [];
      return;
    }
    await runSearch("semantic", () => api<{ results: any[] }>(`/api/search/semantic?q=${encodeURIComponent(query)}&limit=20`));
  }

  async function runSearch(mode: string, request: () => Promise<{ results: any[] }>) {
    const requestId = searchRequestId + 1;
    searchRequestId = requestId;
    searching = true;
    searchMode = mode;
    error = "";
    try {
      const data = await request();
      if (requestId === searchRequestId) searchResults = data.results;
    } catch (err) {
      if (requestId === searchRequestId) error = String((err as Error).message ?? err);
    } finally {
      if (requestId === searchRequestId) {
        searching = false;
        searchMode = "";
      }
    }
  }

  async function ask() {
    const currentQuestion = question.trim();
    if (!currentQuestion) return;
    const history = chatTurns.map((turn) => ({ question: turn.question, answer: turn.answer }));
    await run("ask", async () => {
      answer = null;
      answer = await api("/api/ask", { method: "POST", body: JSON.stringify({ question: currentQuestion, history, sourceId: questionSource || undefined, model: questionModel || undefined }) });
      chatTurns = [...chatTurns, { question: currentQuestion, ...answer }];
      question = "";
    });
  }

  function restartConversation() {
    chatTurns = [];
    answer = null;
    question = "";
  }

  async function openSearchHit(result: any) {
    await run(`open-search-${result.source_id}`, () => api("/api/search/open", {
      method: "POST",
      body: JSON.stringify({ sourceId: result.source_id, path: result.path })
    }));
  }

  async function writeLock() {
    const profile = contentProfiles[0];
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
      showMaintenanceFeedback(missing === 0, t("maintenanceCheckComplete", { repaired, missing, partials }));
    } else if (error) {
      showMaintenanceFeedback(false, t("maintenanceCheckFailed"));
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
        const haystack = `${sourceTitle(source)} ${sourceDescription(source)} ${sourceCategory(source)} ${source.license} ${(source.tags ?? []).join(" ")}`.toLowerCase();
        if (!haystack.includes(haystackFilter)) continue;
      }
      sources.push(source);
    }
    return sources;
  }

  function profileSubtitle(profile: Profile, index: number) {
    const labels: Record<string, string> = {
      en: t("english"),
      es: t("spanish"),
      both: t("bilingual")
    };
    const language = labels[String(profile.language ?? "")];
    if (profile.variant === "english") return t("englishProfile");
    if (profile.variant === "spanish") return t("spanishProfile");
    if (profile.variant === "bilingual") return t("bilingualProfile");
    const variant = profile.variant ? `${String(profile.variant).charAt(0).toUpperCase()}${String(profile.variant).slice(1)}` : "";
    if (language && variant && language !== variant) return uiLanguage === "es" ? `${language} · perfil ${variant}` : `${language} · ${variant} profile`;
    if (language) return uiLanguage === "es" ? `Perfil ${language.toLowerCase()}` : `${language} profile`;
    return index === 0 ? t("baseProfile") : t("addsTo", { title: profileTitle(contentProfiles[index - 1]) });
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

  function activeIndexProgress(easyProgress: Record<string, any> | null, globalProgress: Record<string, any> | null) {
    const easyIndexing = progressObject(easyProgress?.indexing);
    if (easyIndexing && ["running", "failed"].includes(String(easyIndexing.status ?? ""))) return easyIndexing;
    if (globalProgress && ["running", "failed"].includes(String(globalProgress.status ?? ""))) return globalProgress;
    return easyIndexing ?? globalProgress;
  }

  function sourceIndexInfo(sourceId: unknown) {
    const id = String(sourceId ?? "");
    const item = activeIndexItems.find((entry: any) => entry.sourceId === id);
    const current = activeIndexingProgress?.currentSourceId === id && activeIndexingProgress?.status === "running";
    if (!item && !current) return null;
    const status = current ? "indexing" : String(item?.status ?? "pending");
    const complete = ["indexed", "registered"].includes(status);
    const failed = status === "failed";
    const label = indexStatusLabel(status);
    return {
      ...item,
      sourceId: id,
      status,
      current,
      complete,
      failed,
      label,
      progress: complete ? 100 : failed ? 100 : 0
    };
  }

  function indexStatusLabel(status: unknown) {
    const value = String(status ?? "");
    if (value === "indexing") return t("indexingCurrent");
    if (value === "indexed") return t("indexingCompleted");
    if (value === "registered") return t("indexingRegistered");
    if (value === "failed") return t("indexingFailed");
    return t("indexingQueued");
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
    if (Object.keys(easyProfileSelections).length || !profilesForContentLanguage(contentLanguage).length) return;
    selectRecommendedEasyInstall();
  }

  function selectRecommendedEasyInstall() {
    const profiles = profilesForContentLanguage(contentLanguage);
    if (!profiles.length) return;
    const recommended = recommendedProfile(system, profiles);
    const recommendedIndex = recommended ? profiles.findIndex((profile) => profile.id === recommended.id) : -1;
    const lastSelectedIndex = recommendedIndex >= 0 ? recommendedIndex : 0;
    easyProfileSelections = Object.fromEntries(profiles.map((profile, index) => [profile.id, index <= lastSelectedIndex]));
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
    const allowedIds = new Set(profilesCatalog.map((profile) => profile.id));
    if (systemInfo?.recommendedProfile?.id && allowedIds.has(systemInfo.recommendedProfile.id)) return systemInfo.recommendedProfile;
    const profiles = (Array.isArray(systemInfo?.recommendedProfiles) ? systemInfo.recommendedProfiles : []).filter((profile: Profile) => allowedIds.has(profile.id));
    return profiles[profiles.length - 1] ?? profilesCatalog[0] ?? null;
  }

  function recommendationReason(model: any) {
    if (!system || !model) return "";
    if (model.role === "embedding") return t("embeddingReason");
    if (system.tier === "browse-only") return t("browseOnlyReason");
    if (system.tier === "survival-ai") return t("survivalAiReason");
    if (system.tier === "core-ai") return t("coreAiReason");
    return t("workstationReason");
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
    const parts = recommendedAiModels.map((model) => `${modelTitle(model)} (${gb(model.expected_size_bytes)})`);
    return parts.join(" + ") || t("calculatingRecommendedModels");
  }

  function preparedSize(source: Source) {
    return Number(source.prepared_size_bytes ?? source.expected_size_bytes ?? 0);
  }

  function progressLine(progress: any) {
    if (!progress) return "";
    const eta = progress.etaSeconds ? ` · ${t("etaLeft", { duration: duration(progress.etaSeconds) })}` : "";
    if (progress.phase === "runtime-download" && progress.runtimeBytesTotal) {
      return `${gb(progress.runtimeBytesReceived)} / ${gb(progress.runtimeBytesTotal)}${eta}`;
    }
    if (progress.phase === "model-pull" && progress.modelBytesTotal) {
      return `${t("modelProgress", { current: gb(progress.modelBytesReceived), total: gb(progress.modelBytesTotal), percent: progress.percent ?? 0 })}${eta}`;
    }
    if (progress.totalBytes) return `${t("overallProgress", { current: gb(progress.currentBytes ?? 0), total: gb(progress.totalBytes) })}${eta}`;
    return detailLabel(progress.detail);
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
      const bytes = progress.totalBytes ? `${gb(progress.currentBytes ?? 0)} / ${gb(progress.totalBytes)}` : t("totalSizeUnknown");
      const counts = progress.sourceCount ? `${progress.done ?? 0}/${progress.sourceCount} ${t("completeCount")}` : "";
      const active = progress.active ? ` · ${t("activeCount", { count: progress.active })}` : "";
      return `${t("easyDownloadLine")} · ${bytes}${counts ? ` · ${counts}` : ""}${active}`;
    }
    if (progress.phase === "prepare") return t("easyPrepareLine");
    if (progress.phase === "index") return t("easyIndexLine");
    if (progress.phase === "ai") return t("easyAiLine");
    return detailLabel(progress.detail);
  }

  function downloadProfileTooltip(profile: Profile) {
    return t("downloadProfileTooltip", { title: profileTitle(profile) });
  }

  function downloadTooltip(source: Source | Record<string, any>) {
    return t("downloadTooltip", { title: sourceTitle(source) });
  }

  function verifyTooltip(source: Source | Record<string, any>) {
    return t("verifyTooltip", { title: sourceTitle(source) });
  }

  function indexTooltip(source: Source | Record<string, any>) {
    const verb = fullyIndexedSourceIds.has(source.id) ? t("reindex") : t("index");
    return t("indexTooltip", { verb, title: sourceTitle(source) });
  }

  function indexActionLabel(sourceId: string) {
    if (sourceIsIndexing(sourceId)) return fullyIndexedSourceIds.has(sourceId) ? t("reindexingAction") : t("indexingAction");
    return fullyIndexedSourceIds.has(sourceId) ? t("reindex") : t("index");
  }

  function sourceIsIndexing(sourceId: unknown) {
    const id = String(sourceId ?? "");
    return busy.has(`index-${id}`) || Boolean(sourceIndexInfo(id)?.current);
  }

  function sourceIndexProgressLine(indexInfo: Record<string, any> | null | undefined) {
    if (!indexInfo) return "";
    const done = Number(activeIndexingProgress?.completed ?? 0);
    const total = Number(activeIndexingProgress?.total ?? 1);
    return t("indexingSourceProgress", { status: indexInfo.label ?? t("indexingQueued"), done, total });
  }

  function openTooltip(source: Source | Record<string, any>) {
    const action = source.open?.action ?? (source.type === "zim" ? "kiwix_serve" : "direct_open");
    if (action === "kiwix_serve") return t("openZimTooltip", { title: sourceTitle(source) });
    if (action === "extract_serve") return t("openExtractServeTooltip", { title: sourceTitle(source) });
    if (action === "extract_open") return t("openExtractOpenTooltip", { title: sourceTitle(source) });
    return t("openDirectTooltip", { title: sourceTitle(source) });
  }

  function modelTitle(model: Record<string, any> | null | undefined) {
    return model?.title ?? "";
  }
</script>

{#key uiLanguage}
<main>
  <aside>
    <h1>Offline Survival</h1>
    <label class="languageControl">
      {t("appLanguage")}
      <select value={uiLanguage} on:change={e => setUiLanguage((e.currentTarget as HTMLSelectElement).value)}>
        <option value="en">{t("english")}</option>
        <option value="es">{t("spanish")}</option>
      </select>
    </label>
    <button class="easyInstallButton" type="button" class:active={activeTab === "easy"} data-badge={t("recommendedBadge")} on:click={openEasyInstall}>{t("easyInstall")}</button>
    <div class="meter">
      <span>{t("downloaded")}</span>
      <strong>{gb(downloadedBytes)}</strong>
    </div>
    {#if system}
      <div class="meter explainMeter" title={t("recommendationTitle")}>
        <span>
          {t("recommendedSetup")}
          <small>{t("recommendationExplain")}</small>
        </span>
        <strong>{recommendedSetupProfile ? profileTitle(recommendedSetupProfile) : t("noProfileFits")}</strong>
      </div>
      <div class="meter">
        <span>{t("recommendationCap")}</span>
        <strong>{gb(system.recommendationLimitBytes ?? 0)}</strong>
      </div>
      <div class="meter">
        <span>{t("freeSpace")}</span>
        <strong>{gb(system.freeSpaceBytes)}</strong>
      </div>
    {/if}
    <label>
      {t("libraryPath")}
      <input bind:value={libraryPath} />
    </label>
    <button on:click={setLibrary} disabled={busy.has("library")}>{t("setLibrary")}</button>
    <div class="sidebarService">
      <div>
        <span>Kiwix</span>
        <strong class:ok={statusTone(kiwixService.status) === "ok"} class:warn={statusTone(kiwixService.status) === "warn"} class:bad={statusTone(kiwixService.status) === "bad"}>{statusLabel(kiwixService.status)}</strong>
        <small>{kiwixService.url}</small>
      </div>
      {#if kiwixService.status === "running"}
        <button type="button" on:click={() => stop("kiwix")} disabled={busy.has("stop-kiwix")}>{t("stopKiwix")}</button>
      {:else}
        <button type="button" on:click={startKiwix} disabled={busy.has("kiwix") || kiwixService.status === "missing"}>{t("startKiwix")}</button>
      {/if}
    </div>
    <button type="button" class="dangerAction" on:click={cleanSources} disabled={busy.has("clean-sources")}>{t("cleanSources")}</button>
  </aside>

  <section class="workspace">
    <nav class="tabs" aria-label={t("appSections")}>
      <button type="button" class:active={activeTab === "dashboard"} on:click={() => activeTab = "dashboard"}>{t("dashboard")}</button>
      <button type="button" class:active={activeTab === "downloads"} on:click={() => activeTab = "downloads"}>{t("downloads")}</button>
      <button type="button" class:active={activeTab === "search"} on:click={() => activeTab = "search"}>{t("search")}</button>
      <button type="button" class:active={activeTab === "extra"} on:click={() => activeTab = "extra"}>{t("extraKnowledge")}</button>
      <button type="button" class:active={activeTab === "ai"} on:click={() => activeTab = "ai"}>{t("localAi")}</button>
      <button type="button" class:active={activeTab === "share"} on:click={() => activeTab = "share"}>{t("share")}</button>
      <button type="button" class:active={activeTab === "logs"} on:click={() => activeTab = "logs"}>{t("logs")}</button>
    </nav>
    {#if error}<div class="alert">{error}</div>{/if}
    {#if busy.size}<div class="busy">{t("working", { busy: [...busy].join(", ") })}</div>{/if}

    {#if activeTab === "easy"}
    <section id="easy-install" class="band">
      <div class="sectionHeader">
        <div>
          <h2>{t("easyInstall")}</h2>
          <small>{t("easyInstallIntro")}</small>
        </div>
        <label class="languageControl">
          {t("contentLanguage")}
          <select value={contentLanguage} on:change={e => setContentLanguage((e.currentTarget as HTMLSelectElement).value)}>
            <option value="en">{t("english")}</option>
            <option value="es">{t("spanish")}</option>
            <option value="both">{t("bilingual")}</option>
          </select>
        </label>
      </div>
      <div class="serviceGrid">
        {#each contentProfiles as profile}
          <article class:recommendedModel={easyProfileSelections[profile.id]}>
            <label class="checkRow">
              <input type="checkbox" checked={Boolean(easyProfileSelections[profile.id])} on:change={(event) => toggleEasyProfile(profile.id, event.currentTarget.checked)} />
              <span>
                <strong>{profileTitle(profile)}</strong>
                <small>{gb(profile.preparedSizeBytes ?? profile.expectedSizeBytes)} {t("preparedDisk")} · {gb(profile.expectedSizeBytes)} {t("download")} · {profile.sourceIds.length} {t("sources")}</small>
              </span>
            </label>
            <small>{profileDescription(profile)}</small>
          </article>
        {/each}
        <article class:recommendedModel={easyInstallAi}>
          <label class="checkRow">
            <input type="checkbox" bind:checked={easyInstallAi} />
            <span>
              <strong>{t("installRecommendedAi")}</strong>
              <small>{recommendedInstallSummary()}</small>
            </span>
          </label>
          <small>{t("installRecommendedAiHelp")}</small>
        </article>
      </div>
      <div class="stats">
        <span>{t("profilesSelected", { count: selectedEasyProfiles.length })}</span>
        <span>{t("preparedDiskEstimate", { size: gb(selectedEasyPreparedBytes) })}</span>
        <span>{t("compressedDownload", { size: gb(selectedEasyDownloadBytes) })}</span>
        <span>{easyInstallAi ? t("localAiIncluded") : t("localAiSkipped")}</span>
      </div>
      <div class="centerAction">
        <button class="primaryAction startEasyInstallButton" type="button" on:click={easyInstall} disabled={busy.has("easy-install") || (!selectedEasyProfiles.length && !easyInstallAi)}>
          {busy.has("easy-install") ? t("installing") : t("startEasyInstall")}
        </button>
      </div>
      {#if easyInstallProgress}
        <div class="progressPanel">
          <div class="progressHeader">
            <strong>{phaseLabel(easyInstallProgress.phase) || t("easyInstallProgressTitle")}</strong>
            <span>{easyInstallProgress.percent ?? 0}%</span>
          </div>
	          <progress max="100" value={easyInstallProgress.percent ?? 0}></progress>
	          <small>{detailLabel(easyInstallProgress.detail)}</small>
	          <small>{easyInstallProgressLine(easyInstallProgress)}</small>
	          {#if easyInstallProgress.phase === "index" && activeIndexItems.length}
	            <div class="indexingList">
	              {#each activeIndexItems as item}
	                {@const indexInfo = sourceIndexInfo(item.sourceId)}
	                <div class="resourceRow compactResource">
	                  <span>
	                    <strong>{sourceTitleById(item.sourceId, item.title)}</strong>
	                    <small>
	                      {indexInfo?.label ?? t("indexingQueued")}
	                      {#if item.chunks} · {t("chunksIndexed", { count: item.chunks })}{/if}
	                      {#if item.pages} · {t("pagesIndexed", { count: item.pages })}{/if}
	                      {#if item.error} · {item.error}{/if}
	                    </small>
	                  </span>
	                  <span class="sourceProgress">
	                    {#if indexInfo?.current}
	                      <progress></progress>
	                    {:else}
	                      <progress max="100" value={indexInfo?.progress ?? 0}></progress>
	                    {/if}
	                  </span>
	                </div>
	              {/each}
	            </div>
	          {/if}
	        </div>
	      {/if}
      {#if showEasyAiProgress}
        <div class="progressPanel aiProgress">
          <div class="progressHeader">
            <strong>{sourceTitleById(aiInstallProgress.sourceId, aiInstallProgress.item ?? t("localAiSetup"))}</strong>
            <span>{phaseLabel(aiInstallProgress.phase ?? aiInstallProgress.status)}</span>
          </div>
          <progress max="100" value={aiInstallProgress.percent ?? 0}></progress>
          <small>{detailLabel(aiInstallProgress.detail)}</small>
          <small>{progressLine(aiInstallProgress)}</small>
        </div>
      {/if}
    </section>
    {/if}

    {#if activeTab === "dashboard"}
    <section class="band">
      <div class="sectionHeader">
        <h2>{t("profiles")}</h2>
        <label class="languageControl">
          {t("contentLanguage")}
          <select value={contentLanguage} on:change={e => setContentLanguage((e.currentTarget as HTMLSelectElement).value)}>
            <option value="en">{t("english")}</option>
            <option value="es">{t("spanish")}</option>
            <option value="both">{t("bilingual")}</option>
          </select>
        </label>
        <input placeholder={t("filterProfileSources")} bind:value={filter} />
      </div>
      <p>{t("profilesHelp")}</p>
      <div class="stats">
        <span>{contentProfiles.length} {t("profiles").toLowerCase()}</span>
        <span>{contentSources.length} {t("catalogSources")}</span>
        <span>{state.documents.length} {t("indexedDocuments")}</span>
        <span>{state.blobs.length} {t("uniqueBlobs")}</span>
        <span>{state.services.filter((service) => service.status === "running").length} {t("servicesRunning")}</span>
      </div>
	      {#if system}
	        <div class="stats">
	          <span>{system.platform}/{system.arch}</span>
          <span>{system.cpuCount} {t("cpuThreads")}</span>
          <span>{gb(system.totalMemBytes)} RAM</span>
          <span>{t("aiRecommendations")}: {system.aiRecommendation.join(", ") || t("aiNone")}</span>
	        </div>
	      {/if}
	      {#if activeIndexingProgress?.status === "running"}
	        <div class="progressPanel">
	          <div class="progressHeader">
	            <strong>{t("indexingNow")}</strong>
	            <span>{activeIndexingProgress.percent ?? 0}%</span>
	          </div>
	          <progress max="100" value={activeIndexingProgress.percent ?? 0}></progress>
	          <small>{t("indexProgressSummary", { done: activeIndexingProgress.completed ?? 0, total: activeIndexingProgress.total ?? 0, failed: activeIndexingProgress.failed ?? 0 })}</small>
	          <small>{detailLabel(activeIndexingProgress.detail)}</small>
	          <div class="indexingList">
	            {#each activeIndexItems as item}
	              {@const indexInfo = sourceIndexInfo(item.sourceId)}
	              <div class="resourceRow compactResource">
	                <span>
	                  <strong>{sourceTitleById(item.sourceId, item.title)}</strong>
	                  <small>{indexInfo?.label ?? t("indexingQueued")}</small>
	                </span>
	                <span class="sourceProgress">
	                  {#if indexInfo?.current}
	                    <progress></progress>
	                  {:else}
	                    <progress max="100" value={indexInfo?.progress ?? 0}></progress>
	                  {/if}
	                </span>
	              </div>
	            {/each}
	          </div>
	        </div>
	      {/if}
	    </section>

    {#if loadingCatalog}
      <section class="band emptyState">
        <h2>{t("loadingProfiles")}</h2>
        <p>{t("loadingProfilesHelp")}</p>
      </section>
    {:else if catalogError}
      <section class="band emptyState">
        <h2>{t("profilesCouldNotLoad")}</h2>
        <p>{t("backendNotResponding")}</p>
        <small>{catalogError}</small>
        <button type="button" on:click={load}>{t("retryLoadingProfiles")}</button>
      </section>
    {:else if contentProfiles.length === 0}
      <section class="band emptyState">
        <h2>{t("noProfilesFound")}</h2>
        <p>{t("noProfilesFoundHelp")}</p>
        <button type="button" on:click={load}>{t("retryLoadingProfiles")}</button>
      </section>
    {:else}
    {#each contentProfiles as profile, index}
      {@const added = addedSources(profile)}
      {@const progress = profileProgressInfo(profile)}
      {@const hasDownloadableSources = profileHasDownloadableSources(profile)}
      <section class="band profileCard">
        <div class="sectionHeader">
          <div>
            <h2>{profileTitle(profile)}</h2>
            <small>{profileSubtitle(profile, index)}</small>
          </div>
          <span class="tooltipHost" title={downloadProfileTooltip(profile)}>
            <button aria-label={downloadProfileTooltip(profile)} on:click={() => downloadProfile(profile)} disabled={!hasDownloadableSources || busy.has(`profile-${profile.id}`)}>
              {hasDownloadableSources ? t("downloadFullProfile") : t("profileDownloaded")}
            </button>
          </span>
        </div>
        <p>{profileDescription(profile)}</p>
        <div class="stats">
          <span>{t("addonSourcesShown", { count: added.length })}</span>
          <span>{t("preparedAddonDisk", { size: gb(profile.addedPreparedSizeBytes ?? profile.addedExpectedSizeBytes ?? 0) })}</span>
          <span>{t("totalSourcesFullProfile", { count: profile.sourceIds.length })}</span>
          <span>{t("preparedFullProfile", { size: gb(profile.preparedSizeBytes ?? profile.expectedSizeBytes) })}</span>
          <span>{t("compressedDownload", { size: gb(profile.expectedSizeBytes) })}</span>
        </div>
        <div class="progressPanel">
          <div class="progressHeader">
            <strong>{t("fullProfileProgress")}</strong>
            <span>{progress.progress}% · {gb(progress.received)} / {gb(progress.total)}</span>
          </div>
          <progress max="100" value={progress.progress}></progress>
          <small>{t("progressSummary", { done: progress.done, active: progress.active, failed: progress.failed })}</small>
        </div>
        <div class="table">
          <div class="row head">
            <span>{t("addonSource")}</span><span>{t("type")}</span><span>{t("preparedDiskColumn")}</span><span>{t("status")}</span><span>{t("actions")}</span>
          </div>
          {#each added as source}
            {@const info = sourceProgressInfo(source)}
            {@const indexInfo = sourceIndexInfo(source.id)}
            {@const sourceDownloading = ["queued", "downloading", "resuming"].includes(String(info.downloadRow?.status ?? ""))}
            {@const downloaded = sourceIsDownloaded(info.local ?? {})}
            {@const indexBusy = sourceIsIndexing(source.id)}
            {@const indexLine = sourceIndexProgressLine(indexInfo)}
            {@const verifyNotice = verifyFeedback[source.id]}
            <div class="row">
              <span>
                <strong>{sourceTitle(source)}</strong>
                <small>{sourceCategory(source)} · {licenseLabel(source.license)} · {info.local?.local_path ?? t("notDownloaded")}</small>
              </span>
              <span>{sourceTypeLabel(source.type)}</span>
              <span>{gb(preparedSize(source))}</span>
              <span class="sourceProgress">
                <span class:ok={!indexBusy && (indexInfo?.complete || statusTone(info.status) === "ok")} class:warn={indexBusy || statusTone(info.status) === "warn"} class:bad={indexInfo?.failed || statusTone(info.status) === "bad"}>{indexBusy ? indexActionLabel(source.id) : indexInfo?.label ?? statusLabel(info.status)}</span>
                {#if indexBusy}
                  <progress></progress>
                  <small>{indexLine || t("indexingLargeFiles")}</small>
                  {#if indexLine}
                    <small>{t("indexingLargeFiles")}</small>
                  {/if}
                {:else if info.totalKnown}
                  <progress max="100" value={info.progress}></progress>
                  <small>{info.progress}% · {gb(info.received)} / {gb(info.total)}</small>
                {:else}
                  <progress></progress>
                  <small>{t("downloadedTotalUnknown", { size: gb(info.received) })}</small>
                {/if}
              </span>
              <span class="actions">
                {#if downloaded}
                  <small>{t("downloaded")}</small>
                {:else}
                  <span class="tooltipHost" title={downloadTooltip(source)}>
                    <button aria-label={downloadTooltip(source)} on:click={() => download(source.id)} disabled={busy.has(`download-${source.id}`) || sourceDownloading}>{t("download")}</button>
                  </span>
                {/if}
                <span class="tooltipHost" title={verifyTooltip(source)}>
                  <button aria-label={verifyTooltip(source)} on:click={() => verify(source.id)} disabled={!info.local?.local_path || busy.has(`verify-${source.id}`) || sourceDownloading}>{t("verify")}</button>
                </span>
                <span class="tooltipHost" title={indexTooltip(source)}>
                  <button aria-label={indexTooltip(source)} on:click={() => indexSource(source.id)} disabled={!info.local?.local_path || busy.has(`index-${source.id}`) || sourceDownloading || indexBusy}>{indexActionLabel(source.id)}</button>
                </span>
                <span class="tooltipHost" title={openTooltip(source)}>
                  <button aria-label={openTooltip(source)} on:click={() => openOriginal(source.id)} disabled={!info.local?.local_path || busy.has(`open-${source.id}`)}>{t("open")}</button>
                </span>
                {#if indexBusy}
                  <small class="inlineFeedback liveFeedback">{indexLine || t("indexingLargeFiles")}</small>
                {/if}
                {#if verifyNotice}
                  <small class="inlineFeedback" class:ok={verifyNotice.ok} class:bad={!verifyNotice.ok}>{verifyNotice.message}</small>
                {/if}
              </span>
            </div>
          {:else}
            <div class="row emptyRow">
              <span>{t("noAddonSourcesMatch")}</span><span></span><span></span><span></span><span></span>
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
        <h2>{t("downloads")}</h2>
        <div class="maintenanceActions">
          <span>
            <button on:click={reconcile} disabled={busy.has("reconcile")}>{t("checkFiles")}</button>
            <small>{t("checkFilesHelp")}</small>
            {#if maintenanceFeedback}
              <small class="inlineFeedback" class:ok={maintenanceFeedback.ok} class:bad={!maintenanceFeedback.ok}>{maintenanceFeedback.message}</small>
            {/if}
          </span>
          <span>
            <button on:click={cleanupPartials} disabled={busy.has("partials")}>{t("removePartialFiles")}</button>
            <small>{t("removePartialFilesHelp")}</small>
          </span>
        </div>
      </div>
      <div class="table">
        <div class="row head">
          <span>{t("source")}</span><span>{t("status")}</span><span>{t("progress")}</span><span>{t("total")}</span><span>{t("actions")}</span>
        </div>
        {#each state.downloads as downloadRow}
          {@const canPause = ["queued", "downloading", "resuming"].includes(String(downloadRow.status))}
          {@const canRetry = ["failed", "paused"].includes(String(downloadRow.status))}
          {@const downloadReceived = Number(downloadRow.bytes_received || 0)}
          {@const downloadTotal = downloadRow.status === "complete" && !Number(downloadRow.total_bytes || 0) ? downloadReceived : Number(downloadRow.total_bytes || 0)}
          {@const downloadProgress = downloadTotal > 0 ? Math.min(100, Math.round((downloadReceived / downloadTotal) * 100)) : 0}
          {@const downloadTotalKnown = downloadTotal > downloadReceived || downloadRow.status === "complete" || downloadReceived === 0}
          {@const pauseBusy = busy.has(`pause-${downloadRow.source_id}`)}
          {@const retryBusy = busy.has(`retry-${downloadRow.source_id}`)}
          <div class="row">
            <span>{sourceTitleById(downloadRow.source_id)}<small>{downloadRow.error}</small></span>
            <span class:ok={statusTone(downloadRow.status) === "ok"} class:warn={statusTone(downloadRow.status) === "warn"} class:bad={statusTone(downloadRow.status) === "bad"}>{statusLabel(downloadRow.status)}</span>
            <span class="sourceProgress">
              {#if downloadTotalKnown}
                <progress max="100" value={downloadProgress}></progress>
                <small>{downloadProgress}% · {gb(downloadReceived)} {t("downloaded").toLowerCase()}</small>
              {:else}
                <progress></progress>
                <small>{t("downloadedTotalUnknown", { size: gb(downloadReceived) })}</small>
              {/if}
            </span>
            <span>{gb(downloadRow.total_bytes)}</span>
            <span class="actions">
              {#if canPause}
                <button on:click={() => pause(downloadRow.source_id)} disabled={pauseBusy}>{t("pause")}</button>
              {:else if canRetry}
                <button on:click={() => retry(downloadRow.source_id)} disabled={retryBusy}>{t("retry")}</button>
              {:else}
                <small>{t("noActionNeeded")}</small>
              {/if}
            </span>
          </div>
        {/each}
      </div>
      {#if recovery}
        <article class="answer">
          <strong>{t("recoveryScan")}</strong>
          <small>{t("repairedMissingPartials", { repaired: recovery.repaired.length, missing: recovery.missing.length, partials: recovery.partials.length })}</small>
        </article>
      {/if}
    </section>
    {/if}

    {#if activeTab === "extra"}
    <section id="extra-knowledge" class="band">
      <div class="sectionHeader">
        <div>
          <h2>{t("extraKnowledge")}</h2>
          <small>{t("extraKnowledgeHelp")}</small>
        </div>
        <span class="actions">
          <button type="button" on:click={indexImportedExtraFiles} disabled={busy.has("extra-index") || !extraImportedSources.some((source) => source.local_path && !fullyIndexedSourceIds.has(source.id))}>{t("indexImported")}</button>
        </span>
      </div>
      <div class="pathPicker">
        <input placeholder="/home/you/Documents/offline-notes" bind:value={extraFolderPath} />
        <button type="button" on:click={pickExtraFolder} disabled={busy.has("extra-folder")}>{t("chooseFolder")}</button>
        <button type="button" on:click={scanExtraFolder} disabled={busy.has("extra-scan") || !extraFolderPath.trim()}>{t("scanFolder")}</button>
      </div>
      {#if extraScan}
        <div class="stats">
          <span>{t("supportedFiles", { count: extraFiles.length })}</span>
          <span>{t("selectedFolderData", { size: gb(extraScan.totalBytes ?? 0) })}</span>
          <span>{t("unsupportedSkipped", { count: extraScan.skippedUnsupported ?? 0 })}</span>
        </div>
        <article class="infoCard">
          <div class="sectionHeader compactHeader">
            <div>
              <h3>{t("filesFound")}</h3>
              <small>{t("selectedImportHelp", { count: selectedExtraFiles.length })}</small>
            </div>
            <span class="actions">
              <button type="button" on:click={() => setAllExtraSelections(true)} disabled={!extraFiles.length}>{t("selectAll")}</button>
              <button type="button" on:click={() => setAllExtraSelections(false)} disabled={!extraFiles.length}>{t("clear")}</button>
              <label class="inlineCheckbox">
                <input type="checkbox" bind:checked={extraIndexOnImport} />
                <span>{t("indexAfterImport")}</span>
              </label>
              <button class="primaryAction" type="button" on:click={importSelectedExtraFiles} disabled={busy.has("extra-import") || !selectedExtraFiles.length}>{t("importSelected")}</button>
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
              <small>{t("noSupportedFiles")}</small>
            {/each}
          </div>
        </article>
      {/if}
      {#if extraImportResult}
        <article class="answer">
          <strong>{t("importedFiles", { count: extraImportResult.imported?.length ?? 0 })}</strong>
          <small>{t("indexedOrRegistered", { count: extraImportResult.indexed?.length ?? 0 })}</small>
        </article>
      {/if}
      <article class="infoCard">
        <h3>{t("importedLocalSources")}</h3>
        <small class="cardIntro">{extraImportedSources.length ? t("importedLocalSourcesHelp") : t("importedLocalSourcesEmpty")}</small>
        {#if extraImportedSources.length}
          {#each extraImportedSources as source}
            <div class="resourceRow">
              <span>
                <strong>{sourceTitle(source)}</strong>
                <small>{sourceTypeLabel(source.type)} · {statusLabel(source.status)} · {source.local_path}</small>
              </span>
              <span class="actions">
                <button type="button" on:click={() => openOriginal(source.id)} disabled={busy.has(`open-${source.id}`) || !source.local_path}>{t("openButton")}</button>
                <button type="button" on:click={() => indexSource(source.id)} disabled={busy.has(`index-${source.id}`) || !source.local_path}>{indexActionLabel(source.id)}</button>
                {#if busy.has(`index-${source.id}`)}
                  <small class="inlineFeedback">{t("indexingLargeFiles")}</small>
                {/if}
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
        <h2>{t("search")}</h2>
        <span class="actions">
          <span class="tooltipHost" title={indexableDownloadedSources.length || !downloadedIndexSources.length ? t("indexAllDownloadedTooltip") : t("reindexAllDownloadedTooltip")}>
            <button type="button" on:click={indexAllDownloaded} disabled={busy.has("index-all-downloaded") || (!indexableDownloadedSources.length && !downloadedIndexSources.length)}>
              {indexableDownloadedSources.length ? t("indexDownloadedCount", { count: indexableDownloadedSources.length }) : downloadedIndexSources.length ? t("reindexAllDownloaded") : t("allDownloadedIndexed")}
            </button>
          </span>
        </span>
        <form class="searchForm" on:submit|preventDefault={searchNow}>
          <input placeholder={t("searchIndexed")} bind:value={query} />
          <select bind:value={searchSource}>
            <option value="">{t("allSearchable")}</option>
            {#each searchableSources as source}
              <option value={source.id}>{sourceTitle(source)}</option>
            {/each}
          </select>
          <select bind:value={searchLicense}>
            <option value="">{t("allLicenses")}</option>
            {#each licenseOptions as license}
              <option value={license}>{licenseLabel(license)}</option>
            {/each}
          </select>
          <span class="searchModeActions">
            <span class="tooltipHost" title={t("searchTooltip")}>
              <button aria-label={t("searchTooltip")} class="searchSubmitButton" class:active={searching && searchMode === "keyword"} disabled={searching || !query.trim()}>
                {#if searching && searchMode === "keyword"}
                  <span class="spinner" aria-hidden="true"></span>
                  {t("searching")}
                {:else}
                  {t("search")}
                {/if}
              </button>
            </span>
            <span class="tooltipHost" title={t("semanticSearchTooltip")}>
              <button aria-label={t("semanticSearchTooltip")} class="searchSubmitButton" class:active={searching && searchMode === "semantic"} type="button" on:click={semanticSearchNow} disabled={searching || !query.trim()}>
                {#if searching && searchMode === "semantic"}
                  <span class="spinner" aria-hidden="true"></span>
                  {t("semanticSearching")}
                {:else}
                  {t("semantic")}
                {/if}
              </button>
            </span>
          </span>
        </form>
      </div>
      <div class="resourceGrid">
	        <article class="infoCard">
	          <h3>{t("searchableResources")}</h3>
          <small class="cardIntro">{searchableSources.length ? t("searchableResourcesReady") : t("searchableResourcesEmpty")}</small>
          {#if searchableSources.length}
            <div class="actions resourceScroll resourceButtonScroll">
              {#each searchableSources as source}
                <button type="button" class:active={searchSource === source.id} on:click={() => searchSource = source.id}>{sourceTitle(source)}</button>
              {/each}
              <button type="button" class:active={!searchSource} on:click={() => searchSource = ""}>{t("all")}</button>
            </div>
	          {/if}
	        </article>
	        {#if activeIndexingProgress?.status === "running"}
	          <article class="infoCard">
		            <h3>{t("indexingNow")}</h3>
		            <small class="cardIntro">{t("indexingNowHelp")}</small>
		            <small>{t("indexProgressSummary", { done: activeIndexingProgress.completed ?? 0, total: activeIndexingProgress.total ?? 0, failed: activeIndexingProgress.failed ?? 0 })}</small>
		            <div class="resourceScroll">
		              {#each activeIndexItems as item}
		                {@const indexInfo = sourceIndexInfo(item.sourceId)}
		                <div class="resourceRow">
		                  <span>
		                    <strong>{sourceTitleById(item.sourceId, item.title)}</strong>
		                    <small>
		                      {indexInfo?.label ?? t("indexingQueued")}
		                      {#if item.chunks} · {t("chunksIndexed", { count: item.chunks })}{/if}
		                      {#if item.pages} · {t("pagesIndexed", { count: item.pages })}{/if}
		                    </small>
		                  </span>
		                  <span class="sourceProgress">
		                    {#if indexInfo?.current}
		                      <progress></progress>
		                    {:else}
		                      <progress max="100" value={indexInfo?.progress ?? 0}></progress>
		                    {/if}
		                  </span>
		                </div>
		              {/each}
		            </div>
		          </article>
		        {/if}
	        <article class="infoCard">
	          <h3>{t("downloadingNow")}</h3>
	          <small class="cardIntro">{t("downloadingNowHelp")}</small>
	          {#if activeDownloadSources.length}
	            <div class="resourceScroll">
	              {#each activeDownloadSources as source}
	                {@const info = sourceProgressInfo(source)}
	                <div class="resourceRow">
	                  <span>
	                    <strong>{sourceTitle(source)}</strong>
	                    <small>{statusLabel(info.downloadRow?.status ?? "queued")} · {info.progress}% · {gb(info.received)} / {gb(info.total)}</small>
	                  </span>
	                  <span class="sourceProgress">
	                    <progress max="100" value={info.progress}></progress>
	                  </span>
	                </div>
	              {/each}
	            </div>
	          {:else}
	            <small class="emptyNote">{t("noActiveDownloads")}</small>
	          {/if}
        </article>
        <article class="infoCard">
          <h3>{t("downloadedNeedsIndex")}</h3>
	          <small class="cardIntro">{t("downloadedNeedsIndexHelp")}</small>
	          {#if notSearchableDownloads.length}
	            <div class="resourceScroll">
		            {#each notSearchableDownloads as source}
		              {@const downloadRow = downloadState.get(source.id)}
		              {@const indexInfo = sourceIndexInfo(source.id)}
		              {@const sourceDownloading = ["queued", "downloading", "resuming"].includes(String(downloadRow?.status ?? ""))}
	                {@const verifyNotice = verifyFeedback[source.id]}
	                <div class="resourceRow">
		                  <span>
		                    <strong>{sourceTitle(source)}</strong>
		                    <small>{indexInfo?.label ?? (source.type === "repo-archive" ? t("openThenIndex") : t("indexBeforeSearch"))}</small>
		                    {#if indexInfo?.current}
		                      <span class="sourceProgress">
		                        <progress></progress>
		                        <small>{t("indexingLargeFiles")}</small>
		                      </span>
		                    {/if}
		                  </span>
	                  <span class="actions">
	                    <span class="tooltipHost" title={openTooltip(source)}>
	                      <button type="button" aria-label={openTooltip(source)} on:click={() => openOriginal(source.id)} disabled={busy.has(`open-${source.id}`)}>{t("openButton")}</button>
	                    </span>
		                    <span class="tooltipHost" title={indexTooltip(source)}>
		                      <button type="button" aria-label={indexTooltip(source)} on:click={() => indexSource(source.id)} disabled={busy.has(`index-${source.id}`) || sourceDownloading || indexInfo?.current}>{indexActionLabel(source.id)}</button>
		                    </span>
	                    {#if busy.has(`index-${source.id}`)}
	                      <small class="inlineFeedback">{t("indexingLargeFiles")}</small>
	                    {/if}
	                    {#if verifyNotice}
	                      <small class="inlineFeedback" class:ok={verifyNotice.ok} class:bad={!verifyNotice.ok}>{verifyNotice.message}</small>
	                    {/if}
	                  </span>
	                </div>
	              {/each}
	            </div>
	          {:else}
	            <small>{t("noDownloadedNeedsIndex")}</small>
	          {/if}
        </article>
      </div>
      <div class="results">
        {#if searching}
          <article class="answer searchBusyPanel">
            <span class="spinner largeSpinner" aria-hidden="true"></span>
            <strong>{searchMode === "semantic" ? t("semanticSearching") : t("searching")}</strong>
            <small>{t("searchInProgress")}</small>
          </article>
        {/if}
        {#each searchResults as result}
          <button
            type="button"
            class="resultCard clickableResult"
            title={t("openSearchResultTitle")}
            on:click={() => openSearchHit(result)}
          >
            <h3>{sourceTitleById(result.source_id, result.title)}</h3>
            <p>{@html result.snippet}</p>
            <small>{result.path} · {t("clickToOpenMatch")}</small>
          </button>
        {/each}
      </div>
    </section>
    {/if}

    {#if activeTab === "ai"}
    <section id="ai-recommended-setup" class="band">
      <div class="sectionHeader">
        <div>
          <h2>{t("recommendedLocalAiSetup")}</h2>
          <small>{t("localAiInstallHelp")}</small>
        </div>
        <button class="primaryAction" on:click={installRecommendedAi} disabled={loadingCatalog || busy.has("ai-install")}>
          {busy.has("ai-install") ? t("installingAllRecommended") : t("installAllRecommended")}
        </button>
      </div>
      <div class="stats">
        <span>{recommendedInstallSummary()}</span>
        <span>{system?.tier ? tierLabel(system.tier) : t("machineTierUnknown")}</span>
      </div>
      {#if showAiInstallProgress}
        <div class="progressPanel aiProgress">
          <div class="progressHeader">
            <strong>{sourceTitleById(aiInstallProgress.sourceId, aiInstallProgress.item ?? t("localAiSetup"))}</strong>
            <span class:bad={aiInstallProgress.status === "failed"}>{phaseLabel(aiInstallProgress.phase ?? aiInstallProgress.status)}</span>
          </div>
          <progress max="100" value={aiInstallProgress.percent ?? 0}></progress>
          <small>{detailLabel(aiInstallProgress.detail)}</small>
          <small>{progressLine(aiInstallProgress)}</small>
        </div>
      {:else if aiInstallComplete}
        <div class="progressPanel aiProgress">
          <div class="progressHeader">
            <strong>{t("recommendedAiInstalled")}</strong>
            <span class="ok">{t("complete")}</span>
          </div>
          <progress max="100" value="100"></progress>
          <small>{detailLabel(aiInstallProgress.detail)}</small>
        </div>
      {/if}
    </section>

    <section id="ai-service" class="band">
      <div class="sectionHeader">
        <h2>{t("aiService")}</h2>
        <button on:click={refreshServices}>{t("refresh")}</button>
      </div>
      <div class="serviceGrid">
        {#each aiServiceCards as service}
          {@const serviceRunning = service.status === "running"}
          <article>
            <strong>{service.name}</strong>
            <span class:ok={statusTone(service.status) === "ok"} class:warn={statusTone(service.status) === "warn"} class:bad={statusTone(service.status) === "bad"}>{statusLabel(service.status)}</span>
            <small>{service.url}</small>
            {#if serviceRunning}
              <button on:click={() => stop(service.name)} disabled={busy.has(`stop-${service.name}`)}>{t("stop")}</button>
            {:else if service.status === "installing" || service.status === "starting"}
              <small>{service.message ? detailLabel(service.message) : t("localAiSetupInProgress")}</small>
            {:else if service.status === "blocked"}
              <small>{service.message ? detailLabel(service.message) : t("localAiBlockedByRam")}</small>
            {:else if service.status === "missing"}
              <small>{t("localAiRuntimeMissingHelp")}</small>
            {:else if service.name === "ollama" && (service.status === "available" || service.status === "stopped" || service.status === "failed")}
              {#if startAiModel}
                <small>{t("startupGuard", { available: gb(system?.availableMemBytes ?? 0), required: gb(startAiRequiredBytes), model: modelTitle(startAiModel) })}</small>
                {#if startAiSwapPressure}
                  <small>{t("swapTooFull")}</small>
                {/if}
              {:else}
                <small>{t("installChatModelFirst")}</small>
              {/if}
              <button on:click={startOllama} disabled={busy.has("ollama-start") || !startAiAllowed}>{t("startOllama")}</button>
            {:else}
              <small>{t("noRunningServiceToStop")}</small>
            {/if}
          </article>
        {/each}
      </div>
    </section>

    <section id="models" class="band">
      <div class="sectionHeader">
        <h2>{t("models")}</h2>
        <button on:click={refreshModels}>{t("refreshModels")}</button>
      </div>
      {#if recommendedChatModel || recommendedEmbeddingModel}
        <div class="recommendationPanel">
          {#if recommendedChatModel}
            <article class="recommendedModel">
              <span class="badge">{t("recommendedChatBadge")}</span>
              <strong>{modelTitle(recommendedChatModel)}</strong>
              <small>{recommendationReason(recommendedChatModel)}</small>
              <small>{recommendedChatModel.pull} · {gb(recommendedChatModel.expected_size_bytes)} · {statusLabel(recommendedChatModel.status)}</small>
              <button class="primaryAction" on:click={() => pullModel(recommendedChatModel.id)} disabled={busy.has(`model-${recommendedChatModel.id}`) || recommendedChatModel.status === "pulling" || recommendedChatModel.status === "installed"}>
                {recommendedChatModel.status === "installed" ? t("installed") : t("pullRecommendedChatModel")}
              </button>
            </article>
          {/if}
          {#if recommendedEmbeddingModel}
            <article class="recommendedModel">
              <span class="badge">{t("recommendedEmbeddingBadge")}</span>
              <strong>{modelTitle(recommendedEmbeddingModel)}</strong>
              <small>{recommendationReason(recommendedEmbeddingModel)}</small>
              <small>{recommendedEmbeddingModel.pull} · {gb(recommendedEmbeddingModel.expected_size_bytes)} · {statusLabel(recommendedEmbeddingModel.status)}</small>
              <button class="primaryAction" on:click={() => pullModel(recommendedEmbeddingModel.id)} disabled={busy.has(`model-${recommendedEmbeddingModel.id}`) || recommendedEmbeddingModel.status === "pulling" || recommendedEmbeddingModel.status === "installed"}>
                {recommendedEmbeddingModel.status === "installed" ? t("installed") : t("pullRecommendedEmbedding")}
              </button>
            </article>
          {/if}
        </div>
      {/if}
      <div class="serviceGrid">
        {#each availableModels as model}
          <article class:recommendedModel={model.id === recommendedChatModel?.id || model.id === recommendedEmbeddingModel?.id}>
            <strong>{modelTitle(model)}</strong>
            <span class:ok={statusTone(model.status) === "ok"} class:warn={statusTone(model.status) === "warn"} class:bad={statusTone(model.status) === "bad"}>{statusLabel(model.status)}</span>
            <small>{t("engine")}: {model.runtime} · {model.pull} · {modelRoleLabel(model.role)} · {gb(model.expected_size_bytes)}</small>
            {#if model.id === recommendedChatModel?.id}
              <small>{t("recommendedChatForTier", { tier: system?.tier ? tierLabel(system.tier) : t("thisPc") })}</small>
            {/if}
            {#if model.id === recommendedEmbeddingModel?.id}
              <small>{t("recommendedEmbeddingHelp")}</small>
            {/if}
            <button class:primaryAction={model.id === recommendedChatModel?.id || model.id === recommendedEmbeddingModel?.id} on:click={() => pullModel(model.id)} disabled={busy.has(`model-${model.id}`) || model.status === "pulling" || model.status === "installed"}>
              {model.status === "installed" ? t("installed") : model.id === recommendedChatModel?.id || model.id === recommendedEmbeddingModel?.id ? t("pullRecommended") : t("pull")}
            </button>
          </article>
        {/each}
      </div>
    </section>

    <section id="ai" class="band">
      <div class="sectionHeader">
        <h2>{t("localAi")}</h2>
        <span class="actions">
          <span>{t("indexedResourcesAvailable", { count: indexedSources.length })}</span>
          <button type="button" on:click={restartConversation} disabled={askBusy || !chatTurns.length}>{t("restartConversation")}</button>
          <button type="button" on:click={indexAllDownloaded} disabled={busy.has("index-all-downloaded") || (!indexableDownloadedSources.length && !downloadedIndexSources.length)}>
            {indexableDownloadedSources.length ? t("indexDownloadedCount", { count: indexableDownloadedSources.length }) : downloadedIndexSources.length ? t("reindexAllDownloaded") : t("allDownloadedIndexed")}
          </button>
        </span>
      </div>
      <p>{t("textIndexHelp")}</p>
      <form class="ask" on:submit|preventDefault={ask}>
        <select bind:value={questionSource}>
          <option value="">{t("allIndexedResources")}</option>
          {#each indexedSources as source}
            <option value={source.id}>{sourceTitle(source)}</option>
          {/each}
        </select>
        <select bind:value={questionModel} aria-label={t("chatModel")} disabled={!installedChatModels.length}>
          {#if installedChatModels.length}
            {#each installedChatModels as model}
              <option value={model.id}>{modelTitle(model)} · {model.pull}</option>
            {/each}
          {:else}
            <option value="">{t("installChatModelFirst")}</option>
          {/if}
        </select>
        <textarea placeholder={t("askPlaceholder")} bind:value={question}></textarea>
        <button class="askSubmitButton" disabled={askBusy || !question.trim() || !questionModel}>
          {#if askBusy}
            <span class="spinner" aria-hidden="true"></span>
            {t("askingOllama")}
          {:else}
            {t("askOllama")}
          {/if}
        </button>
      </form>
      {#if askBusy}
        <article class="answer searchBusyPanel">
          <span class="spinner largeSpinner" aria-hidden="true"></span>
          <strong>{t("askingOllama")}</strong>
          <small>
            {ollamaService?.status === "starting" || ollamaService?.status === "installing"
              ? t("askStartingOllama")
              : ollamaService?.status === "blocked"
                ? t("askBlockedHelp")
                : t("askInProgress")}
          </small>
          <small>{t("askGeneratedTokens", { count: Number(askProgress?.generatedTokens ?? 0) })}</small>
          {#if ollamaService?.message}
            <small>{detailLabel(ollamaService.message)}</small>
          {/if}
        </article>
      {/if}
      {#if chatTurns.length}
        <div class="chatThread">
          {#each chatTurns as turn}
            <article class="answer">
              <strong>{turn.question}</strong>
              <p>{turn.answer}</p>
              {#each turn.citations as citation}
                <small>[{citation.index}] {sourceTitleById(citation.source_id, citation.title)} · {citation.path}</small>
              {/each}
            </article>
          {/each}
        </div>
      {/if}
    </section>
    {/if}

    {#if activeTab === "share"}
    <section id="share" class="band">
      <div class="sectionHeader">
        <h2>{t("share")}</h2>
      </div>
      <p>{t("shareHelp")}</p>
      <article class="recommendedSetup">
        <div>
          <strong>{t("generatePackageTitle")}</strong>
          <small>{t("generatePackageHelp")}</small>
        </div>
        {#if shareOptions.length}
          <span class="actions">
            <select bind:value={shareProfile} aria-label={t("sourcesToShare")}>
              {#each shareOptions as option}
                <option value={option.id}>{option.title} · {gb(option.sizeBytes)} · {option.sourceCount} {t("sources")}</option>
              {/each}
            </select>
            <select bind:value={sharePrimaryOs} aria-label={t("primaryOperatingSystem")}>
              <option value="linux">{t("primaryLauncherLinux")}</option>
              <option value="windows">{t("primaryLauncherWindows")}</option>
              <option value="macos">{t("primaryLauncherMacos")}</option>
            </select>
            <button type="button" on:click={pickShareAppsFolder} disabled={busy.has("share-apps-folder")}>{t("appBundleFolder")}</button>
            <button class="primaryAction startEasyInstallButton" on:click={generateSharePackage} disabled={busy.has("share-package") || !shareProfile}>
              {busy.has("share-package") ? t("generatingSharePackage") : t("sharePackage")}
            </button>
          </span>
        {/if}
      </article>
      {#if shareAppsPath}
        <small class="pathHint">{t("appBundleFolderValue", { path: shareAppsPath })}</small>
      {:else}
        <small class="pathHint">{t("appBundleFolderHelp")}</small>
      {/if}
      {#if showSharePackageProgress}
        <div class="progressPanel">
          <div class="progressHeader">
            <strong>{profileTitleById(sharePackageProgress.profileId, sharePackageProgress.profileTitle ?? t("sharePackageProgressTitle"))}</strong>
            <span class:bad={sharePackageProgress.status === "failed"} class:ok={sharePackageProgress.status === "complete"}>{phaseLabel(sharePackageProgress.phase ?? sharePackageProgress.status)}</span>
          </div>
          <progress max="100" value={sharePackageProgress.percent ?? 0}></progress>
          <small>{detailLabel(sharePackageProgress.detail)}</small>
          {#if sharePackageProgress.total}
            <small>{t("shareProgressSources", { current: sharePackageProgress.current ?? 0, total: sharePackageProgress.total, percent: sharePackageProgress.percent ?? 0 })}</small>
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
          <strong>{t("noDownloadedSourcesReady")}</strong>
          <small>{t("noDownloadedSourcesReadyHelp")}</small>
        </article>
      {/if}
      {#if sharePackage}
        <article class="answer">
          <strong>{t("sharePackageReady")}</strong>
          {#if sharePackage.profile}
            <small>{t("profile")}: {profileTitle(sharePackage.profile)}</small>
          {/if}
          <small>{t("archive")}: {sharePackage.archivePath}</small>
          <small>{t("folder")}: {sharePackage.packageDir}</small>
          <small>{t("size")}: {gb(sharePackage.sizeBytes)}</small>
          <small>{t("checksum")}: {sharePackage.checksum}</small>
          <small>{t("checksumFile")}: {sharePackage.checksumPath}</small>
          {#if sharePackage.primaryOs}
            <small>{t("primaryLauncher")}: {sharePackage.primaryOs}</small>
          {/if}
          {#if sharePackage.apps?.length}
            <small>{t("includedAppFolders")}: {sharePackage.apps.map((app: any) => app.label).join(", ")}</small>
          {/if}
          {#each sharePackage.instructions as instruction}
            <small>{detailLabel(instruction)}</small>
          {/each}
        </article>
      {/if}
    </section>

    {/if}

    {#if activeTab === "logs"}
    <section id="logs" class="band">
      <div class="sectionHeader">
        <h2>{t("logs")}</h2>
        <button on:click={loadLogs} disabled={busy.has("logs")}>{t("refreshLogs")}</button>
      </div>
      <div class="logTableWrap">
        <table class="logTable">
          <thead>
            <tr>
              <th><button type="button" on:click={() => sortLogsBy("title")}>{t("title")}{logSortIndicator("title")}</button></th>
              <th><button type="button" on:click={() => sortLogsBy("description")}>{t("description")}{logSortIndicator("description")}</button></th>
              <th><button type="button" on:click={() => sortLogsBy("date")}>{t("date")}{logSortIndicator("date")}</button></th>
            </tr>
          </thead>
          <tbody>
            {#each sortedLogs as log}
              <tr>
                <td><strong>{logTitle(log)}</strong></td>
                <td>
                  <details class="logDetails">
                    <summary>{t("details")}</summary>
                    <p>{logDescription(log)}</p>
                    {#if log.data}
                      <small>{log.data}</small>
                    {/if}
                  </details>
                </td>
                <td><time datetime={log.created_at}>{logDateLabel(log)}</time></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
    {/if}
  </section>
</main>

{#if confirmDialog}
  <div class="modalBackdrop" role="presentation" on:click={() => answerConfirm(false)}>
    <div role="dialog" tabindex="-1" aria-modal="true" class:dangerModal={confirmDialog.tone === "danger"} class="confirmModal" aria-labelledby="confirm-title" on:click|stopPropagation on:keydown|stopPropagation>
      <div class="modalHeader">
        <div>
          <span class="modalKicker">{confirmDialog.tone === "danger" ? t("destructiveAction") : t("confirmation")}</span>
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
        <button type="button" on:click={() => answerConfirm(false)}>{confirmDialog.cancelLabel ?? t("cancel")}</button>
        <button type="button" class:dangerAction={confirmDialog.tone === "danger"} class:primaryAction={confirmDialog.tone !== "danger"} on:click={() => answerConfirm(true)}>
          {confirmDialog.confirmLabel ?? t("continue")}
        </button>
      </div>
    </div>
  </div>
{/if}
{/key}
