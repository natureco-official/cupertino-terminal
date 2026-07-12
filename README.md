# Cupertino Terminal

> 🇹🇷 Türkçe okumak için: [README.tr.md](README.tr.md)

An open-source terminal application that brings the look and feel of **macOS Terminal.app** to Windows — traffic-light buttons, tabs, the 10 classic macOS Terminal color profiles, adjustable window transparency with frosted-glass blur, and first-class **WSL (Ubuntu + zsh)** support.

Built with Electron + xterm.js + node-pty. No compilation needed on install: the PTY layer uses prebuilt binaries, so you do **not** need Python or Visual Studio Build Tools.

![Cupertino Terminal running zsh in WSL with the Pro profile](docs/screenshot.png)

## Features

- 🚦 macOS-style window chrome: traffic lights, centered `process — cols×rows` title, separate tab bar (appears with 2+ tabs)
- 🎨 All 10 classic macOS Terminal profiles: Pro, Basic, Homebrew, Man Page, Novel, Ocean, Grass, Red Sands, Silver Aerogel, Solid Colors
- 🪟 Adjustable opacity (0–100%) with two glass modes: **Blurred** (Windows 11 acrylic) and **Clear** (crisp see-through)
- ⚙️ Settings panel (`Ctrl+,`): profile gallery, font size, cursor style/blink, default shell, UI language (English / Turkish)
- 🐧 WSL auto-detection: if a distro is installed, new tabs open straight into Linux; otherwise PowerShell
- 📁 Open in any folder: pass a directory as a command-line argument (used by the optional Explorer context menu)
- ⌨️ macOS-faithful shortcuts: `Ctrl+T` new tab, `Ctrl+W` close tab, `Ctrl+1..9` switch tabs, `Ctrl+C` copy-if-selected, right-click copy/paste
- 🔤 Bundled JetBrains Mono font for a consistent look on every machine
- 🔗 **ZeroLink** — serverless, end-to-end encrypted P2P remote terminal (SSH-like): share a dedicated shell to another machine with a one-time code (see below)

## Requirements

| | |
|---|---|
| OS | Windows 10 or 11 (64-bit). The **Blurred** glass effect needs Windows 11 22H2+; on older versions the app falls back to an opaque background and the option is disabled. |
| Node.js | 18+ (only to run from source / build) |
| WSL | Optional — see the full setup guide below |

## Quick start (run from source)

```powershell
git clone https://github.com/<your-username>/cupertino-terminal.git
cd cupertino-terminal
npm install
npm start
```

Build a Windows installer (NSIS, output in `dist/`):

```powershell
npm run dist
```

> **SmartScreen note:** unsigned open-source builds trigger a Windows SmartScreen warning on first run. Click *More info → Run anyway*.

## Full WSL setup guide (the complete macOS feel)

The app works out of the box with PowerShell, but the authentic macOS experience comes from a real Unix shell. Follow these steps on Windows 10/11 to get **Ubuntu + zsh + Oh My Zsh** exactly as intended. Every command is copy-paste ready.

### Step 1 — Enable the Windows features

Open **PowerShell as Administrator** and run:

```powershell
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
```

Restart your PC if Windows asks for it.

### Step 2 — Install Ubuntu

Still in PowerShell:

```powershell
wsl --install -d Ubuntu
```

When the installation finishes, Ubuntu starts and asks you to create a **Unix username and password**. Pick anything you like — this is separate from your Windows account. (The password is asked again for `sudo` commands, so remember it.)

Verify:

```powershell
wsl --status
wsl -l -v
```

You should see `Ubuntu` with `VERSION 2`.

> **That's enough for the app:** restart Cupertino Terminal and new tabs will automatically open in Ubuntu. The steps below add the macOS shell polish.

### Step 3 — Install zsh (the shell macOS uses)

Open a tab in Cupertino Terminal (or run `wsl` in PowerShell) and run:

```bash
sudo apt update && sudo apt install -y zsh
chsh -s $(which zsh)
```

`chsh` makes zsh your default shell — it takes effect in new sessions.

### Step 4 — Install Oh My Zsh + plugins (recommended)

```bash
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
```

Then add the two most-loved plugins (history-based autosuggestions and live syntax highlighting):

```bash
git clone --depth 1 https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions
git clone --depth 1 https://github.com/zsh-users/zsh-syntax-highlighting ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting
```

### Step 5 — Configure `~/.zshrc`

Open the config with `nano ~/.zshrc` and make these changes (or replace the file with the block below):

```zsh
export ZSH="$HOME/.oh-my-zsh"

# Classic Oh My Zsh look (arrow prompt + git branch).
# For the plain macOS factory prompt instead, set ZSH_THEME="" and
# uncomment the PROMPT line at the bottom.
ZSH_THEME="robbyrussell"

plugins=(git zsh-autosuggestions zsh-syntax-highlighting)

source $ZSH/oh-my-zsh.sh

# Window/tab title: "user@host: ~/dir" — the app's tab titles feed on this
ZSH_THEME_TERM_TITLE_IDLE='%n@%m: %~'
ZSH_THEME_TERM_TAB_TITLE_IDLE='%n@%m: %~'
DISABLE_AUTO_TITLE="false"

# Shared history across sessions
setopt SHARE_HISTORY HIST_IGNORE_DUPS HIST_IGNORE_SPACE

# macOS factory prompt (enable together with ZSH_THEME=""):
# PROMPT='%n@%m %1~ %# '
```

