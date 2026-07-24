'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const env = { ...process.env };
if (process.platform === 'win32') {
  const required = [
    String.raw`C:\msys64\mingw64\bin`,
    String.raw`C:\Program Files\Rust stable GNU 1.97\bin`,
  ];
  const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === 'path');
  const currentPath = pathKeys.map((key) => env[key]).find(Boolean) || '';
  const existing = currentPath
    .split(path.delimiter)
    .filter((entry) => entry && !required.includes(entry));
  for (const key of pathKeys) delete env[key];
  env.PATH = [...required, ...existing].join(path.delimiter);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [
  path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'),
  'build',
  '--no-bundle',
]);

const executable = path.join(
  root,
  'src-tauri',
  'target',
  'release',
  process.platform === 'win32' ? 'cupertino-terminal.exe' : 'cupertino-terminal',
);
run(executable, ['--smoke-test'], { timeout: 30000 });
