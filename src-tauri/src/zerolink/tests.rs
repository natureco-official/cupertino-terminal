use super::{crypto, peer::Peer, peer::PeerEvent, proto, transfer};
use crate::pty::{ExitSink, OutputSink, PtyState};
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::timeout;

fn bytes(vector: &Value, key: &str) -> Vec<u8> {
    hex::decode(vector[key].as_str().expect("golden field must be a string"))
        .expect("golden hex must be valid")
}

#[test]
fn crypto_golden_vectors_are_byte_exact_with_javascript() -> anyhow::Result<()> {
    let vectors: Value = serde_json::from_str(include_str!("vectors.json"))?;
    assert_eq!(vectors["schema"], "zerolink-js-rust-golden-v1");
    for vector in vectors["base32"].as_array().expect("base32 vectors") {
        assert_eq!(
            crypto::base32_encode(&bytes(vector, "inputHex")),
            vector["encoded"].as_str().expect("encoded string")
        );
    }

    let zero = &vectors["zeroCode"];
    let pair = crypto::key_pair_from_private(&bytes(zero, "privateKeyHex"))?;
    assert_eq!(pair.public.as_slice(), bytes(zero, "publicKeyHex"));
    let packed = bytes(zero, "packedAddrsHex");
    let addrs = packed[1..]
        .chunks_exact(6)
        .map(|chunk| {
            format!(
                "{}.{}.{}.{}:{}",
                chunk[0],
                chunk[1],
                chunk[2],
                chunk[3],
                u16::from_be_bytes([chunk[4], chunk[5]])
            )
        })
        .collect::<Vec<_>>();
    let code = crypto::encode_zero_code(
        &pair.public,
        &bytes(zero, "pairingKeyHex"),
        &addrs,
        zero["timestamp"].as_str().expect("timestamp").parse()?,
    )?;
    assert_eq!(code, zero["code"].as_str().expect("code"));

    let session = &vectors["sessionKeys"];
    let pair_a = crypto::key_pair_from_private(&bytes(session, "privateKeyAHex"))?;
    let pair_b = crypto::key_pair_from_private(&bytes(session, "privateKeyBHex"))?;
    let key_a = crypto::derive_session_key(&pair_a, &pair_b.public)?;
    let key_b = crypto::derive_session_key(&pair_b, &pair_a.public)?;
    assert_eq!(key_a, key_b);
    assert_eq!(key_a.as_slice(), bytes(session, "encKeyAtoBHex"));

    let handshake = &vectors["handshake"];
    let packet = crypto::build_handshake(
        &bytes(handshake, "publicKeyHex"),
        &bytes(handshake, "pairingKeyHex"),
        &bytes(handshake, "nonceHex"),
    )?;
    assert_eq!(packet, bytes(handshake, "packetHex"));
    crypto::verify_handshake(
        &packet,
        &bytes(handshake, "pairingKeyHex"),
        Some(&bytes(handshake, "publicKeyHex")),
    )?;

    let aes = &vectors["aes256Gcm"];
    let frame = crypto::encrypt_frame(
        &bytes(aes, "keyHex"),
        &bytes(aes, "ivHex"),
        aes["counter"].as_str().expect("counter").parse()?,
        &bytes(aes, "plaintextHex"),
    )?;
    assert_eq!(frame, bytes(aes, "frameHex"));
    Ok(())
}

struct TestOutput {
    sender: mpsc::UnboundedSender<Vec<u8>>,
}

impl OutputSink for TestOutput {
    fn send(&self, bytes: Vec<u8>) -> Result<(), ()> {
        self.sender
            .send(proto::frame(proto::DATA, bytes))
            .map_err(|_| ())
    }

    fn auto_acknowledge(&self) -> bool {
        true
    }
}

struct TestExit;

impl ExitSink for TestExit {
    fn send(&self, _code: i32) {}
}

