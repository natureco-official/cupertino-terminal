/**
 * ZeroLink CLI
 * ─────────────
 * Çalışma prensibi:
 *
 *   xterm.js'in attachCustomKeyEventHandler'ı her tuşa basışta,
 *   PTY'ye ve xterm'in kendi echo'suna gitmeden ÖNCE çağrılır.
 *   Bu handler'dan false döndürürsek xterm de PTY de hiçbir şey görmez.
 *
 *   "zl" intercept akışı:
 *     1. Normal modda her key event sadece izlenir, tüm girdi PTY'ye gider.
 *     2. Satır başında 'z' basılınca: xterm echo'sunu DURDURUYORUZ (false),
 *        kendi renkli echo'muzu yazıyoruz, _pendingZ = true.
 *     3. Sonraki karakter 'l' ise: intercept mod ON.
 *        Sonraki karakter başka ise: 'z' + karakter PTY'ye yolla, normal mod.
 *     4. Intercept modda Enter'a kadar tüm girişi biz yönetiyoruz.
 *     5. Enter → dispatch(_lineBuf) → ZeroLink komutu çalışır.
 *        Shell asla "zl" görmez → "command not found" olmaz.
 */

'use strict';

// ── ANSI ─────────────────────────────────────────────────────────────────────
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  cyan:    '\x1b[38;2;90;200;250m',
  green:   '\x1b[38;2;48;209;88m',
  yellow:  '\x1b[38;2;255;214;10m',
  red:     '\x1b[38;2;255;69;58m',
  gray:    '\x1b[38;2;142;142;147m',
  white:   '\x1b[38;2;242;242;242m',
  bgGreen: '\x1b[48;2;48;209;88m\x1b[38;2;0;0;0m',
  bgRed:   '\x1b[48;2;255;69;58m\x1b[38;2;255;255;255m',
};
const R = C.reset;
const p  = (col, t) => `${col}${t}${R}`;
const cb = (t) => `${C.cyan}${C.bold}${t}${R}`;

// ── Yardım metni ─────────────────────────────────────────────────────────────
// ANSI kodları + template literal boşlukları terminalde tutarsız görünüyor.
// Bu yüzden metin kısmını ANSI'siz düz string'de tutuyoruz, sadece başlık rengi
// ve highlight için ANSI kullanıyoruz.
const HELP = () => {
  const L = p(C.gray, '╴');  // hafif bir ayraç
  const h = (t) => cb(` ${t} `); // cyan bold başlık
  return [
    '',
    `  ${cb('⬡ ZeroLink')}  ${p(C.gray, 'v1.0 — P2P Encrypted Terminal')}`,
    '',
    `  ${p(C.bold + C.white, 'Kullanım')}`,
    `    ${h('zl share')}          ${p(C.gray, 'Bu terminali paylaş, kod üret')}`,
    `    ${h('zl share --watch')}  ${p(C.gray, 'Kod + canlı geri sayım')}`,
    `    ${h('zl connect')} ${p(C.yellow,'<kod>')}   ${p(C.gray, 'Koda bağlan, uzak terminal aç')}`,
    `    ${h('zl status')}         ${p(C.gray, 'Aktif bağlantı durumu')}`,
    `    ${h('zl disconnect')}     ${p(C.gray, 'Bağlantıyı kes')}`,
    `    ${h('zl help')}           ${p(C.gray, 'Bu yardım metnini göster')}`,
    '',
    `  ${p(C.bold + C.white, 'Güvenlik')}`,
    `    ${p(C.gray, '• ECDH P-256 + AES-256-GCM uçtan uca şifreleme')}`,
    `    ${p(C.gray, '• Kod 5dk geçerli, tek kullanımlık, HMAC imzalı')}`,
    `    ${p(C.gray, '• Sıfır sunucu — hiçbir 3. taraf içeriği göremez')}`,
    '',
    `  ${p(C.bold + C.white, 'Örnek')}`,
    `    ${p(C.gray, 'Paylaş:')}  ${h('zl share --watch')}`,
    `    ${p(C.gray, 'Bağlan:')}  ${h('zl connect')} ${p(C.yellow,'ABCD-EFGH-IJKL-MNOP')}`,
    '',
  ].join('\r\n');
};

