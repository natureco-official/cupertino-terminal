import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { open } from '@tauri-apps/plugin-dialog';
import { check as checkForUpdate } from '@tauri-apps/plugin-updater';

const appWindow = getCurrentWindow();
const noop = () => {};
const unsupported = (feature) => Promise.reject(new Error(`${feature} arrives in a later Tauri build`));
const closeRequested = new Set();
const ptyData = new Map();
const ptyExit = new Map();
const ptyWrites = new Map();
const updateEvents = new Map();
let pendingUpdate = null;
let updaterTask = null;

listen('zl:client:data', ({ payload }) => {
  if (!payload?.tabId) return;
  const bytes = payload.data instanceof Uint8Array
    ? payload.data
    : new Uint8Array(payload.data || []);
  emit(ptyData, payload.tabId, bytes);
}).catch((error) => console.warn('ZeroLink data subscription failed:', error));

function subscribe(map, key, callback) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(callback);
  return () => {
    map.get(key)?.delete(callback);
    if (!map.get(key)?.size) map.delete(key);
  };
}

function emit(map, key, value) {
  for (const callback of map.get(key) || []) callback(value);
}

function tauriWindowSubscription(register, callback) {
  let disposed = false;
  let unlisten = null;
  register((event) => callback(event.payload)).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  }).catch((error) => console.warn('Tauri window event subscription failed:', error));
  return () => {
    disposed = true;
    unlisten?.();
  };
}

function tauriEventSubscription(eventName, callback) {
  let disposed = false;
  let unlisten = null;
  listen(eventName, (event) => callback(event.payload)).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  }).catch((error) => console.warn(`Tauri event subscription failed (${eventName}):`, error));
  return () => {
    disposed = true;
    unlisten?.();
  };
}

async function createPty(tabId, profileKey, cols, rows, cwd) {
  const onData = new Channel();
  const onExit = new Channel();
  onData.onmessage = (data) => {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    try {
      emit(ptyData, tabId, bytes);
    } finally {
      invoke('pty_ack', { tabId }).catch((error) => console.warn('PTY acknowledgement failed:', error));
    }
  };
  onExit.onmessage = (code) => emit(ptyExit, tabId, code);
  return invoke('create_pty', { tabId, profileKey, cols, rows, cwd, onData, onExit });
}

function invokePty(command, payload) {
  return invoke(command, payload).catch((error) => console.warn(`${command} failed:`, error));
}

function writePty(tabId, data) {
  const write = (ptyWrites.get(tabId) || Promise.resolve())
    .catch(noop)
    .then(() => invoke('pty_write', { tabId, data }));
  ptyWrites.set(tabId, write);
  write.finally(() => {
    if (ptyWrites.get(tabId) === write) ptyWrites.delete(tabId);
  }).catch(noop);
  return write.catch((error) => console.warn('pty_write failed:', error));
}

function killPty(tabId) {
  const pending = ptyWrites.get(tabId) || Promise.resolve();
  ptyWrites.delete(tabId);
  return pending.catch(noop).then(() => invokePty('pty_kill', { tabId }));
}

function emitUpdate(eventName, payload) {
  emit(updateEvents, eventName, payload);
}

function runUpdateCheck(manual = false) {
  if (updaterTask) return updaterTask;
  updaterTask = (async () => {
    if (pendingUpdate) {
      await pendingUpdate.close();
      pendingUpdate = null;
    }

    const update = await checkForUpdate();
    if (!update) {
      if (manual) emitUpdate('none', {});
      return;
    }

    pendingUpdate = update;
    emitUpdate('available', { version: update.version, url: null, silent: true });

    let downloaded = 0;
    let contentLength = 0;
    await update.download((event) => {
      if (event.event === 'Started') {
        contentLength = event.data.contentLength || 0;
        emitUpdate('progress', { percent: 0 });
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength;
        const percent = contentLength
          ? Math.max(0, Math.min(100, Math.round((downloaded / contentLength) * 100)))
          : 0;
        emitUpdate('progress', { percent });
      } else if (event.event === 'Finished') {
        emitUpdate('progress', { percent: 100 });
      }
    });
    emitUpdate('downloaded', { version: update.version });
  })().catch((error) => {
    console.warn('Tauri updater failed:', error);
    if (manual) emitUpdate('error', { message: String(error?.message || error) });
  }).finally(() => {
    updaterTask = null;
  });
  return updaterTask;
}

