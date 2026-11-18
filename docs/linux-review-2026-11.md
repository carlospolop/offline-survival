# Linux review and catalog refresh — November 2026

The catalog contains 89 sources: 54 English and 35 Spanish. Civilization Max
Bilingual includes every source. The estimated download is 169.3 GB, before
search indexes, optional AI models, and future content updates. The English and
bilingual Max profile planning ranges now reflect the catalog rather than the
old 1–2 TB placeholders.

## Added sources

| Material | Language | Placement | Reason |
| --- | --- | --- | --- |
| FEMA *Are You Ready?* | English, Spanish | Survival Essential | Household preparedness, sheltering, evacuation, and recovery |
| EPA emergency drinking-water guide | English, Spanish | Survival Essential | Small printable water-safety reference |
| USDA Complete Guide to Home Canning, parts 1–7 (2015 revision) | English | Survival Plus | Food-preservation principles and instructions for different food groups |
| FAO *Una huerta para todos*, fifth edition (2014) | Spanish | Survival Plus ES | Illustrated 289-page family-gardening manual |
| Protección Civil tsunami and volcanic-risk guides | Spanish | Survival Essential ES | Illustrated evacuation and hazard-preparedness guides |
| Vehicle maintenance and amateur-radio Stack Exchange archives | English | Civilization Core | Practical repair and community communications references |
| World English Bible (Classic) and Reina-Valera 1909 | English, Spanish | Civilization Core / Core ES | Public-domain EPUBs in culture and reference, included in the larger tiers |

The new PDFs were downloaded, checked for PDF signatures, measured, and assigned
SHA-256 checksums. The two new ZIM URLs were range-probed against upstream and
measured using Content-Range. Profiles inherit the new sources into larger tiers.

Publisher pages and reuse evidence:

