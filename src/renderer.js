// xterm 5.x UMD dosyalari — ESM named export YOK. Side-effect import ile calistirilip
// global'lerden aliniyor (UMD wrapper window.Terminal/FitAddon/WebLinksAddon set eder).
import { Terminal } from '../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { WebLinksAddon } from '../node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs';
import { WebglAddon } from '../node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs';
import { SearchAddon } from '../node_modules/@xterm/addon-search/lib/addon-search.mjs';
import { ShellState, parseOsc7 } from './shell-state.mjs';
import { normalizeSession, serializeSession } from './session-state.mjs';
import { filterCommands } from './command-palette.mjs';
import './zerolink-cli.js'; // ZeroLinkCLI global'e yuklenir (window.ZeroLinkCLI)

const ZeroLinkCLI = window.ZeroLinkCLI;

// ── ZeroLink global durum (tum sekmeler arasi paylasilan) — tek kaynak of truth ──
const zlState = {
  hostActive:    false,  // host oturumu baslatildi mi
  hostConnected: false,  // client baglandi mi
  clientActive:  false,  // client modunda mi (uzak SSH oturumu aktif)
  clientTabId:   null,   // uzak oturumun bagli oldugu sekme
  lastCode:      null,   // son uretilen kod
  lastAddr:      null,   // son baglanan adres
};

// ---- macOS Terminal.app profilleri ----
// Terminal.app tum profillerde ayni varsayilan ANSI paletini kullanir (Solid Colors haric);
// profiller arka plan/metin/imlec/secim renkleriyle ayrisir.
const ANSI_MAC = {
  black: '#000000',
  red: '#c23621',
  green: '#25bc24',
  yellow: '#adad27',
  blue: '#492ee1',
  magenta: '#d338d3',
  cyan: '#33bbc8',
  white: '#cbcccd',
  brightBlack: '#818383',
  brightRed: '#fc391f',
  brightGreen: '#31e722',
  brightYellow: '#eaec23',
  brightBlue: '#5833ff',
  brightMagenta: '#f935f8',
  brightCyan: '#14f0f0',
  brightWhite: '#e9ebeb',
};

// xterm background hep transparan ('#00000000') → gercek zemin CSS --bg'den gelir;
// boylece pane padding'i ile terminal ici AYNI renkte olur ve yari saydam profiller
// (Pro, Silver Aerogel) pencerenin acrylic blur'unu gosterebilir.
// bgRgb + bgAlpha: zemin rengi ve profilin VARSAYILAN opakligi (macOS Terminal'deki
// profil "Opacity" ayari gibi kullanici kaydiriciyla ezebilir; Otomatik = bgAlpha).
const THEMES = {
  // NatureCo marka teması — natureco.me landing paletinden esinlenildi
  // (koyu yeşil-uzay zemin, zümrüt + turkuaz, altın/gül/indigo aksanlar).
  natureco: {
    name: 'NatureCo',
    bgRgb: '6, 18, 12', bgAlpha: 0.9,
    light: false,
    theme: {
      background: '#00000000',
      foreground: '#e6f0ea',
      cursor: '#34d399',
      cursorAccent: '#06120c',
      selectionBackground: 'rgba(52, 211, 153, 0.26)',
      black: '#0e2318',
      red: '#fb7185',
      green: '#34d399',
      yellow: '#fcd34d',
      blue: '#818cf8',
      magenta: '#f472b6',
      cyan: '#22d3ee',
      white: '#e6f0ea',
      brightBlack: '#4b6358',
      brightRed: '#fda4af',
      brightGreen: '#6ee7b7',
      brightYellow: '#fde68a',
      brightBlue: '#a5b4fc',
      brightMagenta: '#f9a8d4',
      brightCyan: '#67e8f9',
      brightWhite: '#f0f7f3',
    },
  },
  pro: {
    name: 'Pro',
    bgRgb: '30, 30, 30', bgAlpha: 0.82,
    light: false,
    theme: {
      background: '#00000000',
      foreground: '#f2f2f2',
      cursor: '#f2f2f2',
      cursorAccent: '#1e1e1e',
      selectionBackground: 'rgba(120, 150, 210, 0.38)',
      black: '#1e1e1e',
      red: '#ff5f56',
      green: '#27c93f',
      yellow: '#ffbd2e',
      blue: '#5da3fa',
      magenta: '#bf68d9',
      cyan: '#5ad4d4',
      white: '#f2f2f2',
      brightBlack: '#6b6b6b',
      brightRed: '#ff8783',
      brightGreen: '#5af78e',
      brightYellow: '#f3f99d',
      brightBlue: '#9aedfe',
      brightMagenta: '#d2a8ff',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff',
    },
  },
  basic: {
    name: 'Basic',
    bgRgb: '255, 255, 255', bgAlpha: 1,
    light: true,
    theme: {
      background: '#00000000',
      foreground: '#000000',
      cursor: '#5b5b5b',
      cursorAccent: '#ffffff',
      selectionBackground: 'rgba(164, 205, 255, 0.65)',
      ...ANSI_MAC,
    },
  },
  homebrew: {
    name: 'Homebrew',
    bgRgb: '0, 0, 0', bgAlpha: 1,
    light: false,
    theme: {
      background: '#00000000',
      foreground: '#28fe14',
      cursor: '#23ff18',
      cursorAccent: '#000000',
      selectionBackground: 'rgba(40, 254, 20, 0.22)',
      ...ANSI_MAC,
    },
  },
  manPage: {
    name: 'Man Page',
    bgRgb: '254, 244, 156', bgAlpha: 1,
    light: true,
    theme: {
      background: '#00000000',
      foreground: '#000000',
      cursor: '#7f7f7f',
      cursorAccent: '#fef49c',
      selectionBackground: 'rgba(169, 193, 226, 0.75)',
      ...ANSI_MAC,
    },
  },
  novel: {
    name: 'Novel',
    bgRgb: '223, 219, 195', bgAlpha: 1,
    light: true,
    theme: {
      background: '#00000000',
      foreground: '#3b2322',
      cursor: '#73635a',
      cursorAccent: '#dfdbc3',
      selectionBackground: 'rgba(164, 163, 144, 0.7)',
      ...ANSI_MAC,
    },
  },
  ocean: {
    name: 'Ocean',
    bgRgb: '34, 79, 188', bgAlpha: 1,
    light: false,
    theme: {
      background: '#00000000',
      foreground: '#ffffff',
      cursor: '#7f7f7f',
      cursorAccent: '#224fbc',
      selectionBackground: 'rgba(33, 109, 255, 0.75)',
      ...ANSI_MAC,
    },
  },
  grass: {
    name: 'Grass',
    bgRgb: '19, 119, 61', bgAlpha: 1,
    light: false,
    theme: {
      background: '#00000000',
      foreground: '#fff0a5',
      cursor: '#8c2800',
      cursorAccent: '#fff0a5',
      selectionBackground: 'rgba(182, 73, 38, 0.75)',
      ...ANSI_MAC,
    },
  },
  redSands: {
    name: 'Red Sands',
    bgRgb: '122, 37, 30', bgAlpha: 1,
    light: false,
    theme: {
      background: '#00000000',
      foreground: '#d7c9a7',
      cursor: '#ffffff',
      cursorAccent: '#7a251e',
      selectionBackground: 'rgba(164, 163, 144, 0.55)',
      ...ANSI_MAC,
    },
  },
  silverAerogel: {
    name: 'Silver Aerogel',
    bgRgb: '146, 146, 146', bgAlpha: 0.88,
    light: true,
    theme: {
      background: '#00000000',
      foreground: '#000000',
      cursor: '#404040',
      cursorAccent: '#929292',
      selectionBackground: 'rgba(120, 120, 120, 0.55)',
      ...ANSI_MAC,
    },
  },
  solidColors: {
    name: 'Solid Colors',
    bgRgb: '255, 255, 255', bgAlpha: 1,
    light: true,
    theme: {
      background: '#00000000',
      foreground: '#000000',
      cursor: '#7f7f7f',
      cursorAccent: '#ffffff',
      selectionBackground: 'rgba(164, 205, 255, 0.65)',
      black: '#000000',
      red: '#ff0000',
      green: '#00ff00',
      yellow: '#ffff00',
      blue: '#0000ff',
      magenta: '#ff00ff',
      cyan: '#00ffff',
      white: '#ffffff',
      brightBlack: '#666666',
      brightRed: '#ff0000',
      brightGreen: '#00ff00',
      brightYellow: '#ffff00',
      brightBlue: '#0000ff',
      brightMagenta: '#ff00ff',
      brightCyan: '#00ffff',
      brightWhite: '#ffffff',
    },
  },
};

