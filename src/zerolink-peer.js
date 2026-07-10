/**
 * ZeroLink Peer Engine
 * ────────────────────
 * WebRTC DataChannel üzerinden P2P şifreli tünel kurar.
 * STUN sunucuları SADECE public IP/port keşfi için kullanılır —
 * hiçbir içerik STUN sunucusundan geçmez.
 *
 * Akış:
 *   1. Host sinyal soketini açar (UDP 47221), AYNI soketten STUN sorgusu yapar
 *      → public adres NAT eşlemesiyle birebir aynı olur (kritik!).
 *   2. Yerel + public adresler ZeroLink koduna gömülür (bant dışı paylaşım).
 *   3. Client koddaki adreslere UDP "hello" gönderir (retry'li) → host offer yollar.
 *   4. Offer/answer ICE adaylarıyla birlikte gider (non-trickle) → DTLS DataChannel.
 *   5. DataChannel üzerinde ZeroLink crypto katmanı (ECDH + AES-256-GCM).
 *
 * node-datachannel API notu: Bu kütüphane tarayıcı WebRTC API'sinden FARKLIDIR —
 * createOffer()/createAnswer() yok; createDataChannel veya setRemoteDescription
 * müzakereyi otomatik başlatır, sonuç onLocalDescription/localDescription()'dan alınır.
 */

'use strict';

const nodeDataChannel = require('node-datachannel');
const dgram           = require('dgram');
const EventEmitter    = require('events');
const crypto          = require('crypto');
const {
  generateKeyPair,
  deriveSessionKeys,
  encrypt,
  decrypt,
  buildHandshake,
  parseHandshake,
} = require('./zerolink-crypto');

// Ücretsiz STUN sunucuları — sadece adres keşfi, içerik geçmez
const STUN_SERVERS = [
  { host: 'stun.l.google.com',  port: 19302 },
  { host: 'stun1.l.google.com', port: 19302 },
  { host: 'stun.cloudflare.com', port: 3478 },
];

// Opsiyonel TURN sunucusu (simetrik NAT / kısıtlı ağlar için relay).
// İçerik TURN üzerinden geçse bile ZeroLink katmanı E2E şifreli olduğundan TURN
// operatörü içeriği GÖREMEZ (yalnızca şifreli baytları relay'ler).
// Ayar: main.js settings'ten setTurnConfig() ile ya da ortam değişkeninden:
//   ZEROLINK_TURN_URL=turn:host:3478  ZEROLINK_TURN_USER=...  ZEROLINK_TURN_CRED=...
let _turnConfig = null;
function setTurnConfig(cfg) {
  // cfg: { url, username, credential } | null
  _turnConfig = (cfg && cfg.url) ? cfg : null;
}
function _envTurn() {
  const url = process.env.ZEROLINK_TURN_URL;
  if (!url) return null;
  return { url, username: process.env.ZEROLINK_TURN_USER || '', credential: process.env.ZEROLINK_TURN_CRED || '' };
}

// node-datachannel iceServers listesini kur (STUN + varsa TURN)
function buildIceServers() {
  const list = STUN_SERVERS.map(s => `stun:${s.host}:${s.port}`);
  const turn = _turnConfig || _envTurn();
  if (turn) {
    // node-datachannel string biçimi: turn:user:pass@host:port
    const u = turn.url.replace(/^turns?:/i, '');
    const scheme = /^turns:/i.test(turn.url) ? 'turns' : 'turn';
    if (turn.username) list.push(`${scheme}:${encodeURIComponent(turn.username)}:${encodeURIComponent(turn.credential)}@${u}`);
    else list.push(`${scheme}:${u}`);
  }
  return list;
}

// UDP rendezvous sinyalleşme portu (host tarafı)
const SIGNAL_PORT = 47221;

// ── Minimal STUN client (RFC 5389 Binding Request) ───────────────────────────
// Mevcut soket üzerinden çalışır — böylece öğrenilen public port, bu soketin
// NAT eşlemesinin ta kendisidir. ('stun' npm paketi kendi soketini açtığından
// yanlış port öğrenirdik; bu yüzden elle yazıldı.)

