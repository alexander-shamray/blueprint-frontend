import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * #314, `docs/client-architecture.md` §17: no user-facing sentence is written
 * as a bare string.
 *
 * `i18n-coverage.spec.ts` reads markers that exist, and the template lint rule
 * reads static text, so a sentence typed as a TypeScript literal or inside a
 * bound expression (`[label]="'New price'"`, `{{ ok ? 'Saved now' : '' }}`) is
 * outside both. This reads those two places and fails on a literal that looks
 * like prose. In TypeScript that is a capitalised word followed by another
 * word; in a binding or a built string, any two words side by side. A selector,
 * a header name, a URL, a route path and a storage key contain no space, and an
 * OAuth scope or an ISO code list has no capitalised word, so the shape is the
 * allow-list for all of them and nothing is listed by hand. A single word, and
 * a sentence that starts in lower case, are not caught, because an enum value
 * and a label read the same; that is a limit, kept in §17.
 *
 * What the shape cannot tell from a sentence is skipped by position instead:
 * an import specifier, a property name, a type, the value of a property named
 * `template` or `styles`, and the argument of `new Error(…)`, which §17 keeps
 * as a diagnostic. Only inline templates are read; a `templateUrl` file is not.
 * A tagged `$localize` template is a marked message and is not a
 * literal; a template under any other tag is (#552). A built string is read
 * whole, each substitution standing in as a word, so a sentence split by `${}`
 * is still one. `ALLOWED` is for what is left, and every entry says why.
 */
const root = process.cwd();

/**
 * A plain literal: a capitalised word, then another word of any length, either
 * holding an apostrophe or a hyphen ("Add a product", "Don't save", #543). An
 * ISO code list or a scope is not.
 */
const SENTENCE = /^[A-Z][a-z]*(?:['’-][a-z]+)*[ \t]+[A-Za-z]/;
/** Inside a binding or a built string, two words side by side, one of two letters or more. */
const WORDS = /[A-Za-z]{2,}[ \t]+[A-Za-z]|[A-Za-z][ \t]+[A-Za-z]{2,}/;

const DIAGNOSTIC = 'a diagnostic the account page maps to its own banner (§17), never shown';

const MODEL_TEXT =
  "read by the assistant's model, never shown: tool text stays English (AI assistant design " +
  '§5.4, client-architecture.md §19), and the panel words each call from its name';

const SHOP_TOOLS = 'src/app/features/assistant/shop-tools.ts';

/** A literal that is prose on purpose; each has the file, the exact text and the reason. */
const ALLOWED: readonly { file: string; text: string; why: string }[] = [
  {
    file: 'src/app/core/api/order-path.ts',
    text: 'Not Found',
    why: 'the HTTP reason phrase of a synthetic 404, protocol text and not a message',
  },
  {
    file: 'src/app/core/auth/auth.interceptor.ts',
    text: 'Bearer ${}',
    why: 'the Authorization header scheme and its token, protocol text and not a message',
  },
  {
    file: 'src/app/core/auth/native-auth.strategy.ts',
    text: 'Sign-in was abandoned by a sign-out.',
    why: DIAGNOSTIC,
  },
  {
    file: 'src/app/core/auth/native-auth.strategy.ts',
    text: 'Sign-in failed: ${}',
    why: DIAGNOSTIC,
  },
  {
    file: 'src/app/core/auth/native-auth.strategy.ts',
    text: 'The authorization server returned no code and no error.',
    why: DIAGNOSTIC,
  },
  {
    file: 'src/app/core/auth/native-auth.strategy.ts',
    text: 'Sign-in was dismissed before it completed.',
    why: DIAGNOSTIC,
  },
  {
    file: 'src/app/core/assistant/client-tools.ts',
    text: 'This client has no tool named ${}.',
    why: MODEL_TEXT,
  },
  { file: SHOP_TOOLS, text: '${} must be a UUID', why: MODEL_TEXT },
  { file: SHOP_TOOLS, text: 'page must be one of ${}', why: MODEL_TEXT },
  { file: SHOP_TOOLS, text: 'Opened ${}.', why: MODEL_TEXT },
  { file: SHOP_TOOLS, text: 'Open a product', why: MODEL_TEXT },
  { file: SHOP_TOOLS, text: 'Open a page', why: MODEL_TEXT },
  { file: SHOP_TOOLS, text: 'Open an order', why: MODEL_TEXT },
  { file: SHOP_TOOLS, text: 'Open the cart', why: MODEL_TEXT },
  {
    file: SHOP_TOOLS,
    text: "Shows one product's page in the shop, by the product's id as an order line or ",
    why: MODEL_TEXT,
  },
  {
    file: SHOP_TOOLS,
    text: "Shows one of the signed-in customer's orders, by its id as list_orders returns it: ",
    why: MODEL_TEXT,
  },
  {
    file: SHOP_TOOLS,
    text: "Shows the customer's cart, where they review it and go on to checkout. Changes only ",
    why: MODEL_TEXT,
  },
  {
    file: SHOP_TOOLS,
    text: "Shows one of the shop's pages by its catalogue id: products, orders (the order ",
    why: MODEL_TEXT,
  },
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    // Test support is dev-facing, as the template lint rule treats its fixtures.
    if (entry.isDirectory()) return entry.name === 'testing' ? [] : sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

/** The string literals an expression's source holds, ignoring the `${}` of nothing. */
function quoted(expression: string): string[] {
  return [...expression.matchAll(/'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map(
    (m) => m[1] ?? m[2] ?? '',
  );
}

/** Prose-shaped literals inside the bound expressions of an inline template. */
function boundProse(template: string): string[] {
  const expressions = [
    ...template.matchAll(/\[[\w.-]+\]\s*=\s*"([^"]*)"/g),
    ...template.matchAll(/\[[\w.-]+\]\s*=\s*'([^']*)'/g),
    ...template.matchAll(/\{\{([\s\S]*?)\}\}/g),
  ].map((m) => m[1]);
  return expressions.flatMap(quoted).filter((text) => WORDS.test(text));
}

/** A `$localize` tagged template, the one tag that marks a message. */
function isLocalize(node: ts.TaggedTemplateExpression): boolean {
  return ts.isIdentifier(node.tag) && node.tag.text === '$localize';
}

function isSkippedPosition(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  if (ts.isLiteralTypeNode(parent) || ts.isExternalModuleReference(parent)) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isTaggedTemplateExpression(parent) && parent.template === node) {
    if (isLocalize(parent)) return true;
  }
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text === 'template' || parent.name.text === 'styles';
  }
  if (ts.isArrayLiteralExpression(parent) && ts.isPropertyAssignment(parent.parent)) {
    return ts.isIdentifier(parent.parent.name) && parent.parent.name.text === 'styles';
  }
  if (ts.isNewExpression(parent) && ts.isIdentifier(parent.expression)) {
    return /Error$/.test(parent.expression.text);
  }
  return false;
}

/** Prose-shaped literals in TypeScript, and in the bound expressions of its inline templates. */
function untaggedProse(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isSkippedPosition(node) && SENTENCE.test(node.text)) found.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
      // A substitution reads as a one-letter word, so `Only ${n} left` is one sentence
      // (#552), while `${base}products/mine` stays one token.
      if (!isSkippedPosition(node) && WORDS.test(parts.join('x'))) {
        found.push(parts.join('${}'));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  const inline = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'template' &&
      (ts.isNoSubstitutionTemplateLiteral(node.initializer) || ts.isStringLiteral(node.initializer))
    ) {
      found.push(...boundProse(node.initializer.text));
    }
    ts.forEachChild(node, inline);
  };
  inline(file);
  return found;
}

