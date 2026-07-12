'use strict';

const path = require('path');

function validDirectory(candidate, fsImpl = require('fs')) {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  try {
    const resolved = path.resolve(candidate);
    return fsImpl.statSync(resolved).isDirectory() ? resolved : null;
  } catch (_) { return null; }
}

function directoryFromDeepLink(value, platform = process.platform) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'terminal:' && parsed.protocol !== 'shell:') return null;
    let pathname = decodeURIComponent(parsed.pathname || '');
    if (platform === 'win32' && /^\/[a-zA-Z]:\//.test(pathname)) pathname = pathname.slice(1);
    return pathname || null;
  } catch (_) { return null; }
}

function directoryFromArgs(argv, defaultApp = false, fsImpl = require('fs')) {
  if (!Array.isArray(argv)) return null;
  const start = defaultApp ? 2 : 1;
  for (const arg of argv.slice(start)) {
    if (!arg || arg.startsWith('-') || /^(terminal|shell):/i.test(arg)) continue;
    const cwd = validDirectory(arg, fsImpl);
    if (cwd) return cwd;
  }
  return null;
}

module.exports = { validDirectory, directoryFromDeepLink, directoryFromArgs };
