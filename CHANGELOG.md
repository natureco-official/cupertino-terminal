# Changelog

## 0.6.0 — 2026-07-24 — Electron → Tauri (Rust core + native WebView)

The whole application was re-platformed from Electron to Tauri v2: a Rust core driving each
OS's native WebView (WKWebView on macOS, WebView2 on Windows). No bundled Chromium/Electron
runtime, node-pty, or node-datachannel — the shared xterm.js frontend now talks to Rust.

### Highlights
- **Native shell, not Electron.** ~10× smaller footprint; the built app is a single native binary.
- **Real PTY** on `portable-pty`, streamed over a per-terminal `tauri::ipc::Channel` as raw bytes
  with backpressure and UTF-8-boundary-safe delivery.
- **ZeroLink reimplemented in Rust** on `webrtc-rs`, byte-compatible with the previous wire format
  (golden-vector tested), preserving the v0.5.0 pairing-key mutual authentication. Verified with a
  real cross-device (macOS ↔ Windows) encrypted session.
- **Feature parity**: native macOS app menu, deep links (`terminal://`/`shell://`), NatureCo account
  SSO (ported to Rust, sharing `~/.natureco/auth.json`), clipboard, sessions, splits, history.
- **macOS polish**: Cmd owns app shortcuts while Ctrl passes to the shell (readline/SIGINT work),
  configurable Option-as-Meta, native traffic lights + window dragging + vibrancy, hollow inactive
  cursor, OSC-133/OSC-7 shell integration.
- **Performance**: sub-frame keystroke latency (~6 ms p95), ~29 MB idle RSS, and a code-split
  renderer (initial chunk 56 KB, down from 543 KB).
- **Packaging + auto-update**: Tauri bundler produces `.dmg`/`.msi`/`.AppImage`; the updater checks
  the GitHub releases `latest.json`. macOS builds are ad-hoc signed (no notarization).

### Fixes found and closed during the migration
- ZeroLink signaling datagram cap raised (1200 B → 16 KB) so real SDPs with STUN candidates connect
  across networks. Received-filename sanitization made cross-platform (splits `/` and `\` on every
  OS) to stay traversal-proof. Windows PTY teardown treats an already-exited child's kill error as
  success. macOS bundle identifier moved off the `.app` suffix.

### Verification
- Every step verified on real GitHub Actions CI (MSVC + Apple Silicon `cargo check` + `cargo test`,
  plus JS tests), a live macOS build, and a live cross-device ZeroLink session.

## 0.5.0 — 2026-07-24

### Security — critical, breaking wire-protocol change

- **Fixed: the ZeroLink host accepted any WebRTC connection as authenticated, regardless of whether the connecting party ever possessed the ZeroLink code.** The 0.4.0 fix pinned the *client*'s view of the host's public key to the one embedded in the code (closing an active MITM gap), but nothing on the *host* side verified the connecting client. WebRTC signaling itself (`hello`/`offer`/`answer` on the fixed UDP rendezvous port) required no credential, and the host derived a session key from — and started a live shell for — whatever public key the connecting peer sent in its handshake. On a shared network, anyone who could reach the host's signaling port could obtain full interactive shell access without ever seeing the code.
  - Fix: the code now embeds an additional random 16-byte pairing key. The handshake packet carries an HMAC-SHA256 proof computed from it; both sides verify the proof before deriving session keys or starting a session. A connection that completes WebRTC negotiation without a valid proof is closed immediately, never reaches `'connected'`, and no shell is ever spawned for it.
  - **This changes the ZeroLink code and handshake wire format.** Hosts and clients must both be on 0.5.0+; older and newer versions cannot connect to each other.

### Dependencies
- Fixed a high-severity `fast-uri` host-confusion advisory (GHSA-v2hh-gcrm-f6hx) picked up by real CI's `npm audit --audit-level=high` — unrelated to the ZeroLink fix above, found while confirming this release on actual GitHub Actions runners.

### Verification
- 30 regression tests (5 new, covering the pairing-key round-trip and the exact attack this fix closes), `tsc --noEmit`, full syntax check, and a live end-to-end simulation (real host + real attacker peer completing full WebRTC/DTLS negotiation with a wrong pairing key). Confirmed green on real GitHub Actions CI (windows-latest + macos-15), not just locally.

## 0.4.0 — 2026-07-13

### macOS
- Moved zsh runtime/history state out of the read-only app bundle and App Translocation into the writable Electron user-data directory.
- Preserved `.zshenv`, `.zprofile`, `.zshrc`, `.zlogin`, and `.zlogout` startup order without modifying user files or sourcing `.zshrc` twice.
- Preserved login startup semantics for bash, added fish OSC integration, and restored common Homebrew paths for Finder-launched GUI sessions.
- Finder open-file actions now open the containing directory. Intel and Apple Silicon DMGs use architecture-specific filenames and the native `.icns` icon.

### Windows
- Preserved Explorer launch directories in WSL instead of forcing `~`.
- Hardened PTY IDs, dimensions, input payloads, duplicate-tab replacement, kill handling, and early output subscription.
- Changed NSIS to consistent per-user installation and architecture-specific installer names.

### Security and reliability
- Pinned the ZeroLink handshake key to the public key in the one-time code, closing an active MITM gap.
- Enforced exact ordered counters, strict code characters, bounded protocol frames, 1 GiB file limits, partial-file cleanup, atomic account-session writes, and safe renderer navigation.
- Disconnected renderer observers on pane close and corrected the PTY benchmark to measure transport throughput rather than PowerShell string allocation.

### Verification
- 25 regression tests, native Electron PTY smoke, full application smoke, PTY throughput benchmark, zero high-severity audit findings, and a real Windows NSIS build.
