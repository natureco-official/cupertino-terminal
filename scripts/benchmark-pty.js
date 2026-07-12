'use strict';

const { app } = require('electron');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');

const TARGET_BYTES = 5_000_000;
const LIMIT_MS = 15_000;

app.whenReady().then(() => {
  const isWin = process.platform === 'win32';
  const command = isWin ? 'powershell.exe' : '/bin/sh';
  const args = isWin
    ? ['-NoProfile', '-Command', `[Console]::Out.Write('x' * ${TARGET_BYTES})`]
    : ['-lc', `head -c ${TARGET_BYTES} /dev/zero | tr '\\0' x`];
  const started = performance.now();
  let bytes = 0;
  const child = pty.spawn(command, args, {
    name: 'xterm-256color', cols: 120, rows: 40, cwd: app.getPath('home'), env: process.env,
  });
  const timer = setTimeout(() => {
    try { child.kill(); } catch (_) {}
    console.error(`PTY benchmark exceeded ${LIMIT_MS}ms`);
    app.exit(1);
  }, LIMIT_MS);
  child.onData((data) => { bytes += Buffer.byteLength(data); });
  child.onExit(({ exitCode }) => {
    clearTimeout(timer);
    const elapsed = Math.round(performance.now() - started);
    const mbps = ((bytes / 1_000_000) / (elapsed / 1000)).toFixed(1);
    if (exitCode !== 0 || bytes < TARGET_BYTES) {
      console.error(`PTY benchmark incomplete: exit=${exitCode}, bytes=${bytes}`);
      app.exit(1);
      return;
    }
    console.log(`PTY benchmark passed: ${bytes} bytes in ${elapsed}ms (${mbps} MB/s)`);
    app.exit(0);
  });
});
