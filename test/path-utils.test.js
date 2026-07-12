'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { validDirectory, directoryFromDeepLink, directoryFromArgs } = require('../src/path-utils');

test('validDirectory accepts directories and rejects files/missing input', () => {
  assert.equal(validDirectory(os.tmpdir()), path.resolve(os.tmpdir()));
  assert.equal(validDirectory(__filename), null);
  assert.equal(validDirectory(''), null);
  assert.equal(validDirectory(path.join(os.tmpdir(), 'cupertino-does-not-exist')), null);
});

test('directoryFromDeepLink accepts only terminal and shell schemes', () => {
  assert.equal(directoryFromDeepLink('terminal:///Users/test/My%20Project'), '/Users/test/My Project');
  assert.equal(directoryFromDeepLink('shell:///tmp'), '/tmp');
  assert.equal(directoryFromDeepLink('terminal:///C:/Users/test', 'win32'), 'C:/Users/test');
  assert.equal(directoryFromDeepLink('https://example.com/tmp'), null);
  assert.equal(directoryFromDeepLink('not a url'), null);
});

test('directoryFromArgs handles packaged and development Electron argv layouts', () => {
  assert.equal(directoryFromArgs(['app.exe', os.tmpdir()], false), path.resolve(os.tmpdir()));
  assert.equal(directoryFromArgs(['electron.exe', 'project', os.tmpdir()], true), path.resolve(os.tmpdir()));
  assert.equal(directoryFromArgs(['app.exe', '--flag', 'missing'], false), null);
});
