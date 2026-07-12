'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('OSC 7 paths and OSC 133 command lifecycle are tracked', async () => {
  const { parseOsc7, ShellState } = await import('../src/shell-state.mjs');
  assert.equal(parseOsc7('file://host/Users/test/My%20Project'), '/Users/test/My Project');
  assert.equal(parseOsc7('file://host/C:/Work/repo', 'win32'), 'C:/Work/repo');
  assert.equal(parseOsc7('https://example.com/path'), null);

  let now = 1000;
  const state = new ShellState(() => now);
  state.cwdChanged('/repo');
  state.osc133('A');
  state.commandStarted();
  now = 2350;
  const done = state.osc133('D;2');
  assert.deepEqual(done, {
    cwd: '/repo', atPrompt: true, running: false, lastExitCode: 2, lastDurationMs: 1350,
  });
});
