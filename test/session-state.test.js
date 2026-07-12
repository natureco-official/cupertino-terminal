'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('sessions are bounded, normalized and keep the active tab', async () => {
  const { normalizeSession, serializeSession } = await import('../src/session-state.mjs');
  const records = new Map([
    ['a', { profileKey: 'zsh', shellState: { cwd: '/one' } }],
    ['b', { profileKey: 'bash', shellState: { cwd: '/two' } }],
  ]);
  assert.deepEqual(serializeSession(records, 'b'), {
    tabs: [{ profileKey: 'zsh', cwd: '/one' }, { profileKey: 'bash', cwd: '/two' }], activeIndex: 1,
  });
  const bad = normalizeSession({ tabs: new Array(20).fill(null), activeIndex: 99 });
  assert.equal(bad.tabs.length, 12);
  assert.equal(bad.activeIndex, 11);
});
