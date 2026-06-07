# Offline Survival: Final Tool Architecture

Last reviewed: 2026-06-03

## 1. Product Goal

Build a cross-platform desktop application that lets any non-technical user download, verify, organize, search, and run offline survival and civilization-rebuilding knowledge packs.

The tool is not a new wiki and must not become a hand-written content fork. The repository should provide the application, manifests, schemas, download logic, verification logic, indexes, launchers, and packaging recipes. The actual knowledge payloads should be downloaded from original or approved mirror sources into a local data library.

The end result should let a user:

- Choose a data profile, from small survival essentials to large civilization reconstruction bundles.
- Download official ZIMs, PDFs, EPUBs, repositories, manuals, model files, and metadata.
- Verify checksums and licenses.
- Browse downloaded ZIMs locally through Kiwix Server.
- Open PDFs, EPUBs, Markdown manuals, and extracted text locally.
- Search all downloaded practical content.
- Optionally install and manage Ollama plus local chat and embedding models.
- Ask local AI questions against selected downloaded documents with citations.
- See exactly what is downloaded, missing, outdated, indexing, indexed, running, stopped, or broken.
- Copy the whole archive to another disk and keep it usable offline.

The product should feel like a local knowledge appliance: install it, choose what kind of archive you want, download it, and then use the app as the control panel for every local reader, server, index, and model.

## 2. Non-Goals

- Do not write a replacement encyclopedia or survival wiki.
- Do not merge sources into one canonical article per topic.
- Do not remove overlap between sources unless files are exact duplicate payloads.
- Do not silently scrape questionable, copyrighted, pirated, weapons-focused, or legally unclear collections.
- Do not require Docker, Python, Git, Node, or terminal skills from the end user.
- Do not require a GPU.
- Do not require an account or cloud API.
- Do not auto-update content without the user explicitly approving a snapshot update.
- Do not hide original source identity behind a single blended article view.
- Do not make the LLM the primary interface. Browsing and search must work without AI.

## 3. Core Design Principles

### Manifest First

Every downloadable artifact is described in a manifest before it is downloaded. The app consumes these manifests rather than embedding source lists in UI code.

Manifests define:

- Source title and description.
- Bundle/profile membership.
- Download URL, mirror URLs, or catalog lookup rule.
- Expected size range.
- Exact checksum when known.
- License and attribution requirements.
- Source type: ZIM, PDF, EPUB, Git repo, wiki clone, model, binary tool, index, or generated derivative.
- Runtime behavior: browse, serve, index, embed, open externally, or use as a model.

### Preserve Originals

Raw downloaded artifacts remain untouched in `library/raw/`. Any extracted text, chunks, thumbnails, indexes, or embeddings are generated derivatives in separate folders. This keeps provenance clean and allows rebuilding indexes without re-downloading the source.

### Browse Originals, Search Derivatives

Humans browse the original artifact whenever possible:

- ZIM files through Kiwix.
- PDFs through the system PDF viewer or embedded PDF panel.
- EPUBs through an embedded reader or external reader.
- GitHub wiki Markdown through a rendered local view.

Search and AI use normalized derivatives:

- Markdown or plain text for full-text search.
- JSONL chunk records for retrieval.
- Vector indexes for semantic search.
- SQLite state and metadata for the app.

### Redundancy Is Acceptable

Near-duplicate sources are allowed. Three survival manuals or several offline wikis can coexist because their differences may matter. Only exact duplicate files should be detected and optionally de-duplicated by checksum.

Exact duplicate policy:

- If two manifest entries resolve to the same SHA-256, store one physical blob and create two logical source records.
- If two sources cover the same topic but have different files, titles, revisions, licenses, or checksums, keep both.
- Search results may group similar records visually, but must never delete or overwrite one source with another.

### Offline By Default

The app must keep working when disconnected after content has been downloaded. Online operations are explicit:

- Refresh catalog.
- Download selected content.
- Update manifest snapshot.
- Install runtime.
- Pull model.

### Localhost Boundaries

All local services must bind to `127.0.0.1` by default:

- Kiwix Server.
- Search API.
- App backend.
- Ollama API.

LAN sharing can exist later as an explicit advanced mode.

## 4. Recommended Application Stack

### Desktop Framework: Tauri v2

Use Tauri v2 as the app shell.

Reasons:

- Cross-platform portable app bundles and installers for Windows, macOS, and Linux.
- Smaller application size than Electron.
- Rust backend is a strong fit for filesystem scanning, process supervision, checksums, and local service orchestration.
- Web frontend still allows a polished UI.
- Bundled sidecar binaries are supported for tools like `kiwix-serve`.

### UI Framework: Svelte + TypeScript

Use Svelte + TypeScript for the v1 UI.

Reasons:

- Small frontend payload.
- Simple state model for local desktop UI.
- Low ceremony for dashboards, forms, progress views, and settings.
- Good fit for Tauri because most privileged work belongs in Rust commands, not the frontend.

### Electron Decision

Do not use Electron for v1.

Electron solves cross-platform desktop packaging, but this product needs heavy filesystem work, process supervision, checksums, and bundled sidecars. Tauri keeps that work in Rust and produces smaller installers. Electron can remain a future rewrite option only if Tauri packaging blocks release on a target OS.

Recommended decision:

- Build v1 in Tauri.
- Use Svelte + TypeScript for the UI.
- Use Rust commands for privileged local operations.
- Keep downloader/indexer logic in Rust.
- Use Python only as a development/build-time optional pipeline, not as an end-user dependency.

## 5. Installability and Packaging Requirements

The tool must be runnable by ordinary users on normal consumer machines. The primary distribution should be a ready-to-run portable app package, not a mandatory installer. Installers are a secondary convenience for users who want Start Menu entries, file associations, auto-update integration, or OS-managed app placement.

Supported operating systems for v1:

| OS | Primary package | Secondary package | Notes |
| --- | --- | --- | --- |
| Windows 10/11 x64 | Portable signed `.zip` containing `.exe` and sidecars | `.msi` or `.exe` installer | Installer should not be required. |
| macOS Apple Silicon | Signed/notarized `.app` inside `.dmg` | Portable `.zip` of `.app` | macOS security makes signing/notarization important even for portable use. |
| macOS Intel | Signed/notarized `.app` inside `.dmg` | Portable `.zip` of `.app` | Support while dependency/tooling ecosystem still supports it. |
| Linux x64 | `.AppImage` | `.deb`/`.rpm` later | AppImage is the portable primary target. |

Minimum practical hardware tiers:

