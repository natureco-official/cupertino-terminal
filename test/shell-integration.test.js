const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('zsh integration restores writable user config and emits OSC as bytes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'shell-integration', '.zshrc'), 'utf8');

  const restoreIndex = source.indexOf('ZDOTDIR="$CUPERTINO_ORIGINAL_ZDOTDIR"');
  const sourceIndex = source.indexOf('source "$ZDOTDIR/.zshrc"');
  assert.ok(restoreIndex >= 0 && sourceIndex > restoreIndex, 'ZDOTDIR must be restored before user config is sourced');
  assert.doesNotMatch(source, /PROMPT=.*\$'\\e\]133;B\\a'/, 'quoted ANSI expression would render as prompt text');
  assert.match(source, /PROMPT=.*_cupertino_esc.*\]133;B.*_cupertino_bel/, 'prompt must contain expanded ESC and BEL bytes');
});
