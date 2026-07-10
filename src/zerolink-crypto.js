/**
 * ZeroLink Crypto Engine
 * ──────────────────────
 * Tüm şifreleme / imzalama / kod üretme işlemleri burada.
 * Dışarıya hiçbir zaman ham anahtar çıkmaz; sadece şifreli paketler ve kodlar.
 *
 * Protokol özeti:
 *   1. Her oturum için ECDH P-256 anahtar çifti üretilir (forward secrecy).
 *   2. Host: publicKey (33B compressed) + adres listesi + timestamp
 *      → HMAC-SHA256 (16B'ye kısaltılmış) ile imzalanır → Base32 → ZeroLink kodu.
 *   3. Client kodu çözer, ECDH ile ortak sır türetir, AES-256-GCM tüneli açar.
 *   4. Her mesaj: counter(8) + IV(12) + AuthTag(16) + Ciphertext — replay koruması
 *      için 64-bit monotonic sayaç (kanal ordered+reliable → sıkı artan).
 *   5. Kod tek kullanımlık + 5 dakika TTL.
 */

'use strict';

const crypto = require('crypto');

// ── Sabitler ──────────────────────────────────────────────────────────────────
const CODE_TTL_MS   = 5 * 60 * 1000;   // Kodun geçerlilik süresi: 5 dakika
const CODE_VERSION  = 0x5A4C;          // 'ZL' magic — sahte kod tespiti için
const HMAC_KEY_SIZE = 32;
const CODE_HMAC_LEN = 16;              // kod imzası 16 byte'a kısaltılır (kod kısalsın)
const GCM_TAG_LEN   = 16;
const GCM_IV_LEN    = 12;
const PUBKEY_LEN    = 33;              // P-256 compressed point

// Uygulama genelinde sabit HMAC imzalama anahtarı (sadece kod bütünlüğü için;
// oturum şifreleme anahtarından bağımsız — ikisi hiçbir zaman karışmaz).
// ⚠ Anahtar sızsa bile oturum içeriği çözülemez (AES anahtarı ECDH ephemeral).
const APP_HMAC_KEY = Buffer.from(
  'ZeroLink_v1_HMAC_AppKey_NotForEncryption_OnlyIntegrity_2024',
  'utf8'
).subarray(0, HMAC_KEY_SIZE);

// ── Base32 (RFC 4648, padding yok) ────────────────────────────────────────────
const B32_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += B32_ALPHA[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) output += B32_ALPHA[(value << (5 - bits)) & 0x1f];
  return output;
}

function base32Decode(str) {
  const s = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const output = [];
  for (const c of s) {
    const idx = B32_ALPHA.indexOf(c);
    if (idx < 0) throw new Error('Geçersiz Base32 karakter');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

// ── ECDH Anahtar Çifti ────────────────────────────────────────────────────────

/**
 * Yeni bir oturum anahtar çifti üretir.
 * @returns {{ ecdh: ECDH, publicKey: Buffer }} publicKey: 33 byte compressed point
 */
function generateKeyPair() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    ecdh,                                          // deriveSecret için saklanır
    publicKey: ecdh.getPublicKey(null, 'compressed'), // 33 byte, karşı tarafa gider
  };
}

/**
 * ECDH shared secret → HKDF-SHA256 ile oturum anahtarı türetir.
 * @returns {{ encKey: Buffer }} 32 byte AES-256-GCM anahtarı
 */
function deriveSessionKeys(ecdh, remotePubKey) {
  const shared = ecdh.computeSecret(remotePubKey);
  const info   = Buffer.from('ZeroLink-v1-session', 'utf8');
  const salt   = Buffer.alloc(32, 0); // sabit tuz (protokol standardı)
  const encKey = Buffer.from(crypto.hkdfSync('sha256', shared, salt, info, 32));
  return { encKey };
}

// ── AES-256-GCM Şifreleme ─────────────────────────────────────────────────────