// ── ZeroLinkCLI ──────────────────────────────────────────────────────────────
class ZeroLinkCLI {
  constructor({ term, tabId, termAPI, getZlState }) {
    this.term     = term;
    this.tabId    = tabId;
    this.api      = termAPI;
    this.getState = getZlState;

    this._intercept = false;  // intercept modu aktif mi
    this._buf       = '';     // intercept tampon: "zl share …"
    this._pendingZ  = false;  // 'z' basıldı, 'l' bekleniyor
    this._lastTyped = '\n';   // son işlenen karakter (kelime başı tespiti için)
    this._blockNext = false;  // sonraki onData'yı PTY'den engelle (input event bypass)
    this._watchTimer = null;
    this._unsubs     = [];
    // NOT: xterm tek custom key handler destekler — bu sınıf handler'ı KENDİSİ
    // BAĞLAMAZ. createTab, kısayol handler'ıyla zincirleyip handleKey()'i çağırır.
  }

  // ── Ana key handler (xterm echo + PTY'den ÖNCE çalışır) ──────────────────
  // true  → xterm normal davransın (PTY'ye ilet, echo yap)
  // false → xterm hiçbir şey yapmasın (biz kontrol ediyoruz)
  handleKey(e) {
    // Sadece keydown ilgilendiriyor, keyup yoksay
    if (e.type !== 'keydown') return true;

    // Client modunda: tüm girdi zaten onData'dan yönlendiriliyor, buraya müdahale etme
    if (this.getState().clientActive) return true;

    // ── Intercept modu aktifken ─────────────────────────────────────────────
    if (this._intercept) {
      return this._interceptKey(e);
    }

    // ── Normal mod: 'z' takibi ──────────────────────────────────────────────
    return this._normalKey(e);
  }

  // Intercept veya 'z' bekleme durumunda mi? (createTab kısayol handler'ı bunu
  // görürse tüm tuşları — Ctrl+C iptal dahil — ZeroLink'e yönlendirir.)
  isCapturing() { return this._intercept || this._pendingZ; }

  // ── Normal mod key handler ────────────────────────────────────────────────
  // Kurallar:
  //   - Sadece KELİME BAŞINDAKİ 'z'leri intercept et (üst üste 'z'leri atla)
  //   - _blockNext: xterm input event + onData bypass'ını engelle
  //   - Enter/Backspace: önce bekleyen 'z'yi PTY'ye boşalt (yutma)
  _normalKey(e) {
    const key = e.key;

    // ── Özel tuşlar: tamponu sıfırla, PTY'ye geç ─────────────────────────────
    if (e.ctrlKey || e.altKey || e.metaKey || (key.length > 1 && key !== 'Backspace' && key !== 'Enter')) {
      this._lastTyped = '\n';  // modifier/special → yeni kelime başlangıcı
      this._reset();
      return true;
    }

    // Enter/Backspace: önce bekleyen 'z' varsa boşalt
    if (key === 'Enter' || key === 'Backspace') {
      if (this._pendingZ) {
        this._pendingZ = false;
        this._blockNext = true;
        this.api.writePty(this.tabId, 'z');
        // NOT: 'z' PTY'ye gitti ama xterm echo YAPMAZSA kullanıcı görmez.
        // PTY echo'su halleder.
      }
      this._lastTyped = (key === 'Enter') ? '\n' : '\b';
      this._buf = '';
      return true;
    }

    // ── Kelime başı kontrolü ─────────────────────────────────────────────────
    const atWordStart = !this._lastTyped || /[\s\n\r]/.test(this._lastTyped);

    // ── 'z' geldi, sadece kelime başında intercept et ──────────────────────
    if ((key === 'z' || key === 'Z') && !this._pendingZ && atWordStart) {
      this._pendingZ   = true;
      this._lastTyped   = 'z';
      this._blockNext   = true;  // onData bypass koruması
      return false;              // PTY'ye gitme, sessiz bekle
    }

    // ── 'l' geldi ve 'z' bekliyorduk → intercept başlat ────────────────────
    if ((key === 'l' || key === 'L') && this._pendingZ) {
      this._pendingZ   = false;
      this._lastTyped   = 'l';
      this._blockNext   = true;
      this._intercept   = true;
      this._buf         = 'zl';
      // echo: 'zl'yi birlikte bas (cyan) — PTY hiçbirini görmez
      this.term.write(p(C.cyan, 'zl'));
      return false;
    }

    // ── 'z' bekliyordu ama farklı harf geldi → ikisi birlikte PTY'ye ───────
    if (this._pendingZ) {
      this._pendingZ = false;
      this._lastTyped = key;
      this._blockNext = true;
      // Bekleyen 'z' + yeni karakteri TEK writePty'de gönder → çiftlenme olmaz
      this.api.writePty(this.tabId, 'z' + key);
      return false; // xterm tekrar işlemesin
    }

    // ── Normal karakter → PTY'ye geç ───────────────────────────────────────
    this._lastTyped = key;
    return true;
  }