| Tier | RAM | Disk | AI expectation |
| --- | --- | --- | --- |
| Browse-only | 4-8 GB | 20-80 GB | No local LLM, exact search only. |
| Survival AI | 8-16 GB | 64-128 GB | Small chat model, lightweight embeddings. |
| Core AI | 16-32 GB | 512 GB | 4B-8B chat model plus embeddings. |
| Rebuild workstation | 32-64 GB | 1-2 TB | Larger indexes and optional 14B-30B class models. |

Dependency strategy:

- The portable app package includes the UI, Rust backend, and bundled sidecars.
- `kiwix-serve` is bundled as a Tauri sidecar for each supported OS/architecture.
- Ollama is detected first, then installed through an official OS installer or guided flow as an optional runtime.
- Git is not required. GitHub repositories and wikis use archive downloads by default.
- Python, Node, Docker, Java, and command-line package managers must not be required for end users.
- Power users may enable external tools such as `aria2`, Git, or custom model runtimes.

First-run flow:

1. Choose app-local portable library mode or an external library directory.
2. Choose a library directory and disk budget.
3. Run OS/CPU/RAM/free-space detection.
4. Recommend compatible profiles and AI models.
5. Let the user select packs and optional AI.
6. Download, verify, register, and index selected content.

Public release requirements:

- Portable app package for every supported OS.
- Signed and checksummed release artifacts.
- Installers only as optional convenience packages.
- No terminal commands required for the main workflow.
- Clear recovery actions when downloads fail, checksums fail, ports conflict, or a runtime is missing.

## 6. Repository Layout

```text
survival-civilization-archive/
  README.md
  FINAL_TOOL_ARCHITECTURE.md
  LICENSE

  app/
    src-tauri/
      src/
        commands/
        download/
        manifests/
        runtime/
        services/
        state/
        verify/
      tauri.conf.json
      capabilities/
      binaries/
        windows/
        macos/
        linux/
    ui/
      src/
        components/
        pages/
        stores/
        styles/

  manifests/
    profiles/
      survival-essential.yaml
      survival-plus.yaml
      civilization-core.yaml
      civilization-rebuild.yaml
      civilization-max.yaml
    sources/
      kiwix.yaml
      survival-repos.yaml
      medical.yaml
      agriculture.yaml
      textbooks.yaml
      repair.yaml
      appropriate-tech.yaml
      governance.yaml
      models.yaml
      runtimes.yaml
    locks/
      2026-q2-survival-essential.lock.yaml
      2026-q2-civilization-core.lock.yaml

  schemas/
    source.schema.json
    profile.schema.json
    lock.schema.json
    state.schema.json
    license.schema.json

  policies/
    curation.md
    licensing.md
    medical-safety.md
    dangerous-content.md
    chunking.yaml
    indexing.yaml

  tools/
    manifest-lint/
    catalog-refresh/
    checksum-release/
    zim-probe/
    index-bench/

  docs/
    user-guide.md
    developer-guide.md
    bundle-format.md
    source-review-checklist.md

  library/                 # gitignored user data root
    raw/
    normalized/
    chunks/
    indexes/
    models/
    runtimes/
    logs/
    tmp/
    archive-state.sqlite
```

## 7. Local Data Layout

The app should let the user choose a library directory on first run. The default should be:

- Windows: `%USERPROFILE%\OfflineSurvival`
- macOS: `~/OfflineSurvival`
- Linux: `~/OfflineSurvival`
- Portable mode: `./OfflineSurvival` next to the executable

Recommended data layout:

```text
OfflineSurvival/
  raw/
    zim/
    pdf/
    epub/
    html/
    repos/
    models/
    runtimes/
  normalized/
    markdown/
    text/
  chunks/
    chunks.jsonl
    documents.jsonl
  indexes/
    fts.sqlite
    vectors.sqlite
    lancedb/
    kiwix-library.xml
  services/
    pids/
    ports.json
  logs/
  tmp/
  archive-state.sqlite
```

The library must be relocatable. Store paths relative to the library root where possible.

## 8. Content Organization Model

The app organizes external data without turning it into a single custom wiki.

Each source has three layers:

1. Original artifact: the downloaded ZIM, PDF, EPUB, repository archive, HTML export, model file, or runtime file.
2. Source record: metadata that describes origin, license, checksum, category, profile, and local path.
3. Optional derivative: extracted text, chunks, thumbnails, and indexes generated for search and AI.

The UI should expose the original source as the primary object. For example, iFixit remains "iFixit in English," the SurvivalManual wiki remains "SurvivalManual Wiki," and Wikipedia medicine remains its own Kiwix item.

Recommended domain taxonomy:

```text
survival/
  water
  fire
  shelter
  navigation
  weather
  food
  first-aid
  sanitation

medicine/
  emergency-care
  public-health
  infection-control
  maternal-health
  medicines

food-systems/
  soil
  seeds
  crops
  livestock
  irrigation
  storage
  preservation

repair/
  electronics
  appliances
  tools
  vehicles
  structures

science-education/
  mathematics
  physics
  chemistry
  biology
  anatomy

reconstruction/
  energy
  manufacturing
  materials
  communications
  governance
  education
  logistics
```

Tags are additive. A document about disinfecting water can be tagged as `survival/water`, `medicine/public-health`, and `sanitation`.

## 9. Data Profiles

Profiles are user-facing download options. They are not hardcoded lists; each profile is a manifest that includes groups of sources.

### Survival Essential

Target: 5-15 GB.

For users with limited disk space who want emergency survival, first aid, food, water, shelter, sanitation, and simple offline browsing.

Include:

- SurvivalManual repository and wiki.
- SurvivalManual ebook.
- Selected first aid and emergency medicine PDFs.
- Water, sanitation, shelter, food preservation, and basic agriculture PDFs.
- Simple Wikipedia or another small general reference ZIM.
- Optional tiny embedding model, no default chat model unless user chooses AI.

Expected user outcome:

- Can browse emergency knowledge offline.
- Can search local survival manuals.
- Can open practical PDFs.
- Can run without any AI runtime.

### Survival Plus

Target: 30-60 GB.

For a USB SSD or normal laptop.

Include:

- Everything in Survival Essential.
- Wikipedia top or selected broad English ZIM without images.
- Wikipedia medicine ZIM.
- Core science ZIMs where available.
- OpenStax or LibreTexts core science/math textbooks, after license review.
- FAO agriculture subset.
- iFixit ZIM for repair knowledge.
- Ollama plus one small chat model and one embedding model.

Expected user outcome:

