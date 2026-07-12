const MAX_TABS = 12;

export function normalizeSession(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.tabs)) return { tabs: [], activeIndex: 0 };
  const tabs = value.tabs.slice(0, MAX_TABS).map((tab) => ({
    profileKey: typeof tab?.profileKey === 'string' ? tab.profileKey : 'default',
    cwd: typeof tab?.cwd === 'string' && tab.cwd ? tab.cwd : null,
  }));
  const requested = Number.isInteger(value.activeIndex) ? value.activeIndex : 0;
  return { tabs, activeIndex: Math.max(0, Math.min(requested, Math.max(0, tabs.length - 1))) };
}

export function serializeSession(records, activeId) {
  const list = [...records];
  return normalizeSession({
    tabs: list.map(([id, rec]) => ({ profileKey: rec.profileKey || 'default', cwd: rec.shellState?.cwd || null })),
    activeIndex: Math.max(0, list.findIndex(([id]) => id === activeId)),
  });
}
