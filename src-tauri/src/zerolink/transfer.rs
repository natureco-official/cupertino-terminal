use super::{peer::Peer, proto};
use anyhow::{ensure, Context};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_FILE_BYTES: u64 = 1024 * 1024 * 1024;
const CHUNK_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDone {
    pub id: u32,
    pub name: String,
    pub dest: String,
    pub bytes: u64,
}

struct Incoming {
    file: File,
    name: String,
    dest: PathBuf,
    temp: PathBuf,
    size: u64,
    received: u64,
}

pub struct FileSink {
    directory: PathBuf,
    incoming: HashMap<u32, Incoming>,
}

impl FileSink {
    pub fn downloads() -> Self {
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        Self::in_directory(home.join("ZeroLink-Downloads"))
    }

    pub fn in_directory(directory: PathBuf) -> Self {
        Self {
            directory,
            incoming: HashMap::new(),
        }
    }

    pub fn meta(&mut self, payload: &[u8]) -> anyhow::Result<Option<Vec<u8>>> {
        let meta = proto::decode_file_meta(payload)?;
        if meta.size > MAX_FILE_BYTES {
            return Ok(Some(file_error(meta.id, "file exceeds 1 GiB safety limit")));
        }
        self.remove_partial(meta.id);
        fs::create_dir_all(&self.directory)?;
        let safe = safe_basename(&meta.name, meta.id);
        let mut dest = self.directory.join(&safe);
        if dest.exists() {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            let extension = dest
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            let stem = dest
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("zerolink");
            let collision = if extension.is_empty() {
                format!("{stem}-{stamp}")
            } else {
                format!("{stem}-{stamp}.{extension}")
            };
            dest = self.directory.join(collision);
        }
        let temp = dest.with_extension(format!(
            "{}part-{}-{}",
            dest.extension()
                .and_then(|value| value.to_str())
                .map(|value| format!("{value}."))
                .unwrap_or_default(),
            std::process::id(),
            meta.id
        ));
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        let name = dest
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("zerolink")
            .to_owned();
        self.incoming.insert(
            meta.id,
            Incoming {
                file,
                name,
                dest,
                temp,
                size: meta.size,
                received: 0,
            },
        );
        Ok(None)
    }

    pub fn chunk(&mut self, payload: &[u8]) -> anyhow::Result<Option<Vec<u8>>> {
        let (id, data) = proto::decode_file_chunk(payload)?;
        let Some(incoming) = self.incoming.get_mut(&id) else {
            return Ok(None);
        };
        let next = incoming.received.saturating_add(data.len() as u64);
        if next > incoming.size || next > MAX_FILE_BYTES {
            self.remove_partial(id);
            return Ok(Some(file_error(id, "file exceeded declared size")));
        }
        incoming.file.write_all(data)?;
        incoming.received = next;
        Ok(None)
    }

    pub fn end(&mut self, payload: &[u8]) -> anyhow::Result<(Option<Vec<u8>>, Option<FileDone>)> {
        let id = proto::decode_u32(payload)?;
        let Some(mut incoming) = self.incoming.remove(&id) else {
            return Ok((None, None));
        };
        if incoming.received != incoming.size {
            drop(incoming.file);
            let _ = fs::remove_file(&incoming.temp);
            return Ok((Some(file_error(id, "file was received incompletely")), None));
        }
        incoming.file.flush()?;
        incoming.file.sync_all()?;
        drop(incoming.file);
        if let Err(error) = fs::rename(&incoming.temp, &incoming.dest) {
            let _ = fs::remove_file(&incoming.temp);
            return Err(error.into());
        }
        let mut ack = proto::encode_u32(id).to_vec();
        ack.extend_from_slice(&proto::encode_u32(
            u32::try_from(incoming.received).unwrap_or(u32::MAX),
        ));
        Ok((
            Some(proto::frame(proto::FILE_ACK, ack)),
            Some(FileDone {
                id,
                name: incoming.name,
                dest: incoming.dest.to_string_lossy().into_owned(),
                bytes: incoming.received,
            }),
        ))
    }

    pub fn destroy(&mut self) {
        let ids = self.incoming.keys().copied().collect::<Vec<_>>();
        for id in ids {
            self.remove_partial(id);
        }
    }

    fn remove_partial(&mut self, id: u32) {
        if let Some(incoming) = self.incoming.remove(&id) {
            drop(incoming.file);
            let _ = fs::remove_file(incoming.temp);
        }
    }
}

impl Drop for FileSink {
    fn drop(&mut self) {
        self.destroy();
    }
}

pub async fn send_file(
    peer: &Peer,
    id: u32,
    path: &Path,
    mut progress: impl FnMut(u64, u64, &str),
) -> anyhow::Result<proto::FileMeta> {
    let metadata = fs::metadata(path)?;
    ensure!(metadata.is_file(), "only regular files may be sent");
    ensure!(
        metadata.len() <= MAX_FILE_BYTES,
        "file exceeds 1 GiB safety limit"
    );
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .context("file name is not valid UTF-8")?
        .to_owned();
    let meta = proto::FileMeta {
        id,
        size: metadata.len(),
        name,
    };
    peer.send(proto::frame(
        proto::FILE_META,
        proto::encode_file_meta(&meta)?,
    ))
    .await?;
    let mut file = File::open(path)?;
    let mut buffer = vec![0_u8; CHUNK_BYTES];
    let mut sent = 0_u64;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        peer.send(proto::frame(
            proto::FILE_CHUNK,
            proto::encode_file_chunk(id, &buffer[..count]),
        ))
        .await?;
        sent += count as u64;
        progress(sent, meta.size, &meta.name);
    }
    peer.send(proto::frame(proto::FILE_END, proto::encode_u32(id)))
        .await?;
    Ok(meta)
}

pub fn file_error(id: u32, message: &str) -> Vec<u8> {
    let mut payload = proto::encode_u32(id).to_vec();
    payload.extend_from_slice(message.as_bytes());
    proto::frame(proto::FILE_ERR, payload)
}

fn safe_basename(name: &str, id: u32) -> String {
    let basename = Path::new(name)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let safe = basename
        .chars()
        .map(|character| {
            if matches!(
                character,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            ) || character.is_control()
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    if safe.is_empty() || safe == "." || safe == ".." {
        format!("zerolink-{id}")
    } else {
        safe
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn received_name_cannot_escape_download_directory() {
        assert_eq!(safe_basename("../../evil.txt", 1), "evil.txt");
        assert_eq!(safe_basename(r"..\..\evil:name.txt", 2), "evil_name.txt");
    }
}
