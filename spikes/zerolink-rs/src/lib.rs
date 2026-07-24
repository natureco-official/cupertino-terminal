use aes_gcm::aead::{AeadInOut, KeyInit, consts::U12};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use p256::ecdh::diffie_hellman;
use p256::elliptic_curve::sec1::ToSec1Point;
use p256::{PublicKey, SecretKey};
use sha2::Sha256;
use subtle::ConstantTimeEq;

const BASE32_ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const APP_HMAC_KEY_SOURCE: &[u8] = b"ZeroLink_v1_HMAC_AppKey_NotForEncryption_OnlyIntegrity_2024";

pub fn base32_encode(input: &[u8]) -> String {
    let mut output = String::with_capacity(input.len().div_ceil(5) * 8);
    let mut accumulator = 0_u32;
    let mut bits = 0_u8;

    for &byte in input {
        accumulator = (accumulator << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let index = ((accumulator >> bits) & 0x1f) as usize;
            output.push(BASE32_ALPHABET[index] as char);
        }
    }

    if bits > 0 {
        let index = ((accumulator << (5 - bits)) & 0x1f) as usize;
        output.push(BASE32_ALPHABET[index] as char);
    }
    output
}

pub fn compressed_public_key(private_key: &[u8]) -> anyhow::Result<Vec<u8>> {
    let secret = SecretKey::from_slice(private_key)?;
    Ok(secret.public_key().to_sec1_point(true).as_bytes().to_vec())
}

pub fn ecdh_shared_secret(
    private_key: &[u8],
    remote_public_key: &[u8],
) -> anyhow::Result<[u8; 32]> {
    let secret = SecretKey::from_slice(private_key)?;
    let public = PublicKey::from_sec1_bytes(remote_public_key)?;
    let shared = diffie_hellman(secret.to_nonzero_scalar(), public.as_affine());
    Ok(shared.raw_secret_bytes().to_owned().into())
}

pub fn derive_session_key(shared: &[u8]) -> anyhow::Result<[u8; 32]> {
    let salt = [0_u8; 32];
    let hkdf = Hkdf::<Sha256>::new(Some(&salt), shared);
    let mut output = [0_u8; 32];
    hkdf.expand(b"ZeroLink-v1-session", &mut output)
        .map_err(|_| anyhow::anyhow!("HKDF output length is invalid"))?;
    Ok(output)
}

pub fn hmac_sha256(key: &[u8], message: &[u8]) -> anyhow::Result<[u8; 32]> {
    let mut mac = <Hmac<Sha256> as hmac::KeyInit>::new_from_slice(key)?;
    mac.update(message);
    Ok(mac.finalize().into_bytes().into())
}

pub fn encode_zero_code(
    public_key: &[u8],
    pairing_key: &[u8],
    packed_addrs: &[u8],
    timestamp: u64,
) -> anyhow::Result<(Vec<u8>, Vec<u8>, String)> {
    anyhow::ensure!(public_key.len() == 33, "public key must be 33 bytes");
    anyhow::ensure!(pairing_key.len() == 16, "pairing key must be 16 bytes");

    let mut payload = Vec::with_capacity(2 + 8 + 33 + 16 + packed_addrs.len());
    payload.extend_from_slice(&0x5a4c_u16.to_be_bytes());
    payload.extend_from_slice(&timestamp.to_be_bytes());
    payload.extend_from_slice(public_key);
    payload.extend_from_slice(pairing_key);
    payload.extend_from_slice(packed_addrs);

    let full_hmac = hmac_sha256(&APP_HMAC_KEY_SOURCE[..32], &payload)?;
    let hmac16 = full_hmac[..16].to_vec();
    let mut bytes = payload.clone();
    bytes.extend_from_slice(&hmac16);
    let ungrouped = base32_encode(&bytes);
    let code = ungrouped
        .as_bytes()
        .chunks(4)
        .map(|chunk| std::str::from_utf8(chunk).expect("Base32 is ASCII"))
        .collect::<Vec<_>>()
        .join("-");
    Ok((payload, hmac16, code))
}

