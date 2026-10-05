import { Routes } from '@angular/router';
import { PERMISSIONS } from '@core/api/types';
import { permissionGuard } from '@core/auth/permission.guard';
import { signedInGuard } from '@core/auth/signed-in.guard';
import { quoteGuard } from '@core/cart/quote.guard';

/**
 * Checkout and Order placed are pushed onto the Cart tab's stack (spec §5), so
 * they are children of the cart route rather than tabs of their own — the back
 * button then returns to the cart, which is where the user came from.
 */
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'tabs/products' },
  {
    path: 'tabs',
    loadComponent: () => import('./tabs/tabs.page').then((m) => m.TabsPage),
    children: [
      {
        path: 'products',
        loadComponent: () => import('@features/products/products.page').then((m) => m.ProductsPage),
      },
      {
        path: 'cart',
        loadComponent: () => import('@features/cart/cart.page').then((m) => m.CartPage),
      },
      {
        path: 'cart/checkout',
        canActivate: [quoteGuard],
        loadComponent: () => import('@features/checkout/checkout.page').then((m) => m.CheckoutPage),
      },
      {
        path: 'cart/placed/:id',
        loadComponent: () =>
          import('@features/order-placed/order-placed.page').then((m) => m.OrderPlacedPage),
      },
      {
        // The buyer's own history (spec §5.7). The read needs a principal and
        // no permission, so the guard asks for a session; the tab hides while
        // there is none, and the BFF decides whose orders come back.
        path: 'orders',
        canActivate: [signedInGuard],
        loadComponent: () => import('@features/orders/orders.page').then((m) => m.OrdersPage),
      },
      {
        // Pushed on the History tab's stack, so back returns to the list.
        path: 'orders/:id',
        canActivate: [signedInGuard],
        loadComponent: () =>
          import('@features/orders/order-detail.page').then((m) => m.OrderDetailPage),
      },
      {
        path: 'publish',
        // The guard refuses a direct navigation even though the tab is hidden.
        // The e2e smoke asserts both halves for the `browser` user (spec §7).
        canActivate: [permissionGuard(PERMISSIONS.catalogWrite)],
        loadComponent: () => import('@features/publish/publish.page').then((m) => m.PublishPage),
      },
      {
        path: 'account',
        loadComponent: () => import('@features/account/account.page').then((m) => m.AccountPage),
      },
      { path: '', pathMatch: 'full', redirectTo: 'products' },
    ],
  },
];