function buildStunRequest() {
  const buf = Buffer.alloc(20);
  buf.writeUInt16BE(0x0001, 0);       // Binding Request
  buf.writeUInt16BE(0, 2);            // length: 0 (attribute yok)
  buf.writeUInt32BE(0x2112A442, 4);   // magic cookie
  crypto.randomBytes(12).copy(buf, 8); // transaction id
  return buf;
}

function parseStunResponse(msg) {
  if (msg.length < 20) return null;
  const type = msg.readUInt16BE(0);
  if (type !== 0x0101) return null;   // Binding Success Response değil
  const len = msg.readUInt16BE(2);
  let o = 20;
  const end = Math.min(20 + len, msg.length);
  while (o + 4 <= end) {
    const attrType = msg.readUInt16BE(o);
    const attrLen  = msg.readUInt16BE(o + 2);
    const v = o + 4;
    if (attrType === 0x0020 && attrLen >= 8) { // XOR-MAPPED-ADDRESS (IPv4)
      const port = msg.readUInt16BE(v + 2) ^ 0x2112;
      const ip = [
        msg[v + 4] ^ 0x21, msg[v + 5] ^ 0x12,
        msg[v + 6] ^ 0xA4, msg[v + 7] ^ 0x42,
      ].join('.');
      return `${ip}:${port}`;
    }
    if (attrType === 0x0001 && attrLen >= 8) { // MAPPED-ADDRESS (eski sunucular)
      const port = msg.readUInt16BE(v + 2);
      const ip = `${msg[v + 4]}.${msg[v + 5]}.${msg[v + 6]}.${msg[v + 7]}`;
      return `${ip}:${port}`;
    }
    o = v + attrLen + ((4 - (attrLen % 4)) % 4); // 4 byte hizalama
  }
  return null;
}

/**
 * Verilen soket üzerinden public adresi öğren (ilk yanıt kazanır).
 * Soketin mevcut 'message' dinleyicilerine dokunmaz; STUN yanıtı sinyal
 * dinleyicisinde JSON.parse'a takılmadan burada yakalanır.
 * @param {dgram.Socket} socket - bind edilmiş UDP soketi
 * @returns {Promise<string>} "IP:PORT"
 */
function discoverPublicAddress(socket, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const onMessage = (msg) => {
      const addr = parseStunResponse(msg);
      if (addr && !done) {
        done = true;
        clearTimeout(timer);
        socket.removeListener('message', onMessage);
        resolve(addr);
      }
    };
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        socket.removeListener('message', onMessage);
        reject(new Error('STUN zaman aşımı — internet bağlantısını kontrol edin'));
      }
    }, timeoutMs);

    socket.on('message', onMessage);
    for (const srv of STUN_SERVERS) {
      try { socket.send(buildStunRequest(), srv.port, srv.host); } catch (_) {}
    }
  });
}

