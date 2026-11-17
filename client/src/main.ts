/**
 * Entry point. Dev-only harnesses are selected by query parameter and are tree-shaken from production builds:
 *   ?showcase  – render kit showcase (no network)
 *   ?uidemo    – UI + audio demo with fake state (no network)
 *   ?autopilot – the real game, but a scripted brain plays the own hero (see game/boot.ts)
 */
const params = new URLSearchParams(window.location.search);

if (import.meta.env.DEV && params.has('showcase')) {
  void import('./dev/showcase.ts');
} else if (import.meta.env.DEV && params.has('uidemo')) {
  void import('./dev/uidemo.ts');
} else {
  void import('./game/boot.ts');
}
