# AGENTS.md — instructions for AI agents

This file tells any AI agent (Claude Code, Codex, opencode, Hermes, OpenClaw, and others) how
to install **Cupertino Terminal** on the current machine and confirm it works. If a user points
you at this repository and says *"install this on my PC"*, you do **not** need to clone or build
anything — run the single command for the detected operating system below.

## Install — one command

**macOS / Linux:**

```sh
curl -fsSL https://raw.githubusercontent.com/natureco-official/cupertino-terminal/main/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/natureco-official/cupertino-terminal/main/install.ps1 | iex
```

The script auto-detects the OS and CPU architecture, downloads the correct signed installer from
the latest GitHub Release, installs it (per-user on Windows — no admin), clears the macOS
quarantine flag so Gatekeeper allows the first launch (the macOS builds are ad-hoc signed), and
launches the app. Requirements: `curl` on Unix, or Windows PowerShell. No `jq`, no build toolchain.

## Verify it worked

Run the check for the platform you installed on:

- **macOS:** the bundle exists and reports the version
  ```sh
  test -d "/Applications/Cupertino Terminal.app" && \
  defaults read "/Applications/Cupertino Terminal.app/Contents/Info.plist" CFBundleShortVersionString
  ```
- **Windows:** the executable exists
  ```powershell
  Test-Path "$env:LOCALAPPDATA\Cupertino Terminal\cupertino-terminal.exe"
  ```
- **Linux:** the binary is installed and executable
  ```sh
  test -x "$HOME/.local/bin/cupertino-terminal" && echo ok
  ```

A healthy result means the app is installed and ready to use. On macOS and Windows the installer
also launches it automatically.

## Do NOT

- Do **not** run `npm install` / `cargo build` to install for an end user. Those are for
  development only and will not produce a ready-to-use app. Use the one-command installer above.
- Do **not** try to notarize or re-sign the macOS build — it is intentionally ad-hoc signed, and
  the installer already clears the quarantine attribute.
- Do **not** require administrator/root: the default install paths are per-user
  (`/Applications` on macOS, `%LOCALAPPDATA%` on Windows, `~/.local/bin` on Linux).

## Uninstall

- **macOS:** `rm -rf "/Applications/Cupertino Terminal.app"`
- **Windows:** run `"%LOCALAPPDATA%\Cupertino Terminal\uninstall.exe" /S`
- **Linux:** `rm -f "$HOME/.local/bin/cupertino-terminal"`

## Building from source (development only)

Requires Node.js 22+, the Rust toolchain, and the Tauri v2 prerequisites. See
[README.md](README.md) → "Run from source". This path is for contributors, not for installing the
app for an end user.
