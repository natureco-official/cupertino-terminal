#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Cupertino Terminal — Varsayılan Terminal Yapma Aracı
# ──────────────────────────────────────────────────────────────────────────────
# Bu script:
#   1. Cupertino Terminal'i terminal:// ve shell:// URL scheme'leri için
#      varsayılan yapar
#   2. Finder sağ-tık menüsüne "Cupertino Terminal'de Aç" ekler
#   3. Launch Services'e kaydeder
#
# Kullanım:
#   chmod +x scripts/set-as-default-terminal.sh
#   ./scripts/set-as-default-terminal.sh
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

APP_PATH="/Applications/Cupertino Terminal.app"
BUNDLE_ID="com.cupertinoterminal.app"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

echo "┌─────────────────────────────────────────────┐"
echo "│  Cupertino Terminal — Varsayılan Terminal    │"
echo "└─────────────────────────────────────────────┘"
echo ""

# ── 1. Uygulama kontrolü ────────────────────────────────────────────────────
if [ ! -d "$APP_PATH" ]; then
  echo "❌  $APP_PATH bulunamadı!"
  echo "   Önce uygulamayı /Applications klasörüne kur:"
  echo "   cp -R \"$REPO_DIR/src-tauri/target/release/bundle/macos/Cupertino Terminal.app\" /Applications/"
  exit 1
fi
echo "✅  Uygulama: $APP_PATH"

# ── 2. Info.plist'e URL scheme'lerini ekle ──────────────────────────────────
PLIST="$APP_PATH/Contents/Info.plist"
URL_TYPES_EXIST=$(/usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes" "$PLIST" 2>/dev/null && echo "yes" || echo "no")

if [ "$URL_TYPES_EXIST" = "yes" ]; then
  echo "✓  CFBundleURLTypes zaten var"
else
  echo "➕  CFBundleURLTypes ekleniyor..."
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes array" \
    -c "Add :CFBundleURLTypes:0 dict" \
    -c "Add :CFBundleURLTypes:0:CFBundleURLName string Terminal URL" \
    -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" \
    -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string terminal" \
    -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:1 string shell" \
    "$PLIST"
  echo "✅  CFBundleURLTypes eklendi"
fi

# ── 3. NSServices (Finder sağ-tık) ──────────────────────────────────────────
NSERVICES_EXIST=$(/usr/libexec/PlistBuddy -c "Print :NSServices" "$PLIST" 2>/dev/null && echo "yes" || echo "no")

if [ "$NSERVICES_EXIST" = "yes" ]; then
  echo "✓  NSServices zaten var"
else
  echo "➕  NSServices (Finder sağ-tık) ekleniyor..."
  /usr/libexec/PlistBuddy -c "Add :NSServices array" \
    -c "Add :NSServices:0 dict" \
    -c "Add :NSServices:0:NSMenuItem dict" \
    -c "Add :NSServices:0:NSMenuItem:default string Cupertino Terminal'de Aç" \
    -c "Add :NSServices:0:NSMessage string openFile" \
    -c "Add :NSServices:0:NSPortName string Cupertino Terminal" \
    -c "Add :NSServices:0:NSRequiredContext dict" \
    -c "Add :NSServices:0:NSRequiredContext:NSApplicationIdentifier string $BUNDLE_ID" \
    -c "Add :NSServices:0:NSSendTypes array" \
    -c "Add :NSServices:0:NSSendTypes:0 string public.folder" \
    "$PLIST"
  echo "✅  NSServices eklendi"
fi

# ── 4. Launch Services'e kaydet ─────────────────────────────────────────────
echo "🔄  Launch Services güncelleniyor..."
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
$LSREGISTER -force "$APP_PATH" 2>/dev/null
echo "✅  Launch Services güncellendi"

# ── 5. URL scheme'leri için varsayılan yap ──────────────────────────────────
echo "🔄  URL scheme'leri ayarlanıyor..."
cat > /tmp/set-default-terminal.swift << 'SWIFT'
import AppKit

let workspace = NSWorkspace.shared
let appURL = URL(fileURLWithPath: "/Applications/Cupertino Terminal.app")

for scheme in ["terminal", "shell"] {
    workspace.setDefaultApplication(at: appURL, toOpenURLsWithScheme: scheme)
    print("  ✅ \(scheme):// -> Cupertino Terminal")
}
SWIFT

swiftc -o /tmp/set-default-terminal /tmp/set-default-terminal.swift 2>/dev/null
/tmp/set-default-terminal
rm -f /tmp/set-default-terminal /tmp/set-default-terminal.swift
echo "✅  URL scheme'leri ayarlandı"

# ── 6. Test ─────────────────────────────────────────────────────────────────
echo ""
echo "🔍  Test ediliyor..."
for scheme in terminal shell; do
  app=$(swift -e "
import AppKit
if let a = NSWorkspace.shared.urlForApplication(toOpen: URL(string: \"\(scheme)://test\")!) {
  print(a.lastPathComponent)
} else { print(\"-\") }
" 2>/dev/null)
  echo "   $scheme:// → ${app:-atanmadi}"
done

echo ""
echo "┌─────────────────────────────────────────────┐"
echo "│  ✅ Tamam! Cupertino Terminal varsayılan!    │"
echo "│                                              │"
echo "│  Test için: open terminal://~/Desktop        │"
echo "└─────────────────────────────────────────────┘"