/**
 * Bir PTY veri parçasını şifreler.
 * @param {Buffer} key        - 32 byte AES anahtarı
 * @param {Buffer} plaintext  - Ham PTY verisi
 * @param {bigint} counter    - Monotonic sayaç (replay koruması)
 * @returns {Buffer}  [ counter:8 | iv:12 | tag:16 | ciphertext ]
 */
function encrypt(key, plaintext, counter) {
  const iv = crypto.randomBytes(GCM_IV_LEN);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_LEN });
  // Sayaç AAD olarak bağlanır: pakette açık taşınır ama tag'e dahildir →
  // saldırgan sayacı değiştiremez (XOR hilesine gerek yok).
  cipher.setAAD(counterBuf);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([counterBuf, iv, tag, ct]);
}

/**
 * Şifreli paketi çözer.
 * @param {Buffer} key     - 32 byte AES anahtarı
 * @param {Buffer} packet  - encrypt() çıktısı
 * @param {bigint} expectedCounter - Beklenen minimum sayaç (replay kontrolü)
 * @returns {{ plaintext: Buffer, counter: bigint }}
 */
function decrypt(key, packet, expectedCounter) {
  if (packet.length < 8 + GCM_IV_LEN + GCM_TAG_LEN) throw new Error('Paket çok kısa');

  const counterBuf = packet.subarray(0, 8);
  const iv         = packet.subarray(8, 8 + GCM_IV_LEN);
  const tag        = packet.subarray(8 + GCM_IV_LEN, 8 + GCM_IV_LEN + GCM_TAG_LEN);
  const ct         = packet.subarray(8 + GCM_IV_LEN + GCM_TAG_LEN);

  const counter = counterBuf.readBigUInt64BE();
  if (counter < expectedCounter) throw new Error('Replay saldırısı tespit edildi');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_LEN });
  decipher.setAAD(counterBuf);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);

  return { plaintext, counter };
}

// ── Adres paketleme (IPv4 binary — kod kısalığı için) ─────────────────────────
// Format: count(1) + [ ip(4) | port(2) ] * count
function packAddrs(addrs) {
  const list = (addrs || []).filter(Boolean).slice(0, 4);
  const bufs = [Buffer.from([list.length])];
  for (const a of list) {
    const [ip, portStr] = a.split(':');
    const parts = ip.split('.').map(n => parseInt(n, 10));
    const port  = parseInt(portStr, 10);
    if (parts.length !== 4 || parts.some(n => isNaN(n) || n < 0 || n > 255) || !(port > 0 && port < 65536)) {
      throw new Error(`Geçersiz adres: ${a}`);
    }
    const b = Buffer.alloc(6);
    b[0] = parts[0]; b[1] = parts[1]; b[2] = parts[2]; b[3] = parts[3];
    b.writeUInt16BE(port, 4);
    bufs.push(b);
  }
  return Buffer.concat(bufs);
}

function unpackAddrs(buf, offset) {
  const count = buf.readUInt8(offset);
  const addrs = [];
  let o = offset + 1;
  for (let i = 0; i < count; i++) {
    const ip   = `${buf[o]}.${buf[o + 1]}.${buf[o + 2]}.${buf[o + 3]}`;
    const port = buf.readUInt16BE(o + 4);
    addrs.push(`${ip}:${port}`);
    o += 6;
  }
  return { addrs, end: o };
}

// ── ZeroLink Kod Formatı ──────────────────────────────────────────────────────
/**
 * Kod yapısı (binary):
 *   [0-1]   version   : uint16 = 0x5A4C ('ZL')
 *   [2-9]   timestamp : uint64 (ms, Unix)
 *   [10-42] publicKey : 33 byte ECDH compressed point
 *   [43..]  addrs     : count(1) + [ip4(4)+port(2)]*count  (yerel + public)
 *   [son 16] hmac     : HMAC-SHA256(payload)[0..16]
 *
 * Örn. 2 adres: 2+8+33+13+16 = 72 byte → Base32 ≈ 116 karakter (4'lü gruplar).
 */