/** Yerel (LAN) IPv4 adresleri. */
function getLocalAddresses() {
  const { networkInterfaces } = require('os');
  const out = [];
  for (const iface of Object.values(networkInterfaces())) {
    for (const addr of iface || []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

/**
 * ZeroLinkPeer — hem host hem client için kullanılır.
 *
 * Events:
 *   'connected'          — Şifreli tünel hazır, veri gönderilebilir
 *   'data'   (Buffer)    — Karşı taraftan PTY verisi geldi (çözülmüş)
 *   'disconnected'       — Bağlantı kapandı
 *   'error'  (Error)     — Hata
 */
class ZeroLinkPeer extends EventEmitter {
  constructor() {
    super();
    this._pc          = null;   // node-datachannel PeerConnection
    this._dc          = null;   // DataChannel
    this._encKey      = null;   // AES-256-GCM anahtarı
    this._sendCounter = 0n;     // monotonic şifreleme sayacı
    this._recvCounter = 0n;     // beklenen minimum alıcı sayacı
    this._keyPair     = null;   // ECDH { ecdh, publicKey }
    this._addrs       = [];     // paylaşılacak adresler (yerel + public)
    this._signalSocket = null;  // UDP sinyalleşme soketi
    this._signalPort   = 0;     // gerçekte bağlanılan port
    this._hsSent       = false; // handshake gönderildi mi (idempotent)
    this._closed       = false;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Sinyal soketini aç, (istenirse) STUN ile public adres öğren, ECDH hazırla.
   * @param {object} opts
   * @param {number}  opts.bindPort - 0 = rastgele (client), SIGNAL_PORT = host
   * @param {boolean} opts.discover - STUN keşfi yapılsın mı (host: true)
   * @returns {Promise<{ publicKey: Buffer, addrs: string[] }>}
   */
  async prepare({ bindPort = 0, discover = false } = {}) {
    this._keyPair = generateKeyPair();

    await this._bindSignalSocket(bindPort);
    const port = this._signalPort;

    // Yerel adresler her zaman kodda yer alır (aynı ağ senaryosu)
    this._addrs = getLocalAddresses().map(ip => `${ip}:${port}`);

    if (discover) {
      try {
        const pub = await discoverPublicAddress(this._signalSocket);
        if (!this._addrs.includes(pub)) this._addrs.push(pub);
      } catch (_) {
        // STUN başarısız → yerel adreslerle devam (aynı ağ çalışır)
      }
    }
    if (this._addrs.length === 0) this._addrs = [`127.0.0.1:${port}`];

    return { publicKey: this._keyPair.publicKey, addrs: this._addrs };
  }

  /**
   * HOST tarafı: DataChannel oluştur → offer üret (ICE adayları SDP içinde).
   * @returns {Promise<{ type: string, sdp: string }>}
   */
  async startAsHost() {
    this._initPeerConnection();
    // node-datachannel varsayilani: sirali + guvenilir (unordered:false, retransmit yok).
    // Terminal akisi icin tam istedigimiz bu → ek reliability config vermiyoruz.
    this._dc = this._pc.createDataChannel('zerolink');
    this._setupDataChannel(this._dc);

    await this._waitForIceGathering();
    return this._pc.localDescription(); // { type: 'offer', sdp } — adaylar içinde
  }

  /**
   * CLIENT tarafı: Host'un offer'ını al, answer üret.
   * @param {{ type: string, sdp: string }} offer
   * @returns {Promise<{ type: string, sdp: string }>}
   */
  async answerOffer(offer) {
    this._initPeerConnection();

    this._pc.onDataChannel((dc) => {
      this._dc = dc;
      this._setupDataChannel(dc);
    });

    // setRemoteDescription(sdp, type) müzakereyi başlatır; answer otomatik üretilir
    this._pc.setRemoteDescription(offer.sdp, offer.type);

    await this._waitForIceGathering();
    return this._pc.localDescription(); // { type: 'answer', sdp }
  }

  /**
   * Karşı tarafın answer'ını ayarla (host kullanır).
   */
  receiveAnswer(answer) {
    this._pc.setRemoteDescription(answer.sdp, answer.type);
  }

  /**
   * DataChannel üzerinden şifreli veri gönder.
   * @param {Buffer|string} data
   */
  send(data) {
    if (!this._dc || !this._encKey) return;
    try {
      const buf     = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      const counter = this._sendCounter++;
      this._dc.sendMessageBinary(encrypt(this._encKey, buf, counter));
    } catch (err) {
      this.emit('error', err);
    }
  }

  /**
   * Bağlantıyı kapat.
   */
  close() {
    this._closed = true;
    try { this._dc?.close(); } catch (_) {}
    try { this._pc?.close(); } catch (_) {}
    try { this._signalSocket?.close(); } catch (_) {}
    this._dc = null;
    this._pc = null;
    this._signalSocket = null;
  }

  get localPublicKey() { return this._keyPair?.publicKey ?? null; }
  get addrs()          { return this._addrs; }
  get signalPort()     { return this._signalPort; }

  // ── Sinyalleşme (UDP rendezvous) ────────────────────────────────────────────

  /**
   * Gelen JSON sinyal paketlerini dinle (hello/offer/answer).
   * STUN yanıtları JSON olmadığından sessizce atlanır.
   */
  onSignal(onMessage) {
    this._signalSocket.on('message', (msg, rinfo) => {
      let json;
      try { json = JSON.parse(msg.toString('utf8')); } catch (_) { return; }
      if (json && typeof json.type === 'string') onMessage(json, rinfo);
    });
  }

  sendSignal(addr, port, payload) {
    if (!this._signalSocket) return;
    try {
      const buf = Buffer.from(JSON.stringify(payload), 'utf8');
      this._signalSocket.send(buf, port, addr);
    } catch (_) {}
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _bindSignalSocket(port) {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      const onBindError = (err) => {
        // Sabit port doluysa (aynı makinede 2. kopya) rastgele porta düş
        if (port !== 0 && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
          sock.removeListener('error', onBindError);
          try { sock.close(); } catch (_) {}
          this._bindSignalSocket(0).then(resolve, reject);
        } else {
          reject(err);
        }
      };
      sock.once('error', onBindError);
      sock.bind(port, () => {
        sock.removeListener('error', onBindError);
        sock.on('error', (err) => this.emit('error', err));
        this._signalSocket = sock;
        this._signalPort   = sock.address().port;
        resolve();
      });
    });
  }

  _initPeerConnection() {
    this._pc = new nodeDataChannel.PeerConnection('ZeroLink', {
      iceServers: buildIceServers(),
    });

    this._pc.onStateChange((state) => {
      if (this._closed) return;
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.emit('disconnected');
      }
    });
  }

  _setupDataChannel(dc) {
    const sendHandshakeOnce = () => {
      if (this._hsSent) return;
      this._hsSent = true;
      try { dc.sendMessageBinary(buildHandshake(this._keyPair.publicKey)); } catch (_) {}
      // Not: handshake şifresiz gider — içeriği zaten public key
    };

    dc.onOpen(sendHandshakeOnce);
    // onDataChannel ile gelen kanal ÇOKTAN AÇIK olabilir → onOpen hiç ateşlenmez
    try { if (dc.isOpen()) sendHandshakeOnce(); } catch (_) {}

    dc.onMessage((msg) => {
      const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);

      // Henüz anahtar türetilmediyse handshake paketi bekliyoruz
      if (!this._encKey) {
        try {
          const { publicKey } = parseHandshake(buf);
          const { encKey } = deriveSessionKeys(this._keyPair.ecdh, publicKey);
          this._encKey = encKey;
          sendHandshakeOnce(); // karşı taraf bizimkini almadıysa (onOpen kaçtıysa)
          this.emit('connected');
        } catch (err) {
          this.emit('error', new Error(`Handshake başarısız: ${err.message}`));
        }
        return;
      }

      // Şifreli PTY verisi
      try {
        const { plaintext, counter } = decrypt(this._encKey, buf, this._recvCounter);
        this._recvCounter = counter + 1n;
        this.emit('data', plaintext);
      } catch (err) {
        this.emit('error', new Error(`Şifre çözme hatası: ${err.message}`));
      }
    });

    dc.onClosed(() => { if (!this._closed) this.emit('disconnected'); });
    dc.onError((err) => this.emit('error', new Error(String(err))));
  }

  _waitForIceGathering(timeoutMs = 5000) {
    return new Promise((resolve) => {
      try {
        if (this._pc.gatheringState() === 'complete') return resolve();
      } catch (_) {}
      let settled = false;
      const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
      const timer = setTimeout(finish, timeoutMs); // STUN yanıtsız kalsa da devam
      this._pc.onGatheringStateChange((state) => {
        if (state === 'complete') finish();
      });
    });
  }
}

module.exports = { ZeroLinkPeer, discoverPublicAddress, getLocalAddresses, setTurnConfig, SIGNAL_PORT };