- Can run Kiwix locally for major reference ZIMs.
- Can use basic source-grounded AI over curated manuals.
- Fits a 64 GB or 128 GB USB SSD if profile selection is conservative.

### Civilization Core

Target: 150-300 GB.

For a serious offline library on a 512 GB SSD.

Include:

- Survival Plus.
- Wikibooks ZIM.
- Wiktionary ZIM.
- More LibreTexts/OpenStax science and engineering.
- CDC, WHO, FAO, Appropedia, Open Source Ecology, and repair resources.
- Practical manufacturing, energy, irrigation, food systems, governance, education, and public health sources.
- Full-text index for all normalized text.
- Vector index for curated practical documents, not necessarily all ZIM content.

Expected user outcome:

- Strong offline practical library for survival, public health, agriculture, repair, and science education.
- Good enough to support a small community knowledge station on one laptop or mini PC.

### Civilization Rebuild

Target: 400-800 GB.

For a 1 TB SSD.

Include:

- Civilization Core.
- Wikisource.
- Broader textbook corpus.
- More agriculture, medicine, engineering, repair, and appropriate technology.
- Larger model options.
- Multiple indexes tuned for practical retrieval.

Expected user outcome:

- Broad reconstruction archive for a serious workstation or external SSD.
- More complete education and engineering coverage.

### Civilization Max

Target: 1-2 TB or more.

For large archive drives.

Include:

- Civilization Rebuild.
- Larger Wikipedia packages, broader Project Gutenberg or cultural collections, more Stack Exchange/technical references where licensing allows.
- Multiple languages if selected.
- Optional LAN server mode.

Expected user outcome:

- Deep archive build, optimized for long-term preservation and replication rather than small-device convenience.

## 10. Source Families

### Kiwix/OpenZIM

Use Kiwix ZIM files as the primary format for large offline websites and encyclopedic content.

Examples:

- Wikipedia subsets.
- Simple Wikipedia.
- Wikipedia medicine.
- Wikibooks.
- Wiktionary.
- Wikisource.
- iFixit.
- LibreTexts.
- Project Gutenberg packages when size allows.

Runtime behavior:

- Download `.zim`.
- Verify checksum.
- Register in `kiwix-library.xml`.
- Serve through bundled `kiwix-serve`.
- Open in the app via `http://127.0.0.1:<port>/`.

Do not extract and vector-index every large ZIM by default. Let Kiwix handle browsing/search. Only index selected ZIMs or selected extracted pages when needed for RAG.

### Survival Repositories

Include:

- `ligi/SurvivalManual`
- `ligi/SurvivalManual.wiki`
- `inferno986return/SurvivalManual-ebook`

Use carefully:

- `alx-xlx/awesome-survival` as discovery metadata only, not as a blindly mirrored source.

Exclude as survival content:

- `CreativeLyons/NukeSurvivalToolkit_Wiki`, because it is about Nuke compositing software, not human survival. It can remain a packaging reference.

### Official Manuals and PDFs

Prioritize:

- WHO emergency and public health documents.
- CDC public health/emergency documents where rights allow.
- FAO agriculture, soil, water, seeds, livestock, fisheries, pest management, and food preservation.
- OpenStax or LibreTexts textbooks after title-level license verification.
- Appropedia and Open Source Ecology appropriate-technology docs.

Policy:

- Never scrape an entire organization blindly.
- Curate by topic and license.
- Store original PDF/EPUB/HTML.
- Extract text for search.
- Keep attribution metadata.

## 11. Source Selection and Review

The project should not try to download every possible survival or reconstruction document. It should rank sources with a repeatable review process.

Source scoring rubric:

| Factor | Weight | Meaning |
| --- | ---: | --- |
| Practical survival/rebuild value | 5 | Directly useful for water, food, shelter, health, repair, agriculture, education, or reconstruction. |
| Authority/provenance | 5 | Comes from a recognized public institution, open education project, maintained wiki, or reputable technical community. |
| Offline format quality | 4 | Available as ZIM, PDF, EPUB, Markdown, static HTML, or another stable offline-friendly format. |
| License clarity | 5 | Redistribution, personal use, attribution, derivatives, and LLM indexing are clear enough to classify. |
| Size efficiency | 3 | Adds high value relative to disk footprint. |
| Maintenance/update stability | 3 | Has stable releases, snapshots, catalog entries, or versioned downloads. |
| Safety fit | 4 | Civilian survival/rebuild value without centering offensive or reckless procedural content. |

Review states:

- `candidate`: Discovered but not ready for profiles.
- `needs_license_review`: Useful but rights are unclear.
- `needs_safety_review`: Useful but contains high-risk material.
- `approved_personal`: Allowed in personal/non-commercial profiles.
- `approved_redistributable`: Allowed in redistributable bundles.
- `approved_metadata_only`: Useful for discovery but not mirrored/downloaded.
- `excluded`: Not appropriate for the project.

Source review checklist:

- Is the source original or an authorized mirror?
- Is the license visible and compatible with the intended profile?
- Does the source have an official download URL or stable release?
- Can it be used offline without a proprietary account?
- Does it duplicate another source exactly or only overlap conceptually?
- Does it include high-risk procedural material that needs restriction?
- Can the app open, serve, or index it with existing adapters?
- Does the manifest contain enough attribution and provenance?

## 12. Runnable Content Adapters

The app should treat "run/open this downloaded thing" as a generic adapter system.

Adapter types:

| Adapter | Input | Runtime | User action |
| --- | --- | --- | --- |
| `kiwix-zim` | `.zim` files | `kiwix-serve` | Start local server and open source. |
| `markdown-wiki` | GitHub wiki Markdown | Built-in renderer | Open rendered local wiki. |
| `pdf` | `.pdf` files | Built-in or OS viewer | Open document. |
| `epub` | `.epub` files | Built-in or OS viewer | Open book. |
| `html-static` | HTML folder/export | Built-in static file server | Serve on localhost and open. |
| `search-index` | SQLite/LanceDB indexes | Built-in backend | Search/query. |
| `ollama-model` | Ollama model name/blobs | Ollama | Pull, load, chat, embed. |
| `external-tool` | Verified binary runtime | Sidecar/process supervisor | Start/stop/probe. |

Every adapter must implement:

- `detect`: Is the artifact present and valid?
- `prepare`: Does it need registration, extraction, or indexing?
- `start`: Start a local process if needed.
- `stop`: Stop the process if the app owns it.
- `status`: Return not installed, ready, running, failed, or incompatible.
- `open`: Return a local URL, file path, or app route.
- `logs`: Provide diagnostics.

