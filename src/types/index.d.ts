// ── Tip Tanımları ────────────────────────────────────────────────────────────
// Cupertino Terminal için TypeScript tip tanımları

import { Terminal, ITerminalOptions, IBuffer } from '@xterm/xterm';

// PTY Process arayüzü
export interface PtyProcess {
  pid: number;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

// Shell profili
export interface ShellProfile {
  command: string;
  args: string[];
  name: string;
}

// Shell durumu
export interface ShellState {
  cwd: string;
  running: boolean;
  lastExitCode: number | null;
  lastDurationMs: number | null;
  commandStarted(): ShellState;
  cwdChanged(cwd: string): ShellState;
  osc133(data: string): ShellState;
}

// Terminal kaydı
export interface TerminalRecord {
  term: Terminal;
  fitAddon: any;
  searchAddon: any;
  webglAddon: any;
  tabEl: HTMLElement;
  paneEl: HTMLElement;
  title: string;
  shellName: string;
  profileKey: string;
  shellState: ShellState;
  inputBuffer: string;
  currentCommand: string | null;
  updateShellState?: (state: ShellState) => void;
  unsubData?: () => void;
  unsubExit?: () => void;
  zlCli?: any;
  resizeObserver?: ResizeObserver;
  parentId?: string;
  splitChildId?: string;
  splitGroup?: HTMLElement;
  splitDivider?: HTMLElement;
  splitDirection?: 'vertical' | 'horizontal';
  splitRatio?: number;
}

// Tema
export interface Theme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface ThemeConfig {
  name: string;
  bgRgb: string;
  bgAlpha: number;
  light: boolean;
  theme: Theme;
}

// Ayarlar
export interface Settings {
  profile: string;
  fontSize: number;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
  shell: string;
  opacity: number | null;
  glass: 'acrylic' | 'clear';
  gpuRenderer: boolean;
  lang: 'en' | 'tr' | null;
}

// Oturum durumu
export interface SessionTab {
  profileKey: string;
  cwd: string | null;
  split?: {
    direction: 'vertical' | 'horizontal';
    ratio: number;
    profileKey: string;
    cwd: string;
  };
}

export interface Session {
  tabs: SessionTab[];
  activeIndex: number;
}

// Komut geçmişi
export interface CommandHistoryEntry {
  command: string;
  cwd: string | null;
  exitCode: number | null;
  durationMs: number | null;
  timestamp: number;
}

// ZeroLink durumu
export interface ZeroLinkState {
  hostActive: boolean;
  hostConnected: boolean;
  clientActive: boolean;
  clientTabId: string | null;
  lastCode: string | null;
  lastAddr: string | null;
}

// IPC API arayüzü
export interface TermAPI {
  // Pencere kontrolleri
  minimize(): void;
  maximize(): void;
  close(): void;
  confirmClose(): void;

  // Shell
  listShells(): Promise<Record<string, ShellProfile>>;

  // Ayarlar
  getSettings(): Promise<Partial<Settings>>;
  setSettings(settings: Settings): void;
  relaunch(): void;
  getCaps(): Promise<{ acrylic: boolean; platform: string; version: string }>;
  getSession(): Promise<Session>;
  setSession(session: Session): void;
  getBootContext(): Promise<{ cwd?: string }>;

  // Geçmiş
  listHistory(): Promise<CommandHistoryEntry[]>;
  addHistory(entry: CommandHistoryEntry): void;
  clearHistory(): void;

  // PTY
  createPty(tabId: string, profileKey: string, cols: number, rows: number, cwd: string | null): Promise<{ pid: number; shellName: string; cwd: string }>;
  writePty(tabId: string, data: string): void;
  resizePty(tabId: string, cols: number, rows: number): void;
  killPty(tabId: string): void;
  onPtyData(tabId: string, callback: (data: Uint8Array) => void): () => void;
  onPtyExit(tabId: string, callback: (code: number) => void): () => void;

  // Pano
  clipboardWrite(text: string): void;
  clipboardRead(): Promise<string>;

  // Dış bağlantı
  openExternal(url: string): void;

  // ZeroLink
  zlHostStart(tabId: string): Promise<{ code: string }>;
  zlHostStop(): void;
  zlClientConnect(code: string, tabId: string): Promise<void>;
  zlClientSend(data: string): void;
  zlClientResize(cols: number, rows: number): void;
  zlClientDisconnect(): void;
  zlClientPushFile(): Promise<{ canceled: boolean; name?: string }>;
  zlClientPullFile(remotePath: string): Promise<{ name: string; bytes: number }>;
  zlClientForwardAdd(localPort: number, remoteHost: string, remotePort: number): Promise<void>;
  zlClientForwardRemove(localPort: number): void;

  // ZeroLink olayları
  onZlHostCode(callback: (data: { code: string }) => void): () => void;
  onZlHostTimer(callback: (data: { secondsLeft: number }) => void): () => void;
  onZlHostExpired(callback: () => void): () => void;
  onZlHostConnected(callback: (data: { addr: string }) => void): () => void;
  onZlHostSession(callback: (data: { pid: number }) => void): () => void;
  onZlHostFile(callback: (info: any) => void): () => void;
  onZlHostDisconnected(callback: () => void): () => void;
  onZlClientConnected(callback: () => void): () => void;
  onZlClientRemoteExit(callback: (data: { code: number }) => void): () => void;
  onZlClientDisconnected(callback: () => void): () => void;
  onZlClientFileProgress(callback: (data: { name: string; sent: number; size: number }) => void): () => void;
  onZlClientFileDone(callback: (info: { name: string; bytes: number }) => void): () => void;
  onZlClientFileError(callback: (data: { message: string }) => void): () => void;
  onZlClientForwardOpen(callback: (data: { localPort: number; target: string }) => void): () => void;
  onZlClientForwardError(callback: (data: { localPort: number; message: string }) => void): () => void;
  onZlError(callback: (data: { message: string }) => void): () => void;

  // Pencere olayları
  onFocusChange(callback: (focused: boolean) => void): () => void;
  onMaximizeChange(callback: (maximized: boolean) => void): () => void;
  onOpenDirectory(callback: (cwd: string) => void): () => void;
  onNewTab(callback: () => void): () => void;
  onCloseTab(callback: () => void): () => void;
  onShowSettings(callback: () => void): () => void;
  onCloseRequested(callback: () => void): () => void;
  onSmokeCommand(callback: (command: string) => void): () => void;

  // Güncelleme
  checkForUpdates(): void;
  installUpdate(): void;
  onUpdateAvailable(callback: (data: { version: string; url?: string; silent?: boolean }) => void): () => void;
  onUpdateProgress(callback: (data: { percent: number }) => void): () => void;
  onUpdateDownloaded(callback: (data: { version: string }) => void): () => void;
  onUpdateNone(callback: (data: { version: string }) => void): () => void;
  onUpdateError(callback: (data: { message: string }) => void): () => void;

  // NatureCo Hesabı
  ncAccountStatus(): Promise<{ loggedIn: boolean; email?: string }>;
  ncAccountSendOtp(email: string): Promise<void>;
  ncAccountVerify(email: string, value: string): Promise<{ email: string }>;
  ncAccountPassword(email: string, password: string): Promise<{ email: string }>;
  ncAccountLogout(): void;
}

// Window geniştirme
declare global {
  interface Window {
    termAPI: TermAPI;
    ZeroLinkCLI: any;
  }
}
