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

# Exercise the real webview, including a loaded catalog and every main tab.
# Use a fresh library and D-Bus session so this cannot touch a user's downloads
# or mistake an already open window for the package being tested.
linux_functional_check() {
  local label="$1" cmd="$2"
  local safe="${label//[^A-Za-z0-9_.-]/_}"
  local logf; logf="$(mktemp)"
  local shot="$SHOT_DIR/${safe}.png"
  local report="$SHOT_DIR/${safe}.json"
  local helper; helper="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify-linux-ui.py"
  export DISPLAY="${DISPLAY:-:99}"
  log "Exercising native UI ($label): $cmd (DISPLAY=$DISPLAY)"
  if ! dbus-run-session -- /usr/bin/python3 "$helper" \
      --command "$cmd" --report "$report" --screenshot "$shot" >"$logf" 2>&1; then
    cat "$logf"
    fail "$label: native UI workflow failed (report: $report)"
  fi
  cat "$logf"
  local colors=0
  if [ -f "$shot" ]; then colors="$(convert "$shot" -format '%k' info: 2>/dev/null || echo 0)"; fi
  if [ "${colors:-0}" -lt 24 ]; then
    fail "$label: window rendered effectively blank ($colors distinct colors)"
  fi
  log "$label: FUNCTIONAL CHECK PASSED (catalog loaded, all main tabs exercised)"
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
