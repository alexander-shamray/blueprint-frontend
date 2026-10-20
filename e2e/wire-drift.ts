import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';

/**
 * The wire-type drift check (#98): what `types.ts` says the backend sends and
 * accepts, held against the OpenAPI documents the services publish. A check
 * and not a generator — `types.ts` stays hand-written, each interface citing
 * the file and symbol it mirrors, and this is what notices when a citation
 * goes stale. Everything here is pure; `wire-drift.spec.ts` fetches the
 * documents and decides where it runs.
 */

export type Direction = 'read' | 'sent';

export interface Checked {
  /** `read`: the client trusts these fields. `sent`: the server must accept what the client posts. */
  readonly direction: Direction;
  readonly service: keyof typeof SERVICES;
  /** The schema name in the service's document; a generic's instantiation is named, not derived. */
  readonly schema: string;
}

/**
 * Host-published ports of the backend's Compose stack (`deploy/compose/services/*.yml`).
 * The gateway routes none of `/openapi/v1.json`, so the services are read
 * directly, with the same `demo` token the smoke signs in with.
 */
export const SERVICES = {
  catalog: 'http://localhost:5102',
  ordering: 'http://localhost:5101',
} as const;

/**
 * The BFF publishes no document: `MapOpenApi()` is absent from
 * `Web.Bff/Program.cs`, and the spec checks that it still answers 404. Its
 * types are excluded by their citation's `Web.Bff/` prefix, not by name, so
 * a new BFF record needs no entry here and a new record from anywhere else
 * cannot arrive without one.
 */
export const BFF_URL = 'http://localhost:5200';
export const BFF_PREFIX = 'Web.Bff/';

/**
 * Every exported interface in `types.ts` is in this table or cites a BFF
 * file. The spec's "checked or cites a BFF file" test fails on any other interface,
 * including one with no citation, which is the point: the next type added is
 * not silently uncovered.
 */
export const CHECKED: Readonly<Record<string, Checked>> = {
  // The product listing declares no response schema, so no `CursorPageOfProductSummaryDto`
  // exists; `/products/mine` publishes the same generic as `CursorPageOfOwnProductDto`,
  // which holds the two fields `CursorPage<T>` owns. The element type is `T`'s to check.
  CursorPage: { direction: 'read', service: 'catalog', schema: 'CursorPageOfOwnProductDto' },
  ProductSummary: { direction: 'read', service: 'catalog', schema: 'ProductSummaryDto' },
  PublishProductCommand: { direction: 'sent', service: 'catalog', schema: 'PublishProductCommand' },
  OwnProduct: { direction: 'read', service: 'catalog', schema: 'OwnProductDto' },
  WithdrawProductRequest: { direction: 'sent', service: 'catalog', schema: 'WithdrawProductRequest' },
  ChangePriceRequest: { direction: 'sent', service: 'catalog', schema: 'ChangePriceRequest' },
  PlaceOrderItem: { direction: 'sent', service: 'ordering', schema: 'PlaceOrderItem' },
  Address: { direction: 'sent', service: 'ordering', schema: 'AddressDto' },
  PlaceOrderCommand: { direction: 'sent', service: 'ordering', schema: 'PlaceOrderCommand' },
  CancelOrderRequest: { direction: 'sent', service: 'ordering', schema: 'CancelOrderRequest' },
};

/**
 * `unknown` is a reference to something other than an exported interface (a
 * type alias, say), and is never compared. A union is judged by its first
 * non-null member, so `'a' | 'b'` is a string.
 */
export type Kind = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'unknown';

export interface WireField {
  readonly optional: boolean;
  readonly nullable: boolean;
  readonly kind: Kind;
}

export interface WireType {
  readonly name: string;
  /** The first `<path>.cs — \`Symbol\`` in the leading comment, or null where there is none. */
  readonly cites: { readonly path: string; readonly symbol: string } | null;
  readonly fields: ReadonlyMap<string, WireField>;
}

