use super::crypto::{self, CipherState, KeyPair};
use anyhow::{ensure, Context};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::{lookup_host, UdpSocket};
use tokio::sync::mpsc;
use tokio::time::timeout;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

pub const SIGNAL_PORT: u16 = 47_221;
pub const SAFE_DATAGRAM_BYTES: usize = 1_200;
const ICE_WAIT: Duration = Duration::from_secs(8);
const STUN_WAIT: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub enum PeerEvent {
    Connected,
    Data(Vec<u8>),
    Disconnected,
    Error(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signal {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub sdp: String,
    #[serde(default)]
    pub sdp_type: String,
}

struct Security {
    pair: KeyPair,
    pairing_key: [u8; 16],
    expected_remote: Option<[u8; 33]>,
    handshake_sent: bool,
    cipher: Option<CipherState>,
    connected_emitted: bool,
}

struct PeerInner {
    pc: Arc<RTCPeerConnection>,
    channel: Mutex<Option<Arc<RTCDataChannel>>>,
    send_lock: tokio::sync::Mutex<()>,
    security: Mutex<Security>,
    events: mpsc::UnboundedSender<PeerEvent>,
}

#[derive(Clone)]
pub struct Peer {
    inner: Arc<PeerInner>,
}

impl Peer {
    pub async fn new(
        pair: KeyPair,
        pairing_key: [u8; 16],
        expected_remote: Option<[u8; 33]>,
    ) -> anyhow::Result<(Self, mpsc::UnboundedReceiver<PeerEvent>)> {
        let config = RTCConfiguration {
            ice_servers: vec![
                RTCIceServer {
                    urls: vec!["stun:stun.l.google.com:19302".into()],
                    ..Default::default()
                },
                RTCIceServer {
                    urls: vec!["stun:stun1.l.google.com:19302".into()],
                    ..Default::default()
                },
                RTCIceServer {
                    urls: vec!["stun:stun.cloudflare.com:3478".into()],
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let pc = Arc::new(
            APIBuilder::new()
                .build()
                .new_peer_connection(config)
                .await?,
        );
        let (events, receiver) = mpsc::unbounded_channel();
        let peer = Self {
            inner: Arc::new(PeerInner {
                pc,
                channel: Mutex::new(None),
                send_lock: tokio::sync::Mutex::new(()),
                security: Mutex::new(Security {
                    pair,
                    pairing_key,
                    expected_remote,
                    handshake_sent: false,
                    cipher: None,
                    connected_emitted: false,
                }),
                events,
            }),
        };
        let state_peer = peer.clone();
        peer.inner
            .pc
            .on_peer_connection_state_change(Box::new(move |state| {
                let state_peer = state_peer.clone();
                Box::pin(async move {
                    if matches!(
                        state,
                        RTCPeerConnectionState::Disconnected
                            | RTCPeerConnectionState::Failed
                            | RTCPeerConnectionState::Closed
                    ) {
                        let _ = state_peer.inner.events.send(PeerEvent::Disconnected);
                    }
                })
            }));
        Ok((peer, receiver))
    }

    pub async fn make_offer(&self) -> anyhow::Result<RTCSessionDescription> {
        let channel = self.inner.pc.create_data_channel("zerolink", None).await?;
        self.install_channel(channel).await;
        let mut complete = self.inner.pc.gathering_complete_promise().await;
        self.inner
            .pc
            .set_local_description(self.inner.pc.create_offer(None).await?)
            .await?;
        timeout(ICE_WAIT, complete.recv())
            .await
            .context("offer ICE gathering timed out")?;
        self.inner
            .pc
            .local_description()
            .await
            .context("offer local description missing")
    }

    pub async fn answer_offer(&self, sdp: &str) -> anyhow::Result<RTCSessionDescription> {
        let callback_peer = self.clone();
        self.inner.pc.on_data_channel(Box::new(move |channel| {
            let callback_peer = callback_peer.clone();
            Box::pin(async move {
                callback_peer.install_channel(channel).await;
            })
        }));
        self.inner
            .pc
            .set_remote_description(RTCSessionDescription::offer(sdp.to_owned())?)
            .await?;
        let mut complete = self.inner.pc.gathering_complete_promise().await;
        self.inner
            .pc
            .set_local_description(self.inner.pc.create_answer(None).await?)
            .await?;
        timeout(ICE_WAIT, complete.recv())
            .await
            .context("answer ICE gathering timed out")?;
        self.inner
            .pc
            .local_description()
            .await
            .context("answer local description missing")
    }

    pub async fn accept_answer(&self, sdp: &str) -> anyhow::Result<()> {
        self.inner
            .pc
            .set_remote_description(RTCSessionDescription::answer(sdp.to_owned())?)
            .await?;
        Ok(())
    }

    async fn install_channel(&self, channel: Arc<RTCDataChannel>) {
        *lock(&self.inner.channel) = Some(channel.clone());
        let open_peer = self.clone();
        channel.on_open(Box::new(move || {
            let open_peer = open_peer.clone();
            Box::pin(async move {
                if let Err(error) = open_peer.send_handshake().await {
                    open_peer.fail_close(format!("handshake send failed: {error}"));
                }
            })
        }));
        let message_peer = self.clone();
        channel.on_message(Box::new(move |message: DataChannelMessage| {
            let message_peer = message_peer.clone();
            Box::pin(async move {
                message_peer.receive(message.data.as_ref()).await;
            })
        }));
        let close_peer = self.clone();
        channel.on_close(Box::new(move || {
            let close_peer = close_peer.clone();
            Box::pin(async move {
                let _ = close_peer.inner.events.send(PeerEvent::Disconnected);
            })
        }));
        let error_peer = self.clone();
        channel.on_error(Box::new(move |error| {
            let error_peer = error_peer.clone();
            Box::pin(async move {
                error_peer.fail_close(format!("DataChannel error: {error}"));
            })
        }));
        if channel.ready_state()
            == webrtc::data_channel::data_channel_state::RTCDataChannelState::Open
        {
            if let Err(error) = self.send_handshake().await {
                self.fail_close(format!("handshake send failed: {error}"));
            }
        }
    }

    async fn send_handshake(&self) -> anyhow::Result<()> {
        let packet = {
            let mut security = lock(&self.inner.security);
            if security.handshake_sent {
                return Ok(());
            }
            security.handshake_sent = true;
            crypto::build_handshake(
                &security.pair.public,
                &security.pairing_key,
                &rand::random::<[u8; 16]>(),
            )?
        };
        let channel = lock(&self.inner.channel)
            .clone()
            .context("DataChannel missing")?;
        channel.send(&Bytes::from(packet)).await?;
        Ok(())
    }

    async fn receive(&self, packet: &[u8]) {
        enum Received {
            Handshake,
            Data(Vec<u8>),
            Error(String),
        }
        let result = {
            let mut security = lock(&self.inner.security);
            if security.cipher.is_none() {
                match crypto::verify_handshake(
                    packet,
                    &security.pairing_key,
                    security
                        .expected_remote
                        .as_ref()
                        .map(|value| value.as_slice()),
                )
                .and_then(|remote| crypto::derive_session_key(&security.pair, &remote))
                {
                    Ok(key) => {
                        security.cipher = Some(CipherState::new(key));
                        Received::Handshake
                    }
                    Err(error) => Received::Error(format!("handshake failed: {error}")),
                }
            } else {
                match security.cipher.as_mut() {
                    Some(cipher) => match cipher.decrypt(packet) {
                        Ok(data) => Received::Data(data),
                        Err(error) => Received::Error(format!("decrypt failed: {error}")),
                    },
                    None => Received::Error("encrypted session state is missing".into()),
                }
            }
        };
        match result {
            Received::Handshake => {
                if let Err(error) = self.send_handshake().await {
                    self.fail_close(format!("handshake send failed: {error}"));
                    return;
                }
                let mut security = lock(&self.inner.security);
                if !security.connected_emitted {
                    security.connected_emitted = true;
                    let _ = self.inner.events.send(PeerEvent::Connected);
                }
            }
            Received::Data(data) => {
                let _ = self.inner.events.send(PeerEvent::Data(data));
            }
            Received::Error(error) => self.fail_close(error),
        }
    }

    pub async fn send(&self, plaintext: Vec<u8>) -> anyhow::Result<()> {
        let _send_guard = self.inner.send_lock.lock().await;
        let packet = {
            let mut security = lock(&self.inner.security);
            security
                .cipher
                .as_mut()
                .context("encrypted session is not established")?
                .encrypt(&plaintext)?
        };
        let channel = lock(&self.inner.channel)
            .clone()
            .context("DataChannel missing")?;
        channel.send(&Bytes::from(packet)).await?;
        Ok(())
    }

    fn fail_close(&self, message: String) {
        let _ = self.inner.events.send(PeerEvent::Error(message));
        let peer = self.clone();
        tokio::spawn(async move {
            peer.close().await;
        });
    }

    pub async fn close(&self) {
        let channel = {
            let guard = lock(&self.inner.channel);
            guard.clone()
        };
        if let Some(channel) = channel {
            let _ = channel.close().await;
        }
        let _ = self.inner.pc.close().await;
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

pub async fn bind_signal(port: u16) -> anyhow::Result<Arc<UdpSocket>> {
    match UdpSocket::bind((Ipv4Addr::UNSPECIFIED, port)).await {
        Ok(socket) => Ok(Arc::new(socket)),
        Err(error)
            if port != 0
                && matches!(
                    error.kind(),
                    std::io::ErrorKind::AddrInUse | std::io::ErrorKind::PermissionDenied
                ) =>
        {
            Ok(Arc::new(UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).await?))
        }
        Err(error) => Err(error.into()),
    }
}

pub fn local_addresses(port: u16) -> Vec<String> {
    let mut result = local_ip_address::list_afinet_netifas()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(_, ip)| match ip {
            std::net::IpAddr::V4(ip) if !ip.is_loopback() => Some(format!("{ip}:{port}")),
            _ => None,
        })
        .collect::<Vec<_>>();
    result.sort();
    result.dedup();
    if result.is_empty() {
        result.push(format!("127.0.0.1:{port}"));
    }
    result
}

pub async fn discover_public_address(socket: &UdpSocket) -> anyhow::Result<String> {
    let mut request = [0_u8; 20];
    request[..2].copy_from_slice(&1_u16.to_be_bytes());
    request[4..8].copy_from_slice(&0x2112_a442_u32.to_be_bytes());
    request[8..].copy_from_slice(&rand::random::<[u8; 12]>());
    for server in [
        ("stun.l.google.com", 19302),
        ("stun1.l.google.com", 19302),
        ("stun.cloudflare.com", 3478),
    ] {
        if let Ok(mut addresses) = lookup_host(server).await {
            if let Some(address) = addresses.next() {
                let _ = socket.send_to(&request, address).await;
            }
        }
    }
    let mut buffer = [0_u8; 2048];
    let (length, _) = timeout(STUN_WAIT, socket.recv_from(&mut buffer))
        .await
        .context("STUN timeout")??;
    parse_stun_response(&buffer[..length]).context("invalid STUN response")
}

pub fn parse_stun_response(message: &[u8]) -> Option<String> {
    if message.len() < 20 || u16::from_be_bytes(message[..2].try_into().ok()?) != 0x0101 {
        return None;
    }
    let declared = usize::from(u16::from_be_bytes(message[2..4].try_into().ok()?));
    let end = (20 + declared).min(message.len());
    let mut offset = 20;
    while offset + 4 <= end {
        let kind = u16::from_be_bytes(message[offset..offset + 2].try_into().ok()?);
        let length = usize::from(u16::from_be_bytes(
            message[offset + 2..offset + 4].try_into().ok()?,
        ));
        let value = offset + 4;
        if value + length > end {
            return None;
        }
        if (kind == 0x0020 || kind == 0x0001) && length >= 8 && message[value + 1] == 1 {
            let mut port = u16::from_be_bytes(message[value + 2..value + 4].try_into().ok()?);
            let mut ip: [u8; 4] = message[value + 4..value + 8].try_into().ok()?;
            if kind == 0x0020 {
                port ^= 0x2112;
                for (byte, mask) in ip.iter_mut().zip([0x21, 0x12, 0xa4, 0x42]) {
                    *byte ^= mask;
                }
            }
            return Some(format!("{}:{port}", Ipv4Addr::from(ip)));
        }
        offset = value + length.div_ceil(4) * 4;
    }
    None
}

pub fn decode_signal(bytes: &[u8]) -> anyhow::Result<Signal> {
    ensure!(
        bytes.len() <= SAFE_DATAGRAM_BYTES,
        "signaling datagram exceeds 1200-byte limit"
    );
    Ok(serde_json::from_slice(bytes)?)
}

pub async fn send_signal(
    socket: &UdpSocket,
    destination: SocketAddr,
    signal: &Signal,
) -> anyhow::Result<()> {
    let bytes = serde_json::to_vec(signal)?;
    ensure!(
        bytes.len() <= SAFE_DATAGRAM_BYTES,
        "signaling JSON is {} bytes; safe UDP limit is {SAFE_DATAGRAM_BYTES} bytes",
        bytes.len()
    );
    socket.send_to(&bytes, destination).await?;
    Ok(())
}