function encodeZeroCode({ publicKey, addrs, timestamp }) {
  if (!publicKey || publicKey.length !== PUBKEY_LEN) throw new Error('Geçersiz public key');
  const ts = BigInt(timestamp ?? Date.now());

  const version = Buffer.alloc(2);
  version.writeUInt16BE(CODE_VERSION);

  const tsBuf = Buffer.alloc(8);
  tsBuf.writeBigUInt64BE(ts);

  const payload = Buffer.concat([version, tsBuf, publicKey, packAddrs(addrs)]);

  const hmac = crypto.createHmac('sha256', APP_HMAC_KEY).update(payload).digest().subarray(0, CODE_HMAC_LEN);
  const b32  = base32Encode(Buffer.concat([payload, hmac]));

  return b32.match(/.{1,4}/g).join('-');
}

function decodeZeroCode(code) {
  const raw = code.replace(/[-\s]/g, '');
  const buf = base32Decode(raw);

  if (buf.length < 2 + 8 + PUBKEY_LEN + 1 + CODE_HMAC_LEN) throw new Error('Kod çok kısa');

  const version = buf.readUInt16BE(0);
  if (version !== CODE_VERSION) throw new Error('Geçersiz ZeroLink kodu');

  const ts        = buf.readBigUInt64BE(2);
  const publicKey = buf.subarray(10, 10 + PUBKEY_LEN);
  const { addrs, end } = unpackAddrs(buf, 10 + PUBKEY_LEN);
  if (buf.length < end + CODE_HMAC_LEN) throw new Error('Kod eksik');

  const payload = buf.subarray(0, end);
  const hmac    = buf.subarray(end, end + CODE_HMAC_LEN);

  const expectedHmac = crypto.createHmac('sha256', APP_HMAC_KEY).update(payload).digest().subarray(0, CODE_HMAC_LEN);
  if (!crypto.timingSafeEqual(hmac, expectedHmac)) throw new Error('Kod imzası geçersiz — sahte veya bozuk kod');

  const now = BigInt(Date.now());
  const age = now - ts;
  if (age > BigInt(CODE_TTL_MS)) throw new Error('Kod süresi dolmuş (5 dakika)');
  if (age < -30000n) throw new Error('Kod zamanı geçersiz (sistem saati sorunu?)');

  return {
    publicKey: Buffer.from(publicKey),
    addrs,
    timestamp: Number(ts),
  };
}

// ── Handshake Paketi ──────────────────────────────────────────────────────────
/**
 * DataChannel açılınca public key değişimi.
 * Format: [ 'ZLHS' magic(4) | publicKey(33) | nonce(16) ]
 */
function buildHandshake(publicKey) {
  const magic = Buffer.from('ZLHS', 'ascii');
  const nonce = crypto.randomBytes(16);
  return Buffer.concat([magic, publicKey, nonce]);
}

function parseHandshake(buf) {
  if (buf.length < 4 + PUBKEY_LEN + 16) throw new Error('Handshake paketi geçersiz');
  const magic = buf.subarray(0, 4).toString('ascii');
  if (magic !== 'ZLHS') throw new Error('Handshake magic geçersiz');
  const publicKey = Buffer.from(buf.subarray(4, 4 + PUBKEY_LEN));
  const nonce     = buf.subarray(4 + PUBKEY_LEN, 4 + PUBKEY_LEN + 16);
  return { publicKey, nonce };
}

// ── Kod Görüntüleme Yardımcıları ─────────────────────────────────────────────
function formatCodeDisplay(code) {
  const clean = code.replace(/[-\s]/g, '');
  return clean.match(/.{1,4}/g)?.join('-') ?? code;
}

function codeTimeLeft(timestamp) {
  const left = CODE_TTL_MS - (Date.now() - timestamp);
  return Math.max(0, Math.floor(left / 1000));
}

module.exports = {
  generateKeyPair,
  deriveSessionKeys,
  encrypt,
  decrypt,
  encodeZeroCode,
  decodeZeroCode,
  buildHandshake,
  parseHandshake,
  formatCodeDisplay,
  codeTimeLeft,
  CODE_TTL_MS,
};