describe('no user-facing sentence is a bare string (#314)', () => {
  it('finds a sentence in TypeScript and in a bound expression, and only there', () => {
    const sample = [
      "import { x } from './Some thing';",
      "const label = 'Order not found';",
      "const key = 'x-request-id';",
      'const marked = $localize`:@@a.b:Order not found`;',
      "throw new Error('Sign-in failed here');",
      'const t = `Total is ${n}`;',
      "@Component({ selector: 'app-a', template: `<p [title]=\"'Pay now'\">{{ ok ? 'All good' : 'x' }}</p>` })",
    ].join('\n');

    expect(untaggedProse('sample.ts', sample)).toEqual([
      'Order not found',
      'Total is ${}',
      'Pay now',
      'All good',
    ]);
  });

  it('finds a sentence with a one-letter word or an apostrophe (#543)', () => {
    const sample = [
      "const a = 'Add a product';",
      "const b = 'Don\\'t save';",
      "const c = 'A product was added';",
      "const iso = 'US GB';",
      "@Component({ selector: 'app-a', template: `<p [title]=\"'Open a page'\"></p>` })",
    ].join('\n');

    expect(untaggedProse('sample.ts', sample)).toEqual([
      'Add a product',
      "Don't save",
      'A product was added',
      'Open a page',
    ]);
  });

  it('reads a template under any tag but $localize, and a built string whole (#552)', () => {
    const sample = [
      'const raw = String.raw`Order not found`;',
      'const helper = tag`Your order ${id} shipped`;',
      'const built = `Only ${n} left`;',
      'const name = `Order ${id}`;',
      'const path = `${base}/orders/${id}`;',
      'const url = `${base}products/mine`;',
      'const pair = `${a} ${b}`;',
      'const marked = $localize`:@@a.c:Only ${n}:count: left`;',
    ].join('\n');

    expect(untaggedProse('sample.ts', sample)).toEqual([
      'Order not found',
      'Your order ${} shipped',
      'Only ${} left',
      'Order ${}',
    ]);
  });

  it('is not vacuous: it walks the application and reads its inline templates', () => {
    const files = sources(join(root, 'src', 'app'));
    expect(files.length).toBeGreaterThan(50);
    const templates = files.filter((file) => /\btemplate:\s*`/.test(readFileSync(file, 'utf8')));
    expect(templates.length).toBeGreaterThan(10);
  });

  it('leaves no unmarked sentence in the application', () => {
    const offenders = sources(join(root, 'src', 'app')).flatMap((file) => {
      const name = relative(root, file).replaceAll('\\', '/');
      return untaggedProse(name, readFileSync(file, 'utf8'))
        .filter((text) => !ALLOWED.some((a) => a.file === name && a.text === text))
        .map((text) => `${name}: ${text}`);
    });

    expect(offenders).toEqual([]);
  });

  it('keeps every allow-list entry live, with its reason', () => {
    const stale = ALLOWED.filter(
      (a) => !untaggedProse(a.file, readFileSync(join(root, a.file), 'utf8')).includes(a.text),
    );

    expect(stale).toEqual([]);
    expect(ALLOWED.filter((a) => a.why.trim() === '')).toEqual([]);
  });
});
