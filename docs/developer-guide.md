# Developer Guide

The repository is manifest-first. Source and model metadata live in `manifests/`, state lives in `archive-state.sqlite`, raw artifacts stay in `raw/`, generated text in `normalized/`, chunk records in `chunks/`, and FTS5 data in SQLite.

Use `npm run validate` before packaging.
