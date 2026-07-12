const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('termAPI', {
  // Pencere kontrolleri
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  confirmClose: () => ipcRenderer.send('window:close-confirmed'),

  // Shell profilleri
  listShells: () => ipcRenderer.invoke('shell:list'),

  // Ayarlar (tema/profil, yazi boyutu, imlec, kabuk) — kalici
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings) => ipcRenderer.send('settings:set', settings),
  relaunch: () => ipcRenderer.send('app:relaunch'),
  getCaps: () => ipcRenderer.invoke('sys:caps'),
  getSession: () => ipcRenderer.invoke('session:get'),
  setSession: (session) => ipcRenderer.send('session:set', session),
  getBootContext: () => ipcRenderer.invoke('app:boot-context'),
  listHistory: () => ipcRenderer.invoke('history:list'),
  addHistory: (entry) => ipcRenderer.send('history:add', entry),
  clearHistory: () => ipcRenderer.send('history:clear'),

  // PTY yasam dongusu
  createPty: (tabId, profileKey, cols, rows, cwd) => ipcRenderer.invoke('pty:create', { tabId, profileKey, cols, rows, cwd }),
  writePty: (tabId, data) => ipcRenderer.send('pty:write', { tabId, data }),
  resizePty: (tabId, cols, rows) => ipcRenderer.send('pty:resize', { tabId, cols, rows }),
  killPty: (tabId) => ipcRenderer.send('pty:kill', { tabId }),

  onPtyData: (tabId, callback) => {
    const channel = `pty:data:${tabId}`;
    const listener = (event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onPtyExit: (tabId, callback) => {
    const channel = `pty:exit:${tabId}`;
    const listener = (event, code) => callback(code);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  // Pano (kopyala/yapistir) — ana surecin clipboard modulu uzerinden (izin/prompt yok)
  clipboardWrite: (text) => ipcRenderer.send('clipboard:write', text),
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),

  // Dis baglanti (NatureCo imzasi / natureco.me) — sistem tarayicisinda ac
  openExternal: (url) => ipcRenderer.send('shell:openExternal', url),

  // NatureCo Hesabı (SSO)
  ncAccountStatus:   ()                 => ipcRenderer.invoke('nc:account:status'),
  ncAccountSendOtp:  (email)            => ipcRenderer.invoke('nc:account:sendOtp', { email }),
  ncAccountVerify:   (email, value)     => ipcRenderer.invoke('nc:account:verify', { email, value }),
  ncAccountPassword: (email, password)  => ipcRenderer.invoke('nc:account:password', { email, password }),
  ncAccountLogout:   ()                 => ipcRenderer.send('nc:account:logout'),

  // Otomatik guncelleme
  checkForUpdates: () => ipcRenderer.send('update:check'),
  installUpdate:   () => ipcRenderer.send('update:install'),   // Windows: indirileni kur + yeniden baslat
  onUpdateAvailable:  (cb) => { const l = (_, d) => cb(d); ipcRenderer.on('update:available', l);  return () => ipcRenderer.removeListener('update:available', l); },
  onUpdateProgress:   (cb) => { const l = (_, d) => cb(d); ipcRenderer.on('update:progress', l);   return () => ipcRenderer.removeListener('update:progress', l); },
  onUpdateDownloaded: (cb) => { const l = (_, d) => cb(d); ipcRenderer.on('update:downloaded', l); return () => ipcRenderer.removeListener('update:downloaded', l); },
  onUpdateNone:       (cb) => { const l = (_, d) => cb(d); ipcRenderer.on('update:none', l);       return () => ipcRenderer.removeListener('update:none', l); },
  onUpdateError:      (cb) => { const l = (_, d) => cb(d); ipcRenderer.on('update:error', l);      return () => ipcRenderer.removeListener('update:error', l); },

  // Pencere odak/blur — traffic-light'lari griye cevirmek icin (macOS davranisi)
  onFocusChange: (callback) => {
    const listener = (event, focused) => callback(focused);
    ipcRenderer.on('window:focus', listener);
    return () => ipcRenderer.removeListener('window:focus', listener);
  },

  // Maximize/restore — maximize'da pencere koselerini duzlestirmek icin
  onMaximizeChange: (callback) => {
    const listener = (event, maximized) => callback(maximized);
    ipcRenderer.on('window:maximized', listener);
    return () => ipcRenderer.removeListener('window:maximized', listener);
  },
  onOpenDirectory: (callback) => { const l = (_, cwd) => callback(cwd); ipcRenderer.on('app:open-directory', l); return () => ipcRenderer.removeListener('app:open-directory', l); },
  onNewTab: (callback) => { const l = () => callback(); ipcRenderer.on('app:new-tab', l); return () => ipcRenderer.removeListener('app:new-tab', l); },
  onCloseTab: (callback) => { const l = () => callback(); ipcRenderer.on('app:close-tab', l); return () => ipcRenderer.removeListener('app:close-tab', l); },
  onShowSettings: (callback) => { const l = () => callback(); ipcRenderer.on('app:show-settings', l); return () => ipcRenderer.removeListener('app:show-settings', l); },
  onCloseRequested: (callback) => { const l = () => callback(); ipcRenderer.on('window:close-requested', l); return () => ipcRenderer.removeListener('window:close-requested', l); },
  onSmokeCommand: (callback) => { const l = (_, command) => callback(command); ipcRenderer.on('app:smoke-command', l); return () => ipcRenderer.removeListener('app:smoke-command', l); },

  // ── ZeroLink ──────────────────────────────────────────────────────────────
  // HOST: bu terminali paylas → ZeroLink kodu uret
  zlHostStart:      (tabId)        => ipcRenderer.invoke('zl:host:start', { tabId }),
  zlHostStop:       ()             => ipcRenderer.send('zl:host:stop'),

  // CLIENT: koda baglan
  zlClientConnect:  (code, tabId)  => ipcRenderer.invoke('zl:client:connect', { code, tabId }),
  zlClientSend:     (data)         => ipcRenderer.send('zl:client:send', { data }),
  zlClientResize:   (cols, rows)   => ipcRenderer.send('zl:client:resize', { cols, rows }),
  zlClientDisconnect: ()           => ipcRenderer.send('zl:client:disconnect'),

  // SSH ek yetenekleri (bağlıyken)
  zlClientPushFile:   ()                                   => ipcRenderer.invoke('zl:client:push'),
  zlClientPullFile:   (remotePath)                         => ipcRenderer.invoke('zl:client:pull', { remotePath }),
  zlClientForwardAdd: (localPort, remoteHost, remotePort)  => ipcRenderer.invoke('zl:client:forward:add', { localPort, remoteHost, remotePort }),
  zlClientForwardRemove: (localPort)                       => ipcRenderer.send('zl:client:forward:remove', { localPort }),

  onZlClientFileProgress: (cb) => { const l = (_, d) => cb(d); ipcRenderer.on('zl:client:file-progress', l); return () => ipcRenderer.removeListener('zl:client:file-progress', l); },
  onZlClientFileDone:     (cb) => { const l = (_, d) => cb(d); ipcRenderer.on('zl:client:file-done', l);     return () => ipcRenderer.removeListener('zl:client:file-done', l); },
  onZlClientFileError:    (cb) => { const l = (_, d) => cb(d); ipcRenderer.on('zl:client:file-error', l);    return () => ipcRenderer.removeListener('zl:client:file-error', l); },
  onZlClientForwardOpen:  (cb) => { const l = (_, d) => cb(d); ipcRenderer.on('zl:client:forward-open', l);   return () => ipcRenderer.removeListener('zl:client:forward-open', l); },
  onZlClientForwardError: (cb) => { const l = (_, d) => cb(d); ipcRenderer.on('zl:client:forward-error', l);  return () => ipcRenderer.removeListener('zl:client:forward-error', l); },

  // HOST olaylari
  onZlHostCode:        (cb) => { const l = (_, d) => cb(d); ipcRenderer.on('zl:host:code', l);        return () => ipcRenderer.removeListener('zl:host:code', l); },
  onZlHostTimer:       (cb) => { const l = (_, d) => cb(d); ipcRenderer.on('zl:host:timer', l);       return () => ipcRenderer.removeListener('zl:host:timer', l); },
  onZlHostExpired:     (cb) => { const l = ()     => cb();  ipcRenderer.on('zl:host:expired', l);     return () => ipcRenderer.removeListener('zl:host:expired', l); },
  onZlHostConnected:   (cb) => { const l = (_, d) => cb(d); ipcRenderer.on('zl:host:connected', l);   return () => ipcRenderer.removeListener('zl:host:connected', l); },
  onZlHostSession:     (cb) => { const l = (_, d) => cb(d); ipcRenderer.on('zl:host:session', l);     return () => ipcRenderer.removeListener('zl:host:session', l); },
  onZlHostFile:        (cb) => { const l = (_, d) => cb(d); ipcRenderer.on('zl:host:file', l);        return () => ipcRenderer.removeListener('zl:host:file', l); },
  onZlHostDisconnected:(cb) => { const l = ()     => cb();  ipcRenderer.on('zl:host:disconnected', l);return () => ipcRenderer.removeListener('zl:host:disconnected', l); },

  // CLIENT olaylari
  onZlClientConnected:   (cb) => { const l = () => cb();    ipcRenderer.on('zl:client:connected', l);   return () => ipcRenderer.removeListener('zl:client:connected', l); },
  onZlClientRemoteExit:  (cb) => { const l = (_, d) => cb(d); ipcRenderer.on('zl:client:remote-exit', l); return () => ipcRenderer.removeListener('zl:client:remote-exit', l); },
  onZlClientDisconnected:(cb) => { const l = () => cb();    ipcRenderer.on('zl:client:disconnected', l);return () => ipcRenderer.removeListener('zl:client:disconnected', l); },

  // Ortak hata olayi
  onZlError: (cb) => { const l = (_, d) => cb(d); ipcRenderer.on('zl:error', l); return () => ipcRenderer.removeListener('zl:error', l); },
});
