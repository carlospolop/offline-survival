# Offline Survival

Build a private offline knowledge library for emergencies, travel, field work, classrooms, and unreliable networks.

Offline Survival is a desktop app that downloads useful public knowledge packs, keeps them on your computer, indexes them for search, and can optionally run a local AI assistant over the material. It is designed so a non-technical person can choose a library size, press **Download**, and later search or share that library without needing the internet.

![Offline Survival dashboard](docs/assets/screenshots/dashboard.png)

## Contents

- [Project Overview](#project-overview)
- [What It Does](#what-it-does)
- [Main Functionality](#main-functionality)
- [Download The App](#download-the-app)
- [First Run](#first-run)
- [Choosing A Library Size](#choosing-a-library-size)
- [Search And Local AI](#search-and-local-ai)
- [Sharing An Offline Library](#sharing-an-offline-library)
- [What Gets Downloaded](#what-gets-downloaded)
- [Privacy And Safety](#privacy-and-safety)
- [Contributing](#contributing)
- [For Developers](#for-developers)
- [Releases](#releases)

## Project Overview

Offline Survival is a desktop tool for preparing a useful offline knowledge archive before you need it. It is meant for emergencies, travel, field work, classrooms, labs, clinics, workshops, homelabs, and any place where internet access may be slow, censored, unreliable, expensive, or gone.

The project is not a single static archive and it is not a cloud service. It is a **library builder**:

- you choose a library size/profile
- the app downloads public knowledge sources into a folder you control
- the app keeps the original files and prepares/indexes what it can
- you search and open that material locally
- you can optionally run Local AI over indexed local sources
- you can package a prepared library for another computer or USB drive

The goal is practical continuity: a person should be able to prepare a disk with survival, medical, repair, agriculture, engineering, reference, and education material and still use it when there is no network.

## What It Does

Offline Survival helps you create a local library with material such as:

- survival manuals and first-aid references
- Simple English Wikipedia and selected Wikipedia collections
- medicine, repair, farming, engineering, cooking, maps, textbooks, and practical how-to archives
- your own extra PDFs, EPUBs, Markdown, HTML, CSV, JSON, text files, and ZIM files

The app keeps the original files, prepares readable copies when needed, builds a local search index, and can package the result for another computer.

## Main Functionality

| Functionality | What it means |
| --- | --- |
| Profile-based library building | Choose from small emergency profiles through large civilization-recovery profiles. Profiles control which sources are downloaded and help keep disk usage predictable. |
| Download manager | Downloads selected public sources, records progress/state, supports retries/resume paths, and keeps files inside the chosen library folder. |
| Source catalog | Sources are defined in manifests with URL, license, attribution, expected size, category, tags, runtime behavior, and profile membership. |
| Local readers/openers | ZIM files can be served through Kiwix, PDFs open with the system viewer, and supported archives can be extracted and opened locally. |
| Indexing and search | Supported files are normalized into searchable text and indexed locally so the library can be searched without internet access. |
| Extra local knowledge | You can import your own PDFs, EPUBs, Markdown, HTML, CSV, JSON, text files, and ZIM files into the local library. |
| Optional Local AI | The app can install and run an app-managed Ollama runtime and recommended models. AI answers use indexed local context when available. |
| RAM safety guard | Local AI only starts when the selected installed chat model fits the currently available RAM and swap pressure is acceptable. |
| Share packages | Build a package containing selected downloaded sources, search data, and available app files for Windows, macOS, and Linux. |
| Cross-platform releases | GitHub Actions publishes Windows, macOS, and Linux builds for x64 and arm64, plus an all-platforms bundle. |
| Recovery and maintenance | The app tracks state in the library folder, marks interrupted downloads, can retry/clean partial downloads, and keeps generated data separate from source code. |
| Privacy by default | Libraries, indexes, imported files, logs, and optional model data stay local. Internal services bind to localhost by default. |

## Download The App

Go to the latest release:

<https://github.com/carlospolop/offline-survival/releases/latest>

Download the file for your computer:

| Your computer | Download |
| --- | --- |
| Windows | `Offline-Survival-windows-x64` or `Offline-Survival-windows-arm64` |
| macOS Intel | `Offline-Survival-macos-x64` |
| macOS Apple Silicon | `Offline-Survival-macos-arm64` |
| Linux Intel/AMD | `Offline-Survival-linux-x64` |
| Linux ARM | `Offline-Survival-linux-arm64` |

Each platform ZIP also contains the all-platforms app bundle, so the same download can be reused when preparing a USB drive for Windows, macOS, and Linux machines. The separate `Offline-Survival-all-platforms` archive is available if you only want the app files without choosing a primary platform.

## First Run

1. Open Offline Survival.
2. Choose a **Library path**. This is where downloaded knowledge files will live.
3. Press **Easy Install** if you want the recommended setup for your computer.
4. Leave the app open while it downloads, verifies, prepares, and indexes files.

The app does not upload your library. Downloaded files stay in the folder you choose.

## Choosing A Library Size

The profiles are ordered from small to large:

| Profile | Best for |
| --- | --- |
| Survival Essential | Small emergency library for limited disks. |
| Survival Plus | More reference material without going huge. |
| Civilization Core | A serious practical library for long offline periods. |
| Civilization Rebuild | Repair, engineering, science, and broader rebuilding material. |
| Civilization Max | The largest catalog option for big disks. |

The sidebar recommends the largest profile that fits a conservative disk budget for the current machine.

## Search And Local AI

Search works after sources are indexed. Local AI is optional.

![Local AI setup](docs/assets/screenshots/local-ai.png)

The Local AI panel can install a small chat model and an embedding model. Startup is protected by a RAM guard:

- the app checks available RAM before starting Ollama
- the check depends on the installed chat model
- if the machine is under memory pressure, Local AI stays blocked instead of freezing the computer
- normal search still works without AI

Local AI answers are grounded in indexed local sources. For medical, electrical, structural, chemical, or other high-risk topics, treat the answer as a pointer back to the cited source, not as professional advice.

## Sharing An Offline Library

The **Share** tab builds a package with the selected downloaded sources, search data, and available app files for Windows, macOS, and Linux.

![Share package screen](docs/assets/screenshots/share.png)

Use this for:

- copying a prepared library to a USB drive
- moving the app to a computer with no internet
- preparing a classroom, clinic, workshop, or field laptop

When creating a share package, choose the primary target OS. The package still includes every available OS app folder, plus generated start files:

- Windows: `Run-Offline-Survival-Windows.bat`
- macOS: `Run-Offline-Survival-macOS.command`
- Linux: `Run-Offline-Survival-Linux.sh`

Linux launchers can point directly at the included library. Windows and macOS installers may need one first-run step after installation: choose the included `OfflineSurvival-Library` folder as the library path.

For the smoothest mixed-OS package, extract a release ZIP first and, in the Share tab, choose its `Offline-Survival-all-platforms` folder as the app bundle folder.

## What Gets Downloaded

The catalog is defined in [manifests/sources/catalog.yaml](manifests/sources/catalog.yaml). It stores source URLs, sizes, licenses, categories, and profiles. The repository stores the catalog and app code only.

The repository must not contain downloaded ZIMs, PDFs, archives, model files, local SQLite state, or generated release bundles. Those are ignored by `.gitignore`.

## Privacy And Safety

- Your downloaded library is local.
- Search indexes are local.
- Extra knowledge files are copied into your selected library path before indexing.
- Local AI runs through a local Ollama runtime when installed.
- The app binds its internal services to localhost by default.
- RAM checks prevent Local AI from starting when the selected model is unsafe for the current machine.

## Contributing

Want to add a feature, improve the app, or propose a new source for one of the library profiles? Read [CONTRIBUTING.md](CONTRIBUTING.md).

The short version: add code/docs as normal, add downloadable sources through `manifests/sources/catalog.yaml`, choose profiles carefully, record license and attribution, and never commit downloaded PDFs, ZIMs, archives, local databases, model files, or generated builds.

## For Developers

Requirements:

- Node.js 22+
- npm
- Rust and Cargo
- platform dependencies for Tauri

Install and validate:

```bash
npm ci
npm run validate
```

Run the web UI and backend during development:

```bash
npm run api
npm run dev
```

Build the desktop app locally:

```bash
npm run build
npm run sidecars:prepare
npm run tauri:build
```

The sidecar script prepares platform-specific backend binaries under `app/src-tauri/binaries/`. Those files are generated and ignored.

## Releases

Releases are built by GitHub Actions from tags like:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The release workflow builds Windows, macOS, and Linux packages for x64 and arm64 where GitHub-hosted runners are available, uploads each platform artifact, and creates an all-platforms archive.

The GitHub Pages site is published from `site/` and is available at:

<https://carlospolop.github.io/offline-survival/>
