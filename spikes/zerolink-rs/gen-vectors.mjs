import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const B32_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const APP_HMAC_KEY = Buffer.from(
  'ZeroLink_v1_HMAC_AppKey_NotForEncryption_OnlyIntegrity_2024',
  'utf8',
).subarray(0, 32);

function hex(value) {
  return Buffer.from(value).toString('hex');
}

// Kept byte-for-byte equivalent to the original JavaScript implementation.
function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let output = '';
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

function ecdhFromPrivate(privateKey) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(privateKey);
  return ecdh;
}

const privateKeyA = Buffer.from(
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  'hex',
);
const privateKeyB = Buffer.from(
  '1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100',
  'hex',
);
const ecdhA = ecdhFromPrivate(privateKeyA);
const ecdhB = ecdhFromPrivate(privateKeyB);
const publicKeyA = ecdhA.getPublicKey(null, 'compressed');
const publicKeyB = ecdhB.getPublicKey(null, 'compressed');

const pairingKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const addrs = ['192.168.1.5:47221'];
const timestamp = 1_735_689_600_123;
const version = Buffer.alloc(2);
version.writeUInt16BE(0x5a4c);
const timestampBytes = Buffer.alloc(8);
timestampBytes.writeBigUInt64BE(BigInt(timestamp));
const packedAddrs = Buffer.from([1, 192, 168, 1, 5, 0xb8, 0x75]);
const zeroCodePayload = Buffer.concat([
  version,
  timestampBytes,
  publicKeyA,
  pairingKey,
  packedAddrs,
]);
const zeroCodeHmac16 = crypto
  .createHmac('sha256', APP_HMAC_KEY)
  .update(zeroCodePayload)
  .digest()
  .subarray(0, 16);
const zeroCodeBytes = Buffer.concat([zeroCodePayload, zeroCodeHmac16]);
const zeroCode = base32Encode(zeroCodeBytes).match(/.{1,4}/g).join('-');

const sharedAtoB = ecdhA.computeSecret(publicKeyB);
const sharedBtoA = ecdhB.computeSecret(publicKeyA);
const hkdfInfo = Buffer.from('ZeroLink-v1-session', 'utf8');
const hkdfSalt = Buffer.alloc(32);
const encKeyAtoB = Buffer.from(crypto.hkdfSync('sha256', sharedAtoB, hkdfSalt, hkdfInfo, 32));
const encKeyBtoA = Buffer.from(crypto.hkdfSync('sha256', sharedBtoA, hkdfSalt, hkdfInfo, 32));
if (!sharedAtoB.equals(sharedBtoA) || !encKeyAtoB.equals(encKeyBtoA)) {
  throw new Error('fixed-key ECDH agreement failed');
}

const nonce = Buffer.from('f0e0d0c0b0a090807060504030201000', 'hex');
const transcript = Buffer.concat([Buffer.from('ZLHS', 'ascii'), publicKeyA, nonce]);
const proof = crypto.createHmac('sha256', pairingKey).update(transcript).digest();
const handshakePacket = Buffer.concat([transcript, proof]);

const aesKey = Buffer.from(
  '603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4',
  'hex',
);
const iv = Buffer.from('cafebabefacedbaddecaf888', 'hex');
const counter = 0x0102030405060708n;
const counterBytes = Buffer.alloc(8);
counterBytes.writeBigUInt64BE(counter);
const plaintext = Buffer.from('ZeroLink binary frame \u0000\u00ff', 'latin1');
const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv, { authTagLength: 16 });
cipher.setAAD(counterBytes);
const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const tag = cipher.getAuthTag();
const frame = Buffer.concat([counterBytes, iv, tag, ciphertext]);

const vectors = {
  schema: 'zerolink-js-rust-golden-v1',
  base32: [
    { inputHex: '', encoded: '' },
    { inputHex: '66', encoded: base32Encode(Buffer.from('66', 'hex')) },
    { inputHex: '666f6f', encoded: base32Encode(Buffer.from('666f6f', 'hex')) },
    { inputHex: '00010203fefeff', encoded: base32Encode(Buffer.from('00010203fefeff', 'hex')) },
  ],
  zeroCode: {
    privateKeyHex: hex(privateKeyA),
    publicKeyHex: hex(publicKeyA),
    pairingKeyHex: hex(pairingKey),
    addrs,
    timestamp: timestamp.toString(),
    packedAddrsHex: hex(packedAddrs),
    payloadHex: hex(zeroCodePayload),
    hmac16Hex: hex(zeroCodeHmac16),
    bytesHex: hex(zeroCodeBytes),
    code: zeroCode,
  },
  sessionKeys: {
    privateKeyAHex: hex(privateKeyA),
    publicKeyAHex: hex(publicKeyA),
    privateKeyBHex: hex(privateKeyB),
    publicKeyBHex: hex(publicKeyB),
    sharedAtoBHex: hex(sharedAtoB),
    sharedBtoAHex: hex(sharedBtoA),
    saltHex: hex(Buffer.alloc(32)),
    infoHex: hex(Buffer.from('ZeroLink-v1-session', 'utf8')),
    encKeyAtoBHex: hex(encKeyAtoB),
    encKeyBtoAHex: hex(encKeyBtoA),
  },
  handshake: {
    pairingKeyHex: hex(pairingKey),
    publicKeyHex: hex(publicKeyA),
    nonceHex: hex(nonce),
    transcriptHex: hex(transcript),
    proofHex: hex(proof),
    packetHex: hex(handshakePacket),
  },
  aes256Gcm: {
    keyHex: hex(aesKey),
    ivHex: hex(iv),
    counter: counter.toString(),
    counterHex: hex(counterBytes),
    plaintextHex: hex(plaintext),
    aadHex: hex(counterBytes),
    ciphertextHex: hex(ciphertext),
    tagHex: hex(tag),
    frameHex: hex(frame),
  },
};

const outputPath = path.join(HERE, 'vectors.json');
fs.writeFileSync(outputPath, `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`wrote ${path.relative(process.cwd(), outputPath)} (${zeroCodeBytes.length} ZeroCode bytes)`);