  // ── Intercept mod key handler ─────────────────────────────────────────────
  _interceptKey(e) {
    const key = e.key;
    this._blockNext = true; // intercept'teki tüm tuşlar için onData bypass koruması

    // Ctrl+C veya Escape → iptal
    if (key === 'Escape' || (e.ctrlKey && key === 'c')) {
      this._cancelIntercept();
      return false;
    }

    // Modifier + başka → yoksay
    if (e.ctrlKey || e.altKey || e.metaKey) return false;

    // Enter → komutu çalıştır
    if (key === 'Enter') {
      const cmd = this._buf.trim();
      this.term.write('\r\n');
      this._intercept = false;
      this._buf = '';
      this._lastTyped = '\n'; // yeni satır → sonraki 'z' kelime başı sayılır
      this._dispatch(cmd);
      return false;
    }

    // Backspace
    if (key === 'Backspace') {
      if (this._buf.length > 2) {
        this._buf = this._buf.slice(0, -1);
        this.term.write('\b \b');
      } else if (this._buf.length === 2) {
        this._cancelIntercept();
      }
      return false;
    }

    // Ok tuşları, F tuşları vb. → yoksay
    if (key.length > 1) return false;

    // Yazılabilir karakter
    const ch = e.key; // gerçek karakter (shift dikkate alınmış)
    this._buf += ch;

    // Sözdizimsel renklendirme: zl=cyan  subcommand=bold  args=yellow
    const parts = this._buf.trimStart().split(/\s+/);
    let color = C.yellow;
    if (parts.length <= 1) color = C.cyan;
    else if (parts.length === 2 && parts[1].length === 1) color = C.white + C.bold;

    this.term.write(`${color}${ch}${R}`);
    return false;
  }

  // ── Intercept iptal ───────────────────────────────────────────────────────
  _cancelIntercept() {
    this._intercept = false;
    this._pendingZ  = false;
    this._buf       = '';
    this._lastTyped = '\n'; // iptal → sonraki 'z' kelime başı
    // Satırı temizle + shell'e Ctrl+U (line buffer temizle)
    this.term.write('\r\x1b[K');
    this.api.writePty(this.tabId, '\x15');
  }

  _reset() {
    this._pendingZ = false;
    this._buf = '';
  }

  // ── onData hook: client modu yönlendirmesi ────────────────────────────────
  // createTab'da term.onData içinden çağrılır
  handleData(data) {
    if (this.getState().clientActive) {
      this.api.zlClientSend(data);
      return false; // PTY'ye gitme
    }
    // Güvenlik ağı: _blockNext flag'i, xterm'in keydown'e rağmen input event
    // üzerinden onData göndermesini engeller. _intercept/_pendingZ de
    // intercept sürecindeyken sızıntıyı bloklar.
    if (this._blockNext) { this._blockNext = false; return false; }
    if (this._intercept || this._pendingZ) return false;
    return true; // PTY'ye ilet
  }

