# Cupertino Terminal — Tauri Migration Plan (Rocks)

Dependency-ordered. Claude (Visionary) hands each rock to Codex (Integrator) as a frozen
build contract, reviews the full diff, and runs the proof command itself. No rock is "done"
until its proof passes when Claude runs it.

Migration is **in-place**: the existing `src/` renderer is kept; a new `src-tauri/` Rust
crate replaces the Electron main process. Electron is removed only once Rock 2 reaches parity.

---

## Rock 0 — Toolchain + native-WebView skeleton
- **Do:** Install Rust (GNU toolchain locally). Scaffold a Tauri v2 app whose window loads the
  existing `src/index.html` renderer in the OS-native WebView. No PTY yet — just the UI painting.
- **Done looks like:** `npm run tauri:dev` (or `cargo tauri dev`) opens a native window that
  renders the Cupertino terminal UI (tabs, theme, chrome), no Chromium involved.
- **Proof:** `cargo tauri build` completes; launching the built app shows the rendered UI.

## Rock 1 — PTY on portable-pty
- **Do:** Rust Tauri commands `pty_create / pty_write / pty_resize / pty_kill` + a data-event
  channel, wired to the existing renderer's `termAPI` shape (so `renderer.js` needs minimal change).
  Reuse `pty-params.js` validation semantics (tab-id, dimensions, input bounds) on the Rust side.
- **Done looks like:** typing in the terminal runs a real shell (zsh/bash/fish on Unix,
  PowerShell/WSL/cmd on Windows); resize reflows; exit is clean.
- **Proof:** an automated headless test spawns a shell via the Rust command, runs `echo` /
  `pwd`, and asserts the round-tripped output.

## Rock 2 — Feature parity with the Electron app
- **Do:** Port every Electron main-process responsibility to Tauri: window controls
  (min/max/close, traffic lights, focus/blur), settings store (electron-store → tauri store /
  a JSON file), clipboard, `openExternal`, deep-link (`terminal://`/`shell://`), session
  persistence, splits, history. Remove Electron once parity is confirmed.
- **Done looks like:** every feature exercised by the current app smoke test works on Tauri.
- **Proof:** the migrated smoke test (equivalent of `smoke:app`) passes; a checklist of each
  ported feature verified.

## Rock 3 — ZeroLink over Rust WebRTC (the risky one)
- **Do:** Port `zerolink-crypto/proto/transfer/host/client/peer` logic to Rust. Replace
  `node-datachannel` with `webrtc-rs` or `str0m` (choose in this rock's Same Page). Reproduce the
  code + handshake wire format **exactly**, including the v0.5.0 pairing-key HMAC mutual auth.
- **Done looks like:** a real host↔client encrypted session works across machines; a party
  without the code cannot connect.
- **Proof:** port the existing ZeroLink test suite (30 tests) to the Rust impl (or drive the Rust
  impl from a test harness), including the attacker-rejection test; all green. Live cross-device run.

## Rock 4 — macOS flawlessness (Windows parity)
- **Do:** Fix the concrete macOS UX bugs the user enumerates. Correct native vibrancy/traffic-light
  geometry, retina/HiDPI rendering, IME/dead-keys, clipboard, focus, and any crash/visual defects.
- **Done looks like:** macOS behaves identically to Windows for every listed bug; nothing degraded.
- **Proof:** real Mac verification over SSH/live for each enumerated bug; before/after evidence.

## Rock 5 — Performance: prove the 10x targets
- **Do:** Enable the xterm WebGL renderer; optimize startup (lazy work, minimal WebView payload);
  measure keystroke latency, cold start, and memory. Compare against Windows Terminal.
- **Done looks like:** cold start < 300 ms, keystroke-to-glyph < 10 ms, idle memory well below the
  Electron build and Windows Terminal.
- **Proof:** a benchmark script reports the numbers; documented side-by-side vs Windows Terminal.

## Rock 6 — Packaging + auto-update + CI
- **Do:** Tauri bundler → `.dmg` (mac arm64+x64), `.msi`/NSIS (win, MSVC in CI), `.AppImage`
  (linux). Wire the Tauri updater. Update the GitHub Actions workflow to build/verify all targets.
- **Done looks like:** tagged release produces working signed-where-possible installers; updater
  moves an install from N-1 to N.
- **Proof:** CI green on all platforms producing real installer artifacts; a manual N-1 → N update.

---

## Same Page gates
Before Codex builds each rock, Claude runs a bounded Same Page Meeting with Codex (read-only
review of that rock's contract: what breaks, what's simpler, what's risky). Rock 3's meeting
also settles the `webrtc-rs` vs `str0m` choice. Verdict recorded per rock.

## Risk register
- **Rock 3 (WebRTC)** is highest risk: Rust WebRTC stacks are heavier/less turnkey than
  `node-datachannel`. Mitigation: prototype the DataChannel + DTLS handshake in isolation before
  wiring the full protocol; keep the crypto/proto layer (already portable, pure) unchanged in shape.
- **GNU vs MSVC on Windows:** local dev uses GNU for speed; CI uses MSVC for official builds.
  Watch for GNU-only build quirks early (Rock 0) so they don't surprise us at packaging (Rock 6).
- **WebView rendering differences:** WKWebView (mac) and WebView2 (win) render xterm differently
  than Chromium; surface any regressions in Rock 0/Rock 5, not at the end.
