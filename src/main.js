const { app, BrowserWindow, ipcMain, Menu, screen, clipboard, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const Store = require('electron-store');

// PTY motoru: @homebridge/node-pty-prebuilt-multiarch — prebuilt N-API binary'leri ile
// gelir, yani Windows'ta Python/VS Build Tools ile DERLEME GEREKTIRMEZ ve ayni binary hem
// Node hem Electron'da calisir. node-pty ile bire bir ayni API (.spawn/.onData/.onExit).
let pty;
try {
  pty = require('@homebridge/node-pty-prebuilt-multiarch');
} catch (err) {
  console.error('node-pty (prebuilt) yuklenemedi:', err);
}

const { execSync } = require('child_process');
const fs = require('fs');
const store = new Store();

// Baslangic calisma dizini: Explorer sag-tik "Cupertino Terminal'de Ac" komut satirinda
// klasor yolu gecirir (argv: [electron.exe, uygulamaDizini, KLASOR]). Ilk iki arguman
// atlanir; gecerli bir dizinse kabuklar orada acilir, yoksa ev dizini.
let launchCwd = null;
for (const a of process.argv.slice(2)) {
  try {
    if (a && !a.startsWith('-') && fs.statSync(a).isDirectory()) { launchCwd = a; break; }
  } catch (_) { /* dizin degil, atla */ }
}

// Uygulama adi (menü çubuğu, Dock, bildirimler) — yoksa Electron "Electron" gösterir
app.setName('Cupertino Terminal');
// Gorev cubugu gruplama/sabitleme kimligi (yoksa Windows uygulamayi "electron" sanir)
app.setAppUserModelId('com.cupertinoterminal.app');

// Varsayılan terminal olarak kaydet: terminal:// ve shell:// URL scheme'leri
if (process.argv.includes('--register-default')) {
  try {
    app.setAsDefaultProtocolClient('terminal');
    app.setAsDefaultProtocolClient('shell');
    console.log('✅ Cupertino Terminal varsayılan terminal olarak kaydedildi');
    app.exit(0);
  } catch (err) {
    console.error('❌ Kayit hatasi:', err);
    app.exit(1);
  }
}
if (process.defaultApp) {
  // Dev modunda (electron .) scheme'leri de kaydet
  app.setAsDefaultProtocolClient('terminal', process.execPath, [path.resolve(process.argv[1])]);
  app.setAsDefaultProtocolClient('shell',   process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('terminal');
  app.setAsDefaultProtocolClient('shell');
}

// ── Shell profilleri (platformlar-arası) ───────────────────────────────────
// Windows: WSL / PowerShell 5+7 / CMD;  macOS-Unix: zsh / bash / fish
const shellProfiles = {
  zsh:        { command: 'zsh',            args: ['-l'],        name: 'zsh' },
  bash:       { command: 'bash',           args: ['-l'],        name: 'bash' },
  fish:       { command: 'fish',           args: ['-l'],        name: 'fish' },
  wsl:        { command: 'wsl.exe',        args: ['--cd', '~'], name: 'WSL' },
  powershell: { command: 'powershell.exe', args: [],            name: 'PowerShell' },
  pwsh:       { command: 'pwsh.exe',       args: [],            name: 'PowerShell 7' },
  cmd:        { command: 'cmd.exe',        args: [],            name: 'Command Prompt' },
};

// Bir komut sistemde var mı? (where on Windows, which elsewhere)
const _cmdCache = new Map();
function commandExists(cmd) {
  if (_cmdCache.has(cmd)) return _cmdCache.get(cmd);
  let ok = false;
  try {
    const probe = process.platform === 'win32' ? 'where' : 'command -v';
    execSync(`${probe} ${cmd}`, { timeout: 3000, stdio: 'ignore' });
    ok = true;
  } catch (_) { ok = false; }
  _cmdCache.set(cmd, ok);
  return ok;
}

// WSL'de GERCEKTEN yuklu bir distro var mi? (yoksa PowerShell'e duseriz)
let _wslCache = null;
function wslAvailable() {
  if (_wslCache !== null) return _wslCache;
  try {
    const out = execSync('wsl.exe -l -q', { timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf16le').replace(/\0/g, '').trim();
    _wslCache = out.length > 0;
  } catch (_) { _wslCache = false; }
  return _wslCache;
}

/**
 * Varsayilan shell:
 *   Windows → WSL distro'su varsa WSL (macOS/zsh deneyimi), yoksa PowerShell.
 *   macOS/Unix → $SHELL (zsh/bash/fish), yoksa zsh.
 */
function getDefaultShell() {
  const savedShell = store.get('shell');
  if (savedShell && shellProfiles[savedShell]) return shellProfiles[savedShell];

  if (process.platform === 'win32') {
    return wslAvailable() ? shellProfiles.wsl : shellProfiles.powershell;
  }
  const sysShell = (process.env.SHELL || '/bin/zsh').split('/').pop();
  return shellProfiles[sysShell] || shellProfiles.zsh;
}

let mainWindow;
const ptyProcesses = new Map(); // windowId/tabId -> pty process

// Bugulu cam: Windows'ta acrylic (DWM, yalnizca Win11 22H2+ / build 22621),
// macOS'ta vibrancy (10.10+, her zaman). Desteklenmeyen eski Windows'ta opak zemine düşülür.
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const WIN_BUILD = parseInt(os.release().split('.')[2] || '0', 10);
const ACRYLIC_SUPPORTED = IS_WIN && WIN_BUILD >= 22621;
const BLUR_SUPPORTED = ACRYLIC_SUPPORTED || IS_MAC; // renderer'a "Bugulu" secenegi icin

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  // Cam efekti (ayarlardan): 'acrylic' = bugulu blur; 'clear' = kristal net saydamlik.
  // transparent:true pencere OLUSTURULURKEN verilmek zorunda → kip degisince yeniden baslatilir.
  let glassMode = (store.get('settings', {}).glass === 'clear') ? 'clear' : 'acrylic';
  if (glassMode === 'acrylic' && !BLUR_SUPPORTED) glassMode = 'opaque';

  // Platforma göre bugulu cam ayarlari
  let glassOpts = {};
  if (glassMode === 'clear') {
    glassOpts = { transparent: true };                       // her platformda per-piksel saydam
  } else if (glassMode === 'acrylic') {
    glassOpts = IS_MAC
      ? { vibrancy: 'under-window', visualEffectState: 'active', transparent: true }
      : { backgroundMaterial: 'acrylic', vibrancy: 'sidebar' /* Win'de no-op */ };
  }

  mainWindow = new BrowserWindow({
    width: Math.min(1100, width - 100),
    height: Math.min(700, height - 100),
    minWidth: 400,
    minHeight: 250,
    ...(IS_WIN ? { icon: path.join(__dirname, 'icon.ico') } : {}),
    // macOS Terminal'deki gibi: baslik cubugu gizli, ozel traffic-light butonlari
    titleBarStyle: 'hidden',
    ...(IS_MAC ? { trafficLightPosition: { x: 12, y: 12 } } : {}),
    frame: false,
    // SEFFAF pencere zemini SART: opak renk verilirse blur hic gorunmez. Gercek zemini CSS --bg verir.
    backgroundColor: glassMode === 'opaque' ? '#1e1e1e' : '#00000000',
    ...glassOpts,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  Menu.setApplicationMenu(null);

  // Açılıştan birkaç sn sonra sessizce güncelleme denetle (yeni sürüm varsa bildirir)
  mainWindow.webContents.once('did-finish-load', () => setTimeout(() => checkForUpdates(false), 4000));

  // Odak/blur bilgisini renderer'a ilet (traffic-light'lar macOS gibi grilesin)
  mainWindow.on('focus', () => mainWindow?.webContents.send('window:focus', true));
  mainWindow.on('blur', () => mainWindow?.webContents.send('window:focus', false));

  // Maximize durumu → renderer koseleri duzlestirir (tam ekranda yuvarlak kose olmaz)
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized', false));

  // Renderer uyari/hatalarini ana surec log'una yansit (headless dogrulama icin faydali)
  mainWindow.webContents.on('console-message', (e, level, message, line, source) => {
    if (level >= 2) console.log(`[renderer] ${message} (${source}:${line})`);
  });

  mainWindow.on('closed', () => {
    for (const proc of ptyProcesses.values()) {
      try { proc.kill(); } catch (_) {}
    }
    ptyProcesses.clear();
    mainWindow = null;
  });
}

// Derin baglanti / URL scheme istegini coz (terminal:// veya shell://)
// Format: terminal:///path/to/dir  veya  shell:///path
function handleDeepLink(url) {
  try {
    // URL'den yolu cikar: terminal:///Users/gencay/Project → /Users/gencay/Project
    const parsed = new URL(url);
    const cwd = decodeURIComponent(parsed.pathname);
    if (cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) {
      launchCwd = cwd;
    }
  } catch (_) { /* sessiz */ }
  // App henüz ready değilse createWindow'u çağırma (screen modülü patlar)
  // whenReady.then(createWindow) zaten arkada çalışıyor
  if (!app.isReady()) return;
  // Pencere yoksa ac, varsa odaklan
  if (!mainWindow) {
    createWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

app.whenReady().then(createWindow);

// macOS: URL scheme ile acilma (terminal://...)
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// macOS: Finder "Birlikte Aç" / NSServices (klasore terminal ac)
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    launchCwd = filePath;
  }
  if (!app.isReady()) return;
  if (!mainWindow) {
    createWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('navigate:dir', filePath);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ---- IPC: pencere kontrolleri (traffic-light butonlari icin) ----
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());

// ---- IPC: pano (kopyala/yapistir) ----
ipcMain.on('clipboard:write', (event, text) => {
  if (typeof text === 'string' && text.length) clipboard.writeText(text);
});
ipcMain.handle('clipboard:read', () => clipboard.readText());

// ---- IPC: dış bağlantıyı sistem tarayıcısında aç (NatureCo imzası / linkler) ----
ipcMain.on('shell:openExternal', (event, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
});

// ---- Otomatik güncelleme ----
// Windows (paketli): electron-updater ile TAM SESSİZ — yeni sürüm arka planda indirilir,
// yeniden başlatınca kurulur (kullanıcı yalnız "Yeniden başlat" der; perMachine kurulumda
// tek bir UAC onayı çıkar). Mac/Linux: imzasız olduğu için sessiz kurulum yapılamaz →
// GitHub Releases'ten bildir + tek tıkla installer indirme. (Mac sessiz güncelleme Apple
// sertifikası ister.)
const UPDATE_REPO = 'Gencayolgun/cupertino-terminal';
const _canAutoUpdate = process.platform === 'win32' && app.isPackaged;
let autoUpdater = null;
let _manualCheck = false;

function _cmpVer(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return 1; if ((pa[i] || 0) < (pb[i] || 0)) return -1; }
  return 0;
}

if (_canAutoUpdate) {
  try {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = true;             // yeni sürümü arka planda indir
    autoUpdater.autoInstallOnAppQuit = true;     // kullanıcı çıkınca yine de kurulsun
    autoUpdater.on('update-available', (info) => {
      mainWindow?.webContents.send('update:available', { version: info.version, silent: true });
    });
    autoUpdater.on('download-progress', (p) => {
      mainWindow?.webContents.send('update:progress', { percent: Math.max(0, Math.min(100, Math.round(p.percent || 0))) });
    });
    autoUpdater.on('update-downloaded', (info) => {
      mainWindow?.webContents.send('update:downloaded', { version: info.version });
    });
    autoUpdater.on('update-not-available', () => {
      if (_manualCheck) mainWindow?.webContents.send('update:none', { version: app.getVersion() });
    });
    autoUpdater.on('error', (err) => {
      if (_manualCheck) mainWindow?.webContents.send('update:error', { message: String(err?.message || err) });
    });
  } catch { autoUpdater = null; }
}

async function checkForUpdates(manual = false) {
  _manualCheck = manual;
  if (autoUpdater) {                              // Windows: sessiz indir/kur
    try { await autoUpdater.checkForUpdates(); }
    catch (err) { if (manual) mainWindow?.webContents.send('update:error', { message: String(err?.message || err) }); }
    return;
  }
  // Mac/Linux: GitHub API ile bildir + tek tıkla indirme
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CupertinoTerminal' },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    const current = app.getVersion();
    if (latest && _cmpVer(latest, current) > 0) {
      const ext = process.platform === 'darwin' ? '.dmg' : '.AppImage';
      const asset = (rel.assets || []).find((a) => a.name.toLowerCase().endsWith(ext));
      mainWindow?.webContents.send('update:available', {
        version: latest,
        url: asset ? asset.browser_download_url : rel.html_url,
      });
    } else if (manual) {
      mainWindow?.webContents.send('update:none', { version: current });
    }
  } catch (err) {
    if (manual) mainWindow?.webContents.send('update:error', { message: err.message });
  }
}
ipcMain.on('update:check', () => checkForUpdates(true));
// Windows: indirilen güncellemeyi kur ve yeniden başlat (sessiz + kurulum sonrası çalıştır)
ipcMain.on('update:install', () => {
  if (autoUpdater) { try { autoUpdater.quitAndInstall(true, true); } catch { /* yoksay */ } }
});

// ---- NatureCo Hesabı (SSO) — CLI ile aynı ~/.natureco/auth.json oturumunu paylaşır ----
const ncAccount = require('./natureco-account');
ipcMain.handle('nc:account:status', async () => {
  if (!ncAccount.isLoggedIn()) return { loggedIn: false };
  const me = await ncAccount.whoami().catch(() => null);
  return { loggedIn: !!me, email: me ? me.email : ncAccount.currentEmail() };
});
ipcMain.handle('nc:account:sendOtp', async (e, { email }) => { await ncAccount.sendOtp(email); return { ok: true }; });
ipcMain.handle('nc:account:verify', async (e, { email, value }) => {
  const v = String(value || '').trim();
  if (/^https?:\/\//i.test(v) || v.includes('token')) await ncAccount.verifyLink(v);
  else await ncAccount.verifyOtp(email, v);
  const me = await ncAccount.whoami().catch(() => null);
  return { email: me ? me.email : ncAccount.currentEmail() };
});
ipcMain.handle('nc:account:password', async (e, { email, password }) => {
  await ncAccount.loginWithPassword(email, password);
  const me = await ncAccount.whoami().catch(() => null);
  return { email: me ? me.email : email };
});
ipcMain.on('nc:account:logout', () => ncAccount.logout());

// ---- IPC: terminal sekmesi olustur ----
ipcMain.handle('pty:create', (event, { tabId, profileKey, cols, rows }) => {
  if (!pty) throw new Error('node-pty mevcut degil');

  const profile = shellProfiles[profileKey] || getDefaultShell();

  // WSL'de calisma dizinini --cd belirler (Windows yolu kabul eder); digerlerinde cwd.
  let args = profile.args;
  if (launchCwd && profile.command === 'wsl.exe') args = ['--cd', launchCwd];

  const proc = pty.spawn(profile.command, args, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 30,
    cwd: launchCwd || os.homedir(),
    env: process.env,
  });

  ptyProcesses.set(tabId, proc);

  proc.onData((data) => {
    mainWindow?.webContents.send(`pty:data:${tabId}`, data);
  });

  proc.onExit(({ exitCode }) => {
    mainWindow?.webContents.send(`pty:exit:${tabId}`, exitCode);
    ptyProcesses.delete(tabId);
  });

  return { pid: proc.pid, shellName: profile.name };
});

ipcMain.on('pty:write', (event, { tabId, data }) => {
  ptyProcesses.get(tabId)?.write(data);
});

ipcMain.on('pty:resize', (event, { tabId, cols, rows }) => {
  const proc = ptyProcesses.get(tabId);
  if (proc) {
    try { proc.resize(cols, rows); } catch (_) {}
  }
});

ipcMain.on('pty:kill', (event, { tabId }) => {
  ptyProcesses.get(tabId)?.kill();
  ptyProcesses.delete(tabId);
});

// Sadece sistemde gercekten yuklu olan kabuklari dondur (platform-bagimsiz)
ipcMain.handle('shell:list', () => {
  const available = {};
  for (const [key, profile] of Object.entries(shellProfiles)) {
    if (commandExists(profile.command)) available[key] = profile;
  }
  // Hicbiri bulunamazsa (nad; PATH sorunu) tam listeyi dondur ki UI bos kalmasin
  return Object.keys(available).length ? available : shellProfiles;
});

// Sistem yetenekleri: bugulu cam destegi + platform (renderer ⌘/Ctrl ve Win10 fallback icin)
ipcMain.handle('sys:caps', () => ({ acrylic: BLUR_SUPPORTED, platform: process.platform, version: app.getVersion() }));

// Cam efekti degisiminde temiz yeniden baslatma (transparent sonradan degistirilemez)
ipcMain.on('app:relaunch', () => {
  app.relaunch();
  app.exit(0);
});

// ---- IPC: ayarlar (kalici — electron-store; macOS Terminal "Settings" muadili) ----
ipcMain.handle('settings:get', () => store.get('settings', {}));
ipcMain.on('settings:set', (event, settings) => {
  if (!settings || typeof settings !== 'object') return;
  store.set('settings', settings);
  // Kabuk secimi getDefaultShell()'in okudugu eski 'shell' anahtarina da yansitilir;
  // 'auto' = kayit yok → WSL varsa WSL, yoksa PowerShell (mevcut davranis).
  if (settings.shell && settings.shell !== 'auto' && shellProfiles[settings.shell]) {
    store.set('shell', settings.shell);
  } else {
    store.delete('shell');
  }
  applyTurnFromSettings(); // ZeroLink TURN yapılandırmasını güncelle
});

// ════════════════════════════════════════════════════════════════════════════
// ZeroLink — Serverless P2P Encrypted Terminal Protocol
// ════════════════════════════════════════════════════════════════════════════
const { ZeroLinkHost }   = require('./zerolink-host');
const { ZeroLinkClient } = require('./zerolink-client');
const { setTurnConfig }  = require('./zerolink-peer');

let zlHost   = null; // aktif host oturumu
let zlClient = null; // aktif client oturumu

// Opsiyonel TURN relay (simetrik NAT / farklı ağlar için). Ayarlardan okunur:
//   settings.zlTurn = { url: 'turn:host:3478', username, credential }
// İçerik TURN üzerinden geçse bile ZeroLink E2E şifreli → operatör içeriği göremez.
function applyTurnFromSettings() {
  const s = store.get('settings', {}) || {};
  setTurnConfig(s.zlTurn && s.zlTurn.url ? s.zlTurn : null);
}
applyTurnFromSettings();

// SSH benzeri: bağlanan istemciye TAZE bir kabuk aç (host kendi ekranını paylaşmaz).
// node-pty örneğini ZeroLinkHost'un beklediği ptyLike arayüzüne uyarlıyoruz.
function makeSessionSpawner() {
  return ({ cols, rows }) => {
    if (!pty) throw new Error('node-pty mevcut degil');
    const profile = getDefaultShell();
    const proc = pty.spawn(profile.command, profile.args, {
      name: 'xterm-256color',
      cols: cols || 100,
      rows: rows || 30,
      cwd: os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'en_US.UTF-8' },
    });
    return {
      pid: proc.pid,
      onData: (cb) => proc.onData(cb),   // {dispose} döner
      onExit: (cb) => proc.onExit(cb),
      write:  (d)  => proc.write(d),
      resize: (c, r) => { try { proc.resize(c, r); } catch (_) {} },
      kill:   () => { try { proc.kill(); } catch (_) {} },
    };
  };
}

// ── HOST tarafı IPC ──────────────────────────────────────────────────────────
ipcMain.handle('zl:host:start', async () => {
  if (zlHost) { zlHost.stop(); zlHost = null; }

  zlHost = new ZeroLinkHost({ spawnSession: makeSessionSpawner() });

  zlHost.on('codeReady',    (code)           => mainWindow?.webContents.send('zl:host:code', { code }));
  zlHost.on('codeTimer',    (secondsLeft)    => mainWindow?.webContents.send('zl:host:timer', { secondsLeft }));
  zlHost.on('codeExpired',  ()               => { mainWindow?.webContents.send('zl:host:expired'); zlHost = null; });
  zlHost.on('clientConnected', ({ addr })    => mainWindow?.webContents.send('zl:host:connected', { addr }));
  zlHost.on('sessionStarted', ({ pid })      => mainWindow?.webContents.send('zl:host:session', { pid }));
  zlHost.on('fileReceived', (info)           => mainWindow?.webContents.send('zl:host:file', info));
  zlHost.on('disconnected', ()               => { mainWindow?.webContents.send('zl:host:disconnected'); zlHost = null; });
  zlHost.on('error',        (err)            => mainWindow?.webContents.send('zl:error', { message: err.message }));

  const code = await zlHost.start();
  return { code };
});

ipcMain.on('zl:host:stop', () => {
  zlHost?.stop();
  zlHost = null;
});

// ── CLIENT tarafı IPC ────────────────────────────────────────────────────────
ipcMain.handle('zl:client:connect', async (event, { code, tabId }) => {
  if (zlClient) { zlClient.stop(); zlClient = null; }

  zlClient = new ZeroLinkClient();

  // Uzak oturum çıktısını istemci sekmesine yaz
  zlClient.on('data', (buf) => mainWindow?.webContents.send(`pty:data:${tabId}`, buf.toString('utf8')));
  zlClient.on('connected',    () => mainWindow?.webContents.send('zl:client:connected'));
  zlClient.on('remoteExit',   (code) => mainWindow?.webContents.send('zl:client:remote-exit', { code }));
  zlClient.on('fileProgress', (info) => mainWindow?.webContents.send('zl:client:file-progress', info));
  zlClient.on('fileDone',     (info) => mainWindow?.webContents.send('zl:client:file-done', info));
  zlClient.on('fileError',    (info) => mainWindow?.webContents.send('zl:client:file-error', info));
  zlClient.on('forwardOpen',  (info) => mainWindow?.webContents.send('zl:client:forward-open', info));
  zlClient.on('forwardError', (info) => mainWindow?.webContents.send('zl:client:forward-error', info));
  zlClient.on('disconnected', () => { mainWindow?.webContents.send('zl:client:disconnected'); zlClient = null; });
  zlClient.on('error',        (err) => { mainWindow?.webContents.send('zl:error', { message: err.message }); zlClient = null; });

  await zlClient.connect(code);
  return { ok: true };
});

// Kullanıcı klavye girişi → uzak PTY (DATA çerçevesi)
ipcMain.on('zl:client:send', (event, { data }) => {
  zlClient?.sendInput(data);
});

// İstemci terminal boyutu → uzak PTY (RESIZE) — SSH SIGWINCH muadili
ipcMain.on('zl:client:resize', (event, { cols, rows }) => {
  zlClient?.sendResize(cols, rows);
});

// Dosya gönder (push): sistem dosya seçici → uzak host'a
ipcMain.handle('zl:client:push', async () => {
  if (!zlClient) throw new Error('Bağlı değil');
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], title: 'ZeroLink — Gönderilecek dosya' });
  if (res.canceled || !res.filePaths[0]) return { canceled: true };
  const info = zlClient.pushFile(res.filePaths[0]);
  return { canceled: false, name: info.name };
});

// Dosya indir (pull): uzak yol → ~/ZeroLink-Downloads
ipcMain.handle('zl:client:pull', (event, { remotePath }) => {
  if (!zlClient) throw new Error('Bağlı değil');
  if (!remotePath) throw new Error('Uzak dosya yolu boş');
  return zlClient.pullFile(remotePath);
});

// Port yönlendirme ekle / kaldır (ssh -L)
ipcMain.handle('zl:client:forward:add', (event, { localPort, remoteHost, remotePort }) => {
  if (!zlClient) throw new Error('Bağlı değil');
  return zlClient.addForward(parseInt(localPort, 10), remoteHost, parseInt(remotePort, 10));
});
ipcMain.on('zl:client:forward:remove', (event, { localPort }) => {
  zlClient?.removeForward(parseInt(localPort, 10));
});

ipcMain.on('zl:client:disconnect', () => {
  zlClient?.stop();
  zlClient = null;
});
