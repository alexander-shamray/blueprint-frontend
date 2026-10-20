import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * #253: the lint gate is the list of files `ng lint` reads, and a gate that
 * silently stops covering the newest surface is the most-repeated failure in
 * these repositories. `e2e/` sat outside it for months, and `e2e/*.mts` was
 * ignored even when ESLint was pointed at it, because the TypeScript block of
 * `eslint.config.js` matched `*.ts` only.
 *
 * So this test's subject is what the gate looks at, not what it found: every
 * TypeScript file in the repository either falls under `angular.json`'s
 * `lintFilePatterns` or is named below with the reason it does not, every file
 * the patterns reach has an ESLint configuration (an unconfigured file is
 * "ignored", which reads as clean), and the e2e type-check covers everything
 * under `e2e/`.
 */
const root = process.cwd();

/** Trees that hold no source this repository writes: dependencies, output, native projects, tooling. */
const NOT_SOURCE = new Set([
  '.angular',
  '.claude',
  '.git',
  'android',
  'artifacts',
  'coverage',
  'dist',
  'ios',
  'node_modules',
  'playwright-report',
  'test-results',
]);

/** TypeScript the lint target deliberately does not read. Empty is the goal; a row needs a reason. */
const UNLINTED = new Map<string, string>([]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (NOT_SOURCE.has(entry)) return [];
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|mts|cts)$/.test(entry) ? [relative(root, full).split(sep).join('/')] : [];
  });
}

/** The glob shapes `lintFilePatterns` and the tsconfig use: `**`, `*`, and literal text. */
function globToRegExp(glob: string): RegExp {
  const body = glob
    .split('**/')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('(?:.*/)?');
  return new RegExp(`^${body}$`);
}

function matchesAny(patterns: readonly string[], file: string): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(file));
}

function lintPatterns(): string[] {
  const angular = JSON.parse(readFileSync(join(root, 'angular.json'), 'utf8')) as {
    projects: Record<string, { architect: { lint: { options: { lintFilePatterns: string[] } } } }>;
  };
  const patterns = Object.values(angular.projects).flatMap(
    (project) => project.architect.lint.options.lintFilePatterns,
  );
  expect(patterns.length, 'angular.json names no lint target').toBeGreaterThan(0);
  return patterns;
}

describe('the lint target', () => {
  const files = walk(root);

  it('finds the trees it is meant to judge', () => {
    // A walk that found nothing would pass every test below.
    expect(files.some((file) => file.startsWith('src/app/'))).toBe(true);
    expect(files.some((file) => file.startsWith('e2e/'))).toBe(true);
    expect(files).toContain('playwright.config.ts');
  });

  it('reads every TypeScript file in the repository, or says why not', () => {
    const patterns = lintPatterns();
    const outside = files.filter((file) => !matchesAny(patterns, file) && !UNLINTED.has(file));
    expect(outside, 'TypeScript no lint pattern reaches').toEqual([]);
  });

  it('gives every file it reads an ESLint configuration', async () => {
    const eslint = new ESLint({ cwd: root });
    const patterns = lintPatterns();
    const read = files.filter((file) => matchesAny(patterns, file));
    const configs = await Promise.all(read.map((file) => eslint.calculateConfigForFile(file)));
    // `undefined` is ESLint's "no configuration matched": the file is ignored, not clean.
    const unconfigured = read.filter((_, index) => configs[index] === undefined);
    expect(unconfigured, 'files ESLint ignores for want of a configuration').toEqual([]);
  }, 60_000);

  it('type-checks everything under e2e/, and the lint script runs that check', () => {
    const tsconfig = JSON.parse(
      readFileSync(join(root, 'tsconfig.e2e.json'), 'utf8').replace(/^\s*\/\*[\s\S]*?\*\//, ''),
    ) as { include: string[] };
    const e2e = files.filter((file) => file.startsWith('e2e/'));
    expect(e2e.length).toBeGreaterThan(0);
    expect(e2e.filter((file) => !matchesAny(tsconfig.include, file))).toEqual([]);

    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['lint']).toContain('tsc -p tsconfig.e2e.json');
  });
});
