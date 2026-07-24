use aes_gcm::aead::{consts::U12, AeadInOut, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{ensure, Context};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use p256::ecdh::diffie_hellman;
use p256::elliptic_curve::sec1::ToSec1Point;
use p256::{PublicKey, SecretKey};
use sha2::Sha256;
use subtle::ConstantTimeEq;

pub const CODE_TTL_MS: u64 = 5 * 60 * 1000;
const APP_HMAC_KEY_SOURCE: &[u8] = b"ZeroLink_v1_HMAC_AppKey_NotForEncryption_OnlyIntegrity_2024";
const BASE32_ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

#[derive(Clone)]
pub struct KeyPair {
    secret: SecretKey,
    pub public: [u8; 33],
}

#[derive(Clone, Debug)]
pub struct DecodedCode {
    pub public_key: [u8; 33],
    pub pairing_key: [u8; 16],
    pub addrs: Vec<String>,
}

pub struct CipherState {
    key: [u8; 32],
    send_counter: u64,
    recv_counter: u64,
}

pub fn generate_key_pair() -> KeyPair {
    loop {
        let bytes = rand::random::<[u8; 32]>();
        if let Ok(secret) = SecretKey::from_slice(&bytes) {
            let mut public = [0_u8; 33];
            public.copy_from_slice(secret.public_key().to_sec1_point(true).as_bytes());
            return KeyPair { secret, public };
        }
    }
}

#[cfg(test)]
pub fn key_pair_from_private(bytes: &[u8]) -> anyhow::Result<KeyPair> {
    let secret = SecretKey::from_slice(bytes)?;
    let mut public = [0_u8; 33];
    public.copy_from_slice(secret.public_key().to_sec1_point(true).as_bytes());
    Ok(KeyPair { secret, public })
}

pub fn generate_pairing_key() -> [u8; 16] {
    rand::random()
}

pub fn base32_encode(input: &[u8]) -> String {
    let mut output = String::with_capacity(input.len().div_ceil(5) * 8);
    let mut accumulator = 0_u32;
    let mut bits = 0_u8;
    for &byte in input {
        accumulator = (accumulator << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            output.push(BASE32_ALPHABET[((accumulator >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        output.push(BASE32_ALPHABET[((accumulator << (5 - bits)) & 0x1f) as usize] as char);
    }
    output
}

fn base32_decode(value: &str) -> anyhow::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut accumulator = 0_u32;
    let mut bits = 0_u8;
    for byte in value
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace() && *byte != b'-')
    {
        let upper = byte.to_ascii_uppercase();
        let index = BASE32_ALPHABET
            .iter()
            .position(|candidate| *candidate == upper)
            .context("invalid Base32 character")? as u32;
        accumulator = (accumulator << 5) | index;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            output.push(((accumulator >> bits) & 0xff) as u8);
        }
    }
    Ok(output)
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> anyhow::Result<[u8; 32]> {
    let mut mac = <Hmac<Sha256> as hmac::KeyInit>::new_from_slice(key)?;
    mac.update(message);
    Ok(mac.finalize().into_bytes().into())
}

pub fn derive_session_key(pair: &KeyPair, remote_public_key: &[u8]) -> anyhow::Result<[u8; 32]> {
    let public = PublicKey::from_sec1_bytes(remote_public_key)?;
    let shared = diffie_hellman(pair.secret.to_nonzero_scalar(), public.as_affine());
    let hkdf = Hkdf::<Sha256>::new(Some(&[0_u8; 32]), shared.raw_secret_bytes());
    let mut key = [0_u8; 32];
    hkdf.expand(b"ZeroLink-v1-session", &mut key)
        .map_err(|_| anyhow::anyhow!("invalid HKDF output length"))?;
    Ok(key)
}

pub fn pack_addrs(addrs: &[String]) -> anyhow::Result<Vec<u8>> {
    let list = addrs.iter().take(4).collect::<Vec<_>>();
    let mut output = Vec::with_capacity(1 + list.len() * 6);
    output.push(list.len() as u8);
    for addr in list {
        let (ip, port) = addr.rsplit_once(':').context("invalid address")?;
        let ip: std::net::Ipv4Addr = ip.parse().context("invalid IPv4 address")?;
        let port: u16 = port.parse().context("invalid port")?;
        ensure!(port > 0, "invalid port");
        output.extend_from_slice(&ip.octets());
        output.extend_from_slice(&port.to_be_bytes());
    }
    Ok(output)
}

pub fn encode_zero_code(
    public_key: &[u8],
    pairing_key: &[u8],
    addrs: &[String],
    timestamp: u64,
) -> anyhow::Result<String> {
    ensure!(public_key.len() == 33, "public key must be 33 bytes");
    ensure!(pairing_key.len() == 16, "pairing key must be 16 bytes");
    let mut payload = Vec::new();
    payload.extend_from_slice(&0x5a4c_u16.to_be_bytes());
    payload.extend_from_slice(&timestamp.to_be_bytes());
    payload.extend_from_slice(public_key);
    payload.extend_from_slice(pairing_key);
    payload.extend_from_slice(&pack_addrs(addrs)?);
    let hmac = hmac_sha256(&APP_HMAC_KEY_SOURCE[..32], &payload)?;
    payload.extend_from_slice(&hmac[..16]);
    Ok(base32_encode(&payload)
        .as_bytes()
        .chunks(4)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or_default())
        .collect::<Vec<_>>()
        .join("-"))
}

pub fn decode_zero_code(code: &str, now_ms: u64) -> anyhow::Result<DecodedCode> {
    let bytes = base32_decode(code)?;
    const HEAD: usize = 2 + 8 + 33 + 16;
    ensure!(bytes.len() >= HEAD + 1 + 16, "code is too short");
    ensure!(
        u16::from_be_bytes([bytes[0], bytes[1]]) == 0x5a4c,
        "invalid ZeroLink code"
    );
    let timestamp = u64::from_be_bytes(bytes[2..10].try_into()?);
    let count = usize::from(bytes[HEAD]);
    ensure!(count <= 4, "invalid address count");
    let end = HEAD + 1 + count * 6;
    ensure!(bytes.len() == end + 16, "invalid ZeroLink code length");
    let expected = hmac_sha256(&APP_HMAC_KEY_SOURCE[..32], &bytes[..end])?;
    ensure!(
        bool::from(bytes[end..].ct_eq(&expected[..16])),
        "invalid ZeroLink code signature"
    );
    ensure!(
        now_ms.saturating_sub(timestamp) <= CODE_TTL_MS,
        "code expired (5 minutes)"
    );
    ensure!(
        timestamp <= now_ms.saturating_add(30_000),
        "invalid code timestamp"
    );
    let mut public_key = [0_u8; 33];
    public_key.copy_from_slice(&bytes[10..43]);
    let mut pairing_key = [0_u8; 16];
    pairing_key.copy_from_slice(&bytes[43..59]);
    let mut addrs = Vec::with_capacity(count);
    for chunk in bytes[60..end].chunks_exact(6) {
        let ip = std::net::Ipv4Addr::new(chunk[0], chunk[1], chunk[2], chunk[3]);
        let port = u16::from_be_bytes([chunk[4], chunk[5]]);
        ensure!(port > 0, "invalid address port");
        addrs.push(format!("{ip}:{port}"));
    }
    Ok(DecodedCode {
        public_key,
        pairing_key,
        addrs,
    })
}

pub fn build_handshake(
    public_key: &[u8],
    pairing_key: &[u8],
    nonce: &[u8],
) -> anyhow::Result<Vec<u8>> {
    ensure!(public_key.len() == 33, "public key must be 33 bytes");
    ensure!(pairing_key.len() == 16, "pairing key must be 16 bytes");
    ensure!(nonce.len() == 16, "nonce must be 16 bytes");
    let mut packet = Vec::with_capacity(85);
    packet.extend_from_slice(b"ZLHS");
    packet.extend_from_slice(public_key);
    packet.extend_from_slice(nonce);
    packet.extend_from_slice(&hmac_sha256(pairing_key, &packet)?);
    Ok(packet)
}

pub fn verify_handshake(
    packet: &[u8],
    pairing_key: &[u8],
    expected_public_key: Option<&[u8]>,
) -> anyhow::Result<[u8; 33]> {
    ensure!(
        packet.len() == 85 && &packet[..4] == b"ZLHS",
        "invalid handshake packet"
    );
    ensure!(pairing_key.len() == 16, "invalid pairing key");
    let expected = hmac_sha256(pairing_key, &packet[..53])?;
    ensure!(
        bool::from(packet[53..].ct_eq(expected.as_slice())),
        "invalid pairing proof"
    );
    if let Some(pinned) = expected_public_key {
        ensure!(
            pinned.len() == 33 && bool::from(packet[4..37].ct_eq(pinned)),
            "remote public key does not match code"
        );
    }
    let mut public = [0_u8; 33];
    public.copy_from_slice(&packet[4..37]);
    Ok(public)
}

impl CipherState {
    pub fn new(key: [u8; 32]) -> Self {
        Self {
            key,
            send_counter: 0,
            recv_counter: 0,
        }
    }

    pub fn encrypt(&mut self, plaintext: &[u8]) -> anyhow::Result<Vec<u8>> {
        let counter = self.send_counter;
        self.send_counter = self
            .send_counter
            .checked_add(1)
            .context("send counter exhausted")?;
        encrypt_frame(&self.key, &rand::random::<[u8; 12]>(), counter, plaintext)
    }

    pub fn decrypt(&mut self, packet: &[u8]) -> anyhow::Result<Vec<u8>> {
        ensure!(packet.len() >= 36, "encrypted packet is too short");
        let counter = u64::from_be_bytes(packet[..8].try_into()?);
        ensure!(counter == self.recv_counter, "replay or reordered packet");
        let cipher = Aes256Gcm::new_from_slice(&self.key)?;
        let nonce: &Nonce<U12> = (&packet[8..20])
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid IV"))?;
        let mut plaintext = packet[36..].to_vec();
        cipher
            .decrypt_inout_detached(
                nonce,
                &packet[..8],
                plaintext.as_mut_slice().into(),
                (&packet[20..36])
                    .try_into()
                    .map_err(|_| anyhow::anyhow!("invalid tag"))?,
            )
            .map_err(|_| anyhow::anyhow!("AES-GCM authentication failed"))?;
        self.recv_counter += 1;
        Ok(plaintext)
    }
}

pub fn encrypt_frame(
    key: &[u8],
    iv: &[u8],
    counter: u64,
    plaintext: &[u8],
) -> anyhow::Result<Vec<u8>> {
    ensure!(key.len() == 32 && iv.len() == 12, "invalid AES key or IV");
    let cipher = Aes256Gcm::new_from_slice(key)?;
    let nonce: &Nonce<U12> = iv.try_into().map_err(|_| anyhow::anyhow!("invalid IV"))?;
    let aad = counter.to_be_bytes();
    let mut ciphertext = plaintext.to_vec();
    let tag = cipher
        .encrypt_inout_detached(nonce, &aad, ciphertext.as_mut_slice().into())
        .map_err(|_| anyhow::anyhow!("AES-GCM encryption failed"))?;
    let mut frame = Vec::with_capacity(36 + ciphertext.len());
    frame.extend_from_slice(&aad);
    frame.extend_from_slice(iv);
    frame.extend_from_slice(tag.as_slice());
    frame.extend_from_slice(&ciphertext);
    Ok(frame)
}
