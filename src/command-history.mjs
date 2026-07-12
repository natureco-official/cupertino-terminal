export function consumePromptInput(buffer, data, atPrompt) {
  if (!atPrompt) return { buffer, submitted: [] };
  if (String(data || '').includes('\x1b')) return { buffer: null, submitted: [] };
  let current = String(buffer || '');
  const submitted = [];
  for (const char of String(data || '')) {
    if (char === '\r' || char === '\n') {
      const command = current.trim();
      if (command) submitted.push(command);
      current = '';
    } else if (char === '\x7f' || char === '\b') {
      current = current.slice(0, -1);
    } else if (char === '\x15') {
      current = '';
    } else if (char >= ' ' && char !== '\x1b') {
      current += char;
    }
  }
  return { buffer: current, submitted };
}

export function normalizeHistory(entries, limit = 500) {
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry) => entry && typeof entry.command === 'string' && entry.command.trim()).slice(-limit).map((entry) => ({
    command: entry.command.trim().slice(0, 4096),
    cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
    exitCode: Number.isInteger(entry.exitCode) ? entry.exitCode : null,
    durationMs: Number.isFinite(entry.durationMs) ? Math.max(0, entry.durationMs) : null,
    timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : Date.now(),
  }));
}
