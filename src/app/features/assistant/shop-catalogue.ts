import { CatalogueEntry } from '@core/assistant/protocol';

/**
 * The shop's pages, as the assistant is told about them (AI assistant design
 * §6.1): each one's id, its label as the page's own title shows it, where it
 * lives and its `help`. The label reuses the title's message id, so the two
 * cannot say different things, and `help` is a message of its own, sent in the
 * build's locale like every other string (§5.4, `docs/client-architecture.md`
 * §17). The routes are `app.routes.ts`'s, and the spec holds every `where` to
 * a route there.
 *
 * Publish is listed only for a customer who may publish, because the route
 * refuses everyone else and a page the assistant may not open is one it should
 * not offer.
 */
export function shopCatalogue(canPublish: boolean): CatalogueEntry[] {
  const entries: CatalogueEntry[] = [
    {
      id: 'products',
      label: $localize`:@@products.title:Products`,
      where: '/tabs/products',
      help: $localize`:@@assistant.page.products:The shop's catalogue, newest first or by name, with a search box. Each row shows a product's price and how many are in stock, and adds it to the cart. Open a product for its own page.`,
    },
    {
      id: 'product',
      label: $localize`:@@product.title:Product`,
      where: '/tabs/products/{productId}',
      help: $localize`:@@assistant.page.product:One product's page: its image, name, price and stock, with a quantity to add to the cart. It works signed out, so a link to it can be shared.`,
    },
    {
      id: 'cart',
      label: $localize`:@@cart.title:Cart`,
      where: '/tabs/cart',
      help: $localize`:@@assistant.page.cart:What the customer is about to buy, kept on this device. Quantities can be changed or removed here, and the total is the platform's quote, never the shop's own sum. Checkout starts from here.`,
    },
    {
      id: 'checkout',
      label: $localize`:@@checkout.title:Checkout`,
      where: '/tabs/cart/checkout',
      help: $localize`:@@assistant.page.checkout:Where the customer gives a delivery address and places the order for the cart's quoted total. It opens only from the cart, once the cart has a quote.`,
    },
    {
      id: 'orders',
      label: $localize`:@@orders.title:History`,
      where: '/tabs/orders',
      help: $localize`:@@assistant.page.orders:The signed-in customer's own orders, newest first, each with its status and total. Open one for its timeline, payment and shipment.`,
    },
    {
      id: 'order',
      label: $localize`:@@detail.title:Order`,
      where: '/tabs/orders/{orderId}',
      help: $localize`:@@assistant.page.order:One of the customer's orders as it stands: its lines, total, payment, shipment and tracking number, updated live while it moves. An order the platform still allows to be cancelled can be cancelled here.`,
    },
    {
      id: 'account',
      label: $localize`:@@account.title:Account`,
      where: '/tabs/account',
      help: $localize`:@@assistant.page.account:Sign in and out, the saved delivery address, and the shop's appearance: light, dark or the device's own. Signing in is what opens the order history.`,
    },
  ];

  if (canPublish) {
    entries.push({
      id: 'publish',
      label: $localize`:@@publish.title:Publish`,
      where: '/tabs/publish',
      help: $localize`:@@assistant.page.publish:Where a seller lists a new product with its name, price and image, and sees the products they have listed. Only an account allowed to publish sees it.`,
    });
  }

  return entries;
}