// ---- i18n: arayuz Turkce + Ingilizce (Ayarlar > Dil; ilk acilista sistem dili) ----
const LANGS = {
  en: {
    close: 'Close', minimize: 'Minimize', zoom: 'Zoom',
    newTabTip: 'New tab (Ctrl+T) — right-click to choose shell',
    settingsTip: 'Settings (Ctrl+,)',
    settings: 'Settings', closeEsc: 'Close (Esc)',
    profile: 'Profile', opacity: 'Opacity', auto: 'Auto',
    autoTip: "Reset to the profile's default opacity",
    glass: 'Glass effect', blurred: 'Blurred', clear: 'Clear',
    blurredTip: 'Background shows through with a frosted blur (acrylic)',
    clearTip: 'Background shows through crisply — changing this restarts the app',
    acrylicReq: 'Blurred glass requires Windows 11 22H2 or later',
    text: 'Text', fontSize: 'Font size', cursor: 'Cursor',
    block: 'Block', underline: 'Underline', bar: 'Vertical bar',
    blink: 'Blink cursor',
    shell: 'Shell', defaultShell: 'Default shell',
    autoShell: 'Automatic (WSL if available)',
    shellHint: 'Shell changes take effect in new tabs.',
    language: 'Language', uiLanguage: 'Interface language',
    shellFail: (m) => `Failed to start shell: ${m}`,
    searchNoResult: 'No matches',
    closeRunning: 'A command is still running. Close it anyway?',
    wslHint: 'Is WSL installed? You can install it with "wsl --install".',
    exited: (c) => `[process exited with code ${c}]`,
    // ZeroLink
    zlBtnTitle: 'ZeroLink — P2P Encrypted Terminal (Ctrl+L)',
    zlBtnTitleActive: 'ZeroLink — Connection active (Ctrl+L)',
    zlCloseTip: 'Close (Esc)',
    zlHostBtn: 'Share This Terminal',
    zlHostSub: 'Generate code, let the other side connect',
    zlClientBtn: 'Connect',
    zlClientSub: 'Open remote terminal with ZeroLink code',
    zlHostDesc: 'Your terminal will be shared encrypted.<br>Code is valid <strong>5 minutes</strong>, single-use.',
    zlHostStart: 'Generate Code',
    zlCodeLabel: 'ZeroLink Code',
    zlCopy: '⎘ Copy',
    zlCopied: '✓ Copied',
    zlTimer: 'Time left:',
    zlWaiting: 'Waiting for connection…',
    zlCancel: 'Cancel',
    zlConnectedBadge: '🔒 Connected — E2E Encrypted',
    zlConnectedAddr: 'Connected:',
    zlDisconnect: 'Disconnect',
    zlClientDesc: 'Enter the ZeroLink code and connect to the remote terminal.',
    zlCodePlaceholder: 'XXXX-XXXX-XXXX-XXXX-…',
    zlConnect: 'Connect',
    zlConnecting: 'Connecting…',
    zlBack: '← Back',
    zlPreparing: 'Preparing…',
    zlCodeExpired: 'Code expired. Generate a new one.',
    zlCodeEmpty: 'ZeroLink code cannot be empty.',
    zlClientActiveDesc: 'Remote terminal is active in this tab.',
    zlDisconnectedMsg: 'Connection closed.',
    zlSendFile: 'Send File',
    zlGet: 'Get',
    zlForwardTitle: 'Port Forward (local → remote)',
    zlRemove: 'Remove',
    zlPullPlaceholder: '/remote/path/file',
    updateSection: 'Updates', version: 'Version', checkUpdate: 'Check for updates',
    updateGet: 'Update', updateAvail: 'New version', updateNone: 'You are up to date.', updateChecking: 'Checking…',
    updateDownloading: 'Downloading update…', updateReady: 'Update ready', updateRestart: 'Restart & update',
    accSignInTip: 'Sign in to NatureCo', accSignedInTip: 'signed in',
    accEcoNote: 'One NatureCo account — works across the CLI, this terminal and the portal.', accEcoDev: 'Developers',
    accSection: 'NatureCo Account', accEmail: 'Email', accSendCode: 'Send login code', accUsePass: 'Use password',
    accCodePh: 'Code or login link', accVerify: 'Verify', accPassPh: 'Password', accSignin: 'Sign in',
    accSignedAs: 'Signed in as', accLogout: 'Log out',
    accBadEmail: 'Enter a valid email', accSending: 'Sending…', accSent: 'Check your email — paste the code or login link', accVerifying: 'Verifying…',
  },
  tr: {
    close: 'Kapat', minimize: 'Küçült', zoom: 'Büyüt',
    newTabTip: 'Yeni sekme (Ctrl+T) — sağ tık: kabuk seç',
    settingsTip: 'Ayarlar (Ctrl+,)',
    settings: 'Ayarlar', closeEsc: 'Kapat (Esc)',
    profile: 'Profil', opacity: 'Opaklık', auto: 'Otomatik',
    autoTip: 'Profilin varsayılan opaklığına dön',
    glass: 'Cam efekti', blurred: 'Buğulu', clear: 'Berrak',
    blurredTip: 'Arka plan buğulu görünür (acrylic blur)',
    clearTip: 'Arka plan net görünür — değişince uygulama yeniden başlar',
    acrylicReq: 'Buğulu cam Windows 11 22H2 ve üzerini gerektirir',
    text: 'Metin', fontSize: 'Yazı boyutu', cursor: 'İmleç',
    block: 'Blok', underline: 'Alt çizgi', bar: 'Dikey çizgi',
    blink: 'İmleç yanıp sönsün',
    shell: 'Kabuk', defaultShell: 'Varsayılan kabuk',
    autoShell: 'Otomatik (WSL varsa WSL)',
    shellHint: 'Kabuk değişikliği yeni sekmelerde geçerli olur.',
    language: 'Dil', uiLanguage: 'Arayüz dili',
    shellFail: (m) => `Shell başlatılamadı: ${m}`,
    searchNoResult: 'Eşleşme yok',
    closeRunning: 'Bir komut hâlâ çalışıyor. Yine de kapatılsın mı?',
    wslHint: 'WSL kurulu mu? "wsl --install" ile kurabilirsiniz.',
    exited: (c) => `[süreç sonlandı, çıkış kodu: ${c}]`,
    // ZeroLink
    zlBtnTitle: 'ZeroLink — P2P Şifreli Terminal (Ctrl+L)',
    zlBtnTitleActive: 'ZeroLink — Bağlantı aktif (Ctrl+L)',
    zlCloseTip: 'Kapat (Esc)',
    zlHostBtn: 'Bu Terminali Paylaş',
    zlHostSub: 'Kod üret, karşı taraf bağlansın',
    zlClientBtn: 'Bağlan',
    zlClientSub: 'ZeroLink kodu ile uzak terminal aç',
    zlHostDesc: 'Terminalin şifreli olarak paylaşılacak.<br>Kod <strong>5 dakika</strong> geçerli, tek kullanımlık.',
    zlHostStart: 'Kod Oluştur',
    zlCodeLabel: 'ZeroLink Kodu',
    zlCopy: '⎘ Kopyala',
    zlCopied: '✓ Kopyalandı',
    zlTimer: 'Kalan süre:',
    zlWaiting: 'Bağlantı bekleniyor…',
    zlCancel: 'İptal Et',
    zlConnectedBadge: '🔒 Bağlı — E2E Şifreli',
    zlConnectedAddr: 'Bağlı:',
    zlDisconnect: 'Bağlantıyı Kes',
    zlClientDesc: 'ZeroLink kodunu gir ve uzak terminale bağlan.',
    zlCodePlaceholder: 'XXXX-XXXX-XXXX-XXXX-…',
    zlConnect: 'Bağlan',
    zlConnecting: 'Bağlanılıyor…',
    zlBack: '← Geri',
    zlPreparing: 'Hazırlanıyor…',
    zlCodeExpired: 'Kodun süresi doldu. Yeni kod oluşturun.',
    zlCodeEmpty: 'ZeroLink kodu boş olamaz.',
    zlClientActiveDesc: 'Uzak terminal bu sekmede aktif.',
    zlDisconnectedMsg: 'Bağlantı kesildi.',
    zlSendFile: 'Dosya Gönder',
    zlGet: 'Al',
    zlForwardTitle: 'Port Yönlendirme (yerel → uzak)',
    zlRemove: 'Kaldır',
    zlPullPlaceholder: '/uzak/yol/dosya',
    updateSection: 'Güncelleme', version: 'Sürüm', checkUpdate: 'Güncellemeleri denetle',
    updateGet: 'Güncelle', updateAvail: 'Yeni sürüm', updateNone: 'En güncel sürümdesin.', updateChecking: 'Denetleniyor…',
    updateDownloading: 'Güncelleme indiriliyor…', updateReady: 'Güncelleme hazır', updateRestart: 'Yeniden başlat',
    accSignInTip: 'NatureCo hesabına giriş yap', accSignedInTip: 'giriş yapıldı',
    accEcoNote: 'Tek NatureCo hesabı — CLI, bu terminal ve portalda geçerli.', accEcoDev: 'Geliştiriciler',
    accSection: 'NatureCo Hesabı', accEmail: 'E-posta', accSendCode: 'Giriş kodu gönder', accUsePass: 'Şifre ile',
    accCodePh: 'Kod veya giriş linki', accVerify: 'Doğrula', accPassPh: 'Şifre', accSignin: 'Giriş',
    accSignedAs: 'Giriş:', accLogout: 'Çıkış',
    accBadEmail: 'Geçerli e-posta gir', accSending: 'Gönderiliyor…', accSent: 'E-postana bak — kodu ya da giriş linkini yapıştır', accVerifying: 'Doğrulanıyor…',
  },
};
function t(key) {
  return (LANGS[settings.lang] || LANGS.en)[key];
}

