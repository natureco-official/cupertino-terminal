// Install the Tauri facade before the existing renderer is evaluated.
(async () => {
  if (window.__TAURI_INTERNALS__) {
    await import('./term-api-tauri.js');
  }
  await import('./renderer.js');
})().catch((error) => {
  console.error('Cupertino Terminal failed to initialize:', error);
});