This avoids hardcoding "Kiwix is special" everywhere. Kiwix is the first important adapter, but the same model supports future offline HTML wikis, local APIs, or specialized readers.

Example runnable manifest fields:

```yaml
runtime:
  adapter: kiwix-zim
  requires:
    - runtime.kiwix-serve
  launch:
    bind: 127.0.0.1
    port_policy: auto
    open_path: /
```

## 13. Licensing Model

Licensing is first-class product data.

Each source must define:

```yaml
license:
  expression: "CC-BY-SA-4.0"
  attribution_required: true
  commercial_use: true
  derivatives_allowed: true
  llm_ingestion_allowed: unknown
  redistribution_allowed: true
  notes: "Verify title/version specific terms."
```

Bundle rules:

- Public/permissive sources can be in redistributable profiles.
- Non-commercial sources can be in personal-use profiles.
- Unknown or conflicting sources stay excluded until reviewed.
- LLM ingestion restrictions must be tracked separately from human offline browsing rights.

The UI must show a license summary before download and keep a local attribution report.

## 14. Manifest Schema

Example source manifest:

```yaml
id: kiwix.ifixit.en.all.2025-12
title: iFixit in English
source_family: kiwix
category: repair
profile_tags:
  - survival-plus
  - civilization-core
language: en
artifact:
  type: zim
  filename: ifixit_en_all_2025-12.zim
  download_url: https://lbo.download.kiwix.org/zim/ifixit/ifixit_en_all_2025-12.zim
  checksum_url: https://lbo.download.kiwix.org/zim/ifixit/ifixit_en_all_2025-12.zim.sha256
  size_bytes: null
  size_estimate: 3.3 GiB
  storage_key: sha256-or-catalog-id
license:
  expression: CC-BY-NC-SA-3.0
  attribution_required: true
  commercial_use: false
  derivatives_allowed: true
  llm_ingestion_allowed: restricted
processing:
  browse: kiwix
  normalize: false
  full_text_index: kiwix_only
  vector_index: false
runtime:
  adapter: kiwix-zim
  service: kiwix
review:
  status: reviewed
  reviewed_at: 2026-06-03
```

Example GitHub wiki source:

```yaml
id: repo.ligi.survivalmanual.wiki
title: SurvivalManual Wiki
source_family: github
category: survival
profile_tags:
  - survival-essential
  - survival-plus
language: en
artifact:
  type: git_or_archive
  clone_url: https://github.com/ligi/SurvivalManual.wiki.git
  archive_url: https://github.com/ligi/SurvivalManual.wiki/archive/refs/heads/master.zip
  target_dir: repos/ligi/SurvivalManual.wiki
license:
  expression: public-domain-derived
  attribution_required: true
processing:
  browse: markdown
  normalize: true
  full_text_index: true
  vector_index: true
runtime:
  adapter: markdown-wiki
```

## 15. Lockfiles and Snapshots

Profiles point to moving manifests. Lockfiles freeze exact versions for reproducibility.

A lockfile records:

- Profile ID.
- Snapshot date.
- Exact artifact URLs.
- Resolved mirrors.
- Checksums.
- Actual sizes.
- Source metadata.
- Index version.
- Model versions.
- Tool/runtime versions.

Example:

```yaml
snapshot_id: 2026-q2-survival-plus
created_at: 2026-06-03
profile: survival-plus
items:
  - id: repo.ligi.survivalmanual.wiki
    resolved_ref: main
    commit: unknown
  - id: kiwix.ifixit.en.all.2025-12
    filename: ifixit_en_all_2025-12.zim
    sha256: pending
```

## 16. App Architecture

```text
UI
  Profile selector
  Download manager
  Library browser
  Search
  AI assistant
  Runtime manager
  Settings

Tauri command layer
  Manifest reader
  State database
  Download engine
  Checksum verifier
  Artifact registry
  Process supervisor
  Adapter registry
  Index builder
  Ollama manager
  Kiwix manager

Local services
  Kiwix Server
  Optional search API
  Ollama

Library
  Raw artifacts
  Normalized text
  Chunks
  Indexes
  Models
  Logs
```

Backend modules:

- Manifest service: reads, validates, and merges source/profile/lock manifests.
- Artifact registry: maps logical sources to physical files and checksum blobs.
- Download service: queues, resumes, verifies, and repairs downloads.
- Adapter registry: knows how to open/run each artifact type.
- Runtime supervisor: starts, stops, probes, and logs local processes.
- Index service: normalizes documents and builds full-text/vector indexes.
- Model service: detects Ollama and manages model pulls.
- Catalog refresh service: queries upstream catalogs such as Kiwix OPDS and updates candidate metadata.
- License service: produces attribution and restriction reports.

## 17. UI Design

The first screen should be the actual tool, not a landing page.

### Main Views

Dashboard:

- Storage used and free space.
- Recommended next action.
- Active profile.
- Downloaded packs.
- Missing packs.
- Running services.
- Index status.
- Warnings requiring action.

Packs:

- Survival Essential.
- Survival Plus.
- Civilization Core.
- Civilization Rebuild.
- Civilization Max.
- Custom.

Each pack shows:

- Estimated size.
- Source categories.
- License mix.
- AI requirements.
- Downloaded percentage.
- Update availability.

Library:

- Filter by survival, medicine, agriculture, repair, science, engineering, governance, education.
- Open source locally.
- Start/stop local service if needed.
- Show provenance, license, size, checksum, and source URL.

Downloads:

- Queue.
- Pause/resume.
- Retry failed items.
- Verify hashes.
- Choose mirrors.
- Show speed and remaining disk estimate.
- Explain failed checksum, disk, permission, network, and catalog errors in normal language.

Search:

- Exact search.
- Semantic search if embeddings are installed.
- Filters by source, license, domain, profile, language, and safety class.
- Results always show source and local/open-original action.

AI:

- Detect whether Ollama is installed/running.
- Install or configure Ollama.
- Pull recommended chat model.
- Pull recommended embedding model.
- Ask questions against selected local sources.
- Show citations and retrieved sources.
- Mark high-risk domains with stronger source-grounding warnings.

Runtime:

- Kiwix: installed, port, running, served ZIMs.
- Ollama: installed, version, running, endpoint, models.
- Indexer: idle, indexing, failed, complete.
- Adapters: ready, missing runtime, running, failed.

Settings:

- Library path.
- Portable mode.
- Network policy.
- Disk budget.
- Model preferences.
- Advanced LAN sharing.

### Critical User Workflows

Install and first archive:

