# macOS UX Bug Catalog — Rock 4 input

Goal: on macOS the terminal must be as flawless as it is on Windows. This catalog is built from a
code audit of the current (Electron) app across the categories the user named — cursor, prompt,
window, copy-paste, keyboard, crashes. Each item lists symptom, root cause, fix direction, priority,
and whether it still needs live-Mac confirmation. These behaviors must be fixed (not reproduced) in
the Tauri build; Rock 4 verifies each on a real Mac.

Severity: **P1** = breaks a core interaction on macOS · **P2** = wrong/annoying · **P3** = polish.

---

## KEYBOARD (the biggest cluster — macOS treats Ctrl and Cmd as different keys; the app does not)

### K1 — App shortcuts steal Ctrl from the shell on macOS  **[P1]**
- **Symptom:** On macOS, `Ctrl+W` closes the tab instead of delete-word-backward; `Ctrl+F` opens
  search instead of forward-char; `Ctrl+L` toggles ZeroLink instead of clear-screen; `Ctrl+T`,
  `Ctrl+P`, `Ctrl+1..9` are all swallowed. Standard readline/emacs shell keybindings are broken.
- **Root cause:** `src/renderer.js:998` `const mod = e.ctrlKey || e.metaKey;` — every app shortcut
  fires on **either** Ctrl or Cmd. On macOS the convention is Cmd = app, Ctrl = shell.
- **Fix:** platform-aware modifier. On macOS, app shortcuts require `metaKey` (Cmd) only; `ctrlKey`
  passes through to the PTY. On Windows/Linux keep Ctrl (move the few that collide, e.g. tab
  new/close, to Ctrl+Shift if desired). One `appModifier(e)` helper gated on platform.
- **Confirm on Mac:** yes (verify Ctrl+W/F/L/T/P/A/E/K/U all reach the shell).

### K2 — Ctrl+C does not send SIGINT when text is selected (macOS)  **[P1]**
- **Symptom:** With a selection present, `Ctrl+C` copies and swallows the interrupt, so a runaway
  process can't be killed with Ctrl+C. On macOS, copy is Cmd+C and **Ctrl+C must always be SIGINT**.
- **Root cause:** `src/renderer.js:1019-1027` — Ctrl+C is treated as copy-when-selection because of
  the K1 modifier conflation.
- **Fix:** after K1, Ctrl+C (real Ctrl) always → PTY (SIGINT); copy is Cmd+C on macOS.
- **Confirm on Mac:** yes.

### K3 — `macOptionIsMeta: true` is hardcoded — breaks Option-composed characters  **[P2]**
- **Symptom:** On macOS the Option key can't produce special/accented characters (Option+e→´,
  Option+n→˜, etc.) because Option is forced to act as Meta. Not configurable.
- **Root cause:** `src/renderer.js:905` `macOptionIsMeta: true` hardcoded, no setting, no platform
  gate.
- **Fix:** make it a setting (default matching macOS Terminal/iTerm2: left Option = Normal, i.e.
  compose characters; expose a "Use Option as Meta" toggle). Only relevant on macOS.
- **Confirm on Mac:** yes.

