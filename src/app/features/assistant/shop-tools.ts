import { ClientTool, ToolOutcome, viewTool } from '@core/assistant/client-tools';

/** What the shop's tools need of the application: a navigation, and whether Publish is open. */
export interface ShopNavigation {
  navigate(commands: readonly string[]): Promise<boolean>;
  canPublish(): boolean;
}

/** The pages `open_page` opens; the cart, a product and an order have tools of their own. */
export const OPENABLE_PAGES = ['products', 'orders', 'account', 'publish'] as const;
export type OpenablePage = (typeof OPENABLE_PAGES)[number];

/** A product's or an order's id: both are UUIDs, as the BFF's tool schemas say. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idSchema(name: string): Record<string, unknown> {
  return {
    type: 'object',
    properties: { [name]: { type: 'string', format: 'uuid' } },
    required: [name],
    additionalProperties: false,
  };
}

/**
 * The shop's UI tools (AI assistant design §6.4, issue #326): each opens one
 * of the shop's own routes, and none changes anything but the view (§6.3) —
 * the cart is opened, never filled. Their titles, descriptions and results are
 * read by the model, not the customer, so they stay English (§5.4); the panel
 * words a call for the customer from its name (`assistant-words.ts`).
 *
 * An input the tool cannot use, a page this customer may not open, and a
 * navigation the router refused are error results the model reads, never an
 * exception.
 */
export function shopTools(nav: ShopNavigation): ClientTool[] {
  const open = async (commands: string[]): Promise<ToolOutcome> => {
    const path = `/${commands.join('/')}`;
    return (await nav.navigate(commands))
      ? { ok: true, content: `Opened ${path}.` }
      : { ok: false, content: 'the shop did not open that page' };
  };

  const byId = (name: string, route: string): ClientTool['run'] => {
    return (input) => {
      const id = input[name];
      if (typeof id !== 'string' || !ID.test(id)) {
        return { ok: false, content: `${name} must be a UUID` };
      }
      return open(['tabs', route, id.toLowerCase()]);
    };
  };

  return [
    {
      descriptor: viewTool(
        'open_product',
        'Open a product',
        "Shows one product's page in the shop, by the product's id as an order line or " +
          'get_product carries it. Changes only what the customer sees.',
        idSchema('product_id'),
      ),
      run: byId('product_id', 'products'),
    },
    {
      descriptor: viewTool(
        'open_order',
        'Open an order',
        "Shows one of the signed-in customer's orders, by its id as list_orders returns it: " +
          'its status, timeline, payment and tracking. Changes only what the customer sees.',
        idSchema('order_id'),
      ),
      run: byId('order_id', 'orders'),
    },
    {
      descriptor: viewTool(
        'open_cart',
        'Open the cart',
        "Shows the customer's cart, where they review it and go on to checkout. Changes only " +
          'what the customer sees: it adds and removes nothing.',
        { type: 'object', properties: {}, additionalProperties: false },
      ),
      run: () => open(['tabs', 'cart']),
    },
    {
      descriptor: viewTool(
        'open_page',
        'Open a page',
        "Shows one of the shop's pages by its catalogue id: products, orders (the order " +
          'history), account, or publish for a customer who may publish. Changes only what ' +
          'the customer sees.',
        {
          type: 'object',
          properties: { page: { type: 'string', enum: [...OPENABLE_PAGES] } },
          required: ['page'],
          additionalProperties: false,
        },
      ),
      run: (input) => {
        const page = input['page'];
        if (!OPENABLE_PAGES.includes(page as OpenablePage)) {
          return { ok: false, content: `page must be one of ${OPENABLE_PAGES.join(', ')}` };
        }
        if (page === 'publish' && !nav.canPublish()) {
          return { ok: false, content: 'this customer may not publish' };
        }
        return open(['tabs', page as OpenablePage]);
      },
    },
  ];
}
