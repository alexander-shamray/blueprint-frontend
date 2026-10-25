import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { expect, test } from '@playwright/test';

/**
 * #326: the assistant's protocol is mirrored, not shared (AI assistant design
 * §13). `src/app/core/assistant/golden/` is a copy of the backend's golden
 * files, `protocol.spec.ts` holds `protocol.ts` to the copy, and this holds the
 * copy to the backend's own files, so a field the backend renames, adds or
 * retypes fails here rather than in a customer's browser.
 *
 * It needs no stack, only the backend's tree, and it lives in the e2e job
 * because that is the one job that checks the backend out (`ci.yml`, at
 * `blueprint-backend/`). Run locally it reads the nearest `blueprint-backend`
 * beside this checkout or any directory above it — so a worktree under
 * `.claude/worktrees/` finds the sibling too — or `BLUEPRINT_BACKEND` when that
 * names one. Under CI a missing
 * tree is a failure, never a skip: a drift check that cannot find its owner
 * has checked nothing.
 *
 * Playwright runs every spec in all three projects, so this reads the files
 * three times, which costs nothing; `playwright.config.ts` argues against a
 * project filter.
 */
const OWNER = join('src', 'BuildingBlocks', 'Common.Assistant', 'Protocol', 'golden');
const COPY = resolve('src', 'app', 'core', 'assistant', 'golden');

/** This directory and each one above it: CI's checkout is beneath, a sibling is one or more up. */
function ancestors(dir: string): string[] {
  const parent = dirname(dir);
  return parent === dir ? [dir] : [dir, ...ancestors(parent)];
}

function backendGolden(): string | null {
  const named = process.env['BLUEPRINT_BACKEND'];
  const candidates = [
    ...(named ? [named] : []),
    ...ancestors(resolve('.')).map((dir) => join(dir, 'blueprint-backend')),
  ];
  const found = candidates.map((root) => join(root, OWNER)).find((dir) => existsSync(dir));
  return found ?? null;
}

function goldenFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort();
}

function read(dir: string, file: string): unknown {
  return JSON.parse(readFileSync(join(dir, file), 'utf8'));
}

test.describe("the assistant protocol's golden files", () => {
  const owner = backendGolden();

  test.beforeAll(() => {
    if (owner === null && process.env['CI']) {
      throw new Error(`No backend checkout holds ${OWNER}; the drift check has nothing to read.`);
    }
  });

  test('the copy holds exactly the files the backend holds', () => {
    test.skip(owner === null, 'no backend checkout beside this one');

    expect(goldenFiles(COPY)).toEqual(goldenFiles(owner ?? COPY));
  });

  test('each copied file says what the backend file says', () => {
    test.skip(owner === null, 'no backend checkout beside this one');

    const differing = goldenFiles(COPY).filter(
      (file) => !isDeepStrictEqual(read(COPY, file), read(owner ?? COPY, file)),
    );

    expect(differing, 'copy each from the backend, then update protocol.ts and its spec').toEqual(
      [],
    );
  });
});
