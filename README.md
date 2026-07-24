# Cupertino Terminal

> 🇹🇷 [Türkçe](README.tr.md)

A cross-platform terminal focused on a polished macOS-style experience without giving up practical developer features. Cupertino Terminal runs on Windows, macOS and Linux and is built with Tauri, Rust and xterm.js.

![Cupertino Terminal](docs/screenshot.png)

## Highlights

- Native PTY sessions with PowerShell, Command Prompt, WSL, zsh, bash and fish detection
- Ten classic terminal color profiles, adjustable opacity and glass effects
- Tabs plus persistent vertical or horizontal split panes with draggable dividers
- Session restore for tabs, pane layouts, working directories and window state
- Scrollback search with `Ctrl/⌘+F`
- Fuzzy Command Palette with `Ctrl/⌘+Shift+P`
- Prompt-aware command history with exit status, duration and working directory
- Shell integration for accurate current directory and command state
- Bundled JetBrains Mono and Turkish/English interface
- ZeroLink end-to-end encrypted peer-to-peer remote terminal
- Built-in update checks and Explorer/Finder launch integration

## Download

Download the latest Windows and macOS installers from [GitHub Releases](https://github.com/natureco-official/cupertino-terminal/releases/latest).

| Platform | Package |
|---|---|
| Windows 10/11 x64 | `.exe` installer |
| Apple Silicon Mac | `arm64.dmg` |
| Intel Mac | `x64 .dmg` |

Unsigned macOS builds may be blocked by Gatekeeper. Until Apple Developer signing and notarization are enabled, open **System Settings → Privacy & Security** and choose **Open Anyway** after the first launch attempt. Unsigned Windows builds may similarly display SmartScreen.

## Keyboard shortcuts

Use `⌘` instead of `Ctrl` on macOS.

| Shortcut | Action |
|---|---|
| `Ctrl/⌘+T` | New tab |
| `Ctrl/⌘+W` | Close active pane or tab |
| `Ctrl/⌘+1…9` | Switch tabs |
| `Ctrl/⌘+F` | Search terminal output |
| `Ctrl/⌘+Shift+P` | Command Palette and smart history |
| `Ctrl/⌘+Shift+\` | Split right |
| `Ctrl/⌘+Shift+-` | Split down |
| `Ctrl/⌘+Alt+Right` | Focus the other pane |
| `Ctrl/⌘+,` | Settings |
| `Ctrl/⌘+L` | ZeroLink panel |
| `Ctrl/⌘+C` | Copy selection, otherwise send interrupt |
| `Ctrl/⌘+V` | Paste |

## Run from source

Requirements: Node.js 22 or newer and Git.

```powershell
git clone https://github.com/natureco-official/cupertino-terminal.git
cd cupertino-terminal
npm install
npm start
```

Quality checks:

```powershell
npm run check
npm run smoke:native
npm run smoke:app
npm run perf:pty
npm audit --audit-level=high
```

Build an installer:

```powershell
npm run dist
```

## Shell integration

Cupertino Terminal automatically injects its integration into supported zsh, bash, fish and PowerShell sessions. Runtime files live in the writable application-data directory, never inside the read-only app bundle. This provides reliable current-directory tracking, prompt boundaries, command duration and exit status without modifying the user's shell configuration files.

WSL distributions are detected automatically on Windows. When available, WSL is preferred; otherwise the app falls back to PowerShell.

## ZeroLink

ZeroLink creates an end-to-end encrypted remote shell between two peers. Use `Ctrl/⌘+L` to share a dedicated shell or connect with a one-time code. It supports interactive sessions, terminal resize, file transfer and local port forwarding.

ZeroLink uses ephemeral ECDH P-256, pinned handshake keys, HKDF and AES-256-GCM with strict replay/order protection. Connection codes are one-time and expire after five minutes. Cross-network connectivity depends on NAT conditions and may require a separately configured TURN relay; terminal content remains encrypted through a relay.

## Release process

Every push and pull request to `main` passes automated JavaScript, native PTY, application smoke, performance and security checks. A `v*` tag additionally builds Windows x64, Apple Silicon and Intel macOS packages and attaches them to a GitHub Release.

## License

MIT — see [LICENSE](LICENSE). JetBrains Mono is included under the [SIL Open Font License 1.1](src/fonts/OFL.txt).

Cupertino Terminal is independent software and is not affiliated with or endorsed by Apple Inc. macOS and Terminal.app are trademarks of Apple Inc.

Part of the [NatureCo](https://natureco.me) ecosystem.
