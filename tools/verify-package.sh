#!/usr/bin/env bash
# Smoke-test a generated Linux or macOS package the way a user would: take the
# decompressed artifact, confirm the executable bit survived, check for missing
# shared libraries, and launch it (headlessly on Linux) to confirm it starts
# without fatal library errors. Exits non-zero on any failure so CI can gate the
# release on it.
set -euo pipefail

OS_KIND="${1:-}"
ART_DIR="${2:-}"
if [ -z "$OS_KIND" ] || [ -z "$ART_DIR" ]; then
  echo "usage: verify-package.sh <linux|macos> <artifact-dir>" >&2
  exit 2
fi
ART_DIR="$(cd "$ART_DIR" && pwd)"

log()  { printf '\n=== %s ===\n' "$*"; }
fail() { printf '\nVERIFY FAILED: %s\n' "$*" >&2; exit 1; }

# Launch a GUI binary, keep it alive for a while, then confirm it neither
# crashed on startup nor failed to load a required library. A Tauri app keeps
# running (its window is shown once the backend is ready), so "still alive after
# ~18s" is the success signal; an early exit means a startup crash.
launch_and_check() {
  local label="$1"; shift
  local logf; logf="$(mktemp)"
  log "Launching $label"
  if [ "$OS_KIND" = "linux" ]; then
    # WebKitGTK needs software rendering and a 24-bit virtual display, and is
    # happier with compositing/DMABUF disabled, when running headless in CI.
    WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1 \
      xvfb-run -a -s "-screen 0 1280x1024x24" "$@" >"$logf" 2>&1 &
  else
    "$@" >"$logf" 2>&1 &
  fi
  local pid=$! alive=0 i
  for i in $(seq 1 18); do
    if kill -0 "$pid" 2>/dev/null; then alive=1; sleep 1; else alive=0; break; fi
  done
  if [ "$alive" = "1" ]; then
    log "$label still running after ~18s — terminating"
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  else
    local code=0
    wait "$pid" 2>/dev/null || code=$?
    log "$label exited early with code $code"
  fi
  echo "----- launch output ($label) -----"; cat "$logf" || true; echo "-----------------------------------"
  # gio/gvfs/dconf module-load warnings are non-fatal noise; a missing top-level
  # shared object is fatal.
  if grep -Eiq 'error while loading shared libraries|cannot open shared object file' "$logf"; then
    fail "$label could not load a required shared library"
  fi
  if [ "$alive" != "1" ]; then
    fail "$label did not stay running (startup crash)"
  fi
}

if [ "$OS_KIND" = "linux" ]; then
  deb="$(find "$ART_DIR" -maxdepth 2 -name '*.deb' | head -1 || true)"
  appimage="$(find "$ART_DIR" -maxdepth 2 -name '*.AppImage' | head -1 || true)"

  # --- .deb: the recommended, system-library-backed package ---
  [ -n "$deb" ] || fail "no .deb found in artifact (expected the recommended Linux package)"
  log "Installing .deb: $deb"
  sudo apt-get update -y
  sudo apt-get install -y "$deb" || { sudo dpkg -i "$deb" || true; sudo apt-get -f install -y; }
  pkg="$(dpkg-deb -f "$deb" Package)"
  bin="$(dpkg -L "$pkg" | grep -E '^/usr/bin/' | head -1 || true)"
  [ -n "$bin" ] || fail "could not locate installed binary for package $pkg"
  log "Installed binary: $bin"
  if ldd "$bin" | grep -i 'not found'; then fail ".deb binary has missing libraries"; fi
  log ".deb missing-library check passed"
  launch_and_check "deb:$pkg" "$bin"

  # --- AppImage: portable fallback. Check exec bit, extract, launch. ---
  if [ -n "$appimage" ]; then
    if [ -x "$appimage" ]; then
      log "AppImage executable bit is set"
    else
      log "NOTE: AppImage lost its executable bit in transit (graphical extractors do this); re-applying for the test"
    fi
    chmod +x "$appimage"
    workdir="$(mktemp -d)"
    log "Extracting AppImage (no FUSE needed)"
    ( cd "$workdir" && "$appimage" --appimage-extract >/dev/null )
    launch_and_check "appimage" "$workdir/squashfs-root/AppRun"
  fi
  log "Linux package verification passed"

elif [ "$OS_KIND" = "macos" ]; then
  dmg="$(find "$ART_DIR" -maxdepth 2 -name '*.dmg' | head -1 || true)"
  [ -n "$dmg" ] || fail "no .dmg found in artifact"
  mnt="$(mktemp -d)"
  log "Mounting $dmg"
  hdiutil attach -nobrowse -noverify -mountpoint "$mnt" "$dmg"
  app="$(find "$mnt" -maxdepth 1 -name '*.app' | head -1 || true)"
  if [ -z "$app" ]; then hdiutil detach "$mnt" >/dev/null 2>&1 || true; fail "no .app inside the dmg"; fi
  log "Found app bundle: $app"
  cp -R "$app" ./VerifyApp.app
  hdiutil detach "$mnt" >/dev/null 2>&1 || true
  exe_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' VerifyApp.app/Contents/Info.plist)"
  bin="$PWD/VerifyApp.app/Contents/MacOS/$exe_name"
  [ -x "$bin" ] || fail "main executable missing or not executable: $bin"
  log "Main executable: $bin"
  echo "otool -L:"; otool -L "$bin" || true
  launch_and_check "macos-app" "$bin"
  log "macOS package verification passed"
else
  fail "unknown OS kind: $OS_KIND (expected linux or macos)"
fi