### K4 — Cmd+, / Cmd+Q / Cmd+H / Cmd+M native app expectations  **[P2]**
- **Symptom:** macOS users expect Cmd+, (settings — currently works via the conflated mod), but also
  Cmd+Q (quit), Cmd+H (hide), Cmd+M (minimize), Cmd+` (cycle windows). These are native-menu roles
  the Electron app only partially wires; the Tauri build must provide a proper macOS app menu.
- **Root cause:** no full macOS application menu with standard roles (`src/main.js` Menu is minimal).
- **Fix:** in the Tauri build, define the standard macOS menu (App/Edit/View/Window) with native
  roles so Cmd+Q/H/M/W/, and Edit copy/paste roles work as expected.
- **Confirm on Mac:** yes.

---

## COPY-PASTE

### C1 — Copy/paste bound to Ctrl instead of Cmd on macOS  **[P1]**
- **Symptom:** Mac users press Cmd+C/Cmd+V; today those work only because Cmd is conflated with Ctrl
  (K1). Once K1 is fixed correctly, copy/paste must be explicitly Cmd+C/Cmd+V on macOS, and the
  right-click copy/paste path kept.
- **Root cause:** shared with K1/K2 (`src/renderer.js:1019-1037`).
- **Fix:** on macOS, copy = Cmd+C (when selection), paste = Cmd+V; Ctrl reserved for the shell.
- **Confirm on Mac:** yes.

### C2 — Paste relies on the WebView's native paste event  **[P2 / migration risk]**
- **Symptom:** paste currently works by letting the browser's native `paste` fire into xterm
  (`renderer.js:1029-1037`). WKWebView's clipboard/native-paste behavior differs from Chromium;
  under Tauri this path may not fire the same way.
- **Fix:** in the Tauri build, drive paste explicitly via the Tauri clipboard API + `term.paste()`
  (bracketed-paste aware), not the implicit browser event.
- **Confirm on Mac:** yes (WKWebView).

---

## WINDOW

### W1 — Native traffic-light spacer / fullscreen gap  **[P2]**
- **Symptom (to verify live):** on macOS the app hides its own traffic lights and reserves a fixed
  54px spacer (`src/styles.css:188`) for the native ones. In native fullscreen (green button) the
  native traffic lights hide, potentially leaving an awkward 54px gap and a titlebar that no longer
  makes sense.
- **Root cause:** fixed spacer with no fullscreen-state adjustment.
- **Fix:** collapse the spacer and adjust the titlebar on `enter-full-screen`/`leave-full-screen`
  (Tauri window events).
- **Confirm on Mac:** yes.

### W2 — Window drag region is Chromium-specific  **[P1 for migration]**
- **Symptom:** the draggable titlebar uses `-webkit-app-region: drag` (`src/styles.css:90`), which
  is an Electron/Chromium feature. In Tauri v2 the drag region is `data-tauri-drag-region`, not the
  CSS property — so without migration the window won't be draggable on the Tauri build.
- **Fix:** add `data-tauri-drag-region` to the titlebar element (and `no-drag` equivalents) in the
  Tauri build.
- **Confirm on Mac:** yes.

### W4 — No window controls on macOS with `decorations:false` + hidden custom traffic-lights  **[P1 for migration]**
- **Symptom:** Rock 0 sets Tauri `decorations: false` (frameless), and the CSS hides the app's own
  traffic lights on `.platform-mac` (`src/styles.css:188`, written for Electron's native
  hiddenInset lights). Under Tauri there are NO native traffic lights, so on macOS the window would
  show **no close/minimize/zoom controls at all**. (Not caught in Rock 0 — its proof ran on Windows,
  which shows the custom traffic lights.)
- **Fix (Rock 2/4):** either show the app's custom traffic lights on macOS too (drop the
  `.platform-mac` hide + wire them to Tauri window commands), or use Tauri's macOS
  `titleBarStyle: Overlay`/transparent titlebar to get real native traffic lights and inset them.
- **Confirm on Mac:** yes.

### W3 — Vibrancy correctness under Tauri/WKWebView  **[P2]**
- **Symptom:** current app uses Electron `vibrancy: 'under-window'`. Tauri sets macOS vibrancy
  differently (window effects API); must reproduce the same frosted-glass look and the transparent
  background so blur shows through.
- **Fix:** configure Tauri macOS window vibrancy + transparent background to match.
- **Confirm on Mac:** yes.

---

## CURSOR

### U1 — No hollow/inactive cursor when the window loses focus  **[P3]**
- **Symptom:** macOS Terminal/iTerm2 draw a hollow (outline) block cursor when the terminal is not
  focused. This app keeps a solid cursor regardless of focus.
- **Root cause:** no focus-driven cursor style change; xterm doesn't do this automatically.
- **Fix:** on blur, switch to an outline cursor (or dim it); restore on focus. Low priority polish.
- **Confirm on Mac:** yes.

### U2 — Cursor defaults are correct  **[OK]**
- `cursorStyle: 'block'`, `cursorBlink: false` (`src/renderer.js:478-479`) match macOS defaults. No bug.

---

## PROMPT

### P1 — zsh shell integration ordering vs instant-prompt frameworks  **[P2, verify]**
- **Symptom (to verify live):** the runtime ZDOTDIR chaining (`src/shell-runtime.js`) sources the
  user's real dotfiles then appends the OSC-133 hook. With powerlevel10k "instant prompt" or similar,
  sourcing order can cause a warning or a double prompt on macOS zsh.
- **Root cause:** hook appended after user `.zshrc`; instant-prompt frameworks are sensitive to load
  order and to output before prompt.
- **Fix:** verify with a p10k instant-prompt setup on the Mac; guard the hook so it doesn't emit
  output before the instant prompt, or document/position accordingly.
- **Confirm on Mac:** yes (needs a p10k/instant-prompt user config).

### P2 — Default macOS shell path assumptions  **[OK / verify]**
- macOS default is zsh; `getDefaultShell()` handles `$SHELL`. Homebrew paths are injected for
  Finder-launched GUI sessions (`src/shell-runtime.js:49-54`). Looks correct; verify PATH on a real
  Mac GUI launch (not just SSH).

---

## CRASHES / STARTUP

### X1 — Gatekeeper "damaged" + App Translocation  **[handled — regression-watch]**
- Prior fixes: ad-hoc code-sign the `.app` (commit 8ad8020) so Sequoia doesn't flag it "damaged";
  zsh runtime/history moved out of the translocated read-only bundle (0.4.0). The Tauri build must
  preserve both: sign the bundle, keep writable state in app-data, never source from the bundle.
- **Confirm on Mac:** yes (fresh download → open → no "damaged", prompt works).

### X2 — AppleScript/GUI-app launch over non-interactive sessions  **[not applicable here]**
- (That class was in natureco-cli, not this app. Noted so it isn't re-investigated here.)

---

## Rock 4 execution checklist (on the Tauri build, real Mac)
1. K1+K2+C1: Ctrl reaches the shell for W/F/L/T/P/A/E/K/U/C; Cmd does app shortcuts + copy/paste.
2. K3: Option composes characters by default; "Option as Meta" toggle works.
3. K4: standard macOS app menu (Cmd+Q/H/M/W/,) present and working.
4. C2: paste via Tauri clipboard + bracketed paste, not implicit WebView event.
5. W1/W2/W3: draggable titlebar (`data-tauri-drag-region`), correct vibrancy, clean fullscreen.
6. U1: hollow cursor on blur.
7. P1/P2: prompt integration clean under p10k instant-prompt; GUI-launch PATH correct.
8. X1: signed bundle, writable state outside bundle, no "damaged", no translocation breakage.
