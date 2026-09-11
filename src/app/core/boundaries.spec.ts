import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Spec §3: "A feature never imports another feature." The ESLint rule is the
 * enforcement; this test is the proof that the rule is wired to something,
 * because a misconfigured no-restricted-imports passes silently and a rule
 * nobody checks is a comment.
 *
 * ESLint's `no-restricted-imports` matches on the raw specifier text alone —
 * it has no filesystem context, so it cannot resolve `../cart` and ask
 * "where does this actually land?". This test can, and that is precisely the
 * case a static import-pattern glob cannot cover: a *bare* relative escape
 * (`../cart`, with no trailing path segment) resolves outside the importing
 * file's own feature directory but matches no glob shape. Flagging every
 * relative import that resolves outside the owner feature — regardless of
 * where it lands — closes that hole without producing false positives on
 * legitimate same-feature relative imports (`./sub/thing`, `../sibling-file`),
 * because resolution is checked against the real directory tree, not a
 * pattern.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Finds every import in `featuresRoot` that reaches outside the importing
 * file's own top-level feature directory — either through the `@features/*`
 * alias (naming a different feature) or through a relative specifier
 * (`./`, `../`, ...) that resolves outside the owner directory once the
 * importing file's location is taken into account.
 */
function findFeatureBoundaryOffenders(featuresRoot: string): string[] {
  const offenders: string[] = [];

  for (const file of walk(featuresRoot)) {
    const owner = file.slice(featuresRoot.length + 1).split(/[\\/]/)[0];
    const ownerDir = join(featuresRoot, owner);
    const source = readFileSync(file, 'utf8');

    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1];

      if (specifier.startsWith('@features/')) {
        const importedFeature = specifier.slice('@features/'.length).split('/')[0];
        if (importedFeature !== owner) {
          offenders.push(`${file} imports @features/${importedFeature}`);
        }
        continue;
      }

      if (specifier.startsWith('.')) {
        const resolved = resolve(dirname(file), specifier);
        const staysInsideOwner = resolved === ownerDir || resolved.startsWith(ownerDir + sep);
        if (!staysInsideOwner) {
          offenders.push(`${file} imports '${specifier}' which resolves outside its own feature`);
        }
      }
    }
  }

  return offenders;
}

describe('import boundaries', () => {
  it('no feature imports another feature (real src/app/features tree)', () => {
    const featuresRoot = join(process.cwd(), 'src', 'app', 'features');
    expect(findFeatureBoundaryOffenders(featuresRoot)).toEqual([]);
  });

  it('core imports no feature', () => {
    const coreRoot = join(process.cwd(), 'src', 'app', 'core');
    const offenders = walk(coreRoot).filter((file) =>
      /from\s+['"]@features\//.test(readFileSync(file, 'utf8')),
    );

    expect(offenders).toEqual([]);
  });

  describe('relative-import escapes (fixture tree)', () => {
    let fixtureRoot: string;

    beforeEach(() => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'boundary-fixture-'));
    });

    afterEach(() => {
      rmSync(fixtureRoot, { recursive: true, force: true });
    });

    it('flags a bare relative import that escapes to a sibling feature', () => {
      mkdirSync(join(fixtureRoot, 'products'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'cart'), { recursive: true });
      writeFileSync(join(fixtureRoot, 'cart', 'index.ts'), `export const x = 1;\n`);
      writeFileSync(
        join(fixtureRoot, 'products', 'index.ts'),
        `import { x } from '../cart';\nexport { x };\n`,
      );

      const offenders = findFeatureBoundaryOffenders(fixtureRoot);

      expect(offenders).toEqual([
        `${join(fixtureRoot, 'products', 'index.ts')} imports '../cart' which resolves outside its own feature`,
      ]);
    });

    it('does not flag relative imports that stay inside the owner feature', () => {
      mkdirSync(join(fixtureRoot, 'products', 'sub'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'products', 'components'), { recursive: true });
      writeFileSync(join(fixtureRoot, 'products', 'sibling-file.ts'), `export const y = 1;\n`);
      writeFileSync(join(fixtureRoot, 'products', 'sub', 'thing.ts'), `export const z = 1;\n`);
      writeFileSync(
        join(fixtureRoot, 'products', 'index.ts'),
        `import { z } from './sub/thing';\nexport { z };\n`,
      );
      writeFileSync(
        join(fixtureRoot, 'products', 'components', 'foo.ts'),
        `import { y } from '../sibling-file';\nexport { y };\n`,
      );

      expect(findFeatureBoundaryOffenders(fixtureRoot)).toEqual([]);
    });

    it('still flags cross-feature alias imports (regression)', () => {
      mkdirSync(join(fixtureRoot, 'products'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'cart'), { recursive: true });
      writeFileSync(join(fixtureRoot, 'cart', 'index.ts'), `export const x = 1;\n`);
      // Built via concatenation, not one template literal: this spec file
      // lives under src/app/core and gets scanned by the "core imports no
      // feature" test above, so its own source must never spell out an
      // "import ... from" line pointing at the features alias verbatim.
      const aliasImportSpecifier = '@features' + '/cart';
      writeFileSync(
        join(fixtureRoot, 'products', 'index.ts'),
        `import { x } from '${aliasImportSpecifier}';\nexport { x };\n`,
      );

      expect(findFeatureBoundaryOffenders(fixtureRoot)).toEqual([
        `${join(fixtureRoot, 'products', 'index.ts')} imports @features/cart`,
      ]);
    });
  });
});