async function installUpdate() {
  if (!pendingUpdate) {
    emitUpdate('error', { message: 'There is no downloaded update to install.' });
    return;
  }
  try {
    await pendingUpdate.install();
    await invoke('relaunch_app');
  } catch (error) {
    console.warn('Tauri update installation failed:', error);
    emitUpdate('error', { message: String(error?.message || error) });
  }
}

window.termAPI = Object.freeze({
  minimize: () => appWindow.minimize(),
  maximize: () => appWindow.toggleMaximize(),
  close: () => {
    if (closeRequested.size) {
      for (const callback of closeRequested) callback();
      return Promise.resolve();
    }
    return appWindow.destroy();
  },
  confirmClose: () => appWindow.destroy(),

  listShells: () => invoke('list_shells'),
  getSettings: () => invoke('get_settings'),
  setSettings: (settings) => invoke('set_settings', { settings }),
  relaunch: () => invoke('relaunch_app'),
  getCaps: () => invoke('get_caps'),
  getSession: () => invoke('get_session'),
  setSession: (session) => invoke('set_session', { session }),
  getBootContext: () => invoke('get_boot_context'),
  listHistory: () => invoke('list_history'),
  addHistory: (entry) => invoke('add_history', { entry }),
  clearHistory: () => invoke('clear_history'),

  createPty,
  writePty,
  resizePty: (tabId, cols, rows) => invokePty('pty_resize', { tabId, cols, rows }),
  killPty,
  onPtyData: (tabId, callback) => subscribe(ptyData, tabId, callback),
  onPtyExit: (tabId, callback) => subscribe(ptyExit, tabId, callback),

  clipboardWrite: (text) => writeText(String(text)).catch((error) => {
    console.warn('Clipboard write failed:', error);
  }),
  clipboardRead: () => readText().catch((error) => {
    console.warn('Clipboard read failed:', error);
    return '';
  }),
  openExternal: (url) => invoke('open_external', { url }).catch((error) => console.warn(error)),

  ncAccountStatus: () => invoke('nc_account_status'),
  ncAccountSendOtp: (email) => invoke('nc_account_send_otp', { email }),
  ncAccountVerify: (email, value) => invoke('nc_account_verify', { email, value }),
  ncAccountPassword: (email, password) => invoke('nc_account_password', { email, password }),
  ncAccountLogout: () => invoke('nc_account_logout').catch((error) => {
    console.warn('NatureCo account logout failed:', error);
  }),

  checkForUpdates: () => runUpdateCheck(true),
  installUpdate,
  onUpdateAvailable: (callback) => subscribe(updateEvents, 'available', callback),
  onUpdateProgress: (callback) => subscribe(updateEvents, 'progress', callback),
  onUpdateDownloaded: (callback) => subscribe(updateEvents, 'downloaded', callback),
  onUpdateNone: (callback) => subscribe(updateEvents, 'none', callback),
  onUpdateError: (callback) => subscribe(updateEvents, 'error', callback),

  onFocusChange: (callback) => tauriWindowSubscription(
    (handler) => appWindow.onFocusChanged(handler),
    callback,
  ),
  onMaximizeChange: (callback) => tauriWindowSubscription(
    (handler) => appWindow.onResized(async () => handler({ payload: await appWindow.isMaximized() })),
    callback,
  ),
  onFullscreenChange: (callback) => {
    appWindow.isFullscreen().then(callback).catch((error) => {
      console.warn('Tauri fullscreen state query failed:', error);
    });
    return tauriWindowSubscription(
      (handler) => appWindow.onResized(async () => handler({ payload: await appWindow.isFullscreen() })),
      callback,
    );
  },
  onOpenDirectory: (callback) => tauriEventSubscription('app:open-directory', callback),
  onNewTab: (callback) => tauriEventSubscription('app:new-tab', callback),
  onCloseTab: (callback) => tauriEventSubscription('app:close-tab', callback),
  onShowSettings: (callback) => tauriEventSubscription('app:show-settings', callback),
  onCloseRequested: (callback) => {
    closeRequested.add(callback);
    return () => closeRequested.delete(callback);
  },
  onSmokeCommand: (callback) => tauriEventSubscription('app:smoke-command', callback),

  completeSmokeTest: (result) => invoke('complete_smoke_test', { result }),
  reportPerformance: (kind, result) => invoke('report_performance', { kind, result }),

  zlHostStart: (tabId) => invoke('zl_host_start', { tabId }),
  zlHostStop: () => invoke('zl_host_stop').catch((error) => console.warn(error)),
  zlClientConnect: (code, tabId) => invoke('zl_client_connect', { code, tabId }),
  zlClientSend: (data) => invoke('zl_client_send', { data }).catch((error) => console.warn(error)),
  zlClientResize: (cols, rows) => invoke('zl_client_resize', { cols, rows }).catch((error) => console.warn(error)),
  zlClientDisconnect: () => invoke('zl_client_disconnect').catch((error) => console.warn(error)),
  zlClientPushFile: async () => {
    const path = await open({ multiple: false, directory: false });
    if (!path) return { canceled: true };
    return invoke('zl_client_push_file', { path });
  },
  zlClientPullFile: (remotePath) => invoke('zl_client_pull_file', { remotePath }),
  zlClientForwardAdd: (localPort, remoteHost, remotePort) => invoke('zl_client_forward_add', {
    localPort: Number(localPort),
    remoteHost,
    remotePort: Number(remotePort),
  }),
  zlClientForwardRemove: (localPort) => invoke('zl_client_forward_remove', {
    localPort: Number(localPort),
  }).catch((error) => console.warn(error)),
  onZlClientFileProgress: (callback) => tauriEventSubscription('zl:client:file-progress', callback),
  onZlClientFileDone: (callback) => tauriEventSubscription('zl:client:file-done', callback),
  onZlClientFileError: (callback) => tauriEventSubscription('zl:client:file-error', callback),
  onZlClientForwardOpen: (callback) => tauriEventSubscription('zl:client:forward-open', callback),
  onZlClientForwardError: (callback) => tauriEventSubscription('zl:client:forward-error', callback),
  onZlHostCode: (callback) => tauriEventSubscription('zl:host:code', callback),
  onZlHostTimer: (callback) => tauriEventSubscription('zl:host:timer', callback),
  onZlHostExpired: (callback) => tauriEventSubscription('zl:host:expired', callback),
  onZlHostConnected: (callback) => tauriEventSubscription('zl:host:connected', callback),
  onZlHostSession: (callback) => tauriEventSubscription('zl:host:session', callback),
  onZlHostFile: (callback) => tauriEventSubscription('zl:host:file', callback),
  onZlHostDisconnected: (callback) => tauriEventSubscription('zl:host:disconnected', callback),
  onZlClientConnected: (callback) => tauriEventSubscription('zl:client:connected', callback),
  onZlClientRemoteExit: (callback) => tauriEventSubscription('zl:client:remote-exit', callback),
  onZlClientDisconnected: (callback) => tauriEventSubscription('zl:client:disconnected', callback),
  onZlError: (callback) => tauriEventSubscription('zl:error', callback),
});

setTimeout(() => runUpdateCheck(false), 4000);
