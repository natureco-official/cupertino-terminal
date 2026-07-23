import { Channel, invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

const appWindow = getCurrentWindow();
const noop = () => {};
const noopSubscription = () => noop;
const unsupported = (feature) => Promise.reject(new Error(`${feature} is not available in Rock 0`));
const closeRequested = new Set();
const ptyData = new Map();
const ptyExit = new Map();

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

async function createPty(tabId, profileKey, cols, rows, cwd) {
  const onData = new Channel();
  const onExit = new Channel();
  onData.onmessage = (data) => emit(ptyData, tabId, data);
  onExit.onmessage = (code) => emit(ptyExit, tabId, code);
  return invoke('create_pty', { tabId, profileKey, cols, rows, cwd, onData, onExit });
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
  writePty: noop,
  resizePty: noop,
  killPty: noop,
  onPtyData: (tabId, callback) => subscribe(ptyData, tabId, callback),
  onPtyExit: (tabId, callback) => subscribe(ptyExit, tabId, callback),

  clipboardWrite: (text) => navigator.clipboard?.writeText(String(text)).catch(noop),
  clipboardRead: () => navigator.clipboard?.readText().catch(() => '') ?? Promise.resolve(''),
  openExternal: (url) => invoke('open_external', { url }).catch((error) => console.warn(error)),

  ncAccountStatus: () => Promise.resolve({ loggedIn: false, email: null }),
  ncAccountSendOtp: () => unsupported('NatureCo account'),
  ncAccountVerify: () => unsupported('NatureCo account'),
  ncAccountPassword: () => unsupported('NatureCo account'),
  ncAccountLogout: noop,

  checkForUpdates: noop,
  installUpdate: noop,
  onUpdateAvailable: noopSubscription,
  onUpdateProgress: noopSubscription,
  onUpdateDownloaded: noopSubscription,
  onUpdateNone: noopSubscription,
  onUpdateError: noopSubscription,

  onFocusChange: (callback) => tauriWindowSubscription(
    (handler) => appWindow.onFocusChanged(handler),
    callback,
  ),
  onMaximizeChange: (callback) => tauriWindowSubscription(
    (handler) => appWindow.onResized(async () => handler({ payload: await appWindow.isMaximized() })),
    callback,
  ),
  onOpenDirectory: noopSubscription,
  onNewTab: noopSubscription,
  onCloseTab: noopSubscription,
  onShowSettings: noopSubscription,
  onCloseRequested: (callback) => {
    closeRequested.add(callback);
    return () => closeRequested.delete(callback);
  },
  onSmokeCommand: noopSubscription,

  zlHostStart: () => unsupported('ZeroLink'),
  zlHostStop: noop,
  zlClientConnect: () => unsupported('ZeroLink'),
  zlClientSend: noop,
  zlClientResize: noop,
  zlClientDisconnect: noop,
  zlClientPushFile: () => unsupported('ZeroLink file transfer'),
  zlClientPullFile: () => unsupported('ZeroLink file transfer'),
  zlClientForwardAdd: () => unsupported('ZeroLink port forwarding'),
  zlClientForwardRemove: noop,
  onZlClientFileProgress: noopSubscription,
  onZlClientFileDone: noopSubscription,
  onZlClientFileError: noopSubscription,
  onZlClientForwardOpen: noopSubscription,
  onZlClientForwardError: noopSubscription,
  onZlHostCode: noopSubscription,
  onZlHostTimer: noopSubscription,
  onZlHostExpired: noopSubscription,
  onZlHostConnected: noopSubscription,
  onZlHostSession: noopSubscription,
  onZlHostFile: noopSubscription,
  onZlHostDisconnected: noopSubscription,
  onZlClientConnected: noopSubscription,
  onZlClientRemoteExit: noopSubscription,
  onZlClientDisconnected: noopSubscription,
  onZlError: noopSubscription,
});
