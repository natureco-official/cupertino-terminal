#!/usr/bin/env node
'use strict';
/**
 * Global npm kurulumundan uygulamayı başlatır:  `cupertino-terminal`
 * (`npm install -g cupertino-terminal` sonrası her yerde çalışır; Win + macOS + Linux)
 *
 * electron olmayan bir Node bağlamında require('electron') → electron ikilisinin
 * dosya yolunu (string) döndürür; onu bu paket dizinini uygulama olarak vererek başlatırız.
 */
const { spawn } = require('child_process');
const path = require('path');

let electron;
try {
  electron = require('electron');
} catch (_) {
  console.error('electron bulunamadı. Kurulum bozuk olabilir — "npm install -g cupertino-terminal" ile tekrar deneyin.');
  process.exit(1);
}

const child = spawn(electron, [path.join(__dirname)], { stdio: 'inherit', windowsHide: false });
child.on('close', (code) => process.exit(code == null ? 0 : code));
child.on('error', (err) => { console.error('Başlatma hatası:', err.message); process.exit(1); });
