mod crypto;
mod peer;
mod proto;
mod transfer;

#[cfg(not(test))]
mod service {
    use super::peer::{Peer, PeerEvent, Signal};
    use super::{crypto, peer, proto, transfer};
    use crate::pty::{ExitSink, OutputSink, PtyState};
    use anyhow::{ensure, Context};
    use serde::Serialize;
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::net::SocketAddr;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tauri::{AppHandle, Emitter, State};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::{mpsc, oneshot};
    use tokio::task::JoinHandle;
    use tokio::time::{interval, Duration};

    const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

    #[derive(Default)]
    pub struct ZeroLinkState {
        inner: tokio::sync::Mutex<Managed>,
    }

    #[derive(Default)]
    struct Managed {
        host: Option<oneshot::Sender<()>>,
        client: Option<mpsc::UnboundedSender<ClientCommand>>,
    }

    #[derive(Serialize)]
    pub struct HostStart {
        code: String,
    }

    enum HostAsync {
        Frame(Vec<u8>),
        Exit(i32),
        ForwardWriter(u32, tokio::net::tcp::OwnedWriteHalf),
    }

    struct TunnelOutput {
        sender: mpsc::Sender<HostAsync>,
    }

    impl OutputSink for TunnelOutput {
        fn send(&self, bytes: Vec<u8>) -> Result<(), ()> {
            self.sender
                .blocking_send(HostAsync::Frame(proto::frame(proto::DATA, bytes)))
                .map_err(|_| ())
        }

        fn auto_acknowledge(&self) -> bool {
            true
        }
    }

    struct TunnelExit {
        sender: mpsc::Sender<HostAsync>,
    }

    impl ExitSink for TunnelExit {
        fn send(&self, code: i32) {
            let _ = self.sender.blocking_send(HostAsync::Exit(code));
        }
    }

    enum ClientCommand {
        Send(Vec<u8>),
        Resize(u16, u16),
        Push(PathBuf, oneshot::Sender<Result<Value, String>>),
        Pull(String, oneshot::Sender<Result<Value, String>>),
        ForwardAdd(u16, String, u16, oneshot::Sender<Result<Value, String>>),
        ForwardRemove(u16),
        Stop,
    }

    enum ClientAsync {
        ForwardWriter(u32, tokio::net::tcp::OwnedWriteHalf),
        ForwardError(u16, String),
    }

    pub struct HeadlessHost {
        code: String,
        cancel: Option<oneshot::Sender<()>>,
        task: Option<JoinHandle<anyhow::Result<()>>>,
    }

    impl HeadlessHost {
        pub fn code(&self) -> &str {
            &self.code
        }

        pub async fn serve_for(mut self, duration: Duration) -> anyhow::Result<()> {
            let mut task = self.task.take().context("host task missing")?;
            tokio::select! {
                result = &mut task => result.context("host task failed")?,
                _ = tokio::time::sleep(duration) => {
                    if let Some(cancel) = self.cancel.take() {
                        let _ = cancel.send(());
                    }
                    task.await.context("host task failed")?
                }
            }
        }
    }

    impl Drop for HeadlessHost {
        fn drop(&mut self) {
            if let Some(cancel) = self.cancel.take() {
                let _ = cancel.send(());
            }
            if let Some(task) = self.task.take() {
                task.abort();
            }
        }
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    fn emit(app: &AppHandle, event: &str, payload: impl Serialize + Clone) {
        let _ = app.emit(event, payload);
    }

    async fn prepare_host(
        include_loopback: bool,
    ) -> anyhow::Result<(
        String,
        Peer,
        mpsc::UnboundedReceiver<PeerEvent>,
        Arc<tokio::net::UdpSocket>,
    )> {
        let socket = peer::bind_signal(peer::SIGNAL_PORT).await?;
        let port = socket.local_addr()?.port();
        let mut addrs = peer::local_addresses(port);
        if include_loopback {
            addrs.insert(0, format!("127.0.0.1:{port}"));
            addrs.dedup();
        }
        if let Ok(public) = peer::discover_public_address(&socket).await {
            if !addrs.contains(&public) {
                addrs.push(public);
            }
        }
        let pair = crypto::generate_key_pair();
        let pairing = crypto::generate_pairing_key();
        let code = crypto::encode_zero_code(&pair.public, &pairing, &addrs, now_ms())?;
        let (peer, events) = Peer::new(pair, pairing, None).await?;
        Ok((code, peer, events, socket))
    }

