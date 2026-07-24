use anyhow::{bail, Context};
use cupertino_terminal_lib::{headless_connect, start_headless_host};
use std::time::Duration;

const HOST_TIMEOUT: Duration = Duration::from_secs(120);
const CLIENT_TIMEOUT: Duration = Duration::from_secs(60);
const COMMAND: &[u8] = b"echo ZL_XDEV_OK_$$\n";
const MARKER: &[u8] = b"ZL_XDEV_OK_";

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("host") if args.next().is_none() => {
            if let Err(error) = run_host().await {
                eprintln!("ZeroLink host error: {error:#}");
                std::process::exit(1);
            }
        }
        Some("connect") => {
            let result = run_connect(args.next(), args.next()).await;
            if let Err(error) = result {
                println!("RESULT=FAIL:{error:#}");
                std::process::exit(1);
            }
        }
        _ => {
            eprintln!("usage: zl-e2e host | zl-e2e connect <code>");
            std::process::exit(1);
        }
    }
}

async fn run_host() -> anyhow::Result<()> {
    let host = start_headless_host().await.context("host start failed")?;
    println!("ZLCODE={}", host.code());
    host.serve_for(HOST_TIMEOUT).await.context("host failed")
}

async fn run_connect(code: Option<String>, extra: Option<String>) -> anyhow::Result<()> {
    let code = code.context("usage: zl-e2e connect <code>")?;
    if extra.is_some() {
        bail!("usage: zl-e2e connect <code>");
    }
    headless_connect(&code, COMMAND, MARKER, CLIENT_TIMEOUT)
        .await
        .context("connect failed")?;
    println!("RESULT=PASS");
    Ok(())
}
