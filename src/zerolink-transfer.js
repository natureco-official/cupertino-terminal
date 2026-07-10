/**
 * ZeroLink Transfer — dosya alımı/gönderimi + port yönlendirme akış yönetimi
 * ─────────────────────────────────────────────────────────────────────────
 * Hem host hem client aynı mantığı kullanır (dosya iki yönde de akabilir; port
 * yönlendirmede data/close her iki yönde ortak). Tek yerde tutulur → tek testle
 * her iki taraf da doğrulanır.
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const net  = require('net');
const P    = require('./zerolink-proto');

const CHUNK = 16 * 1024;
const DOWNLOAD_DIR = () => path.join(os.homedir(), 'ZeroLink-Downloads');

// ── Gelen dosyaları diske yazan alıcı ────────────────────────────────────────
class FileSink {
  /** @param {function} send çerçeve gönderici  @param {function} onDone ({name,dest,bytes}) */
  constructor(send, onDone) {
    this._send = send;
    this._onDone = onDone;
    this._files = new Map(); // id → { ws, name, dest, size, received }
  }

  meta(payload) {
    const { id, size, name } = P.decodeFileMeta(payload);
    // Yol geçişi (path traversal) koruması: sadece dosya adı, güvenli klasöre
    const safe = path.basename(name).replace(/[\\/:*?"<>|]/g, '_') || `zerolink-${id}`;
    const dest = path.join(DOWNLOAD_DIR(), safe);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      this._files.set(id, { ws: fs.createWriteStream(dest), name: safe, dest, size, received: 0 });
    } catch (err) {
      this._send(P.frame(P.T.FILE_ERR, Buffer.concat([P.encodeU32(id), Buffer.from(err.message, 'utf8')])));
    }
  }

  chunk(payload) {
    const { id, data } = P.decodeFileChunk(payload);
    const f = this._files.get(id);
    if (!f) return;
    f.ws.write(data);
    f.received += data.length;
  }

  end(payload) {
    const id = P.decodeU32(payload);
    const f = this._files.get(id);
    if (!f) return;
    this._files.delete(id);
    f.ws.end(() => {
      this._send(P.frame(P.T.FILE_ACK, Buffer.concat([P.encodeU32(id), P.encodeU32(f.received)])));
      this._onDone?.({ name: f.name, dest: f.dest, bytes: f.received });
    });
  }

  destroy() {
    for (const f of this._files.values()) { try { f.ws.destroy(); } catch (_) {} }
    this._files.clear();
  }
}

/**
 * Bir dosyayı okuyup FILE_META/CHUNK/END olarak gönderir (push ya da pull yanıtı).
 * @returns {Promise<{id,name,size}>}
 */
function sendFile(send, id, filePath, onProgress) {
  return new Promise((resolve, reject) => {
    let stat;
    try { stat = fs.statSync(filePath); }
    catch (err) {
      send(P.frame(P.T.FILE_ERR, Buffer.concat([P.encodeU32(id), Buffer.from(err.message, 'utf8')])));
      return reject(err);
    }
    const name = path.basename(filePath);
    send(P.frame(P.T.FILE_META, P.encodeFileMeta({ id, size: stat.size, name })));
    const rs = fs.createReadStream(filePath, { highWaterMark: CHUNK });
    let sent = 0;
    rs.on('data', (chunk) => {
      send(P.frame(P.T.FILE_CHUNK, P.encodeFileChunk(id, chunk)));
      sent += chunk.length;
      onProgress?.({ name, sent, size: stat.size });
    });
    rs.on('end', () => { send(P.frame(P.T.FILE_END, P.encodeU32(id))); resolve({ id, name, size: stat.size }); });
    rs.on('error', (err) => {
      send(P.frame(P.T.FILE_ERR, Buffer.concat([P.encodeU32(id), Buffer.from(err.message, 'utf8')])));
      reject(err);
    });
  });
}

/**
 * Port yönlendirme akış merkezi.
 * - Host tarafı: FWD_OPEN gelince hedefe TCP bağlanır (connector).
 * - Client tarafı: yerel TCP dinleyici soketlerini register() ile kaydeder.
 * - Her iki tarafta FWD_DATA/FWD_CLOSE aynı şekilde işlenir.
 */
class ForwardHub {
  constructor(send) {
    this._send = send;
    this._streams = new Map(); // streamId → net.Socket
  }

  // Host: hedefe bağlan (gelen FWD_OPEN)
  open(payload) {
    const { streamId, target } = P.decodeFwdOpen(payload);
    const idx = target.lastIndexOf(':');
    const host = target.slice(0, idx);
    const port = parseInt(target.slice(idx + 1), 10);
    const sock = net.connect({ host, port });
    this._streams.set(streamId, sock);
    sock.on('data',  (d) => this._send(P.frame(P.T.FWD_DATA, P.encodeFwdData(streamId, d))));
    sock.on('close', ()  => { this._send(P.frame(P.T.FWD_CLOSE, P.encodeU32(streamId))); this._streams.delete(streamId); });
    sock.on('error', ()  => { this._send(P.frame(P.T.FWD_CLOSE, P.encodeU32(streamId))); this._streams.delete(streamId); });
  }

  // Client: yerel soketi kaydet (dinleyici kabul edince)
  register(streamId, sock) { this._streams.set(streamId, sock); }
  unregister(streamId)     { this._streams.delete(streamId); }

  // Gelen FWD_DATA → ilgili sokete yaz (her iki yön)
  data(payload) {
    const { streamId, data } = P.decodeFwdData(payload);
    const sock = this._streams.get(streamId);
    if (sock) { try { sock.write(data); } catch (_) {} }
  }

  // Gelen FWD_CLOSE → soketi kapat
  close(payload) {
    const streamId = P.decodeU32(payload);
    const sock = this._streams.get(streamId);
    if (sock) { try { sock.end(); } catch (_) {} this._streams.delete(streamId); }
  }

  destroy() {
    for (const s of this._streams.values()) { try { s.destroy(); } catch (_) {} }
    this._streams.clear();
  }
}

module.exports = { FileSink, sendFile, ForwardHub, DOWNLOAD_DIR };