    #[tauri::command]
    pub async fn zl_host_start(
        tab_id: Option<String>,
        app: AppHandle,
        pty: State<'_, PtyState>,
        state: State<'_, ZeroLinkState>,
    ) -> Result<HostStart, String> {
        let _ = tab_id;
        stop_host(&state).await;
        let (code, peer, events, socket) = prepare_host(false)
            .await
            .map_err(|error| error.to_string())?;
        let (cancel, cancelled) = oneshot::channel();
        state.inner.lock().await.host = Some(cancel);
        let app_for_task = app.clone();
        let code_for_task = code.clone();
        let pty = pty.inner().clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) =
                run_host(app_for_task.clone(), pty, peer, events, socket, cancelled).await
            {
                emit(
                    &app_for_task,
                    "zl:error",
                    json!({ "message": error.to_string() }),
                );
            }
            emit(&app_for_task, "zl:host:disconnected", json!({}));
        });
        emit(&app, "zl:host:code", json!({ "code": code_for_task }));
        Ok(HostStart { code })
    }

    async fn run_host(
        app: AppHandle,
        pty: PtyState,
        peer: Peer,
        mut events: mpsc::UnboundedReceiver<PeerEvent>,
        socket: Arc<tokio::net::UdpSocket>,
        mut cancelled: oneshot::Receiver<()>,
    ) -> anyhow::Result<()> {
        let mut buffer = vec![0_u8; peer::SAFE_DATAGRAM_BYTES];
        let mut offer: Option<
            webrtc::peer_connection::sdp::session_description::RTCSessionDescription,
        > = None;
        let mut answered = false;
        let mut connected = false;
        let mut timer = interval(Duration::from_secs(1));
        let started = now_ms();
        let (async_tx, mut async_rx) = mpsc::channel(8);
        let session_id = format!("zerolink-host-{}", rand::random::<u32>());
        let mut file_sink = transfer::FileSink::downloads();
        let mut forward_writers: HashMap<u32, tokio::net::tcp::OwnedWriteHalf> = HashMap::new();
        loop {
            tokio::select! {
                _ = &mut cancelled => break,
                _ = timer.tick() => {
                    let elapsed = now_ms().saturating_sub(started);
                    let left = crypto::CODE_TTL_MS.saturating_sub(elapsed) / 1000;
                    emit(&app, "zl:host:timer", json!({ "secondsLeft": left }));
                    if left == 0 && !connected {
                        emit(&app, "zl:host:expired", json!({}));
                        break;
                    }
                }
                received = socket.recv_from(&mut buffer) => {
                    let (length, source) = received?;
                    let Ok(signal) = peer::decode_signal(&buffer[..length]) else { continue };
                    match signal.kind.as_str() {
                        "hello" if !connected => {
                            if offer.is_none() {
                                offer = Some(peer.make_offer().await?);
                            }
                            if let Some(description) = &offer {
                                peer::send_signal(&socket, source, &Signal {
                                    kind: "offer".into(),
                                    sdp: description.sdp.clone(),
                                    sdp_type: "offer".into(),
                                }).await?;
                            }
                        }
                        "answer" if !answered => {
                            ensure!(signal.sdp_type == "answer", "invalid SDP answer type");
                            answered = true;
                            peer.accept_answer(&signal.sdp).await?;
                        }
                        _ => {}
                    }
                }
                Some(event) = events.recv() => match event {
                    PeerEvent::Connected if !connected => {
                        connected = true;
                        emit(&app, "zl:host:connected", json!({ "addr": "peer" }));
                        let info = pty.spawn_zerolink(
                            session_id.clone(),
                            100,
                            30,
                            Arc::new(TunnelOutput { sender: async_tx.clone() }),
                            Arc::new(TunnelExit { sender: async_tx.clone() }),
                        ).map_err(anyhow::Error::msg)?;
                        emit(&app, "zl:host:session", json!({ "pid": info.pid }));
                    }
                    PeerEvent::Data(frame) => {
                        handle_host_frame(
                            &app, &pty, &session_id, &peer, &async_tx, &mut file_sink,
                            &mut forward_writers, frame,
                        ).await?;
                    }
                    PeerEvent::Error(message) => return Err(anyhow::anyhow!(message)),
                    PeerEvent::Disconnected => break,
                    PeerEvent::Connected => {}
                },
                Some(event) = async_rx.recv() => match event {
                    HostAsync::Frame(frame) => peer.send(frame).await?,
                    HostAsync::Exit(code) => peer.send(proto::frame(proto::EXIT, proto::encode_exit(code))).await?,
                    HostAsync::ForwardWriter(id, writer) => { forward_writers.insert(id, writer); }
                }
            }
        }
        file_sink.destroy();
        pty.kill_zerolink(&session_id);
        peer.close().await;
        Ok(())
    }

    pub async fn start_headless_host() -> anyhow::Result<HeadlessHost> {
        let (code, peer, events, socket) = prepare_host(true).await?;
        let (cancel, cancelled) = oneshot::channel();
        let task = tokio::spawn(run_headless_host(
            PtyState::default(),
            peer,
            events,
            socket,
            cancelled,
        ));
        Ok(HeadlessHost {
            code,
            cancel: Some(cancel),
            task: Some(task),
        })
    }

    async fn run_headless_host(
        pty: PtyState,
        peer: Peer,
        mut events: mpsc::UnboundedReceiver<PeerEvent>,
        socket: Arc<tokio::net::UdpSocket>,
        mut cancelled: oneshot::Receiver<()>,
    ) -> anyhow::Result<()> {
        let mut buffer = vec![0_u8; peer::SAFE_DATAGRAM_BYTES];
        let mut offer = None;
        let mut answered = false;
        let mut connected = false;
        let (async_tx, mut async_rx) = mpsc::channel(8);
        let session_id = format!("zerolink-e2e-{}", rand::random::<u32>());
        loop {
            tokio::select! {
                _ = &mut cancelled => break,
                received = socket.recv_from(&mut buffer) => {
                    let (length, source) = received?;
                    let Ok(signal) = peer::decode_signal(&buffer[..length]) else { continue };
                    match signal.kind.as_str() {
                        "hello" if !connected => {
                            if offer.is_none() {
                                offer = Some(peer.make_offer().await?);
                            }
                            if let Some(description) = &offer {
                                peer::send_signal(&socket, source, &Signal {
                                    kind: "offer".into(),
                                    sdp: description.sdp.clone(),
                                    sdp_type: "offer".into(),
                                }).await?;
                            }
                        }
                        "answer" if !answered => {
                            ensure!(signal.sdp_type == "answer", "invalid SDP answer type");
                            answered = true;
                            peer.accept_answer(&signal.sdp).await?;
                        }
                        _ => {}
                    }
                }
                Some(event) = events.recv() => match event {
                    PeerEvent::Connected if !connected => {
                        connected = true;
                        eprintln!("ZeroLink host: encrypted client connected");
                        pty.spawn_zerolink(
                            session_id.clone(),
                            100,
                            30,
                            Arc::new(TunnelOutput { sender: async_tx.clone() }),
                            Arc::new(TunnelExit { sender: async_tx.clone() }),
                        ).map_err(anyhow::Error::msg)?;
                    }
                    PeerEvent::Data(frame) => {
                        handle_terminal_frame(&pty, &session_id, &frame)?;
                    }
                    PeerEvent::Error(message) => return Err(anyhow::anyhow!(message)),
                    PeerEvent::Disconnected => break,
                    PeerEvent::Connected => {}
                },
                Some(event) = async_rx.recv() => match event {
                    HostAsync::Frame(frame) => peer.send(frame).await?,
                    HostAsync::Exit(code) => {
                        peer.send(proto::frame(proto::EXIT, proto::encode_exit(code))).await?
                    }
                    HostAsync::ForwardWriter(_, _) => {}
                }
            }
        }
        pty.kill_zerolink(&session_id);
        peer.close().await;
        Ok(())
    }

    fn handle_terminal_frame(
        pty: &PtyState,
        session_id: &str,
        frame: &[u8],
    ) -> anyhow::Result<bool> {
        let (kind, payload) = proto::parse_frame(frame)?;
        match kind {
            proto::DATA => {
                pty.write_zerolink(session_id, payload)
                    .map_err(anyhow::Error::msg)?;
                Ok(true)
            }
            proto::RESIZE => {
                let (cols, rows) = proto::decode_resize(payload)?;
                pty.resize_zerolink(session_id, cols, rows)
                    .map_err(anyhow::Error::msg)?;
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn handle_host_frame(
        app: &AppHandle,
        pty: &PtyState,
        session_id: &str,
        peer: &Peer,
        async_tx: &mpsc::Sender<HostAsync>,
        sink: &mut transfer::FileSink,
        writers: &mut HashMap<u32, tokio::net::tcp::OwnedWriteHalf>,
        frame: Vec<u8>,
    ) -> anyhow::Result<()> {
        if handle_terminal_frame(pty, session_id, &frame)? {
            return Ok(());
        }
        let (kind, payload) = proto::parse_frame(&frame)?;
        match kind {
            proto::EXEC => {
                let command = String::from_utf8(payload.to_vec())?;
                let peer = peer.clone();
                tauri::async_runtime::spawn(async move {
                    let result = execute_command(&command).await;
                    let (output, code) = match result {
                        Ok(value) => value,
                        Err(error) => (format!("exec error: {error}\r\n").into_bytes(), 127),
                    };
                    let _ = peer.send(proto::frame(proto::DATA, output)).await;
                    let _ = peer
                        .send(proto::frame(proto::EXIT, proto::encode_exit(code)))
                        .await;
                });
            }
            proto::FILE_META => {
                if let Some(error) = sink.meta(payload)? {
                    peer.send(error).await?;
                }
            }
            proto::FILE_CHUNK => {
                if let Some(error) = sink.chunk(payload)? {
                    peer.send(error).await?;
                }
            }
            proto::FILE_END => {
                let (reply, done) = sink.end(payload)?;
                if let Some(reply) = reply {
                    peer.send(reply).await?;
                }
                if let Some(done) = done {
                    emit(app, "zl:host:file", done);
                }
            }
            proto::FILE_REQ => {
                let (id, path) = proto::decode_file_req(payload)?;
                let peer = peer.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) =
                        transfer::send_file(&peer, id, Path::new(&path), |_, _, _| {}).await
                    {
                        let _ = peer
                            .send(transfer::file_error(id, &error.to_string()))
                            .await;
                    }
                });
            }
            proto::FWD_OPEN => {
                let (id, target) = proto::decode_fwd_open(payload)?;
                let (host, port) = parse_target(&target)?;
                let stream = TcpStream::connect((host.as_str(), port)).await?;
                let (mut reader, writer) = stream.into_split();
                async_tx.send(HostAsync::ForwardWriter(id, writer)).await?;
                let peer = peer.clone();
                tauri::async_runtime::spawn(async move {
                    let mut buffer = vec![0_u8; 16 * 1024];
                    loop {
                        match reader.read(&mut buffer).await {
                            Ok(0) | Err(_) => break,
                            Ok(count) => {
                                if peer
                                    .send(proto::frame(
                                        proto::FWD_DATA,
                                        proto::encode_fwd_data(id, &buffer[..count]),
                                    ))
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                            }
                        }
                    }
                    let _ = peer
                        .send(proto::frame(proto::FWD_CLOSE, proto::encode_u32(id)))
                        .await;
                });
            }
            proto::FWD_DATA => {
                let (id, data) = proto::decode_fwd_data(payload)?;
                if let Some(writer) = writers.get_mut(&id) {
                    writer.write_all(data).await?;
                }
            }
            proto::FWD_CLOSE => {
                if let Some(mut writer) = writers.remove(&proto::decode_u32(payload)?) {
                    let _ = writer.shutdown().await;
                }
            }
            _ => {}
        }
        Ok(())
    }

    async fn execute_command(command: &str) -> anyhow::Result<(Vec<u8>, i32)> {
        #[cfg(windows)]
        let output = tokio::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", command])
            .output()
            .await?;
        #[cfg(not(windows))]
        let output =
            tokio::process::Command::new(std::env::var("SHELL").unwrap_or_else(|_| "bash".into()))
                .args(["-lc", command])
                .output()
                .await?;
        let mut bytes = output.stdout;
        bytes.extend_from_slice(&output.stderr);
        Ok((bytes, output.status.code().unwrap_or(1)))
    }

    #[tauri::command]
    pub async fn zl_host_stop(state: State<'_, ZeroLinkState>) -> Result<(), String> {
        stop_host(&state).await;
        Ok(())
    }

    async fn stop_host(state: &ZeroLinkState) {
        if let Some(cancel) = state.inner.lock().await.host.take() {
            let _ = cancel.send(());
        }
    }

    #[tauri::command]
    pub async fn zl_client_connect(
        code: String,
        tab_id: String,
        app: AppHandle,
        state: State<'_, ZeroLinkState>,
    ) -> Result<(), String> {
        stop_client(&state).await;
        let (peer, events, socket, destinations) = prepare_client(&code)
            .await
            .map_err(|error| error.to_string())?;
        let (commands, receiver) = mpsc::unbounded_channel();
        state.inner.lock().await.client = Some(commands);
        tauri::async_runtime::spawn(async move {
            if let Err(error) = run_client(
                app.clone(),
                tab_id,
                peer,
                events,
                socket,
                destinations,
                receiver,
            )
            .await
            {
                emit(&app, "zl:error", json!({ "message": error.to_string() }));
            }
            emit(&app, "zl:client:disconnected", json!({}));
        });
        Ok(())
    }

    async fn prepare_client(
        code: &str,
    ) -> anyhow::Result<(
        Peer,
        mpsc::UnboundedReceiver<PeerEvent>,
        Arc<tokio::net::UdpSocket>,
        Vec<SocketAddr>,
    )> {
        let decoded = crypto::decode_zero_code(code, now_ms())?;
        if decoded.addrs.is_empty() {
            anyhow::bail!("code contains no usable address");
        }
        let destinations = decoded
            .addrs
            .iter()
            .map(|value| value.parse::<SocketAddr>())
            .collect::<Result<Vec<_>, _>>()?;
        let socket = peer::bind_signal(0).await?;
        let pair = crypto::generate_key_pair();
        let (peer, events) = Peer::new(pair, decoded.pairing_key, Some(decoded.public_key)).await?;
        Ok((peer, events, socket, destinations))
    }

    pub async fn headless_connect(
        code: &str,
        input: &[u8],
        marker: &[u8],
        duration: Duration,
    ) -> anyhow::Result<()> {
        let (peer, mut events, socket, destinations) = prepare_client(code).await?;
        let operation = async {
            let mut buffer = vec![0_u8; peer::SAFE_DATAGRAM_BYTES];
            let mut hello = interval(Duration::from_millis(1500));
            let deadline = tokio::time::sleep(duration);
            tokio::pin!(deadline);
            let mut offer_handled = false;
            let mut connected = false;
            let mut output = Vec::new();
            loop {
                tokio::select! {
                    _ = &mut deadline => {
                        let received = String::from_utf8_lossy(&output);
                        anyhow::bail!("encrypted session timed out; received {received:?}");
                    }
                    _ = hello.tick(), if !offer_handled => {
                        let mut sent = false;
                        let mut last_error = None;
                        for destination in &destinations {
                            match peer::send_signal(&socket, *destination, &Signal {
                                kind: "hello".into(),
                                sdp: String::new(),
                                sdp_type: String::new(),
                            }).await {
                                Ok(()) => sent = true,
                                Err(error) => last_error = Some(error),
                            }
                        }
                        if !sent {
                            return Err(last_error.unwrap_or_else(|| {
                                anyhow::anyhow!("code contains no reachable address")
                            }));
                        }
                    }
                    received = socket.recv_from(&mut buffer), if !offer_handled => {
                        let Ok((length, source)) = received else { continue };
                        let Ok(signal) = peer::decode_signal(&buffer[..length]) else { continue };
                        if signal.kind == "offer" {
                            ensure!(signal.sdp_type == "offer", "invalid SDP offer type");
                            offer_handled = true;
                            let answer = peer.answer_offer(&signal.sdp).await?;
                            peer::send_signal(&socket, source, &Signal {
                                kind: "answer".into(),
                                sdp: answer.sdp,
                                sdp_type: "answer".into(),
                            }).await?;
                        }
                    }
                    Some(event) = events.recv() => match event {
                        PeerEvent::Connected if !connected => {
                            connected = true;
                            peer.send(proto::frame(proto::DATA, input)).await?;
                        }
                        PeerEvent::Data(frame) => {
                            let (kind, payload) = proto::parse_frame(&frame)?;
                            if kind == proto::DATA {
                                if payload.windows(4).any(|item| item == b"\x1b[6n") {
                                    peer.send(proto::frame(proto::DATA, b"\x1b[1;1R")).await?;
                                }
                                output.extend_from_slice(payload);
                                if output.windows(marker.len()).filter(|item| *item == marker).count() >= 2 {
                                    peer.close().await;
                                    return Ok(());
                                }
                            }
                        }
                        PeerEvent::Error(message) => return Err(anyhow::anyhow!(message)),
                        PeerEvent::Disconnected => anyhow::bail!("peer disconnected before marker"),
                        PeerEvent::Connected => {}
                    }
                }
            }
        };
        let result = operation.await;
        peer.close().await;
        result
    }

    async fn run_client(
        app: AppHandle,
        tab_id: String,
        peer: Peer,
        mut events: mpsc::UnboundedReceiver<PeerEvent>,
        socket: Arc<tokio::net::UdpSocket>,
        destinations: Vec<SocketAddr>,
        mut commands: mpsc::UnboundedReceiver<ClientCommand>,
    ) -> anyhow::Result<()> {
        let mut buffer = vec![0_u8; peer::SAFE_DATAGRAM_BYTES];
        let mut hello = interval(Duration::from_millis(1500));
        let deadline = tokio::time::sleep(CONNECT_TIMEOUT);
        tokio::pin!(deadline);
        let mut offer_handled = false;
        let mut connected = false;
        let mut file_sink = transfer::FileSink::downloads();
        let (async_tx, mut async_rx) = mpsc::unbounded_channel();
        let mut forward_writers: HashMap<u32, tokio::net::tcp::OwnedWriteHalf> = HashMap::new();
        let mut forward_servers: HashMap<u16, tauri::async_runtime::JoinHandle<()>> =
            HashMap::new();
        let sequence = Arc::new(AtomicU32::new(1));
        loop {
            tokio::select! {
                _ = hello.tick(), if !offer_handled => {
                    for destination in &destinations {
                        peer::send_signal(&socket, *destination, &Signal {
                            kind: "hello".into(), sdp: String::new(), sdp_type: String::new(),
                        }).await?;
                    }
                }
                _ = &mut deadline, if !connected => {
                    return Err(anyhow::anyhow!("connection timed out; is the host online?"));
                }
                received = socket.recv_from(&mut buffer), if !offer_handled => {
                    let (length, source) = received?;
                    let Ok(signal) = peer::decode_signal(&buffer[..length]) else { continue };
                    if signal.kind == "offer" {
                        ensure!(signal.sdp_type == "offer", "invalid SDP offer type");
                        offer_handled = true;
                        let answer = peer.answer_offer(&signal.sdp).await?;
                        peer::send_signal(&socket, source, &Signal {
                            kind: "answer".into(), sdp: answer.sdp, sdp_type: "answer".into(),
                        }).await?;
                    }
                }
                Some(event) = events.recv() => match event {
                    PeerEvent::Connected => {
                        connected = true;
                        emit(&app, "zl:client:connected", json!({}));
                    }
                    PeerEvent::Data(frame) => {
                        handle_client_frame(
                            &app, &tab_id, &peer, &mut file_sink, &mut forward_writers, frame,
                        ).await?;
                    }
                    PeerEvent::Error(message) => return Err(anyhow::anyhow!(message)),
                    PeerEvent::Disconnected => break,
                },
                Some(command) = commands.recv() => match command {
                    ClientCommand::Send(data) => if connected {
                        peer.send(proto::frame(proto::DATA, data)).await?;
                    },
                    ClientCommand::Resize(cols, rows) => if connected {
                        peer.send(proto::frame(proto::RESIZE, proto::encode_resize(cols, rows))).await?;
                    },
                    ClientCommand::Push(path, response) => {
                        let id = sequence.fetch_add(1, Ordering::Relaxed);
                        let name = path.file_name().and_then(|v| v.to_str()).unwrap_or("").to_owned();
                        let peer = peer.clone();
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let result = transfer::send_file(&peer, id, &path, |sent, size, name| {
                                emit(&app, "zl:client:file-progress", json!({"name":name,"sent":sent,"size":size}));
                            }).await;
                            if let Err(error) = result {
                                emit(&app, "zl:client:file-error", json!({"message":error.to_string()}));
                            }
                        });
                        let _ = response.send(Ok(json!({"id":id,"name":name,"canceled":false})));
                    }
                    ClientCommand::Pull(path, response) => {
                        let id = sequence.fetch_add(1, Ordering::Relaxed);
                        let name = Path::new(&path).file_name().and_then(|v|v.to_str()).unwrap_or("").to_owned();
                        let result = peer.send(proto::frame(proto::FILE_REQ, proto::encode_file_req(id, &path))).await
                            .map(|()| json!({"id":id,"name":name}))
                            .map_err(|error| error.to_string());
                        let _ = response.send(result);
                    }
                    ClientCommand::ForwardAdd(local, host, remote, response) => {
                        let result = add_forward(
                            &app, &peer, &async_tx, &sequence, &mut forward_servers, local, host, remote,
                        ).await;
                        let _ = response.send(result.map_err(|error| error.to_string()));
                    }
                    ClientCommand::ForwardRemove(port) => {
                        if let Some(task) = forward_servers.remove(&port) { task.abort(); }
                    }
                    ClientCommand::Stop => break,
                },
                Some(event) = async_rx.recv() => match event {
                    ClientAsync::ForwardWriter(id, writer) => { forward_writers.insert(id, writer); }
                    ClientAsync::ForwardError(port, message) => {
                        emit(&app, "zl:client:forward-error", json!({"localPort":port,"message":message}));
                    }
                }
            }
        }
        for (_, task) in forward_servers {
            task.abort();
        }
        file_sink.destroy();
        peer.close().await;
        Ok(())
    }

    async fn handle_client_frame(
        app: &AppHandle,
        tab_id: &str,
        peer: &Peer,
        sink: &mut transfer::FileSink,
        writers: &mut HashMap<u32, tokio::net::tcp::OwnedWriteHalf>,
        frame: Vec<u8>,
    ) -> anyhow::Result<()> {
        let (kind, payload) = proto::parse_frame(&frame)?;
        match kind {
            proto::DATA => emit(
                app,
                "zl:client:data",
                json!({"tabId":tab_id,"data":payload}),
            ),
            proto::EXIT => emit(
                app,
                "zl:client:remote-exit",
                json!({"code":proto::decode_exit(payload)}),
            ),
            proto::FILE_META => {
                if let Some(error) = sink.meta(payload)? {
                    peer.send(error).await?;
                }
            }
            proto::FILE_CHUNK => {
                if let Some(error) = sink.chunk(payload)? {
                    peer.send(error).await?;
                }
            }
            proto::FILE_END => {
                let (reply, done) = sink.end(payload)?;
                if let Some(reply) = reply {
                    peer.send(reply).await?;
                }
                if let Some(done) = done {
                    emit(app, "zl:client:file-done", done);
                }
            }
            proto::FILE_ACK => {
                ensure!(payload.len() >= 4, "FILE_ACK payload too short");
                let id = proto::decode_u32(payload)?;
                let bytes = payload
                    .get(4..8)
                    .map(proto::decode_u32)
                    .transpose()?
                    .unwrap_or(0);
                emit(app, "zl:client:file-done", json!({"id":id,"bytes":bytes}));
            }
            proto::FILE_ERR => {
                let message = String::from_utf8_lossy(payload.get(4..).unwrap_or_default());
                emit(app, "zl:client:file-error", json!({"message":message}));
            }
            proto::FWD_DATA => {
                let (id, data) = proto::decode_fwd_data(payload)?;
                if let Some(writer) = writers.get_mut(&id) {
                    writer.write_all(data).await?;
                }
            }
            proto::FWD_CLOSE => {
                if let Some(mut writer) = writers.remove(&proto::decode_u32(payload)?) {
                    let _ = writer.shutdown().await;
                }
            }
            _ => {}
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn add_forward(
        app: &AppHandle,
        peer: &Peer,
        async_tx: &mpsc::UnboundedSender<ClientAsync>,
        sequence: &Arc<AtomicU32>,
        servers: &mut HashMap<u16, tauri::async_runtime::JoinHandle<()>>,
        local_port: u16,
        remote_host: String,
        remote_port: u16,
    ) -> anyhow::Result<Value> {
        ensure!(local_port > 0 && remote_port > 0, "invalid port");
        ensure!(
            !servers.contains_key(&local_port),
            "local port already forwarded"
        );
        let listener = TcpListener::bind(("127.0.0.1", local_port)).await?;
        let target = format!("{remote_host}:{remote_port}");
        let event_target = target.clone();
        let peer_for_task = peer.clone();
        let tx = async_tx.clone();
        let seq = sequence.clone();
        let task = tauri::async_runtime::spawn(async move {
            loop {
                let (stream, _) = match listener.accept().await {
                    Ok(value) => value,
                    Err(error) => {
                        let _ = tx.send(ClientAsync::ForwardError(local_port, error.to_string()));
                        break;
                    }
                };
                let id = seq.fetch_add(1, Ordering::Relaxed);
                let (mut reader, writer) = stream.into_split();
                if tx.send(ClientAsync::ForwardWriter(id, writer)).is_err() {
                    break;
                }
                if peer_for_task
                    .send(proto::frame(
                        proto::FWD_OPEN,
                        proto::encode_fwd_open(id, &target),
                    ))
                    .await
                    .is_err()
                {
                    break;
                }
                let stream_peer = peer_for_task.clone();
                tauri::async_runtime::spawn(async move {
                    let mut buffer = vec![0_u8; 16 * 1024];
                    loop {
                        match reader.read(&mut buffer).await {
                            Ok(0) | Err(_) => break,
                            Ok(count) => {
                                if stream_peer
                                    .send(proto::frame(
                                        proto::FWD_DATA,
                                        proto::encode_fwd_data(id, &buffer[..count]),
                                    ))
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                            }
                        }
                    }
                    let _ = stream_peer
                        .send(proto::frame(proto::FWD_CLOSE, proto::encode_u32(id)))
                        .await;
                });
            }
        });
        servers.insert(local_port, task);
        emit(
            app,
            "zl:client:forward-open",
            json!({"localPort":local_port,"target":event_target}),
        );
        Ok(json!({"localPort":local_port,"target":event_target}))
    }

    fn parse_target(target: &str) -> anyhow::Result<(String, u16)> {
        let (host, port) = target
            .rsplit_once(':')
            .context("invalid forwarding target")?;
        ensure!(!host.is_empty(), "invalid forwarding host");
        let port: u16 = port.parse()?;
        ensure!(port > 0, "invalid forwarding port");
        Ok((host.to_owned(), port))
    }

    async fn client_sender(
        state: &ZeroLinkState,
    ) -> Result<mpsc::UnboundedSender<ClientCommand>, String> {
        state
            .inner
            .lock()
            .await
            .client
            .clone()
            .ok_or_else(|| "not connected".into())
    }

    #[tauri::command]
    pub async fn zl_client_send(
        data: String,
        state: State<'_, ZeroLinkState>,
    ) -> Result<(), String> {
        client_sender(&state)
            .await?
            .send(ClientCommand::Send(data.into_bytes()))
            .map_err(|_| "client stopped".into())
    }

    #[tauri::command]
    pub async fn zl_client_resize(
        cols: f64,
        rows: f64,
        state: State<'_, ZeroLinkState>,
    ) -> Result<(), String> {
        let cols = cols.trunc().clamp(1.0, 1000.0) as u16;
        let rows = rows.trunc().clamp(1.0, 500.0) as u16;
        client_sender(&state)
            .await?
            .send(ClientCommand::Resize(cols, rows))
            .map_err(|_| "client stopped".into())
    }

    #[tauri::command]
    pub async fn zl_client_push_file(
        path: String,
        state: State<'_, ZeroLinkState>,
    ) -> Result<Value, String> {
        let (tx, rx) = oneshot::channel();
        client_sender(&state)
            .await?
            .send(ClientCommand::Push(PathBuf::from(path), tx))
            .map_err(|_| "client stopped".to_string())?;
        rx.await.map_err(|_| "client stopped".to_string())?
    }

    #[tauri::command]
    pub async fn zl_client_pull_file(
        remote_path: String,
        state: State<'_, ZeroLinkState>,
    ) -> Result<Value, String> {
        let (tx, rx) = oneshot::channel();
        client_sender(&state)
            .await?
            .send(ClientCommand::Pull(remote_path, tx))
            .map_err(|_| "client stopped".to_string())?;
        rx.await.map_err(|_| "client stopped".to_string())?
    }

    #[tauri::command]
    pub async fn zl_client_forward_add(
        local_port: u16,
        remote_host: String,
        remote_port: u16,
        state: State<'_, ZeroLinkState>,
    ) -> Result<Value, String> {
        let (tx, rx) = oneshot::channel();
        client_sender(&state)
            .await?
            .send(ClientCommand::ForwardAdd(
                local_port,
                remote_host,
                remote_port,
                tx,
            ))
            .map_err(|_| "client stopped".to_string())?;
        rx.await.map_err(|_| "client stopped".to_string())?
    }

    #[tauri::command]
    pub async fn zl_client_forward_remove(
        local_port: u16,
        state: State<'_, ZeroLinkState>,
    ) -> Result<(), String> {
        client_sender(&state)
            .await?
            .send(ClientCommand::ForwardRemove(local_port))
            .map_err(|_| "client stopped".into())
    }

    #[tauri::command]
    pub async fn zl_client_disconnect(state: State<'_, ZeroLinkState>) -> Result<(), String> {
        stop_client(&state).await;
        Ok(())
    }

    async fn stop_client(state: &ZeroLinkState) {
        if let Some(sender) = state.inner.lock().await.client.take() {
            let _ = sender.send(ClientCommand::Stop);
        }
    }
}

#[cfg(not(test))]
pub use service::*;

#[cfg(test)]
mod tests;
