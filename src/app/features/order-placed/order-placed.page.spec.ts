import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { afterEach, describe, expect, it } from 'vitest';
import { OrderPlacedPage } from './order-placed.page';

function mount(id: string): ComponentFixture<OrderPlacedPage> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [OrderPlacedPage],
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => id } } } },
    ],
  });

  const fixture = TestBed.createComponent(OrderPlacedPage);
  fixture.detectChanges();
  return fixture;
}

describe('OrderPlacedPage', () => {
  let controller: HttpTestingController;

  afterEach(() => controller?.verify());

  it('sends customer_request and offers no other reason', () => {
    const fixture = mount('44444444-4444-4444-4444-444444444444');
    controller = TestBed.inject(HttpTestingController);

    fixture.componentInstance.cancel();

    // The other four codes are the platform's own findings — the saga's stock
    // outcomes and Payments' results. A customer cannot truthfully assert any
    // of them, and the endpoint stamps origin User whatever arrives.
    expect(controller.expectOne((r) => r.url.endsWith('/cancel')).request.body)
      .toEqual({ reason: 'customer_request' });

    // The half of the name that the body assertion does not cover: no picker
    // is rendered at all. Asserting CANCEL_REASONS contains customer_request
    // would prove nothing here — that is a fact about a frozen constant, true
    // whatever this page puts on screen.
    expect(fixture.nativeElement.querySelector('ion-select')).toBeNull();
  });

  it('posts the reason and reports the 204', async () => {
    const fixture = mount('44444444-4444-4444-4444-444444444444');
    controller = TestBed.inject(HttpTestingController);

    fixture.componentInstance.cancel();

    const request = controller.expectOne(
      'http://localhost:5000/api/v1/orders/44444444-4444-4444-4444-444444444444/cancel',
    );
    expect(request.request.body).toEqual({ reason: 'customer_request' });

    request.flush(null, { status: 204, statusText: 'No Content' });
    await fixture.whenStable();

    expect(fixture.componentInstance.cancelled()).toBe(true);
  });

  it('maps a 403 to a banner naming orders:cancel', async () => {
    const fixture = mount('44444444-4444-4444-4444-444444444444');
    controller = TestBed.inject(HttpTestingController);

    fixture.componentInstance.cancel();
    controller
      .expectOne((r) => r.url.endsWith('/cancel'))
      .flush({ title: 'Forbidden', status: 403 }, { status: 403, statusText: 'Forbidden' });
    await fixture.whenStable();

    expect(fixture.componentInstance.error()).toMatchObject({
      kind: 'forbidden',
      permission: 'orders:cancel',
    });
  });

  it('hides cancel and explains when the command already committed', () => {
    const fixture = mount('already-committed');
    controller = TestBed.inject(HttpTestingController);

    // No order id came back, so there is nothing to cancel and nothing to read.
    expect(fixture.componentInstance.canCancel()).toBe(false);
    expect(fixture.componentInstance.alreadyCommitted()).toBe(true);
  });
});
