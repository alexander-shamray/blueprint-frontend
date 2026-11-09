import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import * as ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `CommandIdentity` counts what is out only through `begin()`, and its count
 * stops at zero, so a send that took its id from `current()` gets no error: its
 * validation 400 reads as nothing outstanding and frees an id that may yet
 * commit, which is the second order client-architecture.md §12 argues against
 * in *A validation refusal says nothing about a request still out*. No page can
 * see that from a reply, and every page's own spec only covers the sends it has,
 * so this one reads the sends the tree holds, including the next one.
 *
 * It parses rather than greps: a wire interface's `commandId: string`, a comment
 * that mentions the field and a value on the line after the key each read
 * differently to a pattern, and a pattern that goes quiet looks like a pass.
 */
interface CommandSends {
  /** Each `file:line` holding a `commandId` that did not come from `begin()`. */
  readonly offenders: readonly string[];
  /** Each file holding one that did: what `offenders` being empty is worth. */
  readonly begun: readonly string[];
}

/**
 * The one file that builds an object under this key without sending it: its log
 * event repeats the id it read off a request's body. Any other shorthand may be
 * a send, with its value out of sight in a variable or a caller.
 */
const READS_THE_FIELD = 'core/log/client-log.interceptor.ts';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
  });
}

function isBeginCall(node: ts.Expression): boolean {
  return (
    ts.isCallExpression(node) &&
    node.arguments.length === 0 &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'begin'
  );
}

function findCommandSends(root: string): CommandSends {
  const offenders: string[] = [];
  const begun = new Set<string>();

  for (const path of walk(root)) {
    const source = readFileSync(path, 'utf8');
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const name = relative(root, path).split(sep).join('/');
    const refuse = (node: ts.Node) =>
      offenders.push(`${name}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);

    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        node.name.text === 'commandId'
      ) {
        if (isBeginCall(node.initializer)) begun.add(name);
        else refuse(node);
      }
      if (
        ts.isShorthandPropertyAssignment(node) &&
        node.name.text === 'commandId' &&
        name !== READS_THE_FIELD
      ) {
        refuse(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  return { offenders, begun: [...begun] };
}

describe('a command takes its id from CommandIdentity.begin()', () => {
  it('holds of every send in the real src/app tree', () => {
    const { offenders } = findCommandSends(join(process.cwd(), 'src', 'app'));

    expect(offenders).toEqual([]);
  });

  it('reads the surfaces that send, so an empty list means they were looked at', () => {
    const { begun } = findCommandSends(join(process.cwd(), 'src', 'app'));

    expect(begun).toEqual(
      expect.arrayContaining([
        'features/checkout/checkout.page.ts',
        'features/publish/own-products.component.ts',
        'features/publish/publish.page.ts',
      ]),
    );
  });

  describe('on a fixture tree', () => {
    let root: string;

    const write = (name: string, source: string): void => {
      const path = join(root, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, source);
    };

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'command-sends-'));
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('refuses identity.current() as a command id', () => {
      write('page.ts', `send({\n  commandId: this.identity.current(),\n});\n`);

      expect(findCommandSends(root).offenders).toEqual(['page.ts:2']);
    });

    it('refuses an id read into a variable first', () => {
      write('page.ts', `const id = identity.current();\nsend({ commandId: id });\n`);

      expect(findCommandSends(root).offenders).toEqual(['page.ts:2']);
    });

    it('refuses an id with no identity behind it', () => {
      write('page.ts', `send({ commandId: crypto.randomUUID() });\n`);

      expect(findCommandSends(root).offenders).toEqual(['page.ts:1']);
    });

    it('refuses a quoted key the same as a bare one', () => {
      write('page.ts', `send({ 'commandId': identity.current() });\n`);

      expect(findCommandSends(root).offenders).toEqual(['page.ts:1']);
    });

    it('refuses the shorthand, whose value is out of sight', () => {
      write('page.ts', `const commandId = identity.current();\nsend({ commandId });\n`);

      expect(findCommandSends(root).offenders).toEqual(['page.ts:2']);
    });

    it('refuses the shorthand in a helper that names no identity and is handed the id', () => {
      write('helper.ts', `export const place = (commandId: string) => send({ commandId });\n`);

      expect(findCommandSends(root).offenders).toEqual(['helper.ts:1']);
    });

    it('reads a subdirectory, and names the offender by its path from the root', () => {
      write('features/deep/page.ts', `send({ commandId: identity.current() });\n`);

      expect(findCommandSends(root).offenders).toEqual(['features/deep/page.ts:1']);
    });

    it('accepts begin() on any receiver, and counts the file as a send', () => {
      write('page.ts', `send({ commandId: this.identity.begin() });\n`);
      write('row.ts', `send({ commandId: identity.begin() });\n`);

      const { offenders, begun } = findCommandSends(root);

      expect(offenders).toEqual([]);
      expect([...begun].sort()).toEqual(['page.ts', 'row.ts']);
    });

    it('refuses begin() given an argument, which is not the method that counts', () => {
      write('page.ts', `send({ commandId: transaction.begin('x') });\n`);

      expect(findCommandSends(root).offenders).toEqual(['page.ts:1']);
    });

    it('ignores the field on a wire interface and in a comment', () => {
      write(
        'types.ts',
        `// commandId: identity.current()\nexport interface Command {\n  readonly commandId: string;\n}\n`,
      );

      expect(findCommandSends(root).offenders).toEqual([]);
    });

    it('ignores the shorthand in the interceptor, which only reads the field', () => {
      write(READS_THE_FIELD, `const commandId = readBody();\nlog({ commandId });\n`);

      expect(findCommandSends(root).offenders).toEqual([]);
    });

    it('does not read a spec, where a fixed id is the fixture', () => {
      write('page.spec.ts', `send({ commandId: 'c-1' });\n`);

      expect(findCommandSends(root).offenders).toEqual([]);
    });
  });
});
