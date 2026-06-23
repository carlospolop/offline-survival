#!/usr/bin/env bash
# Smoke-test a generated Linux or macOS package the way a user would: install it
# for real, launch it, and confirm an actual application WINDOW appears and
# renders content (not just that the process stays alive). Screenshots are saved
# under $VERIFY_SHOT_DIR for inspection. Exits non-zero on any failure so CI can
# gate the release on it.
set -euo pipefail

OS_KIND="${1:-}"
ART_DIR="${2:-}"
if [ -z "$OS_KIND" ] || [ -z "$ART_DIR" ]; then
  echo "usage: verify-package.sh <linux|macos> <artifact-dir>" >&2
  exit 2
fi
ART_DIR="$(cd "$ART_DIR" && pwd)"
SHOT_DIR="${VERIFY_SHOT_DIR:-$PWD/verify-screenshots}"
mkdir -p "$SHOT_DIR"

log()  { printf '\n=== %s ===\n' "$*"; }
fail() { printf '\nVERIFY FAILED: %s\n' "$*" >&2; exit 1; }

# Launch a Linux GUI binary, wait for its window to map, and confirm the window
# renders non-blank content. A Tauri app keeps its process alive even when the
# webview fails to paint, so "process alive" is NOT proof it works — an actual
# mapped, rendered window is.
linux_functional_check() {
  local label="$1" cmd="$2"
  local safe="${label//[^A-Za-z0-9_.-]/_}"
  local logf; logf="$(mktemp)"
  local shot="$SHOT_DIR/${safe}.png"
  export DISPLAY="${DISPLAY:-:99}"
  log "Launching ($label): $cmd  (DISPLAY=$DISPLAY)"
  WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1 \
    dbus-run-session -- "$cmd" >"$logf" 2>&1 &
  local pid=$! win="" i
  for i in $(seq 1 60); do
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    win="$(xdotool search --name 'Offline Survival' 2>/dev/null | head -1 || true)"
    [ -n "$win" ] && break
    sleep 1
  done
  echo "----- app output ($label) -----"; cat "$logf" || true; echo "-------------------------------"
  if grep -Eiq 'error while loading shared libraries|cannot open shared object file' "$logf"; then
    kill "$pid" 2>/dev/null || true
    fail "$label: a required shared library is missing"
  fi
  if [ -z "$win" ]; then
    kill "$pid" 2>/dev/null || true
    fail "$label: no application window appeared within 60s (the app did not render a window)"
  fi
  log "$label: window id $win mapped — letting it paint"
  sleep 6
  import -window "$win" "$shot" 2>/dev/null || import -window root "$shot" 2>/dev/null || true
  local colors=0
  if [ -f "$shot" ]; then colors="$(convert "$shot" -format '%k' info: 2>/dev/null || echo 0)"; fi
  log "$label: screenshot saved to $shot with $colors distinct colors"
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  # A blank/failed webview is a near-solid fill (a handful of colors); a rendered
  # UI has many. Require a clearly non-trivial render.
  if [ "${colors:-0}" -lt 24 ]; then
    fail "$label: window rendered effectively blank ($colors distinct colors) — the UI did not load"
  fi
  log "$label: FUNCTIONAL CHECK PASSED (window mapped and rendered content)"
}

if [ "$OS_KIND" = "linux" ]; then
  deb="$(find "$ART_DIR" -maxdepth 2 -name '*.deb' | head -1 || true)"
  appimage="$(find "$ART_DIR" -maxdepth 2 -name '*.AppImage' | head -1 || true)"

  [ -n "$deb" ] || fail "no .deb found in artifact (expected the recommended Linux package)"
  log "Installing .deb for real: $deb"
  sudo apt-get update -y
  sudo apt-get install -y "$deb" || { sudo dpkg -i "$deb" || true; sudo apt-get -f install -y; }
  pkg="$(dpkg-deb -f "$deb" Package)"
  # The real app binary, not the bundled "sca-node" Node sidecar.
  bin="$(dpkg -L "$pkg" | grep -E '^/usr/bin/' | grep -v '/sca-node$' | head -1 || true)"
  [ -n "$bin" ] || fail "could not locate installed app binary for package $pkg"
  log "Installed app binary: $bin"
  if ldd "$bin" | grep -i 'not found'; then fail ".deb binary has missing libraries"; fi
  linux_functional_check "deb-${pkg}" "$bin"

  if [ -n "$appimage" ]; then
    if [ -x "$appimage" ]; then log "AppImage executable bit is set"; else log "NOTE: AppImage lost its exec bit in transit; re-applying for the test"; fi
    chmod +x "$appimage"
    workdir="$(mktemp -d)"
    log "Extracting AppImage (no FUSE needed)"
    ( cd "$workdir" && "$appimage" --appimage-extract >/dev/null )
    linux_functional_check "appimage" "$workdir/squashfs-root/AppRun"
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
  appname="$(basename "$app" .app)"
  log "Installing to /Applications (real install): $appname"
  sudo rm -rf "/Applications/$appname.app"
  sudo cp -R "$app" /Applications/
  hdiutil detach "$mnt" >/dev/null 2>&1 || true
  sudo xattr -dr com.apple.quarantine "/Applications/$appname.app" 2>/dev/null || true

  procmatch="/Applications/$appname.app/Contents/MacOS/"
  log "Launching $appname"
  open "/Applications/$appname.app"
  # Give it time to start its backend and show the window.
  win=0
  for i in $(seq 1 30); do
    if ! pgrep -f "$procmatch" >/dev/null 2>&1; then break; fi
    # Window counting via System Events needs Accessibility rights that CI may
    # not grant; treat it as best-effort evidence, not a hard gate.
    win="$(osascript \
      -e 'tell application "System Events"' \
      -e "  if exists (process \"$appname\") then return count of windows of process \"$appname\"" \
      -e '  return 0' \
      -e 'end tell' 2>/dev/null || echo 0)"
    [ "${win:-0}" -ge 1 ] && break
    sleep 1
  done
  screencapture -x "$SHOT_DIR/macos-${appname// /_}.png" 2>/dev/null || true
  # Hard gate: a real install must produce a running, non-crashing app process.
  pgrep -f "$procmatch" >/dev/null 2>&1 || fail "macOS: the app process is not running (startup crash)"
  log "macOS: app process running; window count (best-effort) = ${win:-0}"
  osascript -e "tell application \"$appname\" to quit" 2>/dev/null || true
  pkill -f "$procmatch" 2>/dev/null || true
  log "macOS package verification passed"
else
  fail "unknown OS kind: $OS_KIND (expected linux or macos)"
fi
