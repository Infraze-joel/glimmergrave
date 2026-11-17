// Content version of the unfingerprinted files under client/public/assets (models, sounds).
// Their names stay the same between releases, so every URL carries this version as `?v=` (see
// client/src/core/assetVersion.ts): a browser can then never combine new code with older cached files.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const VERSION_LENGTH = 10;
const NO_ASSETS = 'none';

/** Relative paths of all files below `dir`, sorted, with forward slashes on every platform. */
function listFiles(dir, prefix = '') {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(join(dir, entry.name), rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files.sort();
}

/** Short hex digest over the names and contents of every file below `dir`. */
export function assetVersion(dir) {
  if (!existsSync(dir)) return NO_ASSETS;
  const hash = createHash('sha256');
  for (const rel of listFiles(dir)) {
    const data = readFileSync(join(dir, rel));
    hash.update(`${rel}\0${data.length}\0`);
    hash.update(data);
  }
  return hash.digest('hex').slice(0, VERSION_LENGTH);
}
