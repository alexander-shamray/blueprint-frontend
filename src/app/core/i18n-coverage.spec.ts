import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * #103, `docs/client-architecture.md` §17: every user-facing message is marked,
 * has an explicit id, and is in the extracted file.
 *
 * The template lint rule is the gate for a text node or an attribute with no
 * marker at all, and it cannot see a string built in TypeScript. This test is
 * the other half, and its subject is what the extraction should hold rather
 * than what a run found: it reads every marker in the source, requires each to
 * carry an explicit `@@id` (a generated id changes when the wording does, and
 * a translator's work goes with it), and holds the set of ids in the source
 * equal to the set in `src/locale/messages.xlf`. A message added without
 * running `npx ng extract-i18n`, or removed without it, is a red build.
 *
 * A marker is read wherever a template is: an inline `template` property and a
 * `templateUrl` file. A bare `i18n` or `i18n-<attribute>` with no value is a
 * marker with an empty id (#543), so it fails the id test rather than passing
 * every test unseen.
 */
const root = process.cwd();

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    if (entry.name.endsWith('.html')) return [path];
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

/** The inline templates of a TypeScript file, as written. */
function inlineTemplates(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      if (node.name.text === 'template') found.push(node.initializer.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * `i18n="@@id"` and `i18n-attr="@@id"` in a template, whatever the element; a
 * marker written bare, with no value, is read as the empty id.
 */
function templateMarkers(template: string): string[] {
  return [...template.matchAll(/(?<=\s)i18n(?:-[\w-]+)?(?:="([^"]*)")?(?=[\s>/])/g)].map(
    (m) => m[1] ?? '',
  );
}

const files = sources(join(root, 'src', 'app'));
const contents = files.map((file) => ({ file, text: readFileSync(file, 'utf8') }));
const templates = contents.flatMap(({ file, text }) =>
  file.endsWith('.html') ? [text] : inlineTemplates(file, text),
);
const text = contents.map((c) => c.text).join('\n');

const TEMPLATE_MARKERS = templates.flatMap(templateMarkers);
/** The text between `$localize` and its first backtick-delimited tag, or the empty tag. */
const LOCALIZE_TAGS = [...text.matchAll(/\$localize`(:[^:`]*:)?/g)].map((m) => m[1] ?? '');

const ID = /^@@[A-Za-z][\w.]*$/;
const idsInSource = new Set([
  ...TEMPLATE_MARKERS.filter((value) => ID.test(value)).map((value) => value.slice(2)),
  ...LOCALIZE_TAGS.map((tag) => /^:@@([A-Za-z][\w.]*):$/.exec(tag)?.[1]).filter(
    (id): id is string => id !== undefined,
  ),
]);

const extracted = readFileSync(join(root, 'src', 'locale', 'messages.xlf'), 'utf8');
const idsExtracted = new Set([...extracted.matchAll(/<trans-unit id="([^"]+)"/g)].map((m) => m[1]));

describe('every message is marked, identified and extracted (#103)', () => {
  it('reads a marker with a value, a bare one, and only inside a template', () => {
    const sample = [
      '// the i18n marker in a comment is not a template',
      "@Component({ selector: 'app-a', template: `",
      '  <p i18n="@@a.saved">Saved</p>',
      '  <p i18n>Saved</p>',
      '  <ion-button i18n-title title="Go" />',
      '  <img i18n-alt="@@a.logo" alt="Logo"/>',
      '` })',
    ].join('\n');
    const markers = inlineTemplates('sample.ts', sample).flatMap(templateMarkers);

    expect(markers).toEqual(['@@a.saved', '', '', '@@a.logo']);
    expect(markers.filter((value) => !ID.test(value))).toEqual(['', '']);
  });

  it('is not vacuous: there are markers to hold to the rule', () => {
    expect(templates.length).toBeGreaterThan(10);
    expect(TEMPLATE_MARKERS.length).toBeGreaterThan(100);
    expect(LOCALIZE_TAGS.length).toBeGreaterThan(40);
    expect(idsExtracted.size).toBeGreaterThan(100);
  });

  it('gives every template marker an explicit id', () => {
    expect(TEMPLATE_MARKERS.filter((value) => !ID.test(value))).toEqual([]);
  });

  it('gives every $localize message an explicit id', () => {
    expect(LOCALIZE_TAGS.filter((tag) => !/^:@@[A-Za-z][\w.]*:$/.test(tag))).toEqual([]);
  });

  it('holds the source and the extracted file to the same ids', () => {
    const missing = [...idsInSource].filter((id) => !idsExtracted.has(id)).sort();
    const stale = [...idsExtracted].filter((id) => !idsInSource.has(id)).sort();

    expect({ notExtracted: missing, notInSource: stale }).toEqual({
      notExtracted: [],
      notInSource: [],
    });
  });
});
