import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProductSummary } from '@core/api/types';
import { ProductSheetComponent } from './product-sheet.component';

const product = (quantityAvailable: number | null): ProductSummary => ({
  productId: 'p1',
  name: 'Lamp',
  thumbnailUrl: 'https://img.example/lamp.png',
  amount: 12.5,
  currency: 'EUR',
  publishedAt: '2026-09-10T00:00:00Z',
  quantityAvailable,
});

describe('ProductSheetComponent', () => {
  let fixture: ComponentFixture<ProductSheetComponent>;
  let added: number[];
  let closed: number;

  const mount = async (quantityAvailable: number | null) => {
    fixture = TestBed.createComponent(ProductSheetComponent);
    fixture.componentRef.setInput('product', product(quantityAvailable));
    added = [];
    closed = 0;
    fixture.componentInstance.added.subscribe((n) => added.push(n));
    fixture.componentInstance.closed.subscribe(() => closed++);
    fixture.detectChanges();
    await fixture.whenStable();
  };

  const query = (selector: string): HTMLElement | null => fixture.nativeElement.querySelector(selector);
  const button = (label: string): HTMLElement & { disabled: boolean } =>
    [...fixture.nativeElement.querySelectorAll('ion-button')].find(
      (b: HTMLElement) => b.textContent?.trim() === label,
    );

  beforeEach(() => TestBed.configureTestingModule({ imports: [ProductSheetComponent] }));

  it('shows the larger image, the formatted price and the stock the row carried', async () => {
    await mount(3);

    expect(query('img.hero')?.getAttribute('src')).toBe('https://img.example/lamp.png');
    expect(query('[data-testid="sheet-price"]')?.textContent).toContain('12.50');
    expect(query('[data-testid="sheet-stock"]')?.textContent).toContain('Only 3 left');
  });

  it('says nothing about stock that was never reported', async () => {
    await mount(null);

    expect(query('[data-testid="sheet-stock"]')).toBeNull();
  });

  it('floors the stepper at one', async () => {
    await mount(10);

    fixture.componentInstance.step(-1);
    fixture.detectChanges();

    expect(fixture.componentInstance.quantity()).toBe(1);
    expect(button('−').disabled).toBe(true);
  });

  it('warns past the listed level and still lets the customer add', async () => {
    await mount(2);

    fixture.componentInstance.step(1);
    fixture.componentInstance.step(1);
    fixture.detectChanges();

    expect(query('[data-testid="sheet-exceeds"]')).not.toBeNull();
    button('Add to cart').click();
    expect(added).toEqual([3]);
  });

  it('refuses to add a product that is out of stock', async () => {
    await mount(0);

    expect(button('Add to cart').disabled).toBe(true);
  });

  it('closes on request', async () => {
    await mount(null);

    button('Close').click();
    expect(closed).toBe(1);
  });
});
