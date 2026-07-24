use anyhow::{ensure, Context};

pub const DATA: u8 = 0x01;
pub const RESIZE: u8 = 0x02;
pub const EXEC: u8 = 0x03;
pub const EXIT: u8 = 0x04;
pub const FILE_META: u8 = 0x10;
pub const FILE_CHUNK: u8 = 0x11;
pub const FILE_END: u8 = 0x12;
pub const FILE_ACK: u8 = 0x13;
pub const FILE_ERR: u8 = 0x14;
pub const FILE_REQ: u8 = 0x15;
pub const FWD_OPEN: u8 = 0x20;
pub const FWD_DATA: u8 = 0x21;
pub const FWD_CLOSE: u8 = 0x22;

#[derive(Debug, Clone)]
pub struct FileMeta {
    pub id: u32,
    pub size: u64,
    pub name: String,
}

pub fn frame(kind: u8, payload: impl AsRef<[u8]>) -> Vec<u8> {
    let payload = payload.as_ref();
    let mut result = Vec::with_capacity(1 + payload.len());
    result.push(kind);
    result.extend_from_slice(payload);
    result
}

pub fn parse_frame(bytes: &[u8]) -> anyhow::Result<(u8, &[u8])> {
    bytes
        .split_first()
        .map(|(kind, body)| (*kind, body))
        .context("empty frame")
}

pub fn encode_resize(cols: u16, rows: u16) -> [u8; 4] {
    let mut value = [0_u8; 4];
    value[..2].copy_from_slice(&cols.max(1).to_be_bytes());
    value[2..].copy_from_slice(&rows.max(1).to_be_bytes());
    value
}

pub fn decode_resize(payload: &[u8]) -> anyhow::Result<(u16, u16)> {
    ensure!(payload.len() >= 4, "RESIZE payload too short");
    Ok((
        u16::from_be_bytes(payload[..2].try_into()?),
        u16::from_be_bytes(payload[2..4].try_into()?),
    ))
}

pub fn encode_exit(code: i32) -> [u8; 4] {
    code.to_be_bytes()
}

pub fn decode_exit(payload: &[u8]) -> i32 {
    payload
        .get(..4)
        .and_then(|value| value.try_into().ok())
        .map(i32::from_be_bytes)
        .unwrap_or(0)
}

pub fn encode_u32(value: u32) -> [u8; 4] {
    value.to_be_bytes()
}

pub fn decode_u32(payload: &[u8]) -> anyhow::Result<u32> {
    ensure!(payload.len() >= 4, "U32 payload too short");
    Ok(u32::from_be_bytes(payload[..4].try_into()?))
}

pub fn encode_file_meta(meta: &FileMeta) -> anyhow::Result<Vec<u8>> {
    let name = meta.name.as_bytes();
    ensure!(name.len() <= u16::MAX as usize, "file name too long");
    let mut output = Vec::with_capacity(14 + name.len());
    output.extend_from_slice(&meta.id.to_be_bytes());
    output.extend_from_slice(&meta.size.to_be_bytes());
    output.extend_from_slice(&(name.len() as u16).to_be_bytes());
    output.extend_from_slice(name);
    Ok(output)
}

pub fn decode_file_meta(payload: &[u8]) -> anyhow::Result<FileMeta> {
    ensure!(payload.len() >= 14, "FILE_META payload too short");
    let name_len = usize::from(u16::from_be_bytes(payload[12..14].try_into()?));
    ensure!(
        name_len <= 4096 && payload.len() == 14 + name_len,
        "invalid FILE_META name"
    );
    Ok(FileMeta {
        id: u32::from_be_bytes(payload[..4].try_into()?),
        size: u64::from_be_bytes(payload[4..12].try_into()?),
        name: String::from_utf8(payload[14..].to_vec()).context("FILE_META name is not UTF-8")?,
    })
}

pub fn encode_file_chunk(id: u32, data: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(4 + data.len());
    output.extend_from_slice(&id.to_be_bytes());
    output.extend_from_slice(data);
    output
}

pub fn decode_file_chunk(payload: &[u8]) -> anyhow::Result<(u32, &[u8])> {
    ensure!(payload.len() >= 4, "FILE_CHUNK payload too short");
    Ok((decode_u32(payload)?, &payload[4..]))
}

pub fn encode_file_req(id: u32, path: &str) -> Vec<u8> {
    let mut output = encode_u32(id).to_vec();
    output.extend_from_slice(path.as_bytes());
    output
}

pub fn decode_file_req(payload: &[u8]) -> anyhow::Result<(u32, String)> {
    ensure!(payload.len() >= 5, "FILE_REQ payload too short");
    Ok((
        decode_u32(payload)?,
        String::from_utf8(payload[4..].to_vec())?,
    ))
}

pub fn encode_fwd_open(id: u32, target: &str) -> Vec<u8> {
    encode_file_req(id, target)
}

pub fn decode_fwd_open(payload: &[u8]) -> anyhow::Result<(u32, String)> {
    ensure!(payload.len() >= 6, "FWD_OPEN payload too short");
    decode_file_req(payload)
}

pub fn encode_fwd_data(id: u32, data: &[u8]) -> Vec<u8> {
    encode_file_chunk(id, data)
}

pub fn decode_fwd_data(payload: &[u8]) -> anyhow::Result<(u32, &[u8])> {
    decode_file_chunk(payload)
}