// Statik arayuz yazilarini secili dile gore yeniden yazar (dil degisince cagrilir)
function applyLanguage() {
  const L = LANGS[settings.lang] || LANGS.en;
  document.documentElement.lang = settings.lang || 'en';
  const set = (sel, prop, val) => { const el = document.querySelector(sel); if (el) el[prop] = val; };
  set('#btn-close', 'title', L.close);
  set('#btn-min', 'title', L.minimize);
  set('#btn-max', 'title', L.zoom);
  set('#btn-new-tab', 'title', L.newTabTip);
  set('#btn-settings', 'title', L.settingsTip);
  set('#settings-title', 'textContent', L.settings);
  set('#settings-close', 'title', L.closeEsc);
  set('#h3-profile', 'textContent', L.profile);
  set('#h3-text', 'textContent', L.text);
  set('#h3-shell', 'textContent', L.shell);
  set('#h3-language', 'textContent', L.language);
  set('#lbl-opacity', 'textContent', L.opacity);
  set('#lbl-glass', 'textContent', L.glass);
  set('#lbl-fontsize', 'textContent', L.fontSize);
  set('#lbl-cursor', 'textContent', L.cursor);
  set('#lbl-blink', 'textContent', L.blink);
  set('#lbl-shell', 'textContent', L.defaultShell);
  set('#lbl-language', 'textContent', L.uiLanguage);
  set('#opacity-reset', 'textContent', L.auto);
  set('#opacity-reset', 'title', L.autoTip);
  set('#shell-hint', 'textContent', L.shellHint);
  set('#set-shell option[value="auto"]', 'textContent', L.autoShell);
  const bAcr = document.querySelector('#glass-mode button[data-glass="acrylic"]');
  if (bAcr) {
    bAcr.textContent = L.blurred;
    bAcr.title = bAcr.classList.contains('disabled') ? L.acrylicReq : L.blurredTip;
  }
  const bClr = document.querySelector('#glass-mode button[data-glass="clear"]');
  if (bClr) { bClr.textContent = L.clear; bClr.title = L.clearTip; }
  set('#cursor-style button[data-style="block"]', 'title', L.block);
  set('#cursor-style button[data-style="underline"]', 'title', L.underline);
  set('#cursor-style button[data-style="bar"]', 'title', L.bar);
  for (const el of document.querySelectorAll('.tab .tab-close')) el.title = L.close;
  { const ab = document.getElementById('btn-account'); if (ab && !ab.classList.contains('signed-in')) ab.title = L.accSignInTip; }

  // ── ZeroLink UI ──
  set('#btn-zerolink', 'title', L.zlBtnTitle);
  set('#zl-close', 'title', L.zlCloseTip);
  set('#zl-title', 'textContent', 'ZeroLink');
  set('#zl-btn-host .zl-mode-label', 'textContent', L.zlHostBtn);
  set('#zl-btn-host .zl-mode-sub', 'textContent', L.zlHostSub);
  set('#zl-btn-client .zl-mode-label', 'textContent', L.zlClientBtn);
  set('#zl-btn-client .zl-mode-sub', 'textContent', L.zlClientSub);
  set('#zl-host-idle .zl-desc', 'innerHTML', L.zlHostDesc);
  set('#zl-host-start-btn', 'textContent', L.zlHostStart);
  set('.zl-code-label', 'textContent', L.zlCodeLabel);
  set('#zl-code-copy', 'textContent', L.zlCopy);
  set('#zl-code-copy', 'title', L.zlCopy);
  set('.zl-timer-label', 'textContent', L.zlTimer);
  set('#zl-host-status', 'textContent', L.zlWaiting);
  set('#zl-host-stop-btn', 'textContent', L.zlCancel);
  for (const el of document.querySelectorAll('.zl-connected-badge')) el.innerHTML = L.zlConnectedBadge;
  set('#zl-host-disconnect-btn', 'textContent', L.zlDisconnect);
  set('#zl-client-idle .zl-desc', 'innerHTML', L.zlClientDesc);
  set('#zl-code-input', 'placeholder', L.zlCodePlaceholder);
  set('#zl-client-connect-btn', 'textContent', L.zlConnect);
  set('#zl-client-disconnect-btn', 'textContent', L.zlDisconnect);
  set('#zl-back-btn', 'textContent', L.zlBack);
  set('#zl-client-connecting .zl-status', 'textContent', L.zlConnecting);
  set('#zl-client-status-text', 'textContent', L.zlClientActiveDesc);
  set('#zl-push-label', 'textContent', L.zlSendFile);
  set('#zl-pull-label', 'textContent', L.zlGet);
  set('#zl-fwd-title', 'textContent', L.zlForwardTitle);
  set('#zl-pull-input', 'placeholder', L.zlPullPlaceholder);
  set('#h3-update', 'textContent', L.updateSection);
  set('#lbl-version', 'textContent', L.version);
  set('#btn-check-update', 'textContent', L.checkUpdate);
  // #up-get etiketi güncelleme durumuna göre dinamiktir (Güncelle / Yeniden başlat) → burada set edilmez
  set('#h3-account', 'textContent', L.accSection);
  set('#lbl-acc-email', 'textContent', L.accEmail);
  set('#nc-acc-sendcode', 'textContent', L.accSendCode);
  set('#nc-acc-usepass', 'textContent', L.accUsePass);
  set('#nc-acc-code', 'placeholder', L.accCodePh);
  set('#nc-acc-verify', 'textContent', L.accVerify);
  set('#nc-acc-pass', 'placeholder', L.accPassPh);
  set('#nc-acc-signin', 'textContent', L.accSignin);
  set('#lbl-acc-signed', 'textContent', L.accSignedAs);
  set('#nc-acc-logout', 'textContent', L.accLogout);
  set('#nc-eco-note', 'textContent', L.accEcoNote);
  set('#nc-eco-dev', 'textContent', L.accEcoDev);
}

// ---- Ayarlar (macOS Terminal Settings muadili; electron-store'da kalici) ----
const DEFAULT_SETTINGS = {
  profile: 'natureco',
  fontSize: 13,        // macOS Terminal varsayilanina yakin
  cursorStyle: 'block', // macOS varsayilani
  cursorBlink: false,   // macOS varsayilani: yanip SONMEZ
  shell: 'auto',
  opacity: null,        // null = profil varsayilani (Otomatik); 0-1 arasi kullanici degeri
  glass: 'acrylic',     // 'acrylic' = bugulu blur; 'clear' = kristal net (pencere yeniden olusur)
  gpuRenderer: false,
  lang: null,           // null = ilk acilista sistem dilinden sec (tr → Turkce, digerleri → Ingilizce)
};
let settings = { ...DEFAULT_SETTINGS };

function currentTheme() {
  return THEMES[settings.profile] || THEMES.pro;
}

function terminalTheme() {
  return { ...currentTheme().theme, background: 'rgba(0, 0, 0, 0)' };
}

// Etkin opaklik: kullanici kaydiriciyi kullandiysa onun degeri, yoksa profil varsayilani
function effectiveAlpha() {
  const th = currentTheme();
  return settings.opacity == null ? th.bgAlpha : settings.opacity;
}

// Ayarlari pencere kromuna + tum acik terminallere uygular (macOS gibi aninda etki).
function applySettings({ save = true } = {}) {
  const th = currentTheme();
  document.documentElement.style.setProperty('--bg', `rgba(${th.bgRgb}, ${effectiveAlpha()})`);
  document.body.classList.toggle('light-theme', !!th.light);

  for (const t of tabs.values()) {
    t.term.options.theme = terminalTheme();
    t.term.options.fontSize = settings.fontSize;
    t.term.options.cursorStyle = settings.cursorStyle;
    t.term.options.cursorBlink = settings.cursorBlink;
  }
  const active = tabs.get(activeTabId);
  if (active) active.fitAddon.fit(); // yazi boyutu degisince satir/sutun sayisi degisir

  if (save) window.termAPI.setSettings(settings);
}

// JetBrains Mono ilk sirada (gomulu → garanti/tutarli metrik); varsa SF Mono/Menlo.
const FONT_FAMILY = "'JetBrains Mono', 'SF Mono', 'Menlo', 'Cascadia Code', Consolas, monospace";

let tabCounter = 0;
let activeTabId = null;
const tabs = new Map(); // tabId -> { term, fitAddon, unsubData, unsubExit, tabEl, paneEl, title, shellName }
let sessionSaveTimer = null;
let restoringSession = false;

function scheduleSessionSave() {
  if (restoringSession) return;
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(() => window.termAPI.setSession(serializeSession(tabs, activeTabId)), 200);
}

const tabbarEl = document.getElementById('tabbar');
const panesEl = document.getElementById('panes');
const windowTitleEl = document.getElementById('window-title');
const searchBarEl = document.getElementById('search-bar');
const searchInputEl = document.getElementById('search-input');
const searchStatusEl = document.getElementById('search-status');
const commandPaletteOverlayEl = document.getElementById('command-palette-overlay');
const commandPaletteInputEl = document.getElementById('command-palette-input');
const commandPaletteListEl = document.getElementById('command-palette-list');
const commandPaletteEmptyEl = document.getElementById('command-palette-empty');
let paletteCommands = [];
let paletteSelection = 0;

const paletteText = () => settings.lang === 'tr' ? {
  placeholder: 'Bir komut yazın…', empty: 'Eşleşen komut yok', newTab: 'Yeni sekme', closeTab: 'Sekmeyi kapat',
  find: 'Terminalde ara', settings: 'Ayarları aç', zeroLink: 'ZeroLink panelini aç', clear: 'Terminali temizle',
  theme: 'Tema', shell: 'Kabuk',
} : {
  placeholder: 'Type a command…', empty: 'No matching commands', newTab: 'New tab', closeTab: 'Close tab',
  find: 'Find in terminal', settings: 'Open settings', zeroLink: 'Open ZeroLink', clear: 'Clear terminal',
  theme: 'Theme', shell: 'Shell',
};

async function allCommands() {
  const P = paletteText();
  const base = [
    { id: 'new-tab', label: P.newTab, shortcut: 'Ctrl/⌘ T', keywords: 'tab sekme', run: () => createTabAtActiveCwd() },
    { id: 'close-tab', label: P.closeTab, shortcut: 'Ctrl/⌘ W', keywords: 'close kapat', run: () => activeTabId && closeTab(activeTabId) },
    { id: 'find', label: P.find, shortcut: 'Ctrl/⌘ F', keywords: 'search ara', run: openSearch },
    { id: 'settings', label: P.settings, shortcut: 'Ctrl/⌘ ,', keywords: 'preferences ayarlar', run: openSettings },
    { id: 'zerolink', label: P.zeroLink, shortcut: 'Ctrl/⌘ L', keywords: 'remote share uzak paylaş', run: toggleZeroLink },
    { id: 'clear', label: P.clear, keywords: 'clear temizle', run: () => tabs.get(activeTabId)?.term.clear() },
  ];
  for (const key of Object.keys(THEMES)) {
    base.push({ id: `theme-${key}`, label: `${P.theme}: ${key}`, keywords: 'appearance color görünüm renk', run: () => { settings.profile = key; applySettings(); syncSettingsUI(); } });
  }
  try {
    const shells = await window.termAPI.listShells();
    for (const [key, shell] of Object.entries(shells)) {
      base.push({ id: `shell-${key}`, label: `${P.shell}: ${shell.name}`, keywords: 'terminal profile kabuk', run: () => createTabAtActiveCwd(key) });
    }
  } catch (_) { /* temel komutlar yine kullanilabilir */ }
  return base;
}

function renderCommandPalette() {
  const matches = filterCommands(paletteCommands, commandPaletteInputEl.value);
  paletteSelection = Math.max(0, Math.min(paletteSelection, Math.max(0, matches.length - 1)));
  commandPaletteListEl.replaceChildren();
  commandPaletteEmptyEl.hidden = matches.length > 0;
  matches.forEach((command, index) => {
    const row = document.createElement('button');
    row.className = 'command-palette-item';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(index === paletteSelection));
    row.classList.toggle('selected', index === paletteSelection);
    row.innerHTML = `<span></span><kbd></kbd>`;
    row.querySelector('span').textContent = command.label;
    row.querySelector('kbd').textContent = command.shortcut || '';
    row.addEventListener('mouseenter', () => {
      paletteSelection = index;
      for (const [itemIndex, item] of [...commandPaletteListEl.children].entries()) {
        item.classList.toggle('selected', itemIndex === index);
        item.setAttribute('aria-selected', String(itemIndex === index));
      }
    });
    row.addEventListener('click', () => executePaletteCommand(command));
    commandPaletteListEl.appendChild(row);
  });
}

