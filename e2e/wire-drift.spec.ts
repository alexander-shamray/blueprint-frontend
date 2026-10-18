import { expect, test, type APIRequestContext } from '@playwright/test';
import { KEYCLOAK, requireGateway } from './helpers';
import {
  BFF_URL,
  CHECKED,
  SERVICES,
  compareShape,
  parseWireTypes,
  readWireTypes,
  stale,
  uncovered,
  type Checked,
  type OpenApiDocument,
} from './wire-drift';

/**
 * #98: `types.ts` is hand-written, and this is what notices when the backend
 * moves a field it reads. It lives in the e2e job because that is the one job
 * that has the stack up; run anywhere else it would be a helper, not a gate.
 *
 * Playwright runs every spec in all three projects, so the document is read
 * three times. That is three GETs and not worth a project filter, which
 * `playwright.config.ts` argues against.
 */

test.describe('what the check looks at', () => {
  test('every exported wire interface is checked or cites a BFF file', () => {
    expect(
      uncovered(readWireTypes()),
      'add each to CHECKED in e2e/wire-drift.ts, or give it a citation',
    ).toEqual([]);
  });

  test('no row of CHECKED names an interface that is gone', () => {
    expect(stale(readWireTypes())).toEqual([]);
  });
});

const sample = (body: string) => parseWireTypes(body).filter((t) => t.name === 'Wire')[0];

const read: Checked = { direction: 'read', service: 'catalog', schema: 'S' };
const sent: Checked = { ...read, direction: 'sent' };
const document = (schema: object): OpenApiDocument => ({ components: { schemas: { S: schema } } });

test.describe('the comparison', () => {
  const wire = sample(`
    /** Catalog.Api/X.cs — \`S\`. */
    export interface Wire {
      readonly id: string;
      readonly quantity: number | null;
      readonly note?: string;
    }`);

  const base = {
    required: ['id', 'quantity'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      // .NET publishes a number as number-or-string with a pattern.
      quantity: { type: ['null', 'integer', 'string'], pattern: '^-?\\d+$' },
      note: { type: 'string' },
    },
  };

  test('reads the citation, optionality, nullability and kind', () => {
    expect(wire.cites).toEqual({ path: 'Catalog.Api/X.cs', symbol: 'S' });
    expect(wire.fields.get('quantity')).toEqual({
      optional: false,
      nullable: true,
      kind: 'number',
    });
    expect(wire.fields.get('note')?.optional).toBe(true);
  });

  test('a matching document is clean, and a field the client does not read is not drift', () => {
    const extra = { ...base, properties: { ...base.properties, added: { type: 'string' } } };
    expect(compareShape(wire, read, document(base))).toEqual([]);
    expect(compareShape(wire, read, document(extra))).toEqual([]);
  });

  test('a removed or renamed field fails', () => {
    const { id: _id, ...rest } = base.properties;
    const problems = compareShape(
      wire,
      read,
      document({ ...base, properties: { ...rest, identifier: { type: 'string' } } }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('`id` is not in the document');
  });

  test('a retyped field fails', () => {
    const retyped = { ...base, properties: { ...base.properties, id: { type: 'integer' } } };
    expect(compareShape(wire, read, document(retyped))[0]).toContain(
      '`id` is number in the document and string here',
    );
  });

  test('a read field that silently becomes nullable fails, in every spelling', () => {
    const nullable = (id: object) => document({ ...base, properties: { ...base.properties, id } });
    expect(compareShape(wire, read, nullable({ type: ['null', 'string'] }))[0]).toContain(
      'can be null in the document',
    );
    expect(
      compareShape(wire, read, nullable({ oneOf: [{ type: 'null' }, { type: 'string' }] }))[0],
    ).toContain('can be null in the document');
  });

  test('a read field the document makes optional fails, unless the client says so', () => {
    const optional = document({ ...base, required: ['quantity'] });
    expect(compareShape(wire, read, optional)).toHaveLength(1);
  });

  test('a sent type must send every required non-null field, and may be stricter about null', () => {
    const added = document({
      ...base,
      required: [...base.required, 'fresh'],
      properties: { ...base.properties, fresh: { type: 'string' } },
    });
    expect(compareShape(wire, sent, added)[0]).toContain('requires `fresh`');

    const nullableAdded = document({
      ...base,
      required: [...base.required, 'fresh'],
      properties: { ...base.properties, fresh: { type: ['null', 'string'] } },
    });
    expect(compareShape(wire, sent, nullableAdded)).toEqual([]);

    const neverNull = document({
      ...base,
      properties: { ...base.properties, quantity: { type: 'integer' } },
    });
    expect(compareShape(wire, sent, neverNull)[0]).toContain(
      '`quantity` is never null in the document',
    );
  });

  test('a reference to a string schema is a string, and to an object schema an object', () => {
    const doc = (id: object): OpenApiDocument => ({
      components: {
        schemas: {
          S: {
            required: ['id', 'quantity'],
            properties: { id, quantity: { type: 'integer' }, note: { type: 'string' } },
          },
          Kind: { type: 'string', enum: ['a', 'b'] },
          Inner: { type: 'object', properties: { x: { type: 'string' } } },
        },
      },
    });
    expect(compareShape(wire, read, doc({ $ref: '#/components/schemas/Kind' }))).toEqual([]);
    expect(compareShape(wire, read, doc({ $ref: '#/components/schemas/Inner' }))[0]).toContain(
      '`id` is object in the document and string here',
    );
  });

  test('a document without the schema fails rather than passing on nothing', () => {
    expect(compareShape(wire, read, {})[0]).toContain('no schema by that name');
  });
});

/** The `demo` user's token, by the realm's direct grant on `web-app` (the same client the smoke signs in through). */
async function demoToken(request: APIRequestContext): Promise<string> {
  const response = await request.post(`${KEYCLOAK}/realms/commerce/protocol/openid-connect/token`, {
    form: { grant_type: 'password', client_id: 'web-app', username: 'demo', password: 'demo' },
  });
  expect(response.ok(), 'Keycloak refused the demo user a token').toBe(true);
  return ((await response.json()) as { access_token: string }).access_token;
}

test.describe('against the running stack', () => {
  test.beforeAll(async ({ request }) => requireGateway(request));

  test('the BFF still publishes no document, so excluding its types is still honest', async ({
    request,
  }) => {
    const token = await demoToken(request);
    const response = await request.get(`${BFF_URL}/openapi/v1.json`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(
      response.status(),
      'the BFF now publishes a document: cover its types instead of excluding them',
    ).toBe(404);
  });

  test('types.ts still matches what the services publish', async ({ request }) => {
    const token = await demoToken(request);
    const documents = new Map<string, OpenApiDocument>();
    const problems: string[] = [];
    const types = readWireTypes();

    for (const [name, checked] of Object.entries(CHECKED)) {
      const type = types.find((t) => t.name === name);
      if (!type) continue; // reported by the coverage test above, with a better message
      if (!documents.has(checked.service)) {
        const response = await request.get(`${SERVICES[checked.service]}/openapi/v1.json`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.ok(), `${checked.service} did not serve its OpenAPI document`).toBe(true);
        documents.set(checked.service, (await response.json()) as OpenApiDocument);
      }
      problems.push(
        ...compareShape(type, checked, documents.get(checked.service) as OpenApiDocument),
      );
    }
    expect(problems).toEqual([]);
  });
});
