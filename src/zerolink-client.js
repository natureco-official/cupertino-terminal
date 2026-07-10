/**
 * ZeroLink Client — SSH benzeri oturum istemcisi
 * ──────────────────────────────────────────────
 * Kodu çözer, host'a bağlanır, uzak PTY oturumunu alır. Host TAZE bir kabuk açar;
 * istemci kendi temiz uzak oturumunu görür (host'un ekranını DEĞİL).
 *
 * API:
 *   connect(code)             — bağlan
 *   sendInput(data)           — klavye girişi → uzak PTY (DATA)
 *   sendResize(cols,rows)     — terminal boyutunu bildir (RESIZE / SIGWINCH)
 *   exec(cmd)                 — tek komut çalıştır (interaktif oturum yerine)
 *   pushFile(localPath)       — dosya gönder (host ~/ZeroLink-Downloads'a yazar)
 *   pullFile(remotePath)      — uzaktan dosya indir (~/ZeroLink-Downloads'a)
 *   addForward(lp, rh, rp)    — yerel portu (lp) uzak rh:rp'ye yönlendir (ssh -L)
 *   removeForward(lp)         — yönlendirmeyi kaldır
 *
 * Events:
 *   'connected'  'data' (Buffer)  'remoteExit' (code)
 *   'fileProgress' ({name,sent,size})  'fileDone' ({name,dest,bytes})  'fileError'
 *   'forwardOpen' ({localPort})  'forwardError' ({localPort,message})
 *   'disconnected'  'error' (Error)
 */

'use strict';

const net  = require('net');
const path = require('path');
const EventEmitter = require('events');
const { ZeroLinkPeer } = require('./zerolink-peer');
const { decodeZeroCode } = require('./zerolink-crypto');
const P = require('./zerolink-proto');
const { FileSink, sendFile, ForwardHub } = require('./zerolink-transfer');

const HELLO_INTERVAL_MS  = 1500;
const CONNECT_TIMEOUT_MS = 30000;

class ZeroLinkClient extends EventEmitter {
  constructor() {
    super();
    this._peer = null;
    this._connected = false;
    this._helloTimer = null;
    this._connectTimeout = null;
    this._offerHandled = false;

    this._sink = null;                 // gelen dosyalar (pull yanıtları)
    this._fwd  = null;                  // port yönlendirme akış merkezi
    this._servers = new Map();          // localPort → net.Server
    this._seq = 1;                      // dosya + stream id sayacı (ortak, benzersiz)
  }

  async connect(code) {
    let decoded;
    try { decoded = decodeZeroCode(code); }
    catch (err) { throw new Error(`Geçersiz ZeroLink kodu: ${err.message}`); }

    const hostAddrs = decoded.addrs
      .map((a) => { const i = a.lastIndexOf(':'); return { ip: a.slice(0, i), port: parseInt(a.slice(i + 1), 10) }; })
      .filter((a) => a.ip && a.port > 0);
    if (hostAddrs.length === 0) throw new Error('Kodda geçerli adres yok');

    this._peer = new ZeroLinkPeer();
    await this._peer.prepare({ bindPort: 0, discover: false });

    this._peer.onSignal((msg, rinfo) => this._handleSignal(msg, rinfo));

    this._peer.on('connected', () => {
      this._connected = true;
      this._clearTimers();
      const send = (buf) => this._peer?.send(buf);
      this._sink = new FileSink(send, (info) => this.emit('fileDone', info));
      this._fwd  = new ForwardHub(send);
      this.emit('connected');
    });

    this._peer.on('data', (buf) => this._onFrame(buf));

    this._peer.on('disconnected', () => {
      const was = this._connected;
      this._connected = false;
      this.stop();
      if (was) this.emit('disconnected');
    });

    this._peer.on('error', (err) => this.emit('error', err));

    const sendHellos = () => { for (const { ip, port } of hostAddrs) this._peer?.sendSignal(ip, port, { type: 'hello' }); };
    sendHellos();
    this._helloTimer = setInterval(() => { if (!this._offerHandled) sendHellos(); }, HELLO_INTERVAL_MS);

    this._connectTimeout = setTimeout(() => {
      if (!this._connected) { this.stop(); this.emit('error', new Error('Bağlantı zaman aşımı — host çevrimiçi mi?')); }
    }, CONNECT_TIMEOUT_MS);
  }

