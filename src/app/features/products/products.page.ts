import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import {
  IonContent, IonHeader, IonInfiniteScroll, IonInfiniteScrollContent, IonItem, IonLabel,
  IonList, IonNote, IonThumbnail, IonTitle, IonToolbar, IonButton,
} from '@ionic/angular';
import { CatalogApi } from '@core/api/catalog.api';
import { ProductSummary } from '@core/api/types';
import { CartStore } from '@core/cart/cart.store';
import { DisplayError, mapError } from '@core/errors/error-mapper';
import { ErrorBannerComponent } from '@shared/error-banner.component';

/**
 * Spec §5.1. The landing tab, and it works before sign-in: the listing is
 * anonymous at the gateway and at the endpoint, so a client that demanded a
 * token here would be refusing to show what the platform publishes.
 */
@Component({
  selector: 'app-products',
  standalone: true,
  imports: [
    IonButton, IonContent, IonHeader, IonInfiniteScroll, IonInfiniteScrollContent, IonItem,
    IonLabel, IonList, IonNote, IonThumbnail, IonTitle, IonToolbar, ErrorBannerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header><ion-toolbar><ion-title>Products</ion-title></ion-toolbar></ion-header>

    <ion-content>
      <app-error-banner [error]="error()" />

      <ion-list>
        @for (product of products(); track product.productId) {
          <ion-item>
            @if (product.thumbnailUrl) {
              <ion-thumbnail slot="start">
                <img [src]="product.thumbnailUrl" [alt]="product.name" />
              </ion-thumbnail>
            }

            <ion-label>
              <h2>{{ product.name }}</h2>
              <ion-note>{{ product.amount }} {{ product.currency }}</ion-note>
            </ion-label>

            <ion-button slot="end" fill="clear" (click)="addToCart(product)">Add</ion-button>
          </ion-item>
        }
      </ion-list>

      <ion-infinite-scroll [disabled]="!hasMore()" (ionInfinite)="loadMore($event)">
        <ion-infinite-scroll-content></ion-infinite-scroll-content>
      </ion-infinite-scroll>
    </ion-content>
  `,
})
export class ProductsPage {
  private readonly catalog = inject(CatalogApi);
  private readonly cart = inject(CartStore);
  private cursor: string | null = null;

  readonly products = signal<readonly ProductSummary[]>([]);
  readonly error = signal<DisplayError | null>(null);
  /** Null nextCursor is the last page (CursorPage.cs). Nothing asks past it. */
  readonly hasMore = signal(true);

  constructor() {
    this.load();
  }

  /** Called by the publish page after a success (spec §5.5). */
  reload(): void {
    this.cursor = null;
    this.products.set([]);
    this.hasMore.set(true);
    this.load();
  }

  loadMore(event?: { target: { complete: () => void } }): void {
    this.load(() => event?.target.complete());
  }

  addToCart(product: ProductSummary): void {
    // Local only. The backend has no cart, so there is nothing to call.
    this.cart.add(product);
  }

  private load(done?: () => void): void {
    this.catalog.products(this.cursor).subscribe({
      next: (page) => {
        this.error.set(null);
        this.products.update((existing) => [...existing, ...page.items]);
        this.cursor = page.nextCursor;
        this.hasMore.set(page.nextCursor !== null);
        done?.();
      },
      error: (failure: HttpErrorResponse) => {
        this.error.set(mapError(failure));
        // Stop asking. Retrying into a 429 is how a rate limit becomes a loop.
        this.hasMore.set(false);
        done?.();
      },
    });
  }
}
