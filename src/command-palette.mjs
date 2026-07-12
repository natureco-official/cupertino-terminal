export function fuzzyScore(query, text) {
  const needle = String(query || '').trim().toLowerCase();
  const haystack = String(text || '').toLowerCase();
  if (!needle) return 1;
  let score = 0;
  let cursor = 0;
  let streak = 0;
  for (const char of needle) {
    const index = haystack.indexOf(char, cursor);
    if (index === -1) return -1;
    streak = index === cursor ? streak + 1 : 0;
    score += 10 + streak * 4 - Math.min(8, index - cursor);
    cursor = index + 1;
  }
  if (haystack.startsWith(needle)) score += 40;
  return score - haystack.length * 0.01;
}

export function filterCommands(commands, query) {
  return commands
    .map((command) => ({ command, score: fuzzyScore(query, `${command.label} ${command.keywords || ''}`) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score || a.command.label.localeCompare(b.command.label))
    .map(({ command }) => command);
}
