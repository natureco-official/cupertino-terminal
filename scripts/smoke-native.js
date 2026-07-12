'use strict';

const { app } = require('electron');

async function run() {
  require('node-datachannel');
  const pty = require('@homebridge/node-pty-prebuilt-multiarch');
  const isWin = process.platform === 'win32';
  const command = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/zsh');
  const args = isWin
    ? ['-NoProfile', '-Command', "Write-Output 'CUPERTINO_SMOKE_OK'"]
    : ['-lc', "printf 'CUPERTINO_SMOKE_OK\\n'"];

  await new Promise((resolve, reject) => {
    let output = '';
    const child = pty.spawn(command, args, {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: app.getPath('home'), env: process.env,
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      reject(new Error('PTY smoke test timed out'));
    }, 10000);
    child.onData((data) => { output += data; });
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode === 0 && output.includes('CUPERTINO_SMOKE_OK')) resolve();
      else reject(new Error(`PTY smoke test failed (exit ${exitCode}): ${output}`));
    });
  });
}

app.whenReady()
  .then(run)
  .then(() => { console.log('Native Electron smoke test passed'); app.exit(0); })
  .catch((error) => { console.error(error); app.exit(1); });