1. User opens the app.
2. App checks OS, CPU architecture, RAM, free disk, existing Kiwix/Ollama availability, and writable library paths.
3. App recommends compatible profiles.
4. User selects a profile and optional AI.
5. App shows total size, license summary, required runtimes, and expected indexing time.
6. User confirms.
7. App downloads, verifies, registers adapters, indexes selected text, and reports readiness.

Open downloaded content:

1. User opens Library.
2. User selects a source.
3. App checks adapter state.
4. If the source is a ZIM and Kiwix is stopped, app starts Kiwix.
5. App opens the local URL, file viewer, or rendered local route.

Resume after interruption:

1. User reopens app after crash, shutdown, or drive unplug.
2. App locks the library database.
3. App scans partial downloads and stale process records.
4. App reconciles real files with stored state.
5. App offers Resume, Repair, or Remove for incomplete items.

Ask a local question:

1. User opens AI.
2. App checks Ollama and installed models.
3. User chooses source scope, such as Survival Manuals or Medicine.
4. App retrieves chunks from local indexes.
5. App sends only retrieved local context to the model.
6. App answers with citations and links to originals.

Portable drive use:

1. User selects portable mode or opens app from external drive.
2. App detects the library using relative paths.
3. App reassigns ports and validates runtimes for the current OS.
4. App keeps content usable even if models or OS-specific binaries need reinstalling.

## 18. State Detection

The app needs a local SQLite state database plus live probes.

### Persistent State

Store:

- Known manifests and lockfiles.
- Selected profile.
- Library path.
- Artifact records.
- Logical-source to physical-blob mapping.
- Download progress.
- Checksums.
- Index state.
- Runtime install paths.
- Adapter state.
- Service ports.
- Model records.
- Last catalog refresh.

### Live Probes

On startup:

- Check if library path exists.
- Scan expected files.
- Recompute missing/partial/complete status.
- Probe Kiwix process and port.
- Probe Ollama endpoint at `http://127.0.0.1:11434`.
- Query local Ollama models.
- Probe indexes.
- Reconcile stale PIDs.

### Status Values

Artifacts:

- `not_selected`
- `selected`
- `queued`
- `downloading`
- `paused`
- `downloaded_unverified`
- `verified`
- `corrupt`
- `missing`
- `outdated`
- `deduplicated`

Processing:

- `not_required`
- `pending`
- `extracting`
- `chunking`
- `indexing`
- `indexed`
- `failed`

Services:

- `not_installed`
- `installed`
- `starting`
- `running`
- `stopping`
- `stopped`
- `failed`
- `port_conflict`

Models:

- `not_installed`
- `pulling`
- `installed`
- `loaded`
- `unavailable`
- `incompatible`

### SQLite State Schema

The exact schema can evolve, but v1 should start with explicit tables rather than opaque JSON blobs.

```sql
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE manifests (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  version TEXT,
  path TEXT NOT NULL,
  sha256 TEXT,
  loaded_at TEXT NOT NULL
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_family TEXT NOT NULL,
  category TEXT NOT NULL,
  language TEXT,
  manifest_id TEXT NOT NULL,
  review_status TEXT NOT NULL,
  license_expression TEXT,
  runtime_adapter TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  logical_path TEXT,
  blob_id TEXT,
  download_url TEXT,
  expected_sha256 TEXT,
  actual_sha256 TEXT,
  expected_size INTEGER,
  actual_size INTEGER,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE blobs (
  id TEXT PRIMARY KEY,
  sha256 TEXT UNIQUE,
  relative_path TEXT NOT NULL,
  size_bytes INTEGER,
  ref_count INTEGER NOT NULL DEFAULT 1,
  verified_at TEXT
);

CREATE TABLE downloads (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  url TEXT NOT NULL,
  temp_path TEXT NOT NULL,
  bytes_done INTEGER NOT NULL DEFAULT 0,
  bytes_total INTEGER,
  status TEXT NOT NULL,
  error_code TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE adapters (
  source_id TEXT PRIMARY KEY,
  adapter TEXT NOT NULL,
  status TEXT NOT NULL,
  local_url TEXT,
  process_id INTEGER,
  port INTEGER,
  last_probe_at TEXT,
  last_error TEXT
);

CREATE TABLE documents (
  doc_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  normalized_path TEXT,
  safety_class TEXT,
  language TEXT,
  indexed_at TEXT
);

CREATE TABLE chunks (
  chunk_id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  heading_path TEXT,
  text TEXT NOT NULL,
  token_estimate INTEGER,
  safety_class TEXT
);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  chunk_id UNINDEXED,
  title,
  heading_path,
  text,
  content=''
);

CREATE TABLE models (
  id TEXT PRIMARY KEY,
  runtime TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  size_bytes INTEGER,
  managed_by_app INTEGER NOT NULL DEFAULT 0,
  last_probe_at TEXT
);
```

Important state rules:

- Filesystem reality wins over stale database state after startup reconciliation.
- Database state should explain what the app believes, not replace checksum verification.
- Every source can have multiple artifacts.
- Multiple artifacts can point to one blob when exact deduplication occurs.
- Adapter state is cacheable but must be re-probed before user-visible "running" claims.

## 19. Download Engine

Requirements:

- Resumable downloads.
- Mirror fallback.
- Checksum verification.
- Disk-space preflight.
- Per-profile budget warnings.
- Partial file handling with `.part`.
- Retry with exponential backoff.
- Bandwidth limiting.
- User-visible logs.
- File locking so interrupted or parallel app launches do not corrupt downloads.
- Integrity repair option that re-downloads only failed artifacts when possible.

Recommended implementation:

- Rust async downloader using `reqwest`.
- HTTP range request support.
- Optional aria2 integration later for advanced users.
- Checksum verification with SHA-256.
- ZIM checksum URLs consumed where available.
- GitHub repositories and wikis downloaded as source archives by default.
- Git clone is an advanced/developer mode only, used when the manifest explicitly needs commit history or wiki Git metadata.
- Catalog-backed sources store the catalog entry used for the resolved download URL.

### Recoverable Failure Modes

The app should turn common failures into clear actions:

| Failure | Detection | User action |
| --- | --- | --- |
| Not enough disk | Preflight and live free-space check | Change library path, reduce profile, or remove selected items. |
| Network interruption | Download stalls/errors | Resume later. |
| Checksum mismatch | SHA-256 verification fails | Re-download artifact or mark source broken. |
| Missing runtime | Adapter probe fails | Install runtime, use external app, or skip source. |
| Port conflict | Local bind fails | Retry on another port. |
| Permission denied | File create/write fails | Choose another library path. |
| Corrupt index | Query/index probe fails | Rebuild index from verified originals. |
| Moved library | Stored absolute path invalid | Re-detect root and rewrite relative state. |
| Existing Ollama not running | HTTP probe fails | Start Ollama or continue without AI. |
| Model too large | RAM/disk check fails | Choose smaller model. |

