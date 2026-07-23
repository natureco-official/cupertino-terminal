# Changelog

## 0.5.0 — 2026-07-24

### Security — critical, breaking wire-protocol change

- **Fixed: the ZeroLink host accepted any WebRTC connection as authenticated, regardless of whether the connecting party ever possessed the ZeroLink code.** The 0.4.0 fix pinned the *client*'s view of the host's public key to the one embedded in the code (closing an active MITM gap), but nothing on the *host* side verified the connecting client. WebRTC signaling itself (`hello`/`offer`/`answer` on the fixed UDP rendezvous port) required no credential, and the host derived a session key from — and started a live shell for — whatever public key the connecting peer sent in its handshake. On a shared network, anyone who could reach the host's signaling port could obtain full interactive shell access without ever seeing the code.
  - Fix: the code now embeds an additional random 16-byte pairing key. The handshake packet carries an HMAC-SHA256 proof computed from it; both sides verify the proof before deriving session keys or starting a session. A connection that completes WebRTC negotiation without a valid proof is closed immediately, never reaches `'connected'`, and no shell is ever spawned for it.
  - **This changes the ZeroLink code and handshake wire format.** Hosts and clients must both be on 0.5.0+; older and newer versions cannot connect to each other.

### Verification
- 30 regression tests (5 new, covering the pairing-key round-trip and the exact attack this fix closes), `tsc --noEmit`, full syntax check.

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
