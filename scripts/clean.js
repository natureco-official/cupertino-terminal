'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const targets = [
  path.resolve(root, 'dist-tauri'),
  path.resolve(root, 'src-tauri', 'target'),
];
for (const target of targets) {
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Refusing to clean outside project: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}