function executePaletteCommand(command) {
  closeCommandPalette();
  command?.run();
}

async function openCommandPalette() {
  const P = paletteText();
  commandPaletteInputEl.placeholder = P.placeholder;
  commandPaletteEmptyEl.textContent = P.empty;
  commandPaletteOverlayEl.hidden = false;
  commandPaletteInputEl.value = '';
  paletteSelection = 0;
  paletteCommands = await allCommands();
  renderCommandPalette();
  commandPaletteInputEl.focus();
}

function closeCommandPalette() {
  commandPaletteOverlayEl.hidden = true;
  tabs.get(activeTabId)?.term.focus();
}

commandPaletteInputEl.addEventListener('input', () => { paletteSelection = 0; renderCommandPalette(); });
commandPaletteInputEl.addEventListener('keydown', (event) => {
  const matches = filterCommands(paletteCommands, commandPaletteInputEl.value);
  if (event.key === 'Escape') { event.preventDefault(); closeCommandPalette(); }
  else if (event.key === 'ArrowDown') { event.preventDefault(); paletteSelection = Math.min(matches.length - 1, paletteSelection + 1); renderCommandPalette(); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); paletteSelection = Math.max(0, paletteSelection - 1); renderCommandPalette(); }
  else if (event.key === 'Enter') { event.preventDefault(); executePaletteCommand(matches[paletteSelection]); }
});
commandPaletteOverlayEl.addEventListener('mousedown', (event) => { if (event.target === commandPaletteOverlayEl) closeCommandPalette(); });

function runSearch(direction = 'next', incremental = false) {
  const rec = tabs.get(activeTabId);
  const query = searchInputEl.value;
  if (!rec || !query) { searchStatusEl.textContent = ''; return false; }
  const options = {
    incremental,
    decorations: { matchBackground: '#f5c542', matchBorder: '#fff', matchOverviewRuler: '#f5c542', activeMatchBackground: '#ff8c00' },
  };
  const found = direction === 'previous'
    ? rec.searchAddon.findPrevious(query, options)
    : rec.searchAddon.findNext(query, options);
  searchStatusEl.textContent = found ? '' : t('searchNoResult');
  return found;
}

function openSearch() {
  searchBarEl.hidden = false;
  searchInputEl.focus();
  searchInputEl.select();
  if (searchInputEl.value) runSearch('next', true);
}

function closeSearch() {
  searchBarEl.hidden = true;
  searchStatusEl.textContent = '';
  tabs.get(activeTabId)?.searchAddon.clearDecorations();
  tabs.get(activeTabId)?.term.focus();
}

searchInputEl.addEventListener('input', () => runSearch('next', true));
searchInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
  else if (e.key === 'Enter') { e.preventDefault(); runSearch(e.shiftKey ? 'previous' : 'next'); }
});
document.getElementById('search-prev').addEventListener('click', () => runSearch('previous'));
document.getElementById('search-next').addEventListener('click', () => runSearch('next'));
document.getElementById('search-close').addEventListener('click', closeSearch);

document.getElementById('btn-close').addEventListener('click', () => window.termAPI.close());
window.termAPI.onCloseRequested(() => {
  const running = [...tabs.values()].some((tab) => tab.shellState?.running);
  if (!running || window.confirm(t('closeRunning'))) window.termAPI.confirmClose();
});
document.getElementById('btn-min').addEventListener('click', () => window.termAPI.minimize());
document.getElementById('btn-max').addEventListener('click', () => window.termAPI.maximize());
function activeCwd() { return tabs.get(activeTabId)?.shellState?.cwd || null; }
function createTabAtActiveCwd(profileKey = 'default') { return createTab(profileKey, activeCwd()); }
document.getElementById('btn-new-tab').addEventListener('click', () => createTabAtActiveCwd());
document.getElementById('btn-settings').addEventListener('click', () => toggleSettings());
window.termAPI.onOpenDirectory((cwd) => createTab('default', cwd));
window.termAPI.onNewTab(() => createTabAtActiveCwd());
window.termAPI.onCloseTab(() => { if (activeTabId) closeTab(activeTabId); });
window.termAPI.onShowSettings(() => openSettings());
document.getElementById('btn-account')?.addEventListener('click', () => {
  if (overlayEl.hidden) openSettings();
  document.getElementById('nc-account-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ---- + dugmesine sag tik: sekme basina kabuk secimi (WSL/PowerShell/CMD) ----
// Boylece varsayilan WSL olsa da tek jestte gercek Windows kabugu acilabilir.
const shellMenuEl = document.getElementById('shell-menu');
async function showShellMenu(x, y) {
  if (!shellMenuEl.childElementCount) {
    const profiles = await window.termAPI.listShells();
    for (const [key, p] of Object.entries(profiles)) {
      const item = document.createElement('div');
      item.className = 'shell-menu-item';
      item.textContent = p.name;
      item.addEventListener('click', () => { shellMenuEl.hidden = true; createTab(key); });
      shellMenuEl.appendChild(item);
    }
  }
  shellMenuEl.hidden = false;
  // Ekrandan tasmasin
  shellMenuEl.style.left = `${Math.min(x, window.innerWidth - shellMenuEl.offsetWidth - 8)}px`;
  shellMenuEl.style.top = `${Math.min(y, window.innerHeight - shellMenuEl.offsetHeight - 8)}px`;
}
document.getElementById('btn-new-tab').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  showShellMenu(e.clientX, e.clientY);
});
window.addEventListener('mousedown', (e) => {
  if (!shellMenuEl.hidden && !shellMenuEl.contains(e.target)) shellMenuEl.hidden = true;
});

// Pencere odak/blur → traffic-light'lar macOS gibi grilesin
window.termAPI.onFocusChange((focused) => {
  document.body.classList.toggle('blurred', !focused);
});

// Maximize'da yuvarlak koseler duzlesir (macOS zoom'da da pencere ekrani doldurur)
window.termAPI.onMaximizeChange((maximized) => {
  document.body.classList.toggle('maximized', maximized);
});

/**
 * OSC basliklarini macOS surec-adi tarzina cevirir. Windows kabuklari basliga
 * genelde TAM EXE YOLUNU yazar ("C:\WINDOWS\...\powershell.exe") — macOS Terminal
 * ise yalin surec adi gosterir ("-zsh"). Yalnizca ".exe" ile bitenlere dokunuruz;
 * boylece WSL'in "user@host: ~/dizin" gibi basliklari oldugu gibi kalir.
 */
const PRETTY_NAMES = { powershell: 'PowerShell', pwsh: 'PowerShell', cmd: 'cmd', wsl: 'WSL' };
function cleanTitle(raw) {
  let t = (raw || '').trim();
  const m = t.match(/([^\\/]+)\.exe$/i);
  if (m) t = PRETTY_NAMES[m[1].toLowerCase()] || m[1];
  return t;
}

async function createTab(profileKey = 'default', cwd = null) {
  const tabId = `tab-${++tabCounter}`;

  // ---- Sekme baslik elementi (macOS: kapat butonu SOLDA, hover'da belirir) ----
  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.dataset.tabId = tabId;
  tabEl.innerHTML = `<span class="tab-close" title="${t('close')}">×</span><span class="tab-title">Terminal</span>`;
  tabEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) {
      closeTab(tabId);
    } else {
      activateTab(tabId);
    }
  });
  tabbarEl.appendChild(tabEl);

  // ---- Terminal pane elementi ----
  const paneEl = document.createElement('div');
  paneEl.className = 'pane';
  const xtermWrapper = document.createElement('div');
  xtermWrapper.className = 'xterm-wrapper';
  paneEl.appendChild(xtermWrapper);
  panesEl.appendChild(paneEl);

  // Yeni sekme HEMEN aktive edilir (macOS de yeni sekmeye gecer). Kritik neden:
  // xterm.open() GORUNUR konteyner ister — display:none pane'de hucre olcumu
  // basarisiz olur ve fitAddon.fit() sessizce no-op kalir (terminal 80x24'te
  // sikisir). Once gorunur yap, sonra term.open + fit.
  for (const t of tabs.values()) {
    t.tabEl.classList.remove('active');
    t.paneEl.classList.remove('active');
  }
  tabEl.classList.add('active');
  paneEl.classList.add('active');
  activeTabId = tabId;

  // ---- xterm.js kurulumu (tema/boyut/imlec ayarlardan gelir) ----
  const term = new Terminal({
    fontFamily: FONT_FAMILY,
    fontSize: settings.fontSize,
    lineHeight: 1.15,
    cursorBlink: settings.cursorBlink,
    cursorStyle: settings.cursorStyle,
    theme: terminalTheme(),
    allowTransparency: true,
    scrollback: 5000,
    macOptionIsMeta: true,
  });

  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(searchAddon);
  term.loadAddon(new WebLinksAddon());
  term.open(xtermWrapper);
  let webglAddon = null;
  if (settings.gpuRenderer === true) {
    try {
      webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        console.warn('WebGL context lost; falling back to DOM renderer.');
        webglAddon?.dispose();
        webglAddon = null;
      });
      term.loadAddon(webglAddon);
    } catch (error) {
      console.warn(`WebGL renderer unavailable; using DOM renderer: ${error.message}`);
    }
  }
  fitAddon.fit();

  // macOS overlay scrollbar davranisi: yalnizca KAYDIRIRKEN gorunur, sonra kaybolur
  const viewport = xtermWrapper.querySelector('.xterm-viewport');
  if (viewport) {
    let scrollFadeTimer;
    viewport.addEventListener('scroll', () => {
      viewport.classList.add('scrolling');
      clearTimeout(scrollFadeTimer);
      scrollFadeTimer = setTimeout(() => viewport.classList.remove('scrolling'), 900);
    });
  }

  // Kayit
  const rec = { term, fitAddon, searchAddon, webglAddon, tabEl, paneEl, title: 'Terminal', shellName: 'Terminal', profileKey, shellState: new ShellState() };
  rec.shellState.cwdChanged(cwd);
  tabs.set(tabId, rec);

  const updateShellState = (state) => {
    tabEl.classList.toggle('command-running', state.running);
    tabEl.classList.toggle('command-failed', !state.running && state.lastExitCode !== null && state.lastExitCode !== 0);
    tabEl.dataset.cwd = state.cwd || '';
    const duration = state.lastDurationMs === null ? '' : ` · ${(state.lastDurationMs / 1000).toFixed(1)}s`;
    const exit = state.lastExitCode === null ? '' : ` · exit ${state.lastExitCode}`;
    tabEl.title = `${state.cwd || rec.title}${exit}${duration}`;
  };
  term.parser.registerOscHandler(7, (data) => {
    const cwdValue = parseOsc7(data, navigator.platform.startsWith('Win') ? 'win32' : 'posix');
    if (cwdValue) updateShellState(rec.shellState.cwdChanged(cwdValue));
    if (cwdValue) scheduleSessionSave();
    return true;
  });
  term.parser.registerOscHandler(133, (data) => { updateShellState(rec.shellState.osc133(data)); return true; });

  // ---- Kabuk (shell) OSC baslik degisimi → sekme + pencere basligi (macOS gibi) ----
  term.onTitleChange((title) => setTabTitle(tabId, title));

  // ---- Uygulama kisayollari + ZeroLink: xterm pty'ye GONDERMEDEN once yakala ----
  // xterm TEK custom key handler destekler → app kisayollari ve ZeroLink 'zl'
  // yakalayici burada ZINCIRLENIR. (Onceki tasarim ikisini ayri ayri baglayip
  // birbirini eziyordu — bu birlesik handler o hatayi giderir.)
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;

    // ZeroLink intercept/'z'-bekleme aktifken tum tuslar (Ctrl+C = iptal dahil) ona gider
    const zlCli = rec.zlCli;
    if (zlCli && zlCli.isCapturing()) return zlCli.handleKey(e);

    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();

    // ZeroLink panelini ac/kapat: Ctrl+L
    if (mod && k === 'l' && !e.shiftKey) { toggleZeroLink(); return false; }

    if (mod) {
      if (k === 'p' && e.shiftKey) { openCommandPalette(); return false; }
      if (k === 'f' && !e.shiftKey) { openSearch(); return false; }
      // Yeni / kapat sekme
      if (k === 't' && !e.shiftKey) { createTabAtActiveCwd(); return false; }
      if (k === 'w' && !e.shiftKey) { if (activeTabId) closeTab(activeTabId); return false; }

      // Ayarlar: Ctrl+, (macOS Cmd+, muadili)
      if (k === ',') { toggleSettings(); return false; }

      // KOPYALA: Ctrl+C — metin seciliyse kopyalar (+secimi temizler),
      // secili degilse calisan komutu durdurur (^C/SIGINT). Shift YOK.
      if (k === 'c') {
        if (term.hasSelection()) {
          e.preventDefault(); // xterm/tarayicinin kendi 'copy' olayini da iptal et → CIFT kopyalama olmasin
          window.termAPI.clipboardWrite(term.getSelection());
          term.clearSelection();
          return false;
        }
        return true; // secim yok → SIGINT pty'ye gitsin
      }

      // YAPISTIR: Ctrl+V — kendi paste cagrimizi YAPMIYORUZ (yoksa xterm'in native paste'i
      // ile birlesip metin iki kez gidiyor: "selamselam"). Sadece `false` donuyoruz:
      //   • false → xterm Ctrl+V'yi \x16 kontrol karakteri olarak pty'ye GONDERMEZ
      //   • ama tarayicinin native 'paste' olayini ENGELLEMEZ → gercek yapistirmayi
      //     xterm'in kendi native paste'i TEK seferde yapar.
      // (Sag-tik ile yapistirma ayri: contextmenu handler'inda, o da tek seferlik.)
      if (k === 'v') {
        return false;
      }

      // Sekmeler arasi gecis: Ctrl+1..9
      if (/^[1-9]$/.test(e.key)) { switchToIndex(parseInt(e.key, 10) - 1); return false; }

      return true;
    }

    // Modifiersiz: ZeroLink 'zl' komut yakalama (satir basinda 'z' → 'l' dizisi)
    if (zlCli) return zlCli.handleKey(e);
    return true;
  });

  // ---- Sag tik: secim varsa kopyala, yoksa yapistir (terminal klasigi) ----
  paneEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (term.hasSelection()) {
      window.termAPI.clipboardWrite(term.getSelection());
      term.clearSelection();
    } else {
      window.termAPI.clipboardRead().then((txt) => { if (txt) window.termAPI.writePty(tabId, txt); });
    }
  });

  // ---- PTY olustur ----
  let shellInfo;
  try {
    // Gercek boyutla spawn et — yoksa kabuk acilis banner'ini 80 sutuna gore
    // basar ve genis pencerede kirik gorunur.
    shellInfo = await window.termAPI.createPty(tabId, profileKey, term.cols, term.rows, cwd);
  } catch (err) {
    term.writeln(`\r\n\x1b[31m${t('shellFail')(err.message)}\x1b[0m`);
    term.writeln(`\x1b[90m${t('wslHint')}\x1b[0m`);
  }

  if (shellInfo) {
    rec.shellName = shellInfo.shellName;
    updateShellState(rec.shellState.cwdChanged(shellInfo.cwd));
    setTabTitle(tabId, shellInfo.shellName);
  }

  // ---- ZeroLink CLI — 'zl' komut yakalayici + client yonlendirmesi ----
  const zlCli = new ZeroLinkCLI({
    term,
    tabId,
    termAPI: window.termAPI,
    getZlState: () => zlState,
  });
  rec.zlCli = zlCli;

  term.onData((data) => {
    if ((data.includes('\r') || data.includes('\n')) && rec.shellState.atPrompt) {
      updateShellState(rec.shellState.commandStarted());
    }
    // Client modunda girdi uzak PTY'ye; degilse (intercept degilse) yerel PTY'ye
    const passThrough = zlCli.handleData(data);
    if (passThrough) window.termAPI.writePty(tabId, data);
  });
  term.onResize(({ cols, rows }) => {
    window.termAPI.resizePty(tabId, cols, rows);
    // SSH SIGWINCH muadili: uzak oturuma bagli sekmede boyutu karsiya da ilet
    if (zlState.clientActive && zlState.clientTabId === tabId) {
      window.termAPI.zlClientResize(cols, rows);
    }
    // macOS Terminal basligi boyutu canli gosterir ("PowerShell — 120×34")
    if (tabId === activeTabId) updateWindowTitle();
  });

  rec.unsubData = window.termAPI.onPtyData(tabId, (data) => term.write(data));
  rec.unsubExit = window.termAPI.onPtyExit(tabId, (code) => {
    term.writeln(`\r\n\x1b[90m${t('exited')(code)}\x1b[0m`);
  });

  updateTabBarVisibility();
  activateTab(tabId);

  // Pencere yeniden boyutlandiginda aktif terminali yeniden hizala
  const resizeObserver = new ResizeObserver(() => {
    if (activeTabId === tabId) fitAddon.fit();
  });
  resizeObserver.observe(paneEl);

  term.focus();
  scheduleSessionSave();
}