- [FEMA preparedness guide](https://www.ready.gov/are-you-ready-guide): U.S. government publication.
- [EPA water guide](https://www.epa.gov/ground-water-and-drinking-water/emergency-disinfection-drinking-water-0): U.S. government publication; the Spanish edition is linked from the EPA's Spanish publication page recorded in the manifest.
- [USDA home-canning guide](https://nchfp.uga.edu/resources/category/usda-guide): USDA Agriculture Information Bulletin 539, hosted by the University of Georgia.
- [FAO family-gardening manual](https://www.fao.org/family-farming/detail/es/c/317903/): the PDF copyright page permits attributed noncommercial copying and dissemination. The working PDF is hosted by the University of La Plata. Translation, adaptation, and commercial reuse require separate permission; it is not labeled Creative Commons.
- [Protección Civil publications](https://www.proteccioncivil.es/documentacion/publicaciones): official Spanish government publications, using the existing catalog's `spanish-gov` designation.
- [Kiwix Stack Exchange directory](https://download.kiwix.org/zim/stack_exchange/): attribution and the applicable CC BY-SA terms of individual posts must be retained.
- [World English Bible](https://ebible.org/bible/details.php?id=eng-web) and [Reina-Valera 1909](https://ebible.org/bible/details.php?id=spaRV1909): eBible.org identifies both texts as public domain. The English translation's name is a trademark, so the text is retained unmodified. Both EPUB ZIP containers and their EPUB mimetype entries were checked, and their sizes and SHA-256 hashes recorded.

25 retired Kiwix archive URLs were replaced with available releases and exact
upstream sizes. Five blocked Interior Ministry PDF URLs were replaced with
working copies on the official Protección Civil document server.

The April 2026 WikEM URL is no longer available from Kiwix, and the current OPDS
catalog no longer lists it. Existing local copies remain usable. The catalog
retains this entry pending an equivalent current upstream replacement; an older
medical archive was not substituted silently. Other transient network errors
should be retried before classifying a source as unavailable.

Hesperian's guides were investigated but not added: the current English copyright
page requests permission for digital distribution. The catalog does not assume
that free reading implies unrestricted redistribution.

## Application changes and checks

- Interrupted downloads retain partial files across failed attempts.
- Pausing remains connected to the response body after HTTP headers arrive.
- Truncated responses and PDF/ZIM error pages cannot become successful downloads.
- Failed verification preserves the original expected checksum.
- Shutdown stops active transfers and prevents queued work from starting.
- Compact sources download before large archives.
- Profiles show “Downloading…” while queued and stay below 100% until every item completes.
- Source probes read at most 32 bytes of content even when Range is ignored, validate file signatures, and check Git sources using `git ls-remote`.
- Compatible dependency updates remove the reported critical advisory. Remaining advisories involve the latest available picomatch and its dependents; breaking downgrades were not applied.

Local validation includes the manifest linter, automated tests, production frontend
build, Cargo compilation, and a Linux Debian package build and installation. Browser
checks exercise all main tabs and inspect console/API errors. Generated libraries,
reports, native binaries, and screenshots are excluded from Git.

## Checking a complete local library

Run from the repository root, using the same library folder as the desktop app:

```bash
node --experimental-sqlite tools/library-check.mjs \
  --root=/path/to/OfflineSurvival --verify
```

This checks every catalog entry, file presence and size, and recorded SHA-256
hashes. It exits unsuccessfully for any missing or corrupt source and writes
`logs/library-check.json`. Unlike checking downloaded rows alone, it also detects
catalog sources that have never been downloaded.

For optional accelerated ZIM transfers on machines with `aria2c` installed:

```bash
SCA_DOWNLOAD_TRANSPORT=aria2 SCA_LIBRARY_ROOT=/path/to/OfflineSurvival \
  npm run preview
```

The standard HTTP downloader remains the default. Explicit disk budgets also use
the standard downloader. Aria2 uses sparse partial files and its adjacent `.aria2`
control files for segmented resume; retain both when interrupting these transfers.

Review validation results: 91 automated tests passed; the frontend build, Cargo
check, `.deb` build, real installation, and package window/render verification
passed. The package verifier recorded a rendered window with 3,713 distinct
colors. Browser navigation through Dashboard, Downloads, Search, Extra Knowledge,
Local AI, Share, and Logs produced no console or API errors. The final 87-source
probe found the retired WikEM link and two transient connection failures (IFRC
water treatment and USDA part 1); both transient failures passed on retry. Thus 86 sources have working upstream or mirror probes; the remaining WikEM source already exists in the laptop library.
The new library checker is tested against a complete fixture catalog and against
missing/corrupt files. A clean-install dry run accepts the updated lockfile.

Large EPUB/PDF/text books now use the same 500-chunk transaction batches as ZIM
indexing. On this laptop, indexing the English Bible (2,299 chunks) took 6.3 seconds
with batching, compared with roughly two minutes using individual commits. A
regression test verifies that the final batch remains searchable. Both Bible EPUBs
were downloaded, SHA-256 checked, and indexed locally (2,299 English and 1,742
Spanish chunks).

The live release run also exposed a retired GitHub runner: macOS ARM build and
verification jobs used `macos-14`, which GitHub retired on November 2, 2026.
Both jobs now use the supported `macos-15` ARM runner. See
[GitHub's retirement notice](https://github.blog/changelog/2026-10-01-github-actions-macos-14-runner-image-retirement/).


Live Local AI testing found that a 2,875-token retrieval prompt exhausted the
120-second generation deadline on this laptop, even with Qwen2.5 1.5B. Search now
retains the matched chunk body instead of looking up the longest chunk sharing
its file path. Generation sends at most 4,000 characters of retrieved context by
default, configurable with `SCA_OLLAMA_CONTEXT_MAX_CHARS`, and citations refer only
to the excerpts actually included. A cold-model local test answered in 55.7 seconds
with 1,069 prompt tokens and a passage-supported answer. Tests cover matching a
late book chunk and keeping citations aligned when context is bounded.

`SCA_DOWNLOAD_CONNECTIONS` optionally sets 1–32 aria2 segments per archive
(default 8), with a maximum of 16 connections to each mirror.


Accelerated transfers now wait for their downloader process to close when paused
or shut down, and force termination after two seconds if it ignores SIGTERM.
This prevents orphaned writers from competing with a resumed transfer. A regression
test uses a downloader that ignores SIGTERM and verifies that its process is gone
before pause completes. Late progress callbacks cannot overwrite completed rows.