Apply it:

```bash
exec zsh
```

### Step 6 — (Optional) Developer tools inside WSL

```bash
sudo apt install -y nodejs npm python3-pip python3-venv unzip zip
```

Windows interop works out of the box: call Windows programs from WSL by adding `.exe` — e.g. `explorer.exe .` opens the current folder in File Explorer.

### Troubleshooting

| Symptom | Fix |
|---|---|
| App still opens PowerShell after installing Ubuntu | Fully close and reopen the app — WSL presence is detected once at startup. |
| `wsl --install` says it needs a reboot | Reboot, then run the command again. |
| Tab title shows only `~` | Make sure both `ZSH_THEME_TERM_TITLE_IDLE` and `ZSH_THEME_TERM_TAB_TITLE_IDLE` are set (Step 5). |
| Blurred glass option is greyed out | Your Windows version is older than 11 22H2 — use the Clear mode instead. |

## "Open in Cupertino Terminal" in Explorer's right-click menu

The Windows installer adds this entry automatically for folders and folder backgrounds and removes it on uninstall. The commands below are only needed when running from source without installing.

Run in PowerShell (no admin needed — current user only). Replace `C:\path\to\cupertino-terminal` with your actual location:

```powershell
$app  = 'C:\path\to\cupertino-terminal'
$exe  = "$app\node_modules\electron\dist\electron.exe"
$cmd  = ('"{0}" "{1}" "%V"' -f $exe, $app)
foreach ($base in 'HKCU:\Software\Classes\Directory\shell\CupertinoTerminal',
                  'HKCU:\Software\Classes\Directory\Background\shell\CupertinoTerminal') {
  New-Item -Path "$base\command" -Force | Out-Null
  Set-ItemProperty -Path $base -Name '(Default)' -Value 'Open in Cupertino Terminal'
  Set-ItemProperty -Path $base -Name 'Icon' -Value "$app\src\icon.ico"
  Set-ItemProperty -Path "$base\command" -Name '(Default)' -Value $cmd
}
```

To remove: delete both `CupertinoTerminal` keys under `HKCU:\Software\Classes\Directory`.

## ZeroLink — encrypted P2P remote terminal

ZeroLink turns a terminal tab into an **SSH-like remote session** over a direct,
end-to-end encrypted peer-to-peer tunnel. There is **no server** — the two
machines talk directly and no third party can see the traffic.

**Share a shell (host):** type `zl share` in a tab (or press `Ctrl+L` → *Share*).
You get a one-time **ZeroLink code**. Send it to the other person.

**Connect (client):** on the other machine, type `zl connect <code>` (or `Ctrl+L`
→ *Connect*, paste the code). You get a fresh, private shell on the host — the
host does **not** share its own screen.

While connected, open the panel with `Ctrl+L` for session tools:

| Capability | How |
|---|---|
| Interactive shell | A dedicated shell is spawned per connection |
| Window size sync | Resizing your window resizes the remote shell (SIGWINCH) |
| Run one command | `zl exec`-style single command over the tunnel |
| Send a file | Panel → **Send File** (lands in the host's `~/ZeroLink-Downloads`) |
| Fetch a file | Panel → **Get** `/remote/path` (saved to your `~/ZeroLink-Downloads`) |
| Port forward | Panel → local port → `host:port` (like `ssh -L`) |

**Security:** ephemeral ECDH P-256 → HKDF → AES-256-GCM, with a monotonic
counter bound as authenticated data (replay protection). The connection code is
**one-time**, expires after **5 minutes**, and is HMAC-signed. Even the app's
sever-less design never routes content through a third party.

**Networks:** works on the same LAN out of the box. Across different networks it
depends on your NATs — most home routers work via STUN hole-punching. Behind a
symmetric/port-restricted NAT you may need a TURN relay: set `settings.zlTurn`
(`{ url, username, credential }`) or the `ZEROLINK_TURN_URL` / `_USER` / `_CRED`
environment variables. Content stays E2E encrypted even when relayed.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+T` | New tab (right-click the `+` button to pick WSL / PowerShell / CMD) |
| `Ctrl+W` | Close tab |
| `Ctrl+1` … `Ctrl+9` | Switch to tab N |
| `Ctrl+C` | Copy if text is selected, otherwise send SIGINT |
| `Ctrl+V` | Paste |
| `Ctrl+,` | Settings |
| `Ctrl+L` | ZeroLink panel (share / connect / session tools) |
| Right-click | Copy selection / paste |

## License

MIT — see [LICENSE](LICENSE). Bundles the [JetBrains Mono](https://www.jetbrains.com/lp/mono/) typeface under the [SIL Open Font License 1.1](src/fonts/OFL.txt).

Cupertino Terminal is an independent open-source project. It is not affiliated with or endorsed by Apple Inc. macOS and Terminal.app are trademarks of Apple Inc.

---

<sub>Part of the **NatureCo** ecosystem — [natureco.me](https://natureco.me) · NatureCo ekosisteminin parçası</sub>
