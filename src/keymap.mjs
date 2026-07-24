export function appModifier(event, isMac) {
  return isMac ? event.metaKey : event.ctrlKey || event.metaKey;
}
