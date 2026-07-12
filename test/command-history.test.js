'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('prompt input handles typing, backspace, clear and submission', async () => {
  const { consumePromptInput } = await import('../src/command-history.mjs');
  let state = consumePromptInput('', 'git stats\x7fus\r', true);
  assert.deepEqual(state, { buffer: '', submitted: ['git status'] });
  state = consumePromptInput('secret', '\x15echo ok\r', true);
  assert.deepEqual(state.submitted, ['echo ok']);
  assert.deepEqual(consumePromptInput('', 'password\r', false), { buffer: '', submitted: [] });
  assert.deepEqual(consumePromptInput('echo ok', '\x1b[A', true), { buffer: null, submitted: [] });
});

test('history normalization bounds and sanitizes entries', async () => {
  const { normalizeHistory } = await import('../src/command-history.mjs');
  const result = normalizeHistory([{ command: '  npm test  ', exitCode: 0, durationMs: -1 }, null], 10);
  assert.equal(result[0].command, 'npm test');
  assert.equal(result[0].durationMs, 0);
});
