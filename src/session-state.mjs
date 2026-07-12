const MAX_TABS = 12;

export function normalizeSession(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.tabs)) return { tabs: [], activeIndex: 0 };
  const tabs = value.tabs.slice(0, MAX_TABS).map((tab) => ({
    profileKey: typeof tab?.profileKey === 'string' ? tab.profileKey : 'default',
    cwd: typeof tab?.cwd === 'string' && tab.cwd ? tab.cwd : null,
    ...(tab?.split && (tab.split.direction === 'vertical' || tab.split.direction === 'horizontal') ? {
      split: {
        direction: tab.split.direction,
        ratio: Math.max(20, Math.min(80, Number(tab.split.ratio) || 50)),
        profileKey: typeof tab.split.profileKey === 'string' ? tab.split.profileKey : 'default',
        cwd: typeof tab.split.cwd === 'string' && tab.split.cwd ? tab.split.cwd : null,
      },
    } : {}),
  }));
  const requested = Number.isInteger(value.activeIndex) ? value.activeIndex : 0;
  return { tabs, activeIndex: Math.max(0, Math.min(requested, Math.max(0, tabs.length - 1))) };
}

export function serializeSession(records, activeId) {
  const all = [...records];
  const list = all.filter(([, rec]) => !rec.parentId);
  const activeRecord = records.get(activeId);
  const activeRootId = activeRecord?.parentId || activeId;
  return normalizeSession({
    tabs: list.map(([id, rec]) => {
      const child = rec.splitChildId ? records.get(rec.splitChildId) : null;
      return {
        profileKey: rec.profileKey || 'default',
        cwd: rec.shellState?.cwd || null,
        ...(child ? { split: {
          direction: rec.splitDirection || 'vertical',
          ratio: rec.splitRatio || 50,
          profileKey: child.profileKey || 'default',
          cwd: child.shellState?.cwd || null,
        } } : {}),
      };
    }),
    activeIndex: Math.max(0, list.findIndex(([id]) => id === activeRootId)),
  });
}