function setTabTitle(tabId, rawTitle) {
  const t = tabs.get(tabId);
  if (!t) return;
  const clean = cleanTitle(rawTitle) || t.shellName || 'Terminal';
  t.title = clean;
  const titleEl = t.tabEl.querySelector('.tab-title');
  if (titleEl) titleEl.textContent = clean;
  t.tabEl.title = clean; // uzun basliklar icin tooltip
  if (tabId === activeTabId) updateWindowTitle();
}

function updateWindowTitle() {
  const t = tabs.get(activeTabId);
  const title = (t && t.title) ? t.title : 'Terminal';
  // macOS Terminal baslik formati: "surec — sutun×satir" (orn. "PowerShell — 120×34")
  const size = t ? ` — ${t.term.cols}×${t.term.rows}` : '';
  windowTitleEl.textContent = title + size;
  document.title = title; // OS pencere basligi da guncellensin
}

function updateTabBarVisibility() {
  const multi = tabs.size > 1;
  document.body.classList.toggle('multi-tab', multi);
  document.body.classList.toggle('single-tab', !multi);
  // Sekme cubugu gorunurlugu pane yuksekligini degistirir → aktif terminali yeniden hizala
  const t = tabs.get(activeTabId);
  if (t) requestAnimationFrame(() => t.fitAddon.fit());
}

function switchToIndex(i) {
  const ids = [...tabs.keys()];
  if (i >= 0 && i < ids.length) activateTab(ids[i]);
}

function activateTab(tabId) {
  for (const [id, t] of tabs) {
    const isActive = id === tabId;
    t.tabEl.classList.toggle('active', isActive);
    t.paneEl.classList.toggle('active', isActive);
  }
  activeTabId = tabId;
  const t = tabs.get(tabId);
  if (t) {
    t.fitAddon.fit();
    t.term.focus();
  }
  updateWindowTitle();
  scheduleSessionSave();
}

function closeTab(tabId) {
  const t = tabs.get(tabId);
  if (!t) return;
  if (t.shellState?.running && !window.confirm((LANGS[settings.lang] || LANGS.en).closeRunning)) return;

  window.termAPI.killPty(tabId);
  t.unsubData?.();
  t.unsubExit?.();
  t.zlCli?.destroy();   // ZeroLink CLI temizligi
  t.term.dispose();
  t.tabEl.remove();
  t.paneEl.remove();
  tabs.delete(tabId);

  if (activeTabId === tabId) {
    const remaining = [...tabs.keys()];
    if (remaining.length) {
      activateTab(remaining[remaining.length - 1]);
    } else {
      activeTabId = null;
      createTab(); // en az bir sekme her zaman acik kalsin
    }
  }
  updateTabBarVisibility();
  scheduleSessionSave();
}

// ================= Ayarlar paneli =================
const overlayEl = document.getElementById('settings-overlay');
const profileGridEl = document.getElementById('profile-grid');
const fontValueEl = document.getElementById('font-size-value');
const opacitySliderEl = document.getElementById('opacity-slider');
const opacityValueEl = document.getElementById('opacity-value');
const cursorStyleEl = document.getElementById('cursor-style');
const cursorBlinkEl = document.getElementById('cursor-blink');
const shellSelectEl = document.getElementById('set-shell');

function toggleSettings() {
  overlayEl.hidden ? openSettings() : closeSettings();
}
function openSettings() {
  syncSettingsUI();
  overlayEl.hidden = false;
  try { _ncRefreshAccount?.(); } catch (_) {} // CLI'da giriş yapılmış olabilir → tazele
}
function closeSettings() {
  overlayEl.hidden = true;
  tabs.get(activeTabId)?.term.focus();
}