## 20. Kiwix Integration

Bundle platform-specific `kiwix-serve` sidecars or download verified Kiwix Tools as a runtime artifact.

The app should:

- Build or update a local Kiwix library XML.
- Start `kiwix-serve` on an available localhost port.
- Serve multiple ZIM files.
- Open the local Kiwix URL inside the app or system browser.
- Detect and resolve port conflicts.
- Stop the service on user request.
- Keep Kiwix optional for users who only download PDFs/manuals.

## 21. Ollama Integration

The app should support three modes:

Bundled manager:

- Detect OS/architecture.
- Guide installation using official packages or download verified standalone artifacts where available.
- Start/stop or connect to local Ollama.

Existing install:

- Detect `ollama` in PATH.
- Probe `http://127.0.0.1:11434`.
- Read installed models.

No AI:

- Allow all archive features without installing Ollama.

Recommended models:

- Default chat: `qwen3:8b` for capable 16 GB+ systems.
- Smaller chat: `qwen3:4b` or another 4B-class model for constrained machines.
- Tiny fallback: a 1B-3B model only when RAM is very limited.
- Default embeddings: `bge-m3` for multilingual/longer chunks.
- Lightweight embeddings: `nomic-embed-text` for smaller English-first installs.
- Alternative embeddings: `embeddinggemma` where supported.

The app should not download models automatically unless the user selects AI features.

### Hardware-Aware Model Selection

On first AI setup, detect:

- OS and architecture.
- Total RAM and available RAM.
- Free disk space.
- CPU features where practical.
- GPU presence where Ollama can use it.
- Existing Ollama installation and model directory.

Model recommendation rules:

- If RAM is under 8 GB, recommend no chat model by default; allow a tiny model only with a performance warning.
- If RAM is 8-16 GB, recommend a 1B-4B chat model and lightweight embeddings.
- If RAM is 16-32 GB, recommend `qwen3:8b` and `bge-m3` or `nomic-embed-text`.
- If RAM is 32 GB or more, allow larger optional models and larger RAG indexes.
- If disk budget is under the selected profile estimate, disable large model selections until the user changes the budget or library path.

Ollama model storage:

- Prefer the user's existing Ollama model store when Ollama is already installed.
- Allow advanced users to set `OLLAMA_MODELS` to the archive drive for portable/offline use.
- Record whether models are app-managed or externally managed.

## 22. Search and RAG

### Full-Text Search

Use SQLite FTS5 for v1.

Reasons:

- Portable.
- No separate server.
- Works on all target operating systems.
- Good enough for curated text, Markdown, and PDF derivatives.

Keep `ripgrep` as a developer/debug fallback, not an end-user dependency.

### Vector Search

Use `sqlite-vec` as the default vector layer for v1.

Reasons:

- Keeps state, metadata, full-text search, and vector search in the SQLite ecosystem.
- Avoids a separate vector database service.
- Fits the product goal of a portable archive that ordinary users can install.
- Works well with the decision not to vector-index all huge ZIMs by default.

Use LanceDB only as a later optional backend for Civilization Rebuild/Max if sqlite-vec cannot handle the selected chunk volume after benchmarking. It is not part of the MVP or core architecture.

Resolved v1 search stack:

- SQLite state database.
- SQLite FTS5 exact search.
- sqlite-vec semantic search over curated chunks.
- No vector database server.
- Pluggable vector provider interface retained in code so Max profiles can add LanceDB later without changing manifests.

### RAG Scope

Do not index everything blindly.

Index by default:

- SurvivalManual wiki.
- Curated medical/sanitation/agriculture PDFs.
- Practical repair and appropriate-technology documents.
- Selected textbook chapters.

Do not vector-index by default:

- Full Wikipedia.
- Huge Wikisource collections.
- Very large literary corpora.
- Every Kiwix file.

For large ZIMs, use Kiwix browsing/search first. Add targeted extraction later.

### Answering Rules

The AI assistant must:

- Retrieve sources before answering when in archive mode.
- Show citations with local source links.
- Prefer quoted snippets or source summaries for high-risk topics.
- Clearly say when no local source supports an answer.
- Never claim medical, electrical, chemical, or engineering certainty without cited local sources.

## 23. Indexing Pipeline

Pipeline:

```text
download -> verify -> normalize -> document records -> chunks -> FTS index -> embeddings -> vector index
```

Normalized document record:

```json
{
  "doc_id": "repo.ligi.survivalmanual.wiki.water-procurement",
  "source_id": "repo.ligi.survivalmanual.wiki",
  "title": "Water Procurement",
  "source_path": "raw/repos/ligi/SurvivalManual.wiki/Water-Procurement.md",
  "normalized_path": "normalized/markdown/repo.ligi.survivalmanual.wiki/Water-Procurement.md",
  "license": "public-domain-derived",
  "domain_tags": ["survival", "water"],
  "safety_class": "survival",
  "language": "en"
}
```

Chunk record:

```json
{
  "chunk_id": "repo.ligi.survivalmanual.wiki.water-procurement#0004",
  "doc_id": "repo.ligi.survivalmanual.wiki.water-procurement",
  "heading_path": ["Water Procurement", "Still Construction"],
  "text": "Chunk text...",
  "token_estimate": 420,
  "source_offsets": {"start": 1204, "end": 2890},
  "safety_class": "survival"
}
```

Chunking policy:

- Preserve headings.
- Keep step-by-step procedures intact.
- Keep tables together where possible.
- Use smaller chunks for checklists/procedures.
- Use larger chunks for textbook exposition.
- Store parent document and heading path for every chunk.

### PDF Extraction Decision

Use a Rust-native PDF text extraction stack for v1, with no Java, Python, Poppler, Tesseract, or OCR dependency in the end-user app.

Default behavior:

- Extract born-digital PDF text with a Rust library such as `pdf-extract`/`lopdf` class tooling.
- Preserve the original PDF as the authoritative user-facing artifact.
- If extraction quality is poor, mark the document as `open_only` or `index_partial`.
- Do not block downloads or browsing because extraction failed.
- Do not run OCR in v1.

Later option:

- Add an optional OCR sidecar profile for advanced users.
- Keep OCR-generated text as a derivative with its own extraction metadata.