async fn connected_peers(
    host_pairing: [u8; 16],
    client_pairing: [u8; 16],
) -> anyhow::Result<(
    Peer,
    mpsc::UnboundedReceiver<PeerEvent>,
    Peer,
    mpsc::UnboundedReceiver<PeerEvent>,
)> {
    let host_pair = crypto::generate_key_pair();
    let host_public = host_pair.public;
    let client_pair = crypto::generate_key_pair();
    let (host, host_events) = Peer::new(host_pair, host_pairing, None).await?;
    let (client, client_events) = Peer::new(client_pair, client_pairing, Some(host_public)).await?;
    let offer = host.make_offer().await?;
    let answer = client.answer_offer(&offer.sdp).await?;
    host.accept_answer(&answer.sdp).await?;
    Ok((host, host_events, client, client_events))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn in_process_full_session_real_pty_resize_and_file_round_trip() -> anyhow::Result<()> {
    let pairing = [0x5a_u8; 16];
    let (host, mut host_events, client, mut client_events) =
        connected_peers(pairing, pairing).await?;
    timeout(Duration::from_secs(20), async {
        let mut host_connected = false;
        let mut client_connected = false;
        while !host_connected || !client_connected {
            tokio::select! {
                Some(event) = host_events.recv() => match event {
                    PeerEvent::Connected => { println!("host connected"); host_connected = true },
                    PeerEvent::Error(error) => anyhow::bail!("host: {error}"),
                    _ => {}
                },
                Some(event) = client_events.recv() => match event {
                    PeerEvent::Connected => { println!("client connected"); client_connected = true },
                    PeerEvent::Error(error) => anyhow::bail!("client: {error}"),
                    _ => {}
                },
            }
        }
        Ok::<_, anyhow::Error>(())
    })
    .await??;

    let pty = PtyState::default();
    let session = "zerolink-test-session";
    let (output_tx, mut output_rx) = mpsc::unbounded_channel();
    pty.spawn_zerolink(
        session.into(),
        80,
        24,
        Arc::new(TestOutput { sender: output_tx }),
        Arc::new(TestExit),
    )
    .map_err(anyhow::Error::msg)?;
    client
        .send(proto::frame(proto::RESIZE, proto::encode_resize(111, 37)))
        .await?;
    client
        .send(proto::frame(proto::DATA, b"\x1b[1;1Recho ZL_TAURI_OK\r\n"))
        .await?;

    let mut output = Vec::new();
    let mut resized = false;
    timeout(Duration::from_secs(20), async {
        while !output
            .windows(b"ZL_TAURI_OK".len())
            .any(|value| value == b"ZL_TAURI_OK")
            || !resized
        {
            tokio::select! {
                Some(frame) = output_rx.recv() => host.send(frame).await?,
                Some(event) = host_events.recv() => if let PeerEvent::Data(frame) = event {
                    let (kind, payload) = proto::parse_frame(&frame)?;
                    if kind == proto::DATA {
                        pty.write_zerolink(session, payload).map_err(anyhow::Error::msg)?;
                    } else if kind == proto::RESIZE {
                        let (cols, rows) = proto::decode_resize(payload)?;
                        pty.resize_zerolink(session, cols, rows).map_err(anyhow::Error::msg)?;
                        resized = cols == 111 && rows == 37;
                    }
                },
                Some(event) = client_events.recv() => if let PeerEvent::Data(frame) = event {
                    let (kind, payload) = proto::parse_frame(&frame)?;
                    if kind == proto::DATA {
                        if payload.windows(4).any(|value| value == b"\x1b[6n") {
                            client.send(proto::frame(proto::DATA, b"\x1b[1;1R")).await?;
                        }
                        output.extend_from_slice(payload);
                    }
                },
            }
        }
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    println!("full session: real PTY echoed ZL_TAURI_OK; RESIZE 111x37 handled");

    let source_dir = tempfile::tempdir()?;
    let host_dir = tempfile::tempdir()?;
    let client_dir = tempfile::tempdir()?;
    let source = source_dir.path().join("round-trip.txt");
    std::fs::write(&source, b"ZeroLink Rust file round trip")?;
    transfer::send_file(&client, 7, &source, |_, _, _| {}).await?;
    let mut host_sink = transfer::FileSink::in_directory(host_dir.path().to_owned());
    let host_file = timeout(Duration::from_secs(10), async {
        loop {
            if let Some(PeerEvent::Data(frame)) = host_events.recv().await {
                let (kind, payload) = proto::parse_frame(&frame)?;
                match kind {
                    proto::FILE_META => {
                        if let Some(reply) = host_sink.meta(payload)? {
                            host.send(reply).await?;
                        }
                    }
                    proto::FILE_CHUNK => {
                        if let Some(reply) = host_sink.chunk(payload)? {
                            host.send(reply).await?;
                        }
                    }
                    proto::FILE_END => {
                        let (reply, done) = host_sink.end(payload)?;
                        if let Some(reply) = reply {
                            host.send(reply).await?;
                        }
                        if let Some(done) = done {
                            break Ok::<_, anyhow::Error>(done.dest);
                        }
                    }
                    _ => {}
                }
            }
        }
    })
    .await??;
    transfer::send_file(&host, 8, Path::new(&host_file), |_, _, _| {}).await?;
    let mut client_sink = transfer::FileSink::in_directory(client_dir.path().to_owned());
    let client_file = timeout(Duration::from_secs(10), async {
        loop {
            if let Some(PeerEvent::Data(frame)) = client_events.recv().await {
                let (kind, payload) = proto::parse_frame(&frame)?;
                match kind {
                    proto::FILE_META => {
                        if let Some(reply) = client_sink.meta(payload)? {
                            client.send(reply).await?;
                        }
                    }
                    proto::FILE_CHUNK => {
                        if let Some(reply) = client_sink.chunk(payload)? {
                            client.send(reply).await?;
                        }
                    }
                    proto::FILE_END => {
                        let (reply, done) = client_sink.end(payload)?;
                        if let Some(reply) = reply {
                            client.send(reply).await?;
                        }
                        if let Some(done) = done {
                            break Ok::<_, anyhow::Error>(done.dest);
                        }
                    }
                    _ => {}
                }
            }
        }
    })
    .await??;
    assert_eq!(
        std::fs::read(client_file)?,
        b"ZeroLink Rust file round trip"
    );
    println!("full session: encrypted file push + pull round-trip passed");
    pty.kill_zerolink(session);
    host.close().await;
    client.close().await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn attacker_with_wrong_pairing_key_never_reaches_session() -> anyhow::Result<()> {
    let (host, mut host_events, attacker, mut attacker_events) =
        connected_peers([0x11; 16], [0x22; 16]).await?;
    let connected = timeout(Duration::from_secs(10), async {
        loop {
            tokio::select! {
                Some(event) = host_events.recv() => match event {
                    PeerEvent::Connected => break true,
                    PeerEvent::Error(_) | PeerEvent::Disconnected => break false,
                    PeerEvent::Data(_) => {}
                },
                Some(event) = attacker_events.recv() => match event {
                    PeerEvent::Connected => break true,
                    PeerEvent::Error(_) | PeerEvent::Disconnected => break false,
                    PeerEvent::Data(_) => {}
                },
            }
        }
    })
    .await?;
    assert!(!connected, "wrong pairing key reached an encrypted session");
    println!("attacker rejection: wrong pairing proof closed before session");
    host.close().await;
    attacker.close().await;
    Ok(())
}
