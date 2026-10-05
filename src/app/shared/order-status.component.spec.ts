import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { describe, expect, it } from 'vitest';
import { BUYER_STATUSES } from '@core/api/types';
import { OrderStatusComponent, statusLabel } from './order-status.component';

/** A Stencil host element: resolves once its lazily loaded component has rendered. */
interface StencilHost extends Element {
  componentOnReady(): Promise<unknown>;
}

/**
 * Mounts and waits for every Ionic host to hydrate, for the reason
 * `tabs.page.spec.ts` gives at length (#31): a file this short otherwise ends
 * with the chip's chunk still loading, and Vitest reports the teardown race
 * as an unhandled error with every test passing.
 */
async function mount(status: string): Promise<ComponentFixture<OrderStatusComponent>> {
  const fixture = TestBed.createComponent(OrderStatusComponent);
  fixture.componentRef.setInput('status', status);
  fixture.detectChanges();
  const hosts = [...fixture.nativeElement.querySelectorAll('*')].filter(
    (el): el is StencilHost => el.tagName.startsWith('ION-') && 'componentOnReady' in el,
  );
  await Promise.all(hosts.map((host) => host.componentOnReady()));
  return fixture;
}

describe('statusLabel', () => {
  it('names every member of the closed vocabulary, and none by its wire spelling', () => {
    for (const status of BUYER_STATUSES) {
      expect(statusLabel(status)).not.toBe(status);
    }
  });

  it('calls a declined order a payment decline, which is what §10.7 collapses into it', () => {
    expect(statusLabel('declined')).toBe('Payment declined');
    expect(statusLabel('out_of_stock')).toBe('Out of stock');
  });

  it('renders a member outside the contract as sent, and an inherited key as itself', () => {
    expect(statusLabel('refunding')).toBe('refunding');
    expect(statusLabel('constructor')).toBe('constructor');
  });
});

describe('OrderStatusComponent', () => {
  it('never draws an ending in the danger colour the error banner owns', async () => {
    for (const status of BUYER_STATUSES) {
      const fixture = await mount(status);

      const chip = fixture.debugElement.query(By.css('ion-chip')).componentInstance as {
        color: string;
      };
      expect(chip.color).toBeTruthy();
      expect(chip.color).not.toBe('danger');
    }
  });

  it('renders the label', async () => {
    const fixture = await mount('dispatched');

    expect(fixture.nativeElement.textContent).toContain('Dispatched');
  });
});
