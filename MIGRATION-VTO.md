# Cupertino Terminal — Tauri Migration VTO (Vision / Traction / Organizer)

## Core Focus (one sentence)
Re-platform Cupertino Terminal from Electron to a Rust-core + native-WebView (Tauri) app that is measurably an order of magnitude better than Windows Terminal — instant, flawless, and identical in quality on macOS and Windows — while keeping one codebase, the Cupertino aesthetic, and ZeroLink.

## What "done" looks like
- No Electron/Chromium anywhere. The app runs on each OS's native WebView (WKWebView on macOS, WebView2 on Windows).
- The existing renderer (`src/`, xterm.js, themes, ZeroLink UI) is preserved and driven by Rust Tauri commands instead of Electron main-process IPC.
- macOS quality is at exact parity with Windows — the specific macOS UX bugs the user is hitting are gone.
- Measurable "10x" targets (see below) are met and benchmarked against Windows Terminal.
- ZeroLink still works end-to-end, with the pairing-key mutual-auth security fix (v0.5.0) fully preserved.
- Real installers (.dmg / .msi / .AppImage) build in CI, with working auto-update.

## Non-goals
- Not a from-scratch per-platform native rewrite (no SwiftUI+WinUI split — that would kill the single codebase and cross-platform consistency that define the product).
- Not dropping xterm.js for a bespoke GPU renderer in the first pass (WebGL/WebGPU addon inside the native WebView is enough to hit the targets; a custom renderer is a possible later optimization, not a launch requirement).
- Not changing the ZeroLink wire protocol again (the v0.5.0 pairing-key format is frozen and must be reproduced exactly in Rust).

## Measurable targets (the concrete definition of "10x flawless")
| Metric | Windows Terminal (reference) | Target |
|---|---|---|
| Cold start to interactive | ~1s+ | < 300 ms |
| Keystroke-to-glyph latency | occasional stalls | < 10 ms, GPU-accelerated |
| Idle memory | high | low (no Chromium) |
| Native window chrome | partial | real vibrancy + traffic lights (mac), acrylic (win) |
| macOS parity | — | pixel/behaviour parity with Windows |

## Constraints & stack
- **Shell/core:** Rust + Tauri v2.
- **PTY:** `portable-pty` (WezTerm's battle-tested crate) via Tauri commands.
- **WebRTC (ZeroLink):** Rust `webrtc-rs` or `str0m` (decided during Rock 3 Same Page); ZeroLink crypto/proto ported 1:1, pairing-key auth preserved.
- **Renderer:** keep existing `src/` + xterm.js with the WebGL renderer enabled.
- **Local dev toolchain:** Rust GNU toolchain on this Windows box (light, self-contained); official MSVC Windows builds produced by CI. macOS builds via rustup + Xcode CLT.
- **Process:** Rocket Fuel — Claude = Visionary (plan/review, no implementation code), Codex = Integrator (executes each rock), bounded review rounds, Same Page before code.

## Goals (this migration)
1. Prove the native-WebView shell renders the existing UI (Rock 0).
2. Restore a real working terminal on the Rust PTY (Rock 1).
3. Reach feature parity with the Electron app (Rock 2).
4. Restore ZeroLink over Rust WebRTC with security intact (Rock 3).
5. Make macOS flawless and at Windows parity (Rock 4).
6. Hit and prove the 10x performance targets (Rock 5).
7. Ship real installers + auto-update via CI (Rock 6).
