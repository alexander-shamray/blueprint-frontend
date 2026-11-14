import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Spec §3: "A feature never imports another feature", and core knows nothing
 * about screens. The ESLint rule is the enforcement; this test is the proof
 * that the rule is wired to something, because a misconfigured
 * no-restricted-imports passes silently and a rule nobody checks is a comment.
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
 *
 * The specifiers come from the TypeScript parser rather than a pattern over
 * the text (#551), so every way a module is named counts: `import … from`, a
 * side-effect `import '…'`, `export … from`, `import x = require('…')`, an
 * `import('…')` call and an `import('…')` type. Both halves read them the same
 * way: core may reach no feature by the alias or by a relative path, and the
 * ESLint rule sees no `import()` call at all. A specifier in a comment or a
 * string is not an import, so the fixtures below can spell one out.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

/** Every module specifier a file names as a string literal, in source order. */
function importSpecifiers(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        found.push(node.moduleSpecifier.text);
      }
    } else if (ts.isExternalModuleReference(node) && ts.isStringLiteral(node.expression)) {
      found.push(node.expression.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteralLike(argument)) found.push(argument.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      if (ts.isStringLiteral(node.argument.literal)) found.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The feature an `@features` specifier names, or `undefined` for any other specifier. */
function aliasedFeature(specifier: string): string | undefined {
  if (specifier !== '@features' && !specifier.startsWith('@features/')) return undefined;
  return specifier.slice('@features/'.length).split('/')[0];
}

function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + sep);
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

    for (const specifier of importSpecifiers(file, readFileSync(file, 'utf8'))) {
      const importedFeature = aliasedFeature(specifier);
      if (importedFeature !== undefined) {
        if (importedFeature !== owner) {
          offenders.push(`${file} imports @features/${importedFeature}`);
        }
        continue;
      }

      if (specifier.startsWith('.') && !isInside(resolve(dirname(file), specifier), ownerDir)) {
        offenders.push(`${file} imports '${specifier}' which resolves outside its own feature`);
      }
    }
  }

  return offenders;
}

/** Finds every import in `coreRoot` that names a feature by the alias or lands under `featuresRoot`. */
function findCoreBoundaryOffenders(coreRoot: string, featuresRoot: string): string[] {
  const offenders: string[] = [];

  for (const file of walk(coreRoot)) {
    for (const specifier of importSpecifiers(file, readFileSync(file, 'utf8'))) {
      if (aliasedFeature(specifier) !== undefined) {
        offenders.push(`${file} imports ${specifier}`);
      } else if (
        specifier.startsWith('.') &&
        isInside(resolve(dirname(file), specifier), featuresRoot)
      ) {
        offenders.push(`${file} imports '${specifier}' which resolves into a feature`);
      }
    }
  }

  return offenders;
}

describe('import boundaries', () => {
  const appRoot = join(process.cwd(), 'src', 'app');

  it('no feature imports another feature (real src/app/features tree)', () => {
    expect(findFeatureBoundaryOffenders(join(appRoot, 'features'))).toEqual([]);
  });

  it('core imports no feature (real src/app/core tree)', () => {
    expect(findCoreBoundaryOffenders(join(appRoot, 'core'), join(appRoot, 'features'))).toEqual(
      [],
    );
  });

  it('is not vacuous: it reads the imports of both real trees', () => {
    const count = (dir: string): number =>
      walk(join(appRoot, dir)).flatMap((file) => importSpecifiers(file, readFileSync(file, 'utf8')))
        .length;

    expect(count('core')).toBeGreaterThan(100);
    expect(count('features')).toBeGreaterThan(100);
  });

  it('reads every way a module is named, and nothing in a comment or a string', () => {
    const sample = [
      "import { a } from './a';",
      "import './b';",
      "export { c } from './c';",
      "export * from './d';",
      "import e = require('./e');",
      "const f = await import('./f');",
      "let g: import('./g').G;",
      "// import { h } from './h';",
      'const i = "import { i } from \'./i\'";',
    ].join('\n');

    expect(importSpecifiers('sample.ts', sample)).toEqual([
      './a',
      './b',
      './c',
      './d',
      './e',
      './f',
      './g',
    ]);
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
        `import { z } from './sub/thing';\nexport { z };\nexport const lazy = () => import('./sub/thing');\n`,
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
      writeFileSync(
        join(fixtureRoot, 'products', 'index.ts'),
        `import { x } from '@features/cart';\nexport { x };\n`,
      );

      expect(findFeatureBoundaryOffenders(fixtureRoot)).toEqual([
        `${join(fixtureRoot, 'products', 'index.ts')} imports @features/cart`,
      ]);
    });

    it.each([
      ['a side-effect import', `import '../cart';\n`, `'../cart' which resolves outside`],
      ['a re-export', `export { x } from '../cart';\n`, `'../cart' which resolves outside`],
      [
        'a dynamic relative import',
        `export const p = () => import('../cart/cart.page');\n`,
        `'../cart/cart.page' which resolves outside`,
      ],
      [
        'a dynamic alias import',
        `export const p = () => import('@features/cart/cart.page');\n`,
        `@features/cart`,
      ],
    ])('flags a feature reaching another by %s (#551)', (_form, source, reach) => {
      mkdirSync(join(fixtureRoot, 'products'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'cart'), { recursive: true });
      writeFileSync(join(fixtureRoot, 'products', 'index.ts'), source);

      const offenders = findFeatureBoundaryOffenders(fixtureRoot);

      expect(offenders).toHaveLength(1);
      expect(offenders[0]).toContain(`${join(fixtureRoot, 'products', 'index.ts')} imports ${reach}`);
    });

    it.each([
      ['the alias', `import { CartPage } from '@features/cart/cart.page';\n`],
      ['a relative path', `import { CartPage } from '../../features/cart/cart.page';\n`],
      ['a side-effect import', `import '../../features/cart';\n`],
      ['a dynamic import', `export const p = () => import('../../features/cart/cart.page');\n`],
      ['a dynamic alias import', `export const p = () => import('@features/cart');\n`],
    ])('flags core reaching a feature by %s (#551)', (_form, source) => {
      mkdirSync(join(fixtureRoot, 'core', 'api'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'features', 'cart'), { recursive: true });
      writeFileSync(join(fixtureRoot, 'core', 'api', 'client.ts'), source);

      const offenders = findCoreBoundaryOffenders(
        join(fixtureRoot, 'core'),
        join(fixtureRoot, 'features'),
      );

      expect(offenders).toHaveLength(1);
      expect(offenders[0]).toContain(join(fixtureRoot, 'core', 'api', 'client.ts'));
    });

    it('does not flag core importing core, by any form', () => {
      mkdirSync(join(fixtureRoot, 'core', 'api'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'features', 'cart'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'core', 'api', 'client.ts'),
        `import { a } from '../errors/a';\nimport '@core/cart';\nexport const b = () => import('./b');\n`,
      );

      expect(
        findCoreBoundaryOffenders(join(fixtureRoot, 'core'), join(fixtureRoot, 'features')),
      ).toEqual([]);
    });
  });
});
