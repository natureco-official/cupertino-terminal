'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { ZeroLinkPeer } = require('../src/zerolink-peer');
const {
  generateKeyPair, generatePairingKey, encrypt, decrypt,
  encodeZeroCode, decodeZeroCode, buildHandshake, parseHandshake,
} = require('../src/zerolink-crypto');

test('ZeroLink peer pins the remote public key supplied by the out-of-band code', () => {
  const peer = new ZeroLinkPeer();
  const key = generateKeyPair().publicKey;
  peer.expectRemotePublicKey(key);
  assert.deepEqual(peer._expectedRemotePublicKey, key);
  assert.throws(() => peer.expectRemotePublicKey(Buffer.alloc(12)), /public key/);
});

test('ZeroLink peer rejects a malformed pairing key', () => {
  const peer = new ZeroLinkPeer();
  assert.throws(() => peer.setPairingKey(Buffer.alloc(4)), /eşleştirme anahtarı/);
});

test('ZeroLink code round-trips the pairing key alongside the public key', () => {
  const { publicKey } = generateKeyPair();
  const pairingKey = generatePairingKey();
  const code = encodeZeroCode({ publicKey, pairingKey, addrs: ['192.168.1.5:47221'], timestamp: Date.now() });
  const decoded = decodeZeroCode(code);
  assert.deepEqual(decoded.publicKey, publicKey);
  assert.deepEqual(decoded.pairingKey, pairingKey);
});

test('ZeroLink handshake succeeds only when both sides share the same pairing key', () => {
  const { publicKey } = generateKeyPair();
  const pairingKey = generatePairingKey();
  const packet = buildHandshake(publicKey, pairingKey);
  const parsed = parseHandshake(packet, pairingKey);
  assert.deepEqual(parsed.publicKey, publicKey);
});

test('ZeroLink handshake is rejected end-to-end when the connecting party never received the code', () => {
  // Regression test for a critical bug: the host used to accept ANY WebRTC
  // DataChannel connection and start a live shell regardless of whether the
  // connecting party ever possessed the ZeroLink code (signaling alone
  // provided no authentication). An attacker who completes standard WebRTC
  // negotiation (no code needed for that step) but supplies the wrong — or
  // no — pairing key must never be treated as authenticated.
  const { publicKey } = generateKeyPair();
  const realPairingKey = generatePairingKey();
  const attackerGuess = generatePairingKey(); // attacker never saw the real code
  const packet = buildHandshake(publicKey, realPairingKey);
  assert.throws(() => parseHandshake(packet, attackerGuess), /Eşleştirme kanıtı geçersiz/);
});

test('ZeroLink handshake rejects a packet built without any pairing key (pre-fix wire format)', () => {
  const { publicKey } = generateKeyPair();
  const pairingKey = generatePairingKey();
  assert.throws(() => buildHandshake(publicKey), /eşleştirme anahtarı/);
  // A shorter, legacy-shaped packet (magic+pubkey+nonce, no proof) must be rejected as malformed,
  // not silently accepted as if the proof check were optional.
  const legacyShaped = Buffer.concat([Buffer.from('ZLHS', 'ascii'), publicKey, crypto.randomBytes(16)]);
  assert.throws(() => parseHandshake(legacyShaped, pairingKey), /Handshake paketi geçersiz/);
});

test('ZeroLink replay protection rejects a previously consumed packet', () => {
  const key = crypto.randomBytes(32);
  const packet = encrypt(key, Buffer.from('terminal-data'), 0n);
  assert.equal(decrypt(key, packet, 0n).plaintext.toString(), 'terminal-data');
  assert.throws(() => decrypt(key, packet, 1n), /Replay/);
});

test('ZeroLink ordered channel rejects skipped counters and malformed code characters', () => {
  const key = crypto.randomBytes(32);
  const future = encrypt(key, Buffer.from('future'), 2n);
  assert.throws(() => decrypt(key, future, 0n), /sıra bozulması/);
  const { decodeZeroCode } = require('../src/zerolink-crypto');
  assert.throws(() => decodeZeroCode('AAAA-!!!!'), /Base32/);
});