// Panel acildiginda kontrolleri mevcut ayarlarla esitle
function syncSettingsUI() {
  for (const card of profileGridEl.querySelectorAll('.profile-card')) {
    card.classList.toggle('selected', card.dataset.key === settings.profile);
  }
  const pct = Math.round(effectiveAlpha() * 100);
  opacitySliderEl.value = pct;
  opacityValueEl.textContent = `${pct}%`;
  fontValueEl.textContent = settings.fontSize;
  for (const btn of cursorStyleEl.querySelectorAll('button')) {
    btn.classList.toggle('selected', btn.dataset.style === settings.cursorStyle);
  }
  cursorBlinkEl.checked = settings.cursorBlink;
  shellSelectEl.value = settings.shell;
  for (const btn of document.querySelectorAll('#glass-mode button')) {
    btn.classList.toggle('selected', btn.dataset.glass === (settings.glass || 'acrylic'));
  }
  for (const btn of document.querySelectorAll('#lang-mode button')) {
    btn.classList.toggle('selected', btn.dataset.lang === (settings.lang || 'en'));
  }
}

function buildSettingsUI() {
  // Profil kartlari: mini onizleme (zemin + renkli ornek metin), Terminal.app galerisi gibi
  for (const [key, th] of Object.entries(THEMES)) {
    const card = document.createElement('div');
    card.className = 'profile-card';
    card.dataset.key = key;

    const preview = document.createElement('div');
    preview.className = 'profile-preview';
    preview.style.background = `rgba(${th.bgRgb}, ${th.bgAlpha})`;
    preview.style.color = th.theme.foreground;
    const dots = [th.theme.red, th.theme.green, th.theme.yellow, th.theme.blue]
      .map((c) => `<span style="color:${c}">&#9679;</span>`).join(' ');
    preview.innerHTML = `<div>user$ ls</div><div>${dots}</div>`;

    const nameEl = document.createElement('div');
    nameEl.className = 'profile-name';
    nameEl.textContent = th.name;

    card.appendChild(preview);
    card.appendChild(nameEl);
    card.addEventListener('click', () => {
      settings.profile = key;
      applySettings();
      syncSettingsUI();
    });
    profileGridEl.appendChild(card);
  }

  // Opaklik: kaydirici surukledikce canli uygulanir (macOS gibi)
  opacitySliderEl.addEventListener('input', () => {
    settings.opacity = parseInt(opacitySliderEl.value, 10) / 100;
    opacityValueEl.textContent = `${opacitySliderEl.value}%`;
    applySettings();
  });
  document.getElementById('opacity-reset').addEventListener('click', () => {
    settings.opacity = null; // profil varsayilanina don
    applySettings(); syncSettingsUI();
  });

  // Cam efekti: transparent pencere OLUSTURULURKEN belirlenir → kip degisince
  // ayari kaydedip uygulamayi yeniden baslatiriz (sekmeler yeni pencerede taze acilir).
  // Bugulu (acrylic) yalnizca Win11 22H2+ — eski Windows'ta secenek devre disi kalir.
  window.termAPI.getCaps().then((caps) => {
    if (caps && caps.acrylic === false) {
      const btn = document.querySelector('#glass-mode button[data-glass="acrylic"]');
      if (btn) {
        btn.classList.add('disabled');
        btn.title = t('acrylicReq');
      }
    }
  }).catch(() => {});
  for (const btn of document.querySelectorAll('#glass-mode button')) {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('disabled')) return;
      const v = btn.dataset.glass;
      if ((settings.glass || 'acrylic') === v) return;
      settings.glass = v;
      applySettings(); // kaydet
      window.termAPI.relaunch();
    });
  }

  // Yazi boyutu (9-24 arasi; macOS Terminal da benzer sinirlar kullanir)
  document.getElementById('font-minus').addEventListener('click', () => {
    settings.fontSize = Math.max(9, settings.fontSize - 1);
    applySettings(); syncSettingsUI();
  });
  document.getElementById('font-plus').addEventListener('click', () => {
    settings.fontSize = Math.min(24, settings.fontSize + 1);
    applySettings(); syncSettingsUI();
  });

  // Imlec stili
  for (const btn of cursorStyleEl.querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      settings.cursorStyle = btn.dataset.style;
      applySettings(); syncSettingsUI();
    });
  }

  // Imlec yanip sonme
  cursorBlinkEl.addEventListener('change', () => {
    settings.cursorBlink = cursorBlinkEl.checked;
    applySettings();
  });

  // Kabuk secenekleri main surecinden gelir (WSL/PowerShell/cmd)
  window.termAPI.listShells().then((profiles) => {
    for (const [key, p] of Object.entries(profiles)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = p.name;
      shellSelectEl.appendChild(opt);
    }
    shellSelectEl.value = settings.shell;
  });
  shellSelectEl.addEventListener('change', () => {
    settings.shell = shellSelectEl.value;
    applySettings(); // kayit; acik sekmeler etkilenmez (macOS davranisi)
  });

  // Dil secimi: aninda uygulanir ve kaydedilir
  for (const btn of document.querySelectorAll('#lang-mode button')) {
    btn.addEventListener('click', () => {
      if (settings.lang === btn.dataset.lang) return;
      settings.lang = btn.dataset.lang;
      applySettings(); // kaydet
      applyLanguage();
      syncSettingsUI();
    });
  }

  document.getElementById('settings-close').addEventListener('click', closeSettings);
  // Panelin disina tiklama = kapat (macOS sheet davranisi)
  overlayEl.addEventListener('mousedown', (e) => {
    if (e.target === overlayEl) closeSettings();
  });
}

