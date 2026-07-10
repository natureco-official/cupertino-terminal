/**
 * ZeroLink Host — SSH benzeri oturum sunucusu
 * ───────────────────────────────────────────
 * Eski model (ekran paylaşımı) yerine: bağlanan her istemciye ÖZEL, TAZE bir kabuk
 * açar (SSH gibi). Host kendi ekranını göstermez — istemci kendi oturumunu görür.
 *
 * Adımlar:
 *   1. start() → sinyal soketi + STUN + ECDH hazırlığı, kod üretimi
 *   2. Client 'hello' → offer; answer → DTLS/ICE → şifreli tünel
 *   3. Tünel açılınca `spawnSession()` ile YENİ bir PTY açılır, çerçeveli köprü kurulur
 *   4. Çerçeve tipleri: DATA (stdin→pty), RESIZE (pty boyutu), EXEC (tek komut),
 *      FILE_* (dosya transferi)
 *
 * Güvenlik: kod tek kullanımlık + 5dk TTL; E2E AES-256-GCM (ECDH ephemeral).
 */

'use strict';

const os   = require('os');
const EventEmitter = require('events');
const { ZeroLinkPeer, SIGNAL_PORT } = require('./zerolink-peer');
const { encodeZeroCode, codeTimeLeft } = require('./zerolink-crypto');
const P = require('./zerolink-proto');
const { FileSink, sendFile, ForwardHub } = require('./zerolink-transfer');

/**
 * @param {object} opts
 * @param {function} opts.spawnSession - ({cols,rows}) => ptyLike
 *        ptyLike: { onData(cb)->{dispose}, write(str), resize(cols,rows), kill(), onExit(cb), pid }
 *
 * Events:
 *   'codeReady' (code)        'codeTimer' (secondsLeft)   'codeExpired'
 *   'clientConnected' ({addr})  'sessionStarted' ({pid})
 *   'disconnected'  'error' (Error)
 */
class ZeroLinkHost extends EventEmitter {
  constructor({ spawnSession } = {}) {
    super();
    this._spawnSession = spawnSession;
    this._peer       = null;
    this._codeData   = null;
    this._connected  = false;
    this._codeTimer  = null;
    this._used       = false;
    this._offer      = null;
    this._answered   = false;
    this._clientAddr = null;

    this._session    = null;   // aktif interaktif PTY oturumu
    this._sessDispose = null;
    this._sink   = null;       // gelen dosya alıcısı (client → host push)
    this._fwd    = null;       // port yönlendirme akış merkezi
    this._fileSeq = 1;         // pull yanıtları için id sayacı
  }

  async start() {
    this._peer = new ZeroLinkPeer();
    const { publicKey, addrs } = await this._peer.prepare({ bindPort: SIGNAL_PORT, discover: true });

    const timestamp = Date.now();
    const code = encodeZeroCode({ publicKey, addrs, timestamp });
    this._codeData = { code, timestamp, addrs };

    this._codeTimer = setInterval(() => {
      const left = codeTimeLeft(timestamp);
      this.emit('codeTimer', left);
      if (left <= 0 && !this._connected) { this._invalidateCode(); this.emit('codeExpired'); }
    }, 1000);

    this._peer.onSignal((msg, rinfo) => this._handleSignal(msg, rinfo));

    this._peer.on('connected', () => {
      this._connected = true;
      this._invalidateCode();
      const send = (buf) => this._peer?.send(buf);
      this._sink = new FileSink(send, (info) => this.emit('fileReceived', info));
      this._fwd  = new ForwardHub(send);
      this.emit('clientConnected', { addr: this._clientAddr });
      this._startInteractiveSession();
    });

    this._peer.on('data', (buf) => this._onFrame(buf));

    this._peer.on('disconnected', () => {
      const was = this._connected;
      this._connected = false;
      this.stop();
      if (was) this.emit('disconnected');
    });

    this._peer.on('error', (err) => this.emit('error', err));

    this.emit('codeReady', code);
    return code;
  }

  // ── İnteraktif oturum: taze kabuk aç, PTY ↔ tünel köprüsü ───────────────────
  _startInteractiveSession() {
    if (this._session || !this._spawnSession) return;
    try {
      this._session = this._spawnSession({ cols: 100, rows: 30 });
    } catch (err) {
      this.emit('error', new Error(`Oturum kabuğu açılamadı: ${err.message}`));
      return;
    }
    this._sessDispose = this._session.onData((data) => {
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      this._peer?.send(P.frame(P.T.DATA, buf));
    });
    this._session.onExit?.(({ exitCode }) => {
      this._peer?.send(P.frame(P.T.EXIT, P.encodeExit(exitCode ?? 0)));
    });
    this.emit('sessionStarted', { pid: this._session.pid });
  }

