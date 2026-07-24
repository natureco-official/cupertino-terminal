#!/bin/sh
# Cupertino Terminal — one-command installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/natureco-official/cupertino-terminal/main/install.sh | sh
#
# Auto-detects OS + CPU architecture, downloads the correct signed installer from the latest
# GitHub Release, installs it, clears the macOS quarantine flag (builds are ad-hoc signed), and
# launches the app. Needs only `curl` — no jq, no sudo on the common path.
set -eu

REPO="natureco-official/cupertino-terminal"
API="https://api.github.com/repos/$REPO/releases/latest"

say() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
err() { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || err "curl is required but was not found"

OS="$(uname -s)"
ARCH="$(uname -m)"

# Pull the first release asset whose name ends with the given suffix (e.g. _aarch64.dmg).
asset_url() {
  curl -fsSL "$API" | grep 'browser_download_url' | grep -- "$1" | head -1 | cut -d'"' -f4
}

case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64|aarch64) SUFFIX="_aarch64.dmg" ;;
      x86_64)        SUFFIX="_x64.dmg" ;;
      *) err "unsupported macOS architecture: $ARCH" ;;
    esac
    say "Locating the latest macOS build ($ARCH)..."
    URL="$(asset_url "$SUFFIX")"
    [ -n "$URL" ] || err "no matching .dmg asset in the latest release"
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    DMG="$TMP/cupertino.dmg"
    say "Downloading $(basename "$URL")..."
    curl -fL --progress-bar -o "$DMG" "$URL"
    say "Mounting the disk image..."
    MP="$(hdiutil attach "$DMG" -nobrowse -readonly | grep -o '/Volumes/.*' | tail -1)"
    [ -n "$MP" ] || err "failed to mount the disk image"
    APP="$(ls -d "$MP"/*.app 2>/dev/null | head -1)"
    [ -n "$APP" ] || { hdiutil detach "$MP" >/dev/null 2>&1 || true; err "no .app inside the disk image"; }
    NAME="$(basename "$APP")"
    say "Quitting any running instance..."
    osascript -e "quit app \"${NAME%.app}\"" >/dev/null 2>&1 || true
    say "Installing to /Applications/$NAME..."
    rm -rf "/Applications/$NAME"
    cp -R "$APP" /Applications/
    hdiutil detach "$MP" >/dev/null 2>&1 || true
    # Ad-hoc signed build: strip the quarantine flag so Gatekeeper allows the first launch.
    xattr -dr com.apple.quarantine "/Applications/$NAME" 2>/dev/null || true
    say "Launching..."
    open -a "${NAME%.app}" 2>/dev/null || true
    say "Done — Cupertino Terminal is installed in /Applications."
    ;;
  Linux)
    case "$ARCH" in
      x86_64|amd64) SUFFIX="_amd64.AppImage" ;;
      *) err "unsupported Linux architecture: $ARCH (only x86_64 AppImage is published)" ;;
    esac
    say "Locating the latest Linux build..."
    URL="$(asset_url "$SUFFIX")"
    [ -n "$URL" ] || err "no matching .AppImage asset in the latest release"
    DEST="${XDG_BIN_HOME:-$HOME/.local/bin}"
    mkdir -p "$DEST"
    BIN="$DEST/cupertino-terminal"
    say "Downloading to $BIN..."
    curl -fL --progress-bar -o "$BIN" "$URL"
    chmod +x "$BIN"
    say "Done — run 'cupertino-terminal'."
    case ":$PATH:" in
      *":$DEST:"*) : ;;
      *) say "Note: add $DEST to your PATH to launch it by name." ;;
    esac
    ;;
  *)
    err "unsupported OS: $OS — on Windows use install.ps1"
    ;;
esac
