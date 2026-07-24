'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('command palette fuzzy search prioritizes strong matches', async () => {
  const { filterCommands } = await import('../src/command-palette.mjs');
  const commands = [
    { id: 'settings', label: 'Open Settings', keywords: 'preferences' },
    { id: 'tab', label: 'New Tab', keywords: 'terminal' },
    { id: 'theme', label: 'Change Theme', keywords: 'appearance' },
  ];
  assert.equal(filterCommands(commands, 'sett')[0].id, 'settings');
  assert.equal(filterCommands(commands, 'pref')[0].id, 'settings');
  assert.deepEqual(filterCommands(commands, 'not-found'), []);
  const { appModifier } = await import('../src/keymap.mjs');
  assert.equal(appModifier({ ctrlKey: true, metaKey: false }, true), false);
  assert.equal(appModifier({ ctrlKey: false, metaKey: true }, true), true);
  assert.equal(appModifier({ ctrlKey: true, metaKey: false }, false), true);
});