  // ── Komut dispatch ────────────────────────────────────────────────────────
  async _dispatch(line) {
    const parts = line.trim().split(/\s+/);
    // parts[0] = 'zl', parts[1] = subcommand, parts[2..] = args
    const sub  = (parts[1] || '').toLowerCase();
    const args = parts.slice(2);

    switch (sub) {
      case 'share':
        await this._cmdShare(args.includes('--watch'));
        break;
      case 'connect': case 'conn': case 'c':
        await this._cmdConnect(args.join('').trim());
        break;
      case 'disconnect': case 'disc': case 'd':
        this._cmdDisconnect();
        break;
      case 'status': case 'st':
        this._cmdStatus();
        break;
      case 'help': case '--help': case '-h': case '':
        this._write(HELP());
        break;
      default:
        this._write(`\r\n${p(C.red, `zl: '${sub}' bilinmiyor`)}  ${p(C.gray, '→  zl help')}\r\n\r\n`);
    }
  }

  // ── zl share ──────────────────────────────────────────────────────────────
  async _cmdShare(watch) {
    this._write(`\r\n${cb('⬡ ZeroLink')}  ${p(C.gray, 'hazırlanıyor…')}\r\n`);
    let code;
    try {
      const res = await this.api.zlHostStart(this.tabId);
      code = res.code;
    } catch (err) {
      this._write(`\r\n${p(C.red, '✗ Hata:')} ${err.message}\r\n\r\n`);
      return;
    }
    this._printCodeBox(code);
    if (watch) this._startWatch(Date.now());
    else this._write(`${p(C.gray, '  Sayaç için: ')}${cb('zl share --watch')}\r\n`);

    const cleanup = () => { this._unsubs.forEach(f => f?.()); this._unsubs = []; };
    this._unsubs.push(
      this.api.onZlHostConnected(({ addr }) => {
        this._stopWatch();
        this._write(`\r\n${p(C.bgGreen, ' ✓ BAĞLANTI KURULDU ')}  ${p(C.gray, addr)}\r\n`);
        this._write(`${p(C.gray, '  Kesmek: ')}${cb('zl disconnect')}\r\n\r\n`);
        cleanup();
      }),
      this.api.onZlHostDisconnected(() => {
        this._stopWatch();
        this._write(`\r\n${p(C.yellow, '⚡ Bağlantı kesildi.')}\r\n\r\n`);
        cleanup();
      }),
      this.api.onZlHostExpired(() => {
        this._stopWatch();
        this._write(`\r\n${p(C.red, '✗ Süre doldu.')}  ${p(C.gray, 'Yeni kod: zl share')}\r\n\r\n`);
        cleanup();
      }),
    );
  }

  _printCodeBox(code) {
    const clean = code.replace(/[-\s]/g, '').match(/.{1,4}/g)?.join('-') || code;

    // Kutu YOK — kod TEK mantıksal satırda, baştan girinti YOK. Terminal genişliğe
    // göre yumuşak sarar; xterm sarılmış satırı TEK parça kopyalar → seçince yalnızca
    // kod gelir (çubuk │ veya boşluk kopyalanmaz).
    this._write(`\r\n  ${cb('⬡ ZeroLink Kodu')}  ${p(C.gray, '— kopyalamak için aşağıdaki satırı seç')}\r\n\r\n`);
    this._write(`${p(C.yellow + C.bold, clean)}\r\n\r\n`);
    this._write(`  ${p(C.gray, 'Bağlanmak için:')} ${cb('zl connect <kod>')}\r\n`);
  }

  _startWatch(startTs) {
    this._stopWatch();
    this._watchTimer = setInterval(() => {
      const left = Math.max(0, Math.ceil((5 * 60 * 1000 - (Date.now() - startTs)) / 1000));
      const m = Math.floor(left / 60), s = String(left % 60).padStart(2, '0');
      const col = left <= 10 ? C.red : left <= 30 ? C.yellow : C.green;
      this.term.write(`\r  ${p(C.gray, 'Kalan süre:')}  ${col}${C.bold}${m}:${s}${R}   `);
      if (left === 0) this._stopWatch();
    }, 1000);
  }