// Terminal odakta DEGILKEN (panel acikken) Esc ve Ctrl+, calissin diye window-level
// dinleyici. DIKKAT: terminal odaktayken Ctrl+, xterm'in custom handler'inda ZATEN
// islenir ve olay window'a kadar kabarcaklanir (bubbling) — burada tekrar toggle
// edersek panel acilip ANINDA kapanir. Bu yuzden xterm icinden gelen olayi atlariz.
window.addEventListener('keydown', (e) => {
  const fromTerminal = e.target && e.target.closest && e.target.closest('.xterm');
  if (!fromTerminal && (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
    e.preventDefault();
    if (commandPaletteOverlayEl.hidden) openCommandPalette(); else closeCommandPalette();
    return;
  }
  if (e.key === 'Escape' && !commandPaletteOverlayEl.hidden) { closeCommandPalette(); return; }
  if (e.key === 'Escape' && !overlayEl.hidden) { closeSettings(); return; }
  if (e.key === 'Escape' && !zlOverlayEl.hidden) { closeZeroLink(); return; }
  if (!fromTerminal && (e.ctrlKey || e.metaKey) && e.key === ',') {
    e.preventDefault();
    toggleSettings();
  }
  // Ctrl+L: terminal DISINDA (panel/input odaktayken) ZeroLink'i ac/kapat.
  // Terminal odaktayken xterm'in birlesik handler'i zaten isler → cift toggle olmasin.
  if (!fromTerminal && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    toggleZeroLink();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ZeroLink UI — P2P sifreli uzak terminal paneli
// ═══════════════════════════════════════════════════════════════════════════
const zlOverlayEl = document.getElementById('zl-overlay');
const zlL = () => LANGS[settings.lang] || LANGS.en;

function toggleZeroLink() { zlOverlayEl.hidden ? openZeroLink() : closeZeroLink(); }
function openZeroLink()   { zlResetToModeSelect(); zlOverlayEl.hidden = false; }
function closeZeroLink()  { zlOverlayEl.hidden = true; tabs.get(activeTabId)?.term.focus(); }

document.getElementById('btn-zerolink').addEventListener('click', toggleZeroLink);
document.getElementById('zl-close').addEventListener('click', closeZeroLink);
zlOverlayEl.addEventListener('mousedown', (e) => { if (e.target === zlOverlayEl) closeZeroLink(); });

// Mod secim ekranina sifirla
function zlResetToModeSelect() {
  document.getElementById('zl-mode-select').hidden = false;
  document.getElementById('zl-host-view').hidden   = true;
  document.getElementById('zl-client-view').hidden = true;
  document.getElementById('zl-back-btn').hidden    = true;
  document.getElementById('zl-error').hidden       = true;
  zlShowHostIdle();
  zlShowClientIdle();
}

function zlShowError(msg) {
  const el = document.getElementById('zl-error');
  el.textContent = '⚠ ' + msg;
  el.hidden = false;
}
function zlClearError() { document.getElementById('zl-error').hidden = true; }

// ── HOST UI ──────────────────────────────────────────────────────────────────
function zlShowHostIdle() {
  document.getElementById('zl-host-idle').hidden      = false;
  document.getElementById('zl-host-active').hidden    = true;
  document.getElementById('zl-host-connected').hidden = true;
}
function zlShowHostActive(code) {
  document.getElementById('zl-host-idle').hidden      = true;
  document.getElementById('zl-host-active').hidden    = false;
  document.getElementById('zl-host-connected').hidden = true;
  document.getElementById('zl-code-display').textContent = code;
  document.getElementById('zl-timer').classList.remove('zl-timer-urgent');
  zlClearError();
}
function zlShowHostConnected(addr) {
  document.getElementById('zl-host-idle').hidden      = true;
  document.getElementById('zl-host-active').hidden    = true;
  document.getElementById('zl-host-connected').hidden = false;
  document.getElementById('zl-connected-addr').textContent = `${zlL().zlConnectedAddr} ${addr || ''}`.trim();
}

document.getElementById('zl-btn-host').addEventListener('click', () => {
  document.getElementById('zl-mode-select').hidden = true;
  document.getElementById('zl-host-view').hidden   = false;
  document.getElementById('zl-back-btn').hidden    = false;
});

document.getElementById('zl-host-start-btn').addEventListener('click', async () => {
  zlClearError();
  const startBtn = document.getElementById('zl-host-start-btn');
  startBtn.disabled = true;
  document.getElementById('zl-host-status').textContent = zlL().zlPreparing;
  try {
    const { code } = await window.termAPI.zlHostStart(activeTabId);
    zlState.hostActive = true;
    zlState.lastCode   = code;
    zlShowHostActive(code);
    _updateZlTitlebarBtn();
  } catch (err) {
    zlShowError(err.message);
    startBtn.disabled = false;
  }
});

document.getElementById('zl-code-copy').addEventListener('click', () => {
  const code = document.getElementById('zl-code-display').textContent;
  window.termAPI.clipboardWrite(code);
  const btn = document.getElementById('zl-code-copy');
  btn.textContent = zlL().zlCopied;
  btn.title = zlL().zlCopied;
  setTimeout(() => { btn.textContent = zlL().zlCopy; btn.title = zlL().zlCopy; }, 2000);
});

function _zlHostStopReset() {
  window.termAPI.zlHostStop();
  zlState.hostActive    = false;
  zlState.hostConnected = false;
  zlShowHostIdle();
  document.getElementById('zl-host-start-btn').disabled = false;
  _updateZlTitlebarBtn();
}
document.getElementById('zl-host-stop-btn').addEventListener('click', _zlHostStopReset);
document.getElementById('zl-host-disconnect-btn').addEventListener('click', _zlHostStopReset);

// HOST olaylari (main process → renderer)
window.termAPI.onZlHostCode(({ code }) => {
  zlState.lastCode = code;
  zlShowHostActive(code);
});

window.termAPI.onZlHostTimer(({ secondsLeft }) => {
  const m = Math.floor(secondsLeft / 60);
  const s = String(secondsLeft % 60).padStart(2, '0');
  const timerEl = document.getElementById('zl-timer');
  if (timerEl) {
    timerEl.textContent = `${m}:${s}`;
    if (secondsLeft <= 10) timerEl.classList.add('zl-timer-urgent');
  }
});

window.termAPI.onZlHostExpired(() => {
  zlState.hostActive    = false;
  zlState.hostConnected = false;
  zlState.lastCode      = null;
  zlShowHostIdle();
  zlShowError(zlL().zlCodeExpired);
  document.getElementById('zl-host-start-btn').disabled = false;
  _updateZlTitlebarBtn();
});

window.termAPI.onZlHostConnected(({ addr }) => {
  zlState.hostConnected = true;
  zlState.lastAddr      = addr;
  zlShowHostConnected(addr);
  _updateZlTitlebarBtn();
});

window.termAPI.onZlHostDisconnected(() => {
  zlState.hostActive    = false;
  zlState.hostConnected = false;
  zlState.lastAddr      = null;
  zlShowHostIdle();
  document.getElementById('zl-host-start-btn').disabled = false;
  _updateZlTitlebarBtn();
});

// ── CLIENT UI ─────────────────────────────────────────────────────────────────
function zlShowClientIdle() {
  document.getElementById('zl-client-idle').hidden       = false;
  document.getElementById('zl-client-connecting').hidden = true;
  document.getElementById('zl-client-connected').hidden  = true;
}
function zlShowClientConnecting() {
  document.getElementById('zl-client-idle').hidden       = true;
  document.getElementById('zl-client-connecting').hidden = false;
  document.getElementById('zl-client-connected').hidden  = true;
}
function zlShowClientConnected() {
  document.getElementById('zl-client-idle').hidden       = true;
  document.getElementById('zl-client-connecting').hidden = true;
  document.getElementById('zl-client-connected').hidden  = false;
}

document.getElementById('zl-btn-client').addEventListener('click', () => {
  document.getElementById('zl-mode-select').hidden = true;
  document.getElementById('zl-client-view').hidden = false;
  document.getElementById('zl-back-btn').hidden    = false;
  setTimeout(() => document.getElementById('zl-code-input').focus(), 50);
});

document.getElementById('zl-client-connect-btn').addEventListener('click', async () => {
  const code = document.getElementById('zl-code-input').value.trim();
  if (!code) { zlShowError(zlL().zlCodeEmpty); return; }
  zlClearError();
  zlShowClientConnecting();
  zlState.clientTabId = activeTabId; // uzak oturum bu sekmeye bagli
  try {
    await window.termAPI.zlClientConnect(code, activeTabId);
    // onZlClientConnected olayi zlState'i guncelleyecek
  } catch (err) {
    zlShowClientIdle();
    zlShowError(err.message);
  }
});

document.getElementById('zl-code-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('zl-client-connect-btn').click();
});

document.getElementById('zl-client-disconnect-btn').addEventListener('click', () => {
  window.termAPI.zlClientDisconnect();
  document.getElementById('zl-code-input').value = '';
  _zlClientReset();
});

// Uzak (client) oturumundan yerel kabuğa temiz dönüş
function _zlClientReset() {
  const tabId = zlState.clientTabId;
  zlState.clientActive = false;
  zlState.clientTabId  = null;
  _zlClearTools();
  zlShowClientIdle();
  _updateZlTitlebarBtn();
  const t = tabs.get(tabId);
  if (t) {
    t.term.reset();                       // uzak oturum ekranını temizle
    window.termAPI.writePty(tabId, '\r'); // yerel kabuk prompt'unu yeniden çizdir
    if (tabId === activeTabId) t.term.focus();
  }
}

// CLIENT olaylari
window.termAPI.onZlClientConnected(() => {
  zlState.clientActive = true;
  zlShowClientConnected();
  _updateZlTitlebarBtn();
  // SSH gibi TEMİZ uzak oturum: yerel kabuk kalıntılarını sil, uzak prompt gelsin
  const t = tabs.get(zlState.clientTabId);
  if (t) {
    t.term.reset();
    window.termAPI.zlClientResize(t.term.cols, t.term.rows); // uzak PTY'yi boyutumuza ayarla
    t.term.focus();
  }
  setTimeout(() => closeZeroLink(), 900);
});

// Uzak kabuk sonlandı (exit/logout) → yerel kabuğa dön
window.termAPI.onZlClientRemoteExit(({ code }) => {
  const t = tabs.get(zlState.clientTabId);
  if (t) t.term.write(`\r\n\x1b[90m[uzak oturum kapandı — çıkış kodu ${code}]\x1b[0m\r\n`);
  window.termAPI.zlClientDisconnect();
  _zlClientReset();
});

window.termAPI.onZlClientDisconnected(() => {
  const wasActive = zlState.clientActive;
  _zlClientReset();
  if (wasActive) zlShowError(zlL().zlDisconnectedMsg);
});

// ── ZeroLink oturum araçları (bağlıyken): dosya gönder/al + port yönlendirme ──
const zlForwards = new Set();

function _zlFileStatus(txt) {
  const el = document.getElementById('zl-file-status');
  if (el) el.textContent = txt;
}
function _fmtBytes(n) {
  if (n == null) return '';
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1024 / 1024).toFixed(1) + 'MB';
}
function zlRenderForwards() {
  const list = document.getElementById('zl-fwd-list');
  if (!list) return;
  list.innerHTML = '';
  for (const f of zlForwards) {
    const item = document.createElement('div');
    item.className = 'zl-fwd-item';
    const label = document.createElement('span');
    label.textContent = `:${f.localPort} → ${f.target}`;
    const kill = document.createElement('button');
    kill.className = 'zl-fwd-kill'; kill.textContent = '×'; kill.title = zlL().zlRemove || 'Remove';
    kill.addEventListener('click', () => {
      window.termAPI.zlClientForwardRemove(f.localPort);
      zlForwards.delete(f); zlRenderForwards();
    });
    item.append(label, kill);
    list.appendChild(item);
  }
}
function _zlClearTools() { zlForwards.clear(); zlRenderForwards(); _zlFileStatus(''); }

document.getElementById('zl-push-btn').addEventListener('click', async () => {
  try {
    const res = await window.termAPI.zlClientPushFile();
    if (res && !res.canceled) _zlFileStatus(`⬆ ${res.name} …`);
  } catch (err) { _zlFileStatus('⚠ ' + err.message); }
});

async function zlDoPull() {
  const input = document.getElementById('zl-pull-input');
  const remotePath = input.value.trim();
  if (!remotePath) return;
  try {
    const res = await window.termAPI.zlClientPullFile(remotePath);
    _zlFileStatus(`⬇ ${res.name} …`);
    input.value = '';
  } catch (err) { _zlFileStatus('⚠ ' + err.message); }
}
document.getElementById('zl-pull-btn').addEventListener('click', zlDoPull);
document.getElementById('zl-pull-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') zlDoPull(); });

document.getElementById('zl-fwd-add-btn').addEventListener('click', async () => {
  const lp = document.getElementById('zl-fwd-local').value.trim();
  const rh = document.getElementById('zl-fwd-host').value.trim() || '127.0.0.1';
  const rp = document.getElementById('zl-fwd-port').value.trim();
  if (!lp || !rp) return;
  try {
    await window.termAPI.zlClientForwardAdd(lp, rh, rp);
    document.getElementById('zl-fwd-local').value = '';
    document.getElementById('zl-fwd-port').value  = '';
  } catch (err) { _zlFileStatus('⚠ ' + err.message); }
});

window.termAPI.onZlClientFileProgress(({ name, sent, size }) => {
  const pct = size ? Math.round(sent / size * 100) : 0;
  _zlFileStatus(`${name} ${pct}%`);
});
window.termAPI.onZlClientFileDone((info) => {
  _zlFileStatus(info.name ? `✓ ${info.name} (${_fmtBytes(info.bytes)})` : '✓ tamam');
});
window.termAPI.onZlClientFileError(({ message }) => _zlFileStatus('⚠ ' + message));
window.termAPI.onZlClientForwardOpen(({ localPort, target }) => { zlForwards.add({ localPort, target }); zlRenderForwards(); });
window.termAPI.onZlClientForwardError(({ localPort, message }) => _zlFileStatus(`⚠ port ${localPort}: ${message}`));

// Ortak hata
window.termAPI.onZlError(({ message }) => {
  zlState.hostActive    = false;
  zlState.hostConnected = false;
  if (zlState.clientTabId != null) _zlClientReset(); // uzak oturumdan yerel kabuğa dön
  zlState.clientActive  = false;
  zlShowError(message);
  zlShowHostIdle();
  zlShowClientIdle();
  document.getElementById('zl-host-start-btn').disabled = false;
  _updateZlTitlebarBtn();
});

// Titlebar butonunu aktif/pasif goster
function _updateZlTitlebarBtn() {
  const btn = document.getElementById('btn-zerolink');
  const active = zlState.hostActive || zlState.hostConnected || zlState.clientActive;
  btn.classList.toggle('zl-active', active);
  btn.title = active ? zlL().zlBtnTitleActive : zlL().zlBtnTitle;
}