## 24. Runtime and Binary Management

The app has two categories of external executables:

Managed sidecars:

- `kiwix-serve`
- Optional helper binaries for extraction or conversion if bundled.

Detected external runtimes:

- Ollama.
- System PDF/EPUB viewers.
- Optional Git.

Rules:

- Sidecars must be versioned and checksummed.
- The app must never execute binaries downloaded from manifests unless they are explicitly runtime artifacts with verified checksums.
- Users should be able to see binary versions.
- Logs must expose command, args, exit code, and stderr location.
- Runtime processes started by the app must have clear ownership. If the app connects to a user-managed service, it must not kill it on exit.

## 25. Security Model

Security matters because this app downloads and parses untrusted files, starts local services, and may run local model tooling.

Baseline rules:

- Bind local services to `127.0.0.1` unless the user explicitly enables LAN sharing.
- Verify checksums before opening, extracting, indexing, or executing downloaded artifacts.
- Never execute a downloaded file unless its manifest marks it as a runtime artifact and the checksum matches a trusted lockfile.
- Treat all document text as untrusted input when sending it to an LLM.
- Do not allow retrieved documents to override system prompts, tool policies, or citation rules.
- Run parsers with size limits and timeouts.
- Keep temporary extraction folders isolated under `tmp/`.
- Sanitize static file serving paths to prevent directory traversal.
- Store no private user questions outside the local library unless the user exports logs.
- Separate app logs from chat transcripts.
- Sign public manifests when community manifests are introduced.

LAN sharing mode:

- Off by default.
- Requires explicit confirmation.
- Shows the network address and exposed services.
- Provides a one-click Stop Sharing action.
- Never exposes Ollama by default.

## 26. Content Safety and Scope

The archive should focus on civilian survival, public health, sanitation, agriculture, repair, education, and reconstruction.

Exclude or restrict:

- Offensive weapons construction.
- Explosives.
- Chemical warfare.
- Malware or cyber abuse content unrelated to rebuilding the archive.
- Pirated book dumps.
- Medical content without source provenance.

For dual-use technical material:

- Keep source metadata.
- Add safety class.
- Require explicit user confirmation for high-risk domains.
- Force citation-grounded AI answers.

## 27. Update Strategy

Use stable snapshots.

Recommended cadence:

- Manifest catalog refresh: user-triggered any time.
- Curated profile release: quarterly or semiannual.
- Emergency manifest patch: as needed for broken URLs/checksums.
- Model recommendation review: quarterly.

The app should distinguish:

- App update.
- Manifest update.
- Content snapshot update.
- Runtime update.
- Model update.
- Index rebuild.

Never combine all updates into one opaque button.

## 28. Bundle and Distribution Model

There are three distribution channels:

Portable application packages, primary:

- Windows signed `.zip` with the `.exe`, sidecars, manifests, and default config.
- macOS signed/notarized `.app` distributed in `.dmg` or `.zip`.
- Linux `.AppImage`.

Optional application installers:

- Windows `.msi` or `.exe`.
- macOS drag-to-Applications `.dmg`.
- Linux `.deb` and/or `.rpm`.

Content bundles:

- User-downloaded through the app.
- Optional prebuilt external-drive bundles.
- Lockfile plus payload folders plus checksums.

Portable drive layout:

```text
ArchiveDrive/
  OfflineSurvival-App/
  OfflineSurvival-Library/
  README-FIRST.txt
  checksums/
```

The app should be able to run directly from the drive where the OS allows it.

Installer rule:

- The portable app must be fully functional without installation.
- Installers must not unlock core features that the portable app lacks.
- Installers may add desktop integration only: shortcuts, file associations, update helpers, and OS app registration.

## 29. Implementation Roadmap

Recommended build order:

Phase 0: architecture scaffolding

- Create Tauri app skeleton.
- Add manifest schemas and validation.
- Add SQLite database and migration framework.
- Add library root selection and portable path handling.

Phase 1: download and state

- Implement source/profile manifest loading.
- Implement resumable downloader.
- Implement SHA-256 verification.
- Implement artifact/blob/source tables.
- Implement dashboard state reconciliation.

Phase 2: opening local content

- Add `pdf`, `epub`, and `markdown-wiki` adapters.
- Add Kiwix sidecar detection.
- Add `kiwix-zim` adapter and local server launch.
- Add Library UI.

Phase 3: search

- Add Markdown/PDF text extraction.
- Add document/chunk records.
- Add SQLite FTS5 indexing.
- Add Search UI with source filters and open-original links.

Phase 4: optional AI

- Add Ollama detection.
- Add model recommendation UI.
- Add model pull/status.
- Add embeddings for curated chunks.
- Add cited RAG answers.

Phase 5: packaging

- Build Windows portable ZIP, macOS signed app package, and Linux AppImage.
- Build optional Windows/macOS/Linux installers after portable packages work.
- Add signed/checksummed release artifacts.
- Test library relocation and offline operation.

Phase 6: curated content expansion

- Add Survival Essential lockfile.
- Add Survival Plus lockfile.
- Add source review workflow.
- Add Civilization Core after license and size validation.

## 30. Acceptance Criteria

The architecture is successful when these product tests pass:

- A Windows user can install the app, select Survival Plus, download sources, start Kiwix, and browse a downloaded ZIM without opening a terminal.
- A macOS user can use an existing Ollama install, pull an embedding model from the UI, index SurvivalManual, and ask a cited local question.
- A Linux user can run the AppImage, choose a portable library on an external SSD, and move that SSD to another Linux machine without breaking relative paths.
- The app correctly reports downloaded, missing, corrupt, outdated, running, stopped, and indexed states after restart.
- Two near-duplicate survival wikis can both be downloaded and browsed.
- Two exact duplicate artifacts are stored once physically but shown as separate logical sources if they came from different manifest entries.
- The archive remains useful when offline: existing ZIMs open, PDFs open, search works, and already-pulled models run.
- A user can decline AI entirely and still get the full download, browse, run, and search experience.
- A profile cannot start downloading if the selected disk does not have enough space plus a safety margin.
- Every AI answer in archive mode shows local sources or explicitly says no local source was found.

## 31. MVP

A realistic first version should do less, perfectly.

MVP scope:

- Tauri desktop app.
- Library path selection.
- Manifest loading.
- Survival Essential and Survival Plus profiles.
- Download manager with resume and checksum.
- Kiwix ZIM download and `kiwix-serve` launch.
- SurvivalManual wiki clone/download and Markdown browsing.
- PDF download/open.
- SQLite state database.
- SQLite FTS5 search over normalized Markdown/PDF text.
- Ollama detection.
- Optional model pull for one chat model and one embedding model.
- Basic RAG over curated non-ZIM documents with citations.