  _stopWatch() {
    if (this._watchTimer) { clearInterval(this._watchTimer); this._watchTimer = null; }
    this.term.write('\r\x1b[K');
  }

  // ── zl connect ────────────────────────────────────────────────────────────
  async _cmdConnect(rawCode) {
    const code = rawCode.replace(/\s/g, '');
    if (!code) {
      this._write(`\r\n${p(C.red, '✗ Kullanım:')} zl connect ${p(C.yellow, '<kod>')}\r\n\r\n`);
      return;
    }
    this._write(`\r\n${cb('⬡ ZeroLink')}  ${p(C.gray, 'bağlanılıyor…')}\r\n`);
    this.getState().clientTabId = this.tabId; // uzak oturum bu sekmeye bağlı

    const cleanup = () => { this._unsubs.forEach(f => f?.()); this._unsubs = []; };
    this._unsubs.push(
      this.api.onZlClientConnected(() => {
        this._write(`\r\n${p(C.bgGreen, ' ✓ BAĞLANTI KURULDU ')}  ${p(C.gray, 'Uzak terminal aktif.')}\r\n`);
        this._write(`${p(C.gray, '  Kesmek: ')}${cb('zl disconnect')}\r\n\r\n`);
        cleanup();
      }),
      this.api.onZlClientDisconnected(() => {
        this._write(`\r\n${p(C.yellow, '⚡ Uzak bağlantı kesildi.')}\r\n\r\n`);
        cleanup();
      }),
      this.api.onZlError(({ message }) => {
        this._write(`\r\n${p(C.red, `✗ ${message}`)}\r\n\r\n`);
        cleanup();
      }),
    );

    try {
      await this.api.zlClientConnect(code, this.tabId);
    } catch (err) {
      this._write(`\r\n${p(C.red, `✗ ${err.message}`)}\r\n\r\n`);
      cleanup();
    }
  }

  // ── zl disconnect ─────────────────────────────────────────────────────────
  _cmdDisconnect() {
    const s = this.getState();
    if (!s.hostActive && !s.clientActive) {
      this._write(`\r\n${p(C.gray, '  Aktif ZeroLink bağlantısı yok.')}\r\n\r\n`);
      return;
    }
    this._stopWatch();
    this.api.zlHostStop();
    this.api.zlClientDisconnect();
    this._unsubs.forEach(f => f?.()); this._unsubs = [];
    this._write(`\r\n${p(C.yellow, '⚡ ZeroLink bağlantısı kesildi.')}\r\n\r\n`);
  }

  // ── zl status ─────────────────────────────────────────────────────────────
  _cmdStatus() {
    const s = this.getState();
    this._write(`\r\n${cb('⬡ ZeroLink Status')}\r\n`);
    this._write(`  ${p(C.gray, '─'.repeat(40))}\r\n`);
    if (!s.hostActive && !s.clientActive) {
      this._write(`  ${p(C.gray, 'Aktif bağlantı yok.')}\r\n`);
    } else {
      if (s.hostActive) {
        const dot = s.hostConnected ? p(C.green, '●') : p(C.yellow, '○');
        const lbl = s.hostConnected
          ? p(C.green, 'Bağlı') + (s.lastAddr ? `  ${p(C.gray, s.lastAddr)}` : '')
          : p(C.yellow, 'Bağlantı bekleniyor…');
        this._write(`  ${dot}  Host  —  ${lbl}\r\n`);
      }
      if (s.clientActive) {
        this._write(`  ${p(C.green, '●')}  Client  —  ${p(C.green, 'Uzak terminal aktif')}\r\n`);
      }
    }
    this._write(`  ${p(C.gray, '─'.repeat(40))}\r\n\r\n`);
  }

  // ── Yardımcı ──────────────────────────────────────────────────────────────
  _write(txt) { this.term.write(txt); }

  destroy() {
    this._stopWatch();
    this._unsubs.forEach(f => f?.());
    this._unsubs = [];
  }
}

if (typeof window !== 'undefined') window.ZeroLinkCLI = ZeroLinkCLI;
else module.exports = { ZeroLinkCLI };
