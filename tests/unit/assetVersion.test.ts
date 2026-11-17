// The asset version is the cache key of every model and sound URL: it must follow the file contents exactly.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetVersion } from '../../scripts/asset-version.mjs';

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'glimmergrave-assets-'));
  mkdirSync(join(dir, 'models'));
  mkdirSync(join(dir, 'audio'));
  writeFileSync(join(dir, 'models', 'props.glb'), 'props-v1');
  writeFileSync(join(dir, 'audio', 'hit.mp3'), 'hit-v1');
  return dir;
}

describe('assetVersion', () => {
  it('is a short hex string that is stable for unchanged files', () => {
    const dir = fixture();
    expect(assetVersion(dir)).toMatch(/^[0-9a-f]{10}$/);
    expect(assetVersion(dir)).toBe(assetVersion(dir));
    expect(assetVersion(fixture())).toBe(assetVersion(dir));
  });

  it('changes when the content of any file changes, even at the same size', () => {
    const dir = fixture();
    const before = assetVersion(dir);
    writeFileSync(join(dir, 'models', 'props.glb'), 'props-v2');
    expect(assetVersion(dir)).not.toBe(before);
  });

  it('changes when a file is added or renamed', () => {
    const dir = fixture();
    const before = assetVersion(dir);
    writeFileSync(join(dir, 'models', 'hero.glb'), 'hero');
    const added = assetVersion(dir);
    expect(added).not.toBe(before);
    renameSync(join(dir, 'models', 'hero.glb'), join(dir, 'models', 'hero2.glb'));
    expect(assetVersion(dir)).not.toBe(added);
  });

  it('falls back to a fixed marker when the folder does not exist', () => {
    expect(assetVersion(join(tmpdir(), 'glimmergrave-no-such-folder'))).toBe('none');
  });
});