pub fn build_handshake(
    public_key: &[u8],
    pairing_key: &[u8],
    nonce: &[u8],
) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(public_key.len() == 33, "public key must be 33 bytes");
    anyhow::ensure!(pairing_key.len() == 16, "pairing key must be 16 bytes");
    anyhow::ensure!(nonce.len() == 16, "nonce must be 16 bytes");

    let mut packet = Vec::with_capacity(85);
    packet.extend_from_slice(b"ZLHS");
    packet.extend_from_slice(public_key);
    packet.extend_from_slice(nonce);
    let proof = hmac_sha256(pairing_key, &packet)?;
    packet.extend_from_slice(&proof);
    Ok(packet)
}

pub fn verify_handshake(packet: &[u8], pairing_key: &[u8]) -> bool {
    if packet.len() != 85 || pairing_key.len() != 16 || &packet[..4] != b"ZLHS" {
        return false;
    }
    let transcript = &packet[..53];
    let supplied_proof = &packet[53..];
    let Ok(expected_proof) = hmac_sha256(pairing_key, transcript) else {
        return false;
    };
    bool::from(supplied_proof.ct_eq(expected_proof.as_slice()))
}

pub fn encrypt_frame(
    key: &[u8],
    iv: &[u8],
    counter: u64,
    plaintext: &[u8],
) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(key.len() == 32, "AES-256 key must be 32 bytes");
    anyhow::ensure!(iv.len() == 12, "GCM IV must be 12 bytes");

    let aad = counter.to_be_bytes();
    let cipher = Aes256Gcm::new_from_slice(key)?;
    let nonce: &Nonce<U12> = iv
        .try_into()
        .map_err(|_| anyhow::anyhow!("GCM IV must be 12 bytes"))?;
    let mut ciphertext = plaintext.to_vec();
    let tag = cipher
        .encrypt_inout_detached(nonce, &aad, ciphertext.as_mut_slice().into())
        .map_err(|_| anyhow::anyhow!("AES-GCM encryption failed"))?;

    let mut frame = Vec::with_capacity(8 + 12 + 16 + ciphertext.len());
    frame.extend_from_slice(&aad);
    frame.extend_from_slice(iv);
    frame.extend_from_slice(tag.as_slice());
    frame.extend_from_slice(&ciphertext);
    Ok(frame)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Base32Vector {
        input_hex: String,
        encoded: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ZeroCodeVector {
        private_key_hex: String,
        public_key_hex: String,
        pairing_key_hex: String,
        timestamp: String,
        packed_addrs_hex: String,
        payload_hex: String,
        hmac16_hex: String,
        bytes_hex: String,
        code: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SessionKeyVector {
        private_key_a_hex: String,
        public_key_a_hex: String,
        private_key_b_hex: String,
        public_key_b_hex: String,
        shared_ato_b_hex: String,
        shared_bto_a_hex: String,
        salt_hex: String,
        info_hex: String,
        enc_key_ato_b_hex: String,
        enc_key_bto_a_hex: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct HandshakeVector {
        pairing_key_hex: String,
        public_key_hex: String,
        nonce_hex: String,
        transcript_hex: String,
        proof_hex: String,
        packet_hex: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct AesVector {
        key_hex: String,
        iv_hex: String,
        counter: String,
        counter_hex: String,
        plaintext_hex: String,
        aad_hex: String,
        ciphertext_hex: String,
        tag_hex: String,
        frame_hex: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vectors {
        schema: String,
        base32: Vec<Base32Vector>,
        zero_code: ZeroCodeVector,
        session_keys: SessionKeyVector,
        handshake: HandshakeVector,
        aes256_gcm: AesVector,
    }

    fn decode(value: &str) -> Vec<u8> {
        hex::decode(value).expect("fixture contains valid hex")
    }

    fn vectors() -> Vectors {
        serde_json::from_str(include_str!("../vectors.json")).expect("vectors.json is valid")
    }

    #[test]
    fn reproduces_every_js_golden_vector_byte_exact() -> anyhow::Result<()> {
        let vectors = vectors();
        assert_eq!(vectors.schema, "zerolink-js-rust-golden-v1");

        for vector in vectors.base32 {
            assert_eq!(base32_encode(&decode(&vector.input_hex)), vector.encoded);
        }

        let zero = vectors.zero_code;
        let private_key = decode(&zero.private_key_hex);
        let public_key = compressed_public_key(&private_key)?;
        assert_eq!(public_key, decode(&zero.public_key_hex));
        let pairing_key = decode(&zero.pairing_key_hex);
        let packed_addrs = decode(&zero.packed_addrs_hex);
        let timestamp = zero.timestamp.parse()?;
        let (payload, hmac16, code) =
            encode_zero_code(&public_key, &pairing_key, &packed_addrs, timestamp)?;
        assert_eq!(payload, decode(&zero.payload_hex));
        assert_eq!(hmac16, decode(&zero.hmac16_hex));
        let mut code_bytes = payload;
        code_bytes.extend_from_slice(&hmac16);
        assert_eq!(code_bytes, decode(&zero.bytes_hex));
        assert_eq!(code, zero.code);

        let session = vectors.session_keys;
        assert_eq!(session.salt_hex, "00".repeat(32));
        assert_eq!(decode(&session.info_hex), b"ZeroLink-v1-session");
        assert_eq!(
            compressed_public_key(&decode(&session.private_key_a_hex))?,
            decode(&session.public_key_a_hex)
        );
        assert_eq!(
            compressed_public_key(&decode(&session.private_key_b_hex))?,
            decode(&session.public_key_b_hex)
        );
        let shared_a = ecdh_shared_secret(
            &decode(&session.private_key_a_hex),
            &decode(&session.public_key_b_hex),
        )?;
        let shared_b = ecdh_shared_secret(
            &decode(&session.private_key_b_hex),
            &decode(&session.public_key_a_hex),
        )?;
        assert_eq!(shared_a, shared_b);
        assert_eq!(shared_a.as_slice(), decode(&session.shared_ato_b_hex));
        assert_eq!(shared_b.as_slice(), decode(&session.shared_bto_a_hex));
        let enc_a = derive_session_key(&shared_a)?;
        let enc_b = derive_session_key(&shared_b)?;
        assert_eq!(enc_a, enc_b);
        assert_eq!(enc_a.as_slice(), decode(&session.enc_key_ato_b_hex));
        assert_eq!(enc_b.as_slice(), decode(&session.enc_key_bto_a_hex));

        let handshake = vectors.handshake;
        let handshake_packet = build_handshake(
            &decode(&handshake.public_key_hex),
            &decode(&handshake.pairing_key_hex),
            &decode(&handshake.nonce_hex),
        )?;
        assert_eq!(&handshake_packet[..53], decode(&handshake.transcript_hex));
        assert_eq!(&handshake_packet[53..], decode(&handshake.proof_hex));
        assert_eq!(handshake_packet, decode(&handshake.packet_hex));
        assert!(verify_handshake(
            &handshake_packet,
            &decode(&handshake.pairing_key_hex)
        ));
        let wrong_pairing_key = [0xa5_u8; 16];
        assert!(!verify_handshake(&handshake_packet, &wrong_pairing_key));

        let aes = vectors.aes256_gcm;
        let counter: u64 = aes.counter.parse()?;
        assert_eq!(counter.to_be_bytes().as_slice(), decode(&aes.counter_hex));
        assert_eq!(decode(&aes.aad_hex), decode(&aes.counter_hex));
        let frame = encrypt_frame(
            &decode(&aes.key_hex),
            &decode(&aes.iv_hex),
            counter,
            &decode(&aes.plaintext_hex),
        )?;
        assert_eq!(&frame[20..36], decode(&aes.tag_hex));
        assert_eq!(&frame[36..], decode(&aes.ciphertext_hex));
        assert_eq!(frame, decode(&aes.frame_hex));

        Ok(())
    }
}
