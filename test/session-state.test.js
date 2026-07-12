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

test('split layouts preserve direction, bounded ratio and child context', async () => {
  const { normalizeSession, serializeSession } = await import('../src/session-state.mjs');
  const records = new Map([
    ['root', { profileKey: 'zsh', splitChildId: 'child', splitDirection: 'horizontal', splitRatio: 65, shellState: { cwd: '/root' } }],
    ['child', { parentId: 'root', profileKey: 'bash', shellState: { cwd: '/child' } }],
  ]);
  const saved = serializeSession(records, 'child');
  assert.deepEqual(saved.tabs[0].split, { direction: 'horizontal', ratio: 65, profileKey: 'bash', cwd: '/child' });
  assert.equal(saved.activeIndex, 0);
  assert.equal(normalizeSession({ tabs: [{ split: { direction: 'vertical', ratio: 99 } }] }).tabs[0].split.ratio, 80);
});