  // ── Gelen çerçeveleri işle ──────────────────────────────────────────────────
  _onFrame(buf) {
    const { type, payload } = P.parseFrame(buf);
    switch (type) {
      case P.T.DATA:
        this._session?.write(payload.toString('utf8'));
        break;
      case P.T.RESIZE: {
        const { cols, rows } = P.decodeResize(payload);
        try { this._session?.resize(cols, rows); } catch (_) {}
        break;
      }
      case P.T.EXEC:
        this._runExec(payload.toString('utf8'));
        break;
      // Dosya: client → host push (alıcı)
      case P.T.FILE_META:  this._sink?.meta(payload);  break;
      case P.T.FILE_CHUNK: this._sink?.chunk(payload); break;
      case P.T.FILE_END:   this._sink?.end(payload);   break;
      // Dosya: host → client pull (gönderici); client bir yol istedi
      case P.T.FILE_REQ:   this._servePull(payload);   break;
      // Port yönlendirme (host = connector)
      case P.T.FWD_OPEN:   this._fwd?.open(payload);   break;
      case P.T.FWD_DATA:   this._fwd?.data(payload);   break;
      case P.T.FWD_CLOSE:  this._fwd?.close(payload);  break;
      default:
        // bilinmeyen tip — yoksay (ileri sürüm uyumluluğu)
        break;
    }
  }

  // Pull: client uzaktaki bir dosyayı istedi → oku ve geri gönder
  _servePull(payload) {
    const { id, remotePath } = P.decodeFileReq(payload);
    const send = (b) => this._peer?.send(b);
    sendFile(send, id, remotePath).catch(() => {}); // hata FILE_ERR olarak gitti
  }

  // ── Tek komut çalıştırma (ssh host cmd) ─────────────────────────────────────
  _runExec(command) {
    const { spawn } = require('child_process');
    const isWin = process.platform === 'win32';
    const sh    = isWin ? 'powershell.exe' : (process.env.SHELL || 'bash');
    const args  = isWin ? ['-NoProfile', '-Command', command] : ['-lc', command];
    let proc;
    try {
      proc = spawn(sh, args, { cwd: os.homedir(), env: process.env });
    } catch (err) {
      this._peer?.send(P.frame(P.T.DATA, Buffer.from(`exec hata: ${err.message}\r\n`)));
      this._peer?.send(P.frame(P.T.EXIT, P.encodeExit(127)));
      return;
    }
    proc.stdout.on('data', (d) => this._peer?.send(P.frame(P.T.DATA, d)));
    proc.stderr.on('data', (d) => this._peer?.send(P.frame(P.T.DATA, d)));
    proc.on('close', (code) => this._peer?.send(P.frame(P.T.EXIT, P.encodeExit(code ?? 0))));
    proc.on('error', (err) => {
      this._peer?.send(P.frame(P.T.DATA, Buffer.from(`exec hata: ${err.message}\r\n`)));
      this._peer?.send(P.frame(P.T.EXIT, P.encodeExit(127)));
    });
  }

  async _handleSignal(msg, rinfo) {
    try {
      if (msg.type === 'hello') {
        if (this._used || this._connected) return;
        this._clientAddr = `${rinfo.address}:${rinfo.port}`;
        if (!this._offer) this._offer = await this._peer.startAsHost();
        this._peer.sendSignal(rinfo.address, rinfo.port, { type: 'offer', sdp: this._offer.sdp, sdpType: this._offer.type });
      } else if (msg.type === 'answer') {
        if (this._used || this._answered) return;
        this._answered = true;
        this._peer.receiveAnswer({ type: msg.sdpType, sdp: msg.sdp });
      }
    } catch (err) {
      this.emit('error', err);
    }
  }

  _invalidateCode() {
    if (this._codeTimer) { clearInterval(this._codeTimer); this._codeTimer = null; }
    this._used = true;
  }

  stop() {
    this._invalidateCode();
    try { this._sessDispose?.dispose?.(); } catch (_) {}
    this._sessDispose = null;
    try { this._session?.kill(); } catch (_) {}
    this._session = null;
    this._sink?.destroy(); this._sink = null;
    this._fwd?.destroy();  this._fwd = null;
    this._peer?.close();
    this._peer = null;
    this._connected = false;
  }

  get isConnected() { return this._connected; }
  get code() { return this._codeData?.code ?? null; }
}

module.exports = { ZeroLinkHost };