MVP sources:

- `ligi/SurvivalManual`
- `ligi/SurvivalManual.wiki`
- `inferno986return/SurvivalManual-ebook`
- Simple Wikipedia or selected Wikipedia subset via Kiwix.
- Wikipedia medicine via Kiwix if size fits.
- iFixit via Kiwix if user selects Repair.
- 20-50 curated PDFs/manuals from WHO/CDC/FAO/OpenStax/LibreTexts after license review.

## 32. Later Milestones

Milestone 2:

- Civilization Core profile.
- License report UI.
- More Kiwix families.
- Better PDF extraction.
- Pluggable vector index provider.
- Profile customization.

Milestone 3:

- Civilization Rebuild profile.
- LAN sharing mode.
- Portable external-drive builder.
- App-managed Kiwix library XML editor.
- Source review workflow.
- Benchmark suite for retrieval quality.

Milestone 4:

- Multi-language packs.
- Community manifest submissions.
- Signed manifests.
- Offline update media.
- Dedicated low-resource mode for old computers.

## 33. Resolved Engineering Decisions

These decisions are fixed for v1.

| Area | Decision | Rationale |
| --- | --- | --- |
| Desktop shell | Tauri v2 | Smaller installers, Rust backend, sidecar support, better fit for process/filesystem-heavy app. |
| Frontend | Svelte + TypeScript | Small, direct, adequate for local app UI. |
| Electron | Do not use for v1 | Larger runtime and weaker fit for the Rust-heavy backend. |
| Kiwix runtime | Bundle `kiwix-serve` as a Tauri sidecar | Users should not install Kiwix separately to browse ZIMs. |
| Ollama runtime | Detect existing install; guide official install if missing | Avoids unsafe custom runtime bundling while keeping UI-driven setup. |
| Ollama ownership | App connects to Ollama; it does not kill user-managed Ollama on exit | Prevents breaking a user’s existing local AI setup. |
| GitHub repos/wikis | Download source archives by default | Git must not be an end-user dependency. |
| Git clone | Developer/advanced mode only | Useful for exact commit workflows, not required for normal users. |
| Exact search | SQLite FTS5 | Portable, no service, enough for v1. |
| Vector search | sqlite-vec for v1 curated chunks | Keeps install simple and portable. |
| Large vector backend | LanceDB later only if benchmarks require it | Avoids premature backend complexity. |
| PDF extraction | Rust-native text extraction, no OCR in v1 | Keeps installer simple; original PDFs remain browseable. |
| PDF viewing | Open with OS viewer or embedded web/PDF viewer where available | Rendering is not part of core indexing. |
| Model defaults | `qwen3:8b` chat and `bge-m3` embeddings for 16 GB+ machines | Strong default balance for local reasoning and retrieval. |
| Low-resource model defaults | 4B-class chat model plus `nomic-embed-text` | Keeps 8-16 GB systems usable. |
| Browse-only mode | Fully supported | AI must remain optional. |
| Profile indexing | Index curated practical docs, not all huge ZIMs | Keeps disk, time, and model context under control. |
| App updates | Tauri updater for app only | Content/model updates remain separate explicit operations. |
| Manifest updates | User-approved signed snapshots later | Prevents silent corpus drift. |

Release validation checklist:

- Benchmark sqlite-vec on the actual Survival Plus and Civilization Core chunk counts. This validates capacity; it does not change the v1 default.
- Confirm bundled `kiwix-serve` binaries and licenses per release platform before publishing portable packages or installers.
- Confirm exact Ollama installer flow per OS at release time.
- Verify model names and sizes before each stable release because model catalogs change. The v1 defaults remain `qwen3:8b`, `bge-m3`, and `nomic-embed-text` unless release validation finds a blocking incompatibility.

## 34. Source Notes

Research files used:

- `researches/survival-tops.txt`
- `researches/survival-repos.txt`
- `researches/civilization-recovery.txt`

Online references checked on 2026-06-03:

- Kiwix Server and `kiwix-serve`: https://kiwix-tools.readthedocs.io/en/stable/kiwix-serve.html
- Kiwix applications/server overview: https://kiwix.org/en/applications/
- Kiwix OPDS catalog API: https://library.kiwix.org/catalog/v2/root.xml
- Kiwix iFixit catalog entry: https://library.kiwix.org/catalog/v2/entries?lang=eng&q=ifixit
- Kiwix Wikibooks catalog entry: https://library.kiwix.org/catalog/v2/entries?lang=eng&q=wikibooks
- Tauri distribution docs: https://v2.tauri.app/distribute/
- Tauri updater docs: https://tauri.app/plugin/updater/
- Electron distribution overview: https://www.electronjs.org/docs/latest/tutorial/distribution-overview
- Electron Builder auto-update docs: https://www.electron.build/docs/features/auto-update
- Tauri sidecar docs: https://v2.tauri.app/develop/sidecar/
- Ollama Windows/install notes and local API: https://docs.ollama.com/windows
- Ollama embeddings docs: https://docs.ollama.com/capabilities/embeddings
- Ollama Qwen3 model page: https://ollama.com/library/qwen3
- Ollama BGE-M3 model page: https://ollama.com/library/bge-m3
- Ollama nomic-embed-text model page: https://ollama.com/library/nomic-embed-text
- Ollama EmbeddingGemma model page: https://ollama.com/library/embeddinggemma
- SQLite FTS5 docs: https://www.sqlite.org/fts5.html
- sqlite-vec / SQLite vector extension context: https://sqlite.org/vec1
- LanceDB Rust docs: https://docs.rs/lancedb/latest/lancedb/
- pdf-extract Rust docs: https://docs.rs/pdf-extract/latest/pdf_extract/
- lopdf Rust docs: https://docs.rs/lopdf/latest/lopdf/

## 35. Final Recommendation

Build the project as a Tauri desktop app with a manifest-driven library manager, bundled Kiwix serving, SQLite state, SQLite FTS5 search, optional vector retrieval, and optional Ollama integration.

Keep GitHub focused on code, manifests, schemas, policies, and small fixtures. Keep downloaded knowledge, indexes, models, and runtimes in a relocatable local library. Make the UI center on packs, downloads, local browsing, service state, and source-grounded AI. Let users choose how far they want to go: a small emergency archive, a practical survival-plus archive, or a serious civilization-rebuild library.