// Geri butonu
document.getElementById('zl-back-btn').addEventListener('click', () => {
  window.termAPI.zlHostStop();
  window.termAPI.zlClientDisconnect();
  zlResetToModeSelect();
});

// NatureCo imzası → natureco.me'yi sistem tarayıcısında aç
(() => {
  const nc = document.getElementById('nc-link');
  if (!nc) return;
  const open = (e) => { e.preventDefault(); window.termAPI.openExternal('https://natureco.me'); };
  nc.addEventListener('click', open);
  nc.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') open(e); });
})();

// ── Otomatik güncelleme UI (pill + ayarlar butonu) ──
(() => {
  const pill = document.getElementById('update-pill');
  const upText = document.getElementById('up-text');
  const checkBtn = document.getElementById('btn-check-update');
  const statusEl = document.getElementById('update-status');
  const curVer = document.getElementById('cur-version');
  const getBtn = document.getElementById('up-get');
  let updateUrl = null;     // Mac/Linux: installer indirme linki
  let mode = 'link';        // 'link' (Mac/Linux tek-tık indir) | 'silent' (Windows electron-updater)
  const L = () => LANGS[settings.lang] || LANGS.en;
  const showPill = (text, btnLabel, btnEnabled = true) => {
    if (upText) upText.textContent = text;
    if (getBtn) { getBtn.textContent = btnLabel; getBtn.hidden = !btnLabel; getBtn.disabled = !btnEnabled; }
    if (pill) pill.hidden = false;
  };

  window.termAPI.getCaps().then((c) => { if (c && c.version && curVer) curVer.textContent = 'v' + c.version; }).catch(() => {});

  window.termAPI.onUpdateAvailable(({ version, url, silent }) => {
    if (silent) {
      // Windows: arka planda sessiz indirme başladı
      mode = 'silent';
      showPill(L().updateDownloading || 'Downloading update…', '', false);
      if (statusEl) { statusEl.textContent = (L().updateDownloading || 'Downloading update…'); statusEl.className = 'hint'; }
    } else {
      // Mac/Linux: linkli bildirim, kullanıcı tek tıkla indirir
      mode = 'link';
      updateUrl = url;
      const msg = (L().updateAvail || 'New version') + ' v' + version;
      showPill(msg, L().updateGet || 'Update', true);
      if (statusEl) { statusEl.textContent = msg; statusEl.className = 'hint ok'; }
    }
  });
  window.termAPI.onUpdateProgress(({ percent }) => {
    const t = (L().updateDownloading || 'Downloading update…') + ' ' + percent + '%';
    if (upText) upText.textContent = t;
    if (statusEl) { statusEl.textContent = t; statusEl.className = 'hint'; }
  });
  window.termAPI.onUpdateDownloaded(({ version }) => {
    // Windows: indirildi → yeniden başlatınca kurulur
    mode = 'silent-ready';
    const msg = (L().updateReady || 'Update ready') + ' v' + version;
    showPill(msg, L().updateRestart || 'Restart & update', true);
    if (statusEl) { statusEl.textContent = msg; statusEl.className = 'hint ok'; }
  });
  window.termAPI.onUpdateNone(() => {
    if (statusEl) { statusEl.textContent = L().updateNone || 'You are up to date.'; statusEl.className = 'hint ok'; }
    if (checkBtn) checkBtn.disabled = false;
  });
  window.termAPI.onUpdateError(({ message }) => {
    if (statusEl) { statusEl.textContent = '⚠ ' + message; statusEl.className = 'hint err'; }
    if (checkBtn) checkBtn.disabled = false;
  });

  getBtn?.addEventListener('click', () => {
    if (mode === 'silent-ready') window.termAPI.installUpdate();      // Windows: kur + yeniden başlat
    else if (updateUrl) window.termAPI.openExternal(updateUrl);        // Mac/Linux: installer indir
  });
  document.getElementById('up-close')?.addEventListener('click', () => { if (pill) pill.hidden = true; });
  checkBtn?.addEventListener('click', () => {
    if (statusEl) { statusEl.textContent = L().updateChecking || 'Checking…'; statusEl.className = 'hint'; }
    checkBtn.disabled = true;
    window.termAPI.checkForUpdates();
    setTimeout(() => { checkBtn.disabled = false; }, 5000);
  });
})();

// ── NatureCo Hesabı (SSO) — CLI ile aynı oturumu paylaşır ──
const _ncRefreshAccount = (() => {
  const $ = (id) => document.getElementById(id);
  const L = () => LANGS[settings.lang] || LANGS.en;
  const setStatus = (t, cls = '') => { const el = $('nc-acc-status'); if (el) { el.textContent = t; el.className = 'hint ' + cls; } };

  function setTitlebar(loggedIn, email) {
    const b = $('btn-account');
    if (!b) return;
    b.classList.toggle('signed-in', !!loggedIn);
    b.title = loggedIn
      ? 'NatureCo — ' + (email || (L().accSignedInTip || 'signed in'))
      : (L().accSignInTip || 'Sign in to NatureCo');
  }
  function showLoggedIn(email) {
    if ($('nc-acc-out')) $('nc-acc-out').hidden = true;
    if ($('nc-acc-in')) $('nc-acc-in').hidden = false;
    if ($('nc-acc-who')) $('nc-acc-who').textContent = email || '';
    setTitlebar(true, email);
  }
  function showLoggedOut() {
    if ($('nc-acc-in')) $('nc-acc-in').hidden = true;
    if ($('nc-acc-out')) $('nc-acc-out').hidden = false;
    if ($('nc-acc-otp')) $('nc-acc-otp').hidden = true;
    if ($('nc-acc-pw')) $('nc-acc-pw').hidden = true;
    setStatus('');
    setTitlebar(false);
  }
  async function refresh() {
    try {
      const s = await window.termAPI.ncAccountStatus();
      if (s && s.loggedIn) showLoggedIn(s.email); else showLoggedOut();
    } catch (_) { showLoggedOut(); }
  }
  refresh();

  $('nc-acc-sendcode')?.addEventListener('click', async () => {
    const email = ($('nc-acc-email').value || '').trim();
    if (!/.+@.+\..+/.test(email)) { setStatus(L().accBadEmail || 'Enter a valid email', 'err'); return; }
    setStatus(L().accSending || 'Sending…');
    try {
      await window.termAPI.ncAccountSendOtp(email);
      $('nc-acc-otp').hidden = false; $('nc-acc-pw').hidden = true;
      setStatus(L().accSent || 'Check your email — paste the code or login link', 'ok');
    } catch (e) { setStatus('⚠ ' + e.message, 'err'); }
  });
  $('nc-acc-usepass')?.addEventListener('click', () => { $('nc-acc-pw').hidden = false; $('nc-acc-otp').hidden = true; setStatus(''); });

  async function doVerify(getVal, apiCall) {
    const email = ($('nc-acc-email').value || '').trim();
    const val = getVal();
    if (!val) return;
    setStatus(L().accVerifying || 'Verifying…');
    try { const r = await apiCall(email, val); showLoggedIn(r.email); }
    catch (e) { setStatus('⚠ ' + e.message, 'err'); }
  }
  $('nc-acc-verify')?.addEventListener('click', () => doVerify(() => ($('nc-acc-code').value || '').trim(), (em, v) => window.termAPI.ncAccountVerify(em, v)));
  $('nc-acc-code')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('nc-acc-verify').click(); });
  $('nc-acc-signin')?.addEventListener('click', () => doVerify(() => $('nc-acc-pass').value, (em, v) => window.termAPI.ncAccountPassword(em, v)));
  $('nc-acc-pass')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('nc-acc-signin').click(); });
  $('nc-acc-logout')?.addEventListener('click', () => { window.termAPI.ncAccountLogout(); showLoggedOut(); });

  // Ekosistem hızlı bağlantıları (sistem tarayıcısında aç)
  for (const a of document.querySelectorAll('.nc-eco-link')) {
    a.addEventListener('click', () => { const u = a.getAttribute('data-eco'); if (u) window.termAPI.openExternal(u); });
    a.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); a.click(); } });
  }

  return refresh;
})();

// Gomulu fontu xterm ilk olcumden ONCE yukle (yoksa glyph metrigi kayar), sonra ilk sekme.
async function boot() {
  try {
    const caps = await window.termAPI.getCaps();
    document.body.classList.toggle('platform-mac', caps?.platform === 'darwin');
  } catch (_) { /* platform sinifi zorunlu degil */ }
  try {
    const saved = await window.termAPI.getSettings();
    settings = { ...DEFAULT_SETTINGS, ...saved };
    if (!THEMES[settings.profile]) settings.profile = 'pro';
  } catch (_) { /* ayar okunamazsa varsayilanlar */ }

  // Dil: kayitli tercih yoksa sistem dilinden sec (tr → Turkce, digerleri → Ingilizce)
  if (!settings.lang) {
    settings.lang = (navigator.language || '').toLowerCase().startsWith('tr') ? 'tr' : 'en';
  }
  applyLanguage();

  buildSettingsUI();
  // Krom rengini ilk sekme acilmadan uygula (acik temada koyu flash olmasin);
  // save=false → diske geri yazmaya gerek yok.
  applySettings({ save: false });

  try {
    await Promise.all([
      document.fonts.load('400 13px "JetBrains Mono"'),
      document.fonts.load('700 13px "JetBrains Mono"'),
      document.fonts.load('italic 400 13px "JetBrains Mono"'),
    ]);
    await document.fonts.ready;
  } catch (_) { /* font yuklenemezse sistem mono'suna duser */ }
  let bootContext = {};
  let session = { tabs: [], activeIndex: 0 };
  try {
    [bootContext, session] = await Promise.all([window.termAPI.getBootContext(), window.termAPI.getSession()]);
    session = normalizeSession(session);
  } catch (_) { /* bos oturumla devam */ }

  if (bootContext?.cwd) {
    await createTab('default', bootContext.cwd);
  } else if (session.tabs.length) {
    restoringSession = true;
    for (const tab of session.tabs) await createTab(tab.profileKey, tab.cwd);
    const restoredId = [...tabs.keys()][session.activeIndex];
    if (restoredId) activateTab(restoredId);
    restoringSession = false;
    scheduleSessionSave();
  } else {
    await createTab();
  }
}
boot();
