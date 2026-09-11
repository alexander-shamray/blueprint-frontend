import { Injectable, Signal, signal } from '@angular/core';

/**
 * `IonRouterOutlet` delegates to Ionic's `StackController`, which keeps a
 * `views` list per tab stack and reuses the cached `ComponentRef` for a URL
 * it has already activated (`StackController.getExistingView`, called from
 * `IonRouterOutlet.activateWith`) instead of constructing a new one. So
 * `ProductsPage`'s constructor — which is where it loads its first page —
 * runs exactly ONCE, on first entry into the products tab. Navigating back to
 * `/tabs/products` after publishing a product does NOT re-run it; the tab
 * shows whatever it already had.
 *
 * This service is the fix, mediated through core because a feature never
 * imports another feature (spec §3; ESLint enforces it) — the publish page
 * cannot call `ProductsPage.reload()` directly. It bumps a version; anything
 * that cares (currently just `ProductsPage`) watches it and reacts.
 *
 * Private-writable signal / public `asReadonly()`: this repo's convention for
 * state one class owns and others may only observe — see `CartStore.lines`
 * and `CommandIdentity.current`.
 */
@Injectable({ providedIn: 'root' })
export class CatalogRefresh {
  private readonly version = signal(0);

  readonly current: Signal<number> = this.version.asReadonly();

  /** Called after a publish succeeds. Bumping is the whole API — callers don't know or care by how much. */
  request(): void {
    this.version.update((n) => n + 1);
  }
}