const CITATION = /([\w.]+\/[\w./]+\.cs)\s+—\s+`([^`]+)`/;

function kindOf(node: ts.TypeNode, interfaces: ReadonlySet<string>): Kind {
  if (ts.isTypeOperatorNode(node)) return kindOf(node.type, interfaces);
  if (ts.isArrayTypeNode(node)) return 'array';
  if (ts.isTypeReferenceNode(node)) {
    return interfaces.has(node.typeName.getText()) ? 'object' : 'unknown';
  }
  if (ts.isLiteralTypeNode(node)) {
    return ts.isStringLiteral(node.literal)
      ? 'string'
      : ts.isNumericLiteral(node.literal)
        ? 'number'
        : 'unknown';
  }
  switch (node.kind) {
    case ts.SyntaxKind.StringKeyword:
      return 'string';
    case ts.SyntaxKind.NumberKeyword:
      return 'number';
    case ts.SyntaxKind.BooleanKeyword:
      return 'boolean';
    default:
      return 'unknown';
  }
}

function fieldOf(member: ts.PropertySignature, interfaces: ReadonlySet<string>): WireField | null {
  if (!member.type) return null;
  const members = ts.isUnionTypeNode(member.type) ? member.type.types : [member.type];
  const isNull = (t: ts.TypeNode) =>
    ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword;
  const rest = members.filter((t) => !isNull(t));
  return {
    optional: member.questionToken !== undefined,
    nullable: rest.length !== members.length,
    kind: kindOf(rest[0] ?? member.type, interfaces),
  };
}

/** Every exported interface in the file, with its citation and its own (not inherited) fields. */
export function parseWireTypes(source: string): WireType[] {
  const file = ts.createSourceFile('types.ts', source, ts.ScriptTarget.Latest, true);
  const types: WireType[] = [];
  const interfaces = new Set(
    file.statements.filter(ts.isInterfaceDeclaration).map((s) => s.name.text),
  );

  for (const statement of file.statements) {
    if (!ts.isInterfaceDeclaration(statement)) continue;
    if (!statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;

    const leading = ts.getLeadingCommentRanges(file.text, statement.getFullStart()) ?? [];
    const comment = leading.map((r) => file.text.slice(r.pos, r.end)).join('\n');
    const cited = CITATION.exec(comment);

    const fields = new Map<string, WireField>();
    for (const member of statement.members) {
      if (!ts.isPropertySignature(member) || !ts.isIdentifier(member.name)) continue;
      const field = fieldOf(member, interfaces);
      if (field) fields.set(member.name.text, field);
    }
    types.push({
      name: statement.name.text,
      cites: cited ? { path: cited[1], symbol: cited[2] } : null,
      fields,
    });
  }
  return types;
}

export function readWireTypes(): WireType[] {
  return parseWireTypes(readFileSync(resolve(__dirname, '../src/app/core/api/types.ts'), 'utf8'));
}

/**
 * Names that are in `types.ts` and neither checked nor cited from the BFF.
 * An interface with no citation at all is in here too: a type that does not
 * say what it mirrors is a type this check cannot place.
 */
export function uncovered(types: readonly WireType[]): string[] {
  return types
    .filter((t) => !(t.name in CHECKED) && !t.cites?.path.startsWith(BFF_PREFIX))
    .map((t) => t.name);
}

/** Entries in `CHECKED` that `types.ts` no longer exports, so a rename cannot leave a dead row. */
export function stale(types: readonly WireType[]): string[] {
  const names = new Set(types.map((t) => t.name));
  return Object.keys(CHECKED).filter((n) => !names.has(n));
}

interface Schema {
  readonly type?: string | string[];
  readonly enum?: string[];
  readonly $ref?: string;
  readonly oneOf?: Schema[];
  readonly anyOf?: Schema[];
  readonly required?: string[];
  readonly properties?: Record<string, Schema>;
}

export interface OpenApiDocument {
  readonly components?: { readonly schemas?: Record<string, Schema> };
}

function shapeOf(
  schema: Schema,
  document: OpenApiDocument,
  depth = 0,
): { nullable: boolean; kind: Kind | null } {
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives) {
    const shapes = alternatives.map((a) => shapeOf(a, document, depth));
    return {
      nullable: shapes.some((s) => s.nullable),
      kind: shapes.find((s) => s.kind)?.kind ?? null,
    };
  }
  if (schema.$ref) {
    // A reference to a string enum or an alias is that schema's kind, not an
    // object; only a target with properties (or none we can find) is one.
    const target = document.components?.schemas?.[schema.$ref.split('/').pop() ?? ''];
    if (target && !target.properties && depth < 4) return shapeOf(target, document, depth + 1);
    return { nullable: false, kind: 'object' };
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const kinds = types.filter((t) => t !== 'null');
  // .NET's default JSON options read numbers from strings, so a number is
  // published as ["integer","string"] with a pattern. The string is the
  // lenient reader, not the wire shape, and it is not a retyping.
  const kind: Kind | null = kinds.some((t) => t === 'number' || t === 'integer')
    ? 'number'
    : kinds[0] === 'string'
      ? 'string'
      : kinds[0] === 'boolean'
        ? 'boolean'
        : kinds[0] === 'array'
          ? 'array'
          : kinds[0] === 'object'
            ? 'object'
            : null;
  return { nullable: types.includes('null'), kind };
}

/**
 * Held against the document, one problem per line. A field the backend adds
 * and the client does not read is not a problem; a field the backend removes,
 * renames or retypes, or makes nullable under a client that does not expect
 * it, is. `quantityAvailable: null` is "never reported", not `0` (#78), and
 * a field that silently becomes nullable is the drift worth catching.
 *
 * `read` types are the client's trust in the server: the document must still
 * have each field, with the same kind, and nullable only where the client
 * allows it. `sent` types are the server's trust in the client: the same,
 * plus every required non-null field of the schema must be one the client
 * sends, since a new required field is a 400 on every post. A client type
 * that is stricter than the server about nullability is fine there — the
 * client may refuse to send what the server would accept.
 */
export function compareShape(
  type: WireType,
  checked: Checked,
  document: OpenApiDocument,
): string[] {
  const where = `${type.name} ↔ ${checked.service} ${checked.schema}`;
  const schema = document.components?.schemas?.[checked.schema];
  if (!schema?.properties) return [`${where}: the document has no schema by that name`];

  const problems: string[] = [];
  const required = new Set(schema.required ?? []);

  for (const [name, field] of type.fields) {
    const property = schema.properties[name];
    if (!property) {
      problems.push(`${where}: \`${name}\` is not in the document (removed or renamed)`);
      continue;
    }
    const shape = shapeOf(property, document);
    if (shape.kind && field.kind !== 'unknown' && shape.kind !== field.kind) {
      problems.push(
        `${where}: \`${name}\` is ${shape.kind} in the document and ${field.kind} here`,
      );
    }
    if (checked.direction === 'read' && shape.nullable && !field.nullable) {
      problems.push(`${where}: \`${name}\` can be null in the document and cannot here`);
    }
    if (checked.direction === 'sent' && !shape.nullable && field.nullable) {
      problems.push(`${where}: \`${name}\` is never null in the document and can be here`);
    }
    if (checked.direction === 'read' && !required.has(name) && !field.optional) {
      problems.push(`${where}: \`${name}\` is optional in the document and required here`);
    }
  }

  if (checked.direction === 'sent') {
    for (const name of required) {
      const shape = shapeOf(schema.properties[name] ?? {}, document);
      if (!type.fields.has(name) && !shape.nullable) {
        problems.push(`${where}: the document requires \`${name}\` and this type does not send it`);
      }
    }
  }
  return problems;
}
