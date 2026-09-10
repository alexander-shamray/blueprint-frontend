import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Spec §3: "A feature never imports another feature." The ESLint rule is the
 * enforcement; this test is the proof that the rule is wired to something,
 * because a misconfigured no-restricted-imports passes silently and a rule
 * nobody checks is a comment.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('import boundaries', () => {
  const featuresRoot = join(process.cwd(), 'src', 'app', 'features');

  it('no feature imports another feature', () => {
    const offenders: string[] = [];

    for (const file of walk(featuresRoot)) {
      const owner = file.slice(featuresRoot.length + 1).split(/[\\/]/)[0];
      const source = readFileSync(file, 'utf8');

      for (const match of source.matchAll(/from\s+['"]@features\/([^/'"]+)/g)) {
        if (match[1] !== owner) offenders.push(`${file} imports @features/${match[1]}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('core imports no feature', () => {
    const coreRoot = join(process.cwd(), 'src', 'app', 'core');
    const offenders = walk(coreRoot).filter((file) =>
      /from\s+['"]@features\//.test(readFileSync(file, 'utf8')),
    );

    expect(offenders).toEqual([]);
  });
});
