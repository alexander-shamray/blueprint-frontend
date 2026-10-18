import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, map } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import { ProductSummary } from '@core/api/types';
import { CartPersistence } from '@core/cart/cart.persistence';
import { CartStore } from '@core/cart/cart.store';
import { CatalogAvailability } from '@core/catalog/catalog-availability';
import { RateLimitWindows } from '@core/errors/rate-limit';
import { rateLimitInterceptor } from '@core/errors/rate-limit.interceptor';
import { ProductPage } from './product.page';

const GUID_A = '0199b0c4-6f2e-7a31-8c5d-2e4f6a7b8c9d';
const GUID_B = '0199b0c4-8b21-7c53-ae7f-4a6b8c9d0e1f';
const url = (id: string) => `http://localhost:5000/api/v1/catalog/products/${id}`;

const product = (quantityAvailable: number | null, productId = GUID_A): ProductSummary => ({
  productId,
  name: 'Lamp',
  thumbnailUrl: 'https://img.example/lamp.png',
  amount: 12.5,
  currency: 'EUR',
  publishedAt: '2026-09-10T00:00:00Z',
  quantityAvailable,
});

describe('ProductPage', () => {
  let fixture: ComponentFixture<ProductPage>;
  let controller: HttpTestingController;
  let paramMap: BehaviorSubject<string>;

  const mount = async (id: string, before?: () => void) => {
    paramMap = new BehaviorSubject(id);
    TestBed.configureTestingModule({
      imports: [ProductPage],
      providers: [
        // The real interceptor, for the reason `ProductsPage`'s spec gives:
        // the 429 window is opened from the response, not by the page.
        provideHttpClient(withInterceptors([rateLimitInterceptor])),
        provideHttpClientTesting(),
        provideRouter([]),
        CartStore,
        { provide: CartPersistence, useValue: { read: async () => [], write: async () => undefined } },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: { get: () => paramMap.value } },
            paramMap: paramMap.pipe(map((value) => convertToParamMap({ id: value }))),
          },
        },
      ],
    });
    controller = TestBed.inject(HttpTestingController);
    before?.();
    fixture = TestBed.createComponent(ProductPage);
    fixture.detectChanges();
    await fixture.whenStable();
  };

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
  };

  const query = (selector: string): HTMLElement | null => fixture.nativeElement.querySelector(selector);
  const text = (): string => fixture.nativeElement.textContent ?? '';
  const button = (label: string): HTMLElement & { disabled: boolean } =>
    [...fixture.nativeElement.querySelectorAll('ion-button')].find(
      (b: HTMLElement) => b.textContent?.trim() === label,
    );

  afterEach(() => controller.verify());

  it('reads the product its address names, and shows the image, price and stock', async () => {
    await mount(GUID_A);

    expect(query('app-skeleton-list')).not.toBeNull();
    controller.expectOne(url(GUID_A)).flush(product(3));
    await settle();

    expect(query('img.hero')?.getAttribute('src')).toBe('https://img.example/lamp.png');
    expect(query('[data-testid="product-name"]')?.textContent).toContain('Lamp');
    expect(query('[data-testid="product-price"]')?.textContent).toContain('12.50');
    expect(query('[data-testid="product-stock"]')?.textContent).toContain('Only 3 left');
    expect(query('app-skeleton-list')).toBeNull();
  });

  it('hands the level it read to the cart through core', async () => {
    await mount(GUID_A);
    controller.expectOne(url(GUID_A)).flush(product(2));
    await settle();

    expect(TestBed.inject(CatalogAvailability).of(GUID_A)).toBe(2);
  });

  it('says nothing about stock that was never reported', async () => {
    await mount(GUID_A);
    controller.expectOne(url(GUID_A)).flush(product(null));
    await settle();

    expect(query('[data-testid="product-stock"]')).toBeNull();
  });

  it('floors the stepper at one', async () => {
    await mount(GUID_A);
    controller.expectOne(url(GUID_A)).flush(product(10));
    await settle();

    fixture.componentInstance.step(-1);
    await settle();

    expect(fixture.componentInstance.quantity()).toBe(1);
    expect(button('−').disabled).toBe(true);
  });

  it('warns past the listed level, still adds, and says what it added', async () => {
    await mount(GUID_A);
    controller.expectOne(url(GUID_A)).flush(product(2));
    await settle();

    fixture.componentInstance.step(1);
    fixture.componentInstance.step(1);
    await settle();
    expect(query('[data-testid="product-exceeds"]')).not.toBeNull();

    button('Add to cart').click();
    await settle();

    expect(TestBed.inject(CartStore).count()).toBe(3);
    expect(query('[data-testid="product-added"]')?.textContent).toContain('Added 3 to the cart.');
    expect(fixture.componentInstance.quantity()).toBe(1);
  });

  it('refuses to add a product that is out of stock', async () => {
    await mount(GUID_A);
    controller.expectOne(url(GUID_A)).flush(product(0));
    await settle();

    expect(button('Add to cart').disabled).toBe(true);
    fixture.componentInstance.addToCart();
    expect(TestBed.inject(CartStore).count()).toBe(0);
  });

  it('states that a product the platform does not have is not available, with no banner', async () => {
    await mount(GUID_A);
    controller
      .expectOne(url(GUID_A))
      .flush(
        { title: 'Not found', detail: 'No product with that id.', code: 'product.not_found' },
        { status: 404, statusText: 'Not Found' },
      );
    await settle();

    expect(fixture.componentInstance.notAvailable()).toBe(true);
    expect(fixture.componentInstance.error()).toBeNull();
    expect(text()).toContain('This product is not available');
    expect(text()).not.toContain('No product with that id.');
    expect(button('Browse products')).toBeDefined();
  });

  it('sends nothing for an address that cannot name a product', async () => {
    await mount('..');
    await settle();

    controller.expectNone(() => true);
    expect(fixture.componentInstance.notAvailable()).toBe(true);
  });

  it('shows any other failure as a banner and reads again on Try again', async () => {
    await mount(GUID_A);
    controller
      .expectOne(url(GUID_A))
      .flush({ title: 'Down' }, { status: 503, statusText: 'Unavailable' });
    await settle();

    expect(fixture.componentInstance.error()).not.toBeNull();
    expect(fixture.componentInstance.notAvailable()).toBe(false);

    button('Try again').click();
    controller.expectOne(url(GUID_A)).flush(product(4));
    await settle();

    expect(fixture.componentInstance.error()).toBeNull();
    expect(fixture.componentInstance.product()?.quantityAvailable).toBe(4);
  });

  it('reads a new product when the address changes, and drops the old reply', async () => {
    await mount(GUID_A);
    const first = controller.expectOne(url(GUID_A));

    paramMap.next(GUID_B);
    await settle();
    const second = controller.expectOne(url(GUID_B));

    first.flush(product(1, GUID_A));
    second.flush(product(9, GUID_B));
    await settle();

    expect(fixture.componentInstance.product()?.productId).toBe(GUID_B);
  });

  it('holds the first read while the catalogue window is open, and sends it once it closes', async () => {
    await mount(GUID_A, () =>
      TestBed.inject(RateLimitWindows)
        .forPartition('catalogue')
        .open({ kind: 'rateLimited', title: 'Too many', detail: null, retryAfterSeconds: 30 }),
    );

    controller.expectNone(url(GUID_A));

    TestBed.inject(RateLimitWindows).forPartition('catalogue').close();
    await settle();

    controller.expectOne(url(GUID_A)).flush(product(5));
  });
});
