# Contributing

Thanks for helping improve Offline Survival. Contributions usually fall into two groups:

- **Features**: app, backend, packaging, documentation, UI, tests, or release workflow changes.
- **Sources**: new downloadable knowledge packs and profile placement updates.

The rule that matters most: do not commit downloaded libraries, PDFs, ZIMs, model files, generated app bundles, local databases, logs, or private data. The repository should contain code, manifests, docs, and small screenshots only.

## Quick Start

Requirements:

- Node.js 22+
- npm
- Rust and Cargo
- platform dependencies needed by Tauri for your OS

Set up and validate:

```bash
npm ci
npm run validate
```

Run during development:

```bash
npm run api
npm run dev
```

Build locally:

```bash
npm run build
npm run sidecars:prepare
npm run tauri:build
```

## Contributing Features

Good feature pull requests are small, testable, and explain the user problem being solved.

Before opening a PR:

1. Keep the change focused.
2. Follow existing code style and folder boundaries.
3. Add or update tests when behavior changes.
4. Update README, the web page, or docs when the user workflow changes.
5. Run `npm run validate`.

Useful places to start:

| Area | Files |
| --- | --- |
| Desktop app UI | `app/ui/src/App.svelte`, `app/ui/src/styles/app.css` |
| Backend API | `app/backend/server.mjs` |
| Downloads | `app/backend/downloader.mjs` |
| Indexing/search | `app/backend/indexer.mjs` |
| Local services | `app/backend/services.mjs` |
| Share packages/releases | `app/backend/release.mjs`, `.github/workflows/release.yml` |
| Catalog/profiles | `manifests/sources/catalog.yaml`, `manifests/profiles/*.yaml` |
| Tests | `tests/*.test.mjs` |
| Web page | `site/` |

## Contributing New Sources

Sources live in [manifests/sources/catalog.yaml](manifests/sources/catalog.yaml). A source is a downloadable item such as a ZIM, PDF, ZIP archive, HTML file, or Git archive.

Every source must include:

- `id`: stable lowercase id, using hyphens.
- `title`: human-readable name.
- `description`: what it contains and why it matters.
- `type`: usually `zim`, `pdf`, `html`, or `repo-archive`.
- `category`: broad topic such as `medicine`, `repair`, `food-systems`, `science-education`, `geography`, or `survival`.
- `tags`: practical search/filter tags.
- `license`: exact license or a clear summary if mixed.
- `attribution`: who created or maintains the source.
- `url`: direct download URL or Git URL.
- `source_url`: upstream project or publisher page.
- `expected_size_bytes`: realistic download size.
- `runtime`: supported uses, for example `[open, index, search, ai]` or `[serve, browse, search]`.
- `open`: how the app should open it.
- `profiles`: which library profiles should include it.

Optional but encouraged:

- `mirrors`: fallback download URLs.
- `sha256`: checksum for stable files.
- `expected_extracted_size_bytes`: useful for ZIP/Git archives.
- `artifact_name`: stable local filename when the URL is not enough.

Example PDF source:

```yaml
  - id: example-water-guide
    title: Example Water Guide
    description: Practical water treatment and storage reference.
    type: pdf
    category: survival
    tags: [survival/water, sanitation]
    license: CC-BY-4.0
    attribution: Example Publisher.
    url: https://example.org/water-guide.pdf
    source_url: https://example.org/water-guide
    expected_size_bytes: 2500000
    sha256: null
    runtime: [open, index, search, ai]
    open:
      action: direct_open
      label: Open the downloaded PDF with the system PDF viewer.
    profiles: [survival-plus, civilization-core, civilization-rebuild, civilization-max]
```

Example ZIM source:

```yaml
  - id: example-zim
    title: Example Knowledge ZIM
    description: Offline reference package for a practical topic.
    type: zim
    category: science-education
    tags: [reference, education]
    license: CC-BY-SA-4.0
    attribution: Example contributors via Kiwix/OpenZIM.
    url: https://download.kiwix.org/zim/example/example_en_all.zim
    source_url: https://library.kiwix.org/
    expected_size_bytes: 1000000000
    sha256: null
    runtime: [serve, browse, search]
    open:
      action: kiwix_serve
      label: Start the local Kiwix server and open the ZIM library in a browser.
    profiles: [civilization-core, civilization-rebuild, civilization-max]
```

## Choosing Profiles

Profiles are ordered from smallest to largest:

1. `survival-essential`
2. `survival-plus`
3. `civilization-core`
4. `civilization-rebuild`
5. `civilization-max`

Profiles inherit from smaller profiles. For example, `survival-plus` includes `survival-essential`, `civilization-core` includes `survival-plus`, and so on. If you add a source to `survival-essential`, it effectively appears in every larger profile.

Use this rule of thumb:

| Profile | Add a source when it is... |
| --- | --- |
| `survival-essential` | Small, critical, broadly useful in emergencies, and safe for limited disks. |
| `survival-plus` | Still practical for laptop/USB-SSD users, but broader than immediate emergency use. |
| `civilization-core` | Important for rebuilding, repair, education, engineering, maps, public health, or practical community use. |
| `civilization-rebuild` | Larger, deeper reference material for workstation or 1TB-class drives. |
| `civilization-max` | Very large archival/cultural/breadth material for big drives. |

Avoid adding huge sources to small profiles unless they are clearly worth the disk cost.

## Source Quality Rules

Accepted sources should be:

- legal to download and redistribute according to their license
- useful offline, not just a landing page
- from a clear upstream publisher or project
- reasonably stable
- practical, educational, medical, repair, engineering, agricultural, geographic, or reference-oriented
- safe to describe and ship in a general-purpose knowledge archive

Do not add:

- pirated books, courses, PDFs, or archives
- sources with unclear redistribution rights
- private mirrors or URLs requiring authentication
- offensive weapons-focused, extremist, or illegal operational material
- massive sources without explaining why their profile placement is worth it
- downloaded files themselves

## Updating Sizes And Checksums

`expected_size_bytes` should be close enough for disk planning. Use upstream metadata when available. If you download a file locally to measure it, do not commit the file.

For stable direct files, add `sha256` when practical. For changing ZIM releases or Git archives, `sha256: null` is acceptable, but explain the reason in the PR.

## Testing Source Changes

Run:

```bash
npm run lint:manifests
npm run validate
```

For source-heavy changes, also test one download manually in the app or with a temporary library folder. Keep downloaded data outside the repository.

Before submitting, check:

- The new source has license and attribution.
- The selected profiles make sense.
- The expected size does not break a profile disk budget.
- The source opens or indexes with the declared runtime.
- No generated or downloaded files appear in `git status`.

## Pull Request Checklist

- [ ] I did not commit downloaded sources, model files, local databases, logs, build outputs, or secrets.
- [ ] I ran `npm run validate`.
- [ ] I updated docs or screenshots if the user workflow changed.
- [ ] For new sources, I documented license, attribution, expected size, source URL, and profile placement.
- [ ] For new features, I added or updated focused tests where behavior changed.