  // ── Gelen çerçeveler ────────────────────────────────────────────────────────
  _onFrame(buf) {
    const { type, payload } = P.parseFrame(buf);
    switch (type) {
      case P.T.DATA:       this.emit('data', payload); break;
      case P.T.EXIT:       this.emit('remoteExit', P.decodeExit(payload)); break;
      // Dosya: uzaktan indirme (pull) yanıtı → diske yaz
      case P.T.FILE_META:  this._sink?.meta(payload);  break;
      case P.T.FILE_CHUNK: this._sink?.chunk(payload); break;
      case P.T.FILE_END:   this._sink?.end(payload);   break;
      case P.T.FILE_ACK: { const { id, received } = P.decodeFileAck(payload); this.emit('fileDone', { id, bytes: received }); break; }
      case P.T.FILE_ERR:   this.emit('fileError', { message: payload.subarray(4).toString('utf8') }); break;
      // Port yönlendirme dönüş trafiği
      case P.T.FWD_DATA:   this._fwd?.data(payload);  break;
      case P.T.FWD_CLOSE:  this._fwd?.close(payload); break;
      default: break;
    }
  }

  // ── Oturum gönderim API'si ──────────────────────────────────────────────────
  sendInput(data) {
    if (!this._connected || !this._peer) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    this._peer.send(P.frame(P.T.DATA, buf));
  }

  sendResize(cols, rows) {
    if (!this._connected || !this._peer) return;
    this._peer.send(P.frame(P.T.RESIZE, P.encodeResize(cols, rows)));
  }

  exec(command) {
    if (!this._connected || !this._peer) return;
    this._peer.send(P.frame(P.T.EXEC, Buffer.from(command, 'utf8')));
  }

  send(data) { this.sendInput(data); } // geriye dönük uyumluluk

  // ── Dosya gönder (client → host) ────────────────────────────────────────────
  pushFile(localPath) {
    if (!this._connected || !this._peer) throw new Error('Bağlı değil');
    const id = this._seq++;
    const send = (b) => this._peer?.send(b);
    sendFile(send, id, localPath, (pr) => this.emit('fileProgress', pr))
      .catch((err) => this.emit('fileError', { message: err.message }));
    return { id, name: path.basename(localPath) };
  }

  // ── Dosya indir (host → client) ─────────────────────────────────────────────
  pullFile(remotePath) {
    if (!this._connected || !this._peer) throw new Error('Bağlı değil');
    const id = this._seq++;
    this._peer.send(P.frame(P.T.FILE_REQ, P.encodeFileReq(id, remotePath)));
    return { id, name: path.basename(remotePath) };
  }

  // ── Port yönlendirme: yerel portu uzak host:port'a bağla (ssh -L) ───────────
  addForward(localPort, remoteHost, remotePort) {
    if (!this._connected || !this._peer) throw new Error('Bağlı değil');
    if (this._servers.has(localPort)) throw new Error(`Yerel port ${localPort} zaten yönlendiriliyor`);

    const target = `${remoteHost}:${remotePort}`;
    const server = net.createServer((sock) => {
      const streamId = this._seq++;
      this._fwd?.register(streamId, sock);
      this._peer?.send(P.frame(P.T.FWD_OPEN, P.encodeFwdOpen(streamId, target)));
      sock.on('data',  (d) => this._peer?.send(P.frame(P.T.FWD_DATA, P.encodeFwdData(streamId, d))));
      sock.on('close', ()  => { this._peer?.send(P.frame(P.T.FWD_CLOSE, P.encodeU32(streamId))); this._fwd?.unregister(streamId); });
      sock.on('error', ()  => { try { sock.destroy(); } catch (_) {} });
    });
    server.on('error', (err) => {
      this._servers.delete(localPort);
      this.emit('forwardError', { localPort, message: err.message });
    });
    server.listen(localPort, '127.0.0.1', () => {
      this._servers.set(localPort, server);
      this.emit('forwardOpen', { localPort, target });
    });
    return { localPort, target };
  }

  removeForward(localPort) {
    const server = this._servers.get(localPort);
    if (server) { try { server.close(); } catch (_) {} this._servers.delete(localPort); }
  }

  listForwards() {
    return [...this._servers.keys()];
  }

  _handleSignal(msg, rinfo) {
    (async () => {
      try {
        if (msg.type === 'offer' && !this._offerHandled) {
          this._offerHandled = true;
          const answer = await this._peer.answerOffer({ type: msg.sdpType, sdp: msg.sdp });
          this._peer.sendSignal(rinfo.address, rinfo.port, { type: 'answer', sdpType: answer.type, sdp: answer.sdp });
        }
      } catch (err) { this.emit('error', err); }
    })();
  }

  _clearTimers() {
    if (this._helloTimer)     { clearInterval(this._helloTimer);   this._helloTimer = null; }
    if (this._connectTimeout) { clearTimeout(this._connectTimeout); this._connectTimeout = null; }
  }

  stop() {
    this._clearTimers();
    for (const s of this._servers.values()) { try { s.close(); } catch (_) {} }
    this._servers.clear();
    this._sink?.destroy(); this._sink = null;
    this._fwd?.destroy();  this._fwd = null;
    this._peer?.close();
    this._peer = null;
    this._connected = false;
  }

  get isConnected() { return this._connected; }
}

module.exports = { ZeroLinkClient };
