const { app, BrowserWindow, ipcMain, Menu, screen, clipboard, dialog } = require('electron');
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

// Gorev cubugu gruplama/sabitleme kimligi (yoksa Windows uygulamayi "electron" sanir)
app.setAppUserModelId('com.cupertinoterminal.app');

const shellProfiles = {
  // Varsayilan WSL distro'su (`wsl.exe` -d'siz) → kullanici Ubuntu kurunca otomatik onu kullanir.
  wsl: { command: 'wsl.exe', args: ['--cd', '~'], name: 'WSL (zsh)' },
  powershell: { command: 'powershell.exe', args: [], name: 'PowerShell' },
  cmd: { command: 'cmd.exe', args: [], name: 'Command Prompt' },
};

// WSL'de GERCEKTEN yuklu bir distro var mi? (yoksa PowerShell'e duseriz)
let _wslCache = null;
function wslAvailable() {
  if (_wslCache !== null) return _wslCache;
  try {
    // wsl -l -q yuklu distrolari listeler (UTF-16LE); bir distro varsa cikti bos olmaz.
    const out = execSync('wsl.exe -l -q', { timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf16le').replace(/\0/g, '').trim();
    _wslCache = out.length > 0;
  } catch (_) { _wslCache = false; }
  return _wslCache;
}

/**
 * Varsayilan shell: WSL distro'su varsa WSL (macOS/zsh deneyimi), yoksa PowerShell.
 * Boylece WSL kurulu degilken bile uygulama calisir; Ubuntu kurulunca otomatik WSL'e gecer.
 */
function getDefaultShell() {
  const savedShell = store.get('shell');
  if (savedShell && shellProfiles[savedShell]) return shellProfiles[savedShell];
  return wslAvailable() ? shellProfiles.wsl : shellProfiles.powershell;
}

let mainWindow;
const ptyProcesses = new Map(); // windowId/tabId -> pty process

// Acrylic (bugulu cam) DWM malzemesi yalnizca Windows 11 22H2+ (build 22621) ile gelir.
// Eski Windows'ta backgroundMaterial YOK SAYILIR ve seffaf biraktigimiz pencere zemini
// SIYAH gorunur → destek yoksa opak zemine dusulur. (Berrak kip transparent:true ile
// Windows 10 dahil her surumde calisir.)
const WIN_BUILD = parseInt(os.release().split('.')[2] || '0', 10);
const ACRYLIC_SUPPORTED = process.platform === 'win32' && WIN_BUILD >= 22621;

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  // Cam efekti (ayarlardan): 'acrylic' = bugulu blur; 'clear' = kristal net saydamlik.
  // transparent:true pencere OLUSTURULURKEN verilmek zorunda (sonradan degistirilemez)
  // → kip degisince uygulama yeniden baslatilir (app:relaunch IPC).
  let glassMode = (store.get('settings', {}).glass === 'clear') ? 'clear' : 'acrylic';
  if (glassMode === 'acrylic' && !ACRYLIC_SUPPORTED) glassMode = 'opaque';

  mainWindow = new BrowserWindow({
    width: Math.min(1100, width - 100),
    height: Math.min(700, height - 100),
    minWidth: 400,
    minHeight: 250,
    icon: path.join(__dirname, 'icon.ico'),
    // macOS Terminal'deki gibi: baslik cubugu gizli, ozel traffic-light butonlari
    titleBarStyle: 'hidden',
    frame: false,
    // SEFFAF pencere zemini (acrylic/clear kiplerinde) SART: opak renk verilirse acrylic
    // hic gorunmez ve CSS'teki rgba alfasi sadece bu renge karisir. Gercek zemin rengini
    // CSS --bg verir. Acrylic desteklenmeyen eski Windows'ta ise opak zemin kullanilir
    // (seffaf bolgeler siyah kalacagi icin).
    backgroundColor: glassMode === 'opaque' ? '#1e1e1e' : '#00000000',
    ...(glassMode === 'clear'
      // Berrak: gercek per-piksel seffaflik (blur yok; DWM golgesi kaybolur, kabul edilen taviz)
      ? { transparent: true }
      : glassMode === 'acrylic'
        // Bugulu: Windows 11 acrylic (macOS vibrancy/blur muadili); transparent ile BIRLIKTE kullanilamaz
        ? { backgroundMaterial: 'acrylic', vibrancy: 'sidebar' /* Windows'ta no-op, zararsiz */ }
        : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  Menu.setApplicationMenu(null);

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

app.whenReady().then(createWindow);

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

ipcMain.handle('shell:list', () => shellProfiles);

// Sistem yetenekleri (renderer arayuzu Win10'da bugulu secenegini devre disi gosterir)
ipcMain.handle('sys:caps', () => ({ acrylic: ACRYLIC_SUPPORTED }));

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
