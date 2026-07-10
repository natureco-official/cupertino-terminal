/**
 * ZeroLink Protokol Çerçeveleme (framing / mux)
 * ─────────────────────────────────────────────
 * Şifreli tünel ham byte taşır; bu katman o byte'lara bir "tip" başlığı ekleyerek
 * tek tünelde farklı kanalları (interaktif kabuk, resize, komut, dosya, port) ayırır.
 * SSH'ın kanal çoğullamasının minimal hâli.
 *
 * Çerçeve (şifrelemeden ÖNCE):  [ type:1 | payload... ]
 * Peer katmanı bu çerçeveyi olduğu gibi şifreler/çözer; host & client burada
 * tanımlı tiplere göre yorumlar.
 */
'use strict';

// ── Mesaj tipleri ─────────────────────────────────────────────────────────────
const T = {
  DATA:    0x01,  // PTY stdin/stdout byte'ları (her iki yön)
  RESIZE:  0x02,  // client→host: terminal boyutu (cols,rows)
  EXEC:    0x03,  // client→host: tek komut çalıştır (interaktif oturum açmadan)
  EXIT:    0x04,  // host→client: oturum/komut çıkış kodu

  // Dosya transferi (scp benzeri)
  FILE_META:  0x10, // başlık: id + boyut + mod + isim  (gönderen→alan)
  FILE_CHUNK: 0x11, // id + veri parçası
  FILE_END:   0x12, // id (tüm parçalar gönderildi)
  FILE_ACK:   0x13, // id + alınan bayt (akış kontrolü / tamamlandı)
  FILE_ERR:   0x14, // id + hata mesajı
  FILE_REQ:   0x15, // pull: alan taraf bir yol ister (client→host)

  // Port yönlendirme (ssh -L benzeri)
  FWD_OPEN:  0x20, // streamId + hedef host:port
  FWD_DATA:  0x21, // streamId + veri
  FWD_CLOSE: 0x22, // streamId
};

// ── Çerçeve oluştur / ayrıştır ────────────────────────────────────────────────
function frame(type, payload) {
  const body = payload == null
    ? Buffer.alloc(0)
    : (Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8'));
  return Buffer.concat([Buffer.from([type]), body]);
}

function parseFrame(buf) {
  if (!buf || buf.length < 1) return { type: 0, payload: Buffer.alloc(0) };
  return { type: buf[0], payload: buf.subarray(1) };
}

// ── RESIZE payload ────────────────────────────────────────────────────────────
function encodeResize(cols, rows) {
  const b = Buffer.alloc(4);
  b.writeUInt16BE(Math.max(1, Math.min(65535, cols | 0)), 0);
  b.writeUInt16BE(Math.max(1, Math.min(65535, rows | 0)), 2);
  return b;
}
function decodeResize(p) {
  return { cols: p.readUInt16BE(0), rows: p.readUInt16BE(2) };
}

// ── EXIT payload ──────────────────────────────────────────────────────────────
function encodeExit(code) {
  const b = Buffer.alloc(4);
  b.writeInt32BE((code | 0), 0);
  return b;
}
function decodeExit(p) {
  return p.length >= 4 ? p.readInt32BE(0) : 0;
}

// ── Dosya: META payload ───────────────────────────────────────────────────────
// [ id:4 | size:8 | nameLen:2 | name:utf8 ]
function encodeFileMeta({ id, size, name }) {
  const nameBuf = Buffer.from(name, 'utf8');
  const b = Buffer.alloc(4 + 8 + 2 + nameBuf.length);
  b.writeUInt32BE(id >>> 0, 0);
  b.writeBigUInt64BE(BigInt(size), 4);
  b.writeUInt16BE(nameBuf.length, 12);
  nameBuf.copy(b, 14);
  return b;
}
function decodeFileMeta(p) {
  const id      = p.readUInt32BE(0);
  const size    = Number(p.readBigUInt64BE(4));
  const nameLen = p.readUInt16BE(12);
  const name    = p.subarray(14, 14 + nameLen).toString('utf8');
  return { id, size, name };
}

// ── Dosya: CHUNK payload ──────────────────────────────────────────────────────
// [ id:4 | data... ]
function encodeFileChunk(id, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(id >>> 0, 0);
  return Buffer.concat([head, data]);
}
function decodeFileChunk(p) {
  return { id: p.readUInt32BE(0), data: p.subarray(4) };
}

// id:4 (FILE_END / FILE_ACK / FILE_ERR / FWD_CLOSE ortak baş)
function encodeU32(id) { const b = Buffer.alloc(4); b.writeUInt32BE(id >>> 0, 0); return b; }
function decodeU32(p)  { return p.readUInt32BE(0); }

// ── FILE_REQ (pull): [ id:4 | path:utf8 ] ─────────────────────────────────────
function encodeFileReq(id, remotePath) {
  return Buffer.concat([encodeU32(id), Buffer.from(remotePath, 'utf8')]);
}
function decodeFileReq(p) {
  return { id: p.readUInt32BE(0), remotePath: p.subarray(4).toString('utf8') };
}

// ── FILE_ACK: [ id:4 | received:4 ] ───────────────────────────────────────────
function decodeFileAck(p) {
  return { id: p.readUInt32BE(0), received: p.length >= 8 ? p.readUInt32BE(4) : 0 };
}

// ── Port yönlendirme ──────────────────────────────────────────────────────────
// FWD_OPEN:  [ streamId:4 | "host:port":utf8 ]
function encodeFwdOpen(streamId, target) {
  return Buffer.concat([encodeU32(streamId), Buffer.from(target, 'utf8')]);
}
function decodeFwdOpen(p) {
  return { streamId: p.readUInt32BE(0), target: p.subarray(4).toString('utf8') };
}
// FWD_DATA:  [ streamId:4 | data... ]
function encodeFwdData(streamId, data) {
  return Buffer.concat([encodeU32(streamId), data]);
}
function decodeFwdData(p) {
  return { streamId: p.readUInt32BE(0), data: p.subarray(4) };
}
// FWD_CLOSE: [ streamId:4 ]  → encodeU32/decodeU32

module.exports = {
  T, frame, parseFrame,
  encodeResize, decodeResize,
  encodeExit, decodeExit,
  encodeFileMeta, decodeFileMeta,
  encodeFileChunk, decodeFileChunk,
  encodeFileReq, decodeFileReq, decodeFileAck,
  encodeFwdOpen, decodeFwdOpen,
  encodeFwdData, decodeFwdData,
  encodeU32, decodeU32,
};
