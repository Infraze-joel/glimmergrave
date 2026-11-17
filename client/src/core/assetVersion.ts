// Models and sounds keep their file names between releases. Every URL to them carries the content version
// of the whole assets folder (computed at build time, see scripts/asset-version.mjs and vite.config.ts), so a
// browser cache can never hand an older file to newer code. All loaders must build their URLs with assetUrl().

declare const __ASSET_VERSION__: string | undefined;

const UNVERSIONED = 'dev';

/** Content version of client/public/assets; a fixed marker outside a Vite build (unit tests). */
export const ASSET_VERSION: string = typeof __ASSET_VERSION__ === 'string' ? __ASSET_VERSION__ : UNVERSIONED;

/** URL of a file under /assets/, tagged with the content version. */
export function assetUrl(path: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}v=${ASSET_VERSION}`;
}
