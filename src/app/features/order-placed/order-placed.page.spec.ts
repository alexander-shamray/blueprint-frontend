import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, map } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import { OrderPlacedPage } from './order-placed.page';

const GUID_A = '44444444-4444-4444-4444-444444444444';
const GUID_B = '55555555-5555-5555-5555-555555555555';

function mount(id: string): { fixture: ComponentFixture<OrderPlacedPage>; paramMap: BehaviorSubject<string> } {
  TestBed.resetTestingModule();

  // A BehaviorSubject-backed paramMap, not just `snapshot`, so the reuse
  // test below can drive a second id through the SAME ActivatedRoute the
  // way Angular's `advanceActivatedRoute` does on a reused route — the path
  // that exists whenever a route's `RouteReuseStrategy` reuses a component
  // across two different `:id`s, IonicRouteStrategy included.
  const paramMap = new BehaviorSubject(id);

  TestBed.configureTestingModule({
    imports: [OrderPlacedPage],
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: { paramMap: { get: () => paramMap.value } },
          paramMap: paramMap.pipe(map((value) => convertToParamMap({ id: value }))),
        },
      },
    ],
  });

  const fixture = TestBed.createComponent(OrderPlacedPage);
  fixture.detectChanges();
  return { fixture, paramMap };
}

describe('OrderPlacedPage', () => {
  let controller: HttpTestingController;

  afterEach(() => controller?.verify());

  it('renders the order id and the no-read-endpoint sentence for a real order', () => {
    const { fixture } = mount(GUID_A);

    expect(fixture.nativeElement.textContent).toContain(GUID_A);
    expect(fixture.nativeElement.textContent).toContain(
      'The platform exposes no endpoint that reads an order back',
    );

    const button = [...fixture.nativeElement.querySelectorAll('ion-button')].find(
      (el: HTMLElement) => el.textContent?.trim() === 'Cancel order',
    );
    expect(button).toBeTruthy();
  });

  it('sends customer_request and offers no other reason, via the rendered Cancel button', () => {
    const { fixture } = mount(GUID_A);
    controller = TestBed.inject(HttpTestingController);

    const button: HTMLElement = [...fixture.nativeElement.querySelectorAll('ion-button')].find(
      (el: HTMLElement) => el.textContent?.trim() === 'Cancel order',
    );
    button.click();

    // The other four codes are the platform's own findings — the saga's stock
    // outcomes and Payments' results. A customer cannot truthfully assert any
    // of them, and the endpoint stamps origin User whatever arrives.
    const request = controller.expectOne((r) => r.url.endsWith('/cancel'));
    expect(request.request.body).toEqual({ reason: 'customer_request' });

    // The half of the name that the body assertion does not cover: no picker
    // is rendered at all. Asserting CANCEL_REASONS contains customer_request
    // would prove nothing here — that is a fact about a frozen constant, true
    // whatever this page puts on screen.
    expect(fixture.nativeElement.querySelector('ion-select')).toBeNull();

    request.flush(null, { status: 204, statusText: 'No Content' });
  });

  it('reports the 204 with the cancelled note, clearing a prior error', async () => {
    const { fixture } = mount(GUID_A);
    controller = TestBed.inject(HttpTestingController);

    fixture.componentInstance.cancel();
    controller
      .expectOne((r) => r.url.endsWith('/cancel'))
      .flush({ title: 'Forbidden', status: 403 }, { status: 403, statusText: 'Forbidden' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance.error()).not.toBeNull();

    fixture.componentInstance.cancel();
    controller
      .expectOne((r) => r.url.endsWith('/cancel'))
      .flush(null, { status: 204, statusText: 'No Content' });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.cancelled()).toBe(true);
    expect(fixture.componentInstance.error()).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Cancelled. The platform answered 204.');
  });

  it('guards a second tap while a cancel is in flight — no commandId here to replay under', () => {
    const { fixture } = mount(GUID_A);
    controller = TestBed.inject(HttpTestingController);

    fixture.componentInstance.cancel();
    fixture.componentInstance.cancel();

    // Exactly one request outstanding: expectOne throws if a second one was
    // sent. Flushing it satisfies afterEach's verify().
    controller
      .expectOne((r) => r.url.endsWith('/cancel'))
      .flush(null, { status: 204, statusText: 'No Content' });
  });

  it('maps a 403 to a banner naming orders:cancel', async () => {
    const { fixture } = mount(GUID_A);
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
    const { fixture } = mount('already-committed');

    expect(fixture.componentInstance.canCancel()).toBe(false);
    expect(fixture.componentInstance.alreadyCommitted()).toBe(true);

    const text: string = fixture.nativeElement.textContent;
    expect(text).toContain('Already committed');
    expect(text).toContain('already been applied');
    // No order id came back, so there is nothing to cancel and nothing to
    // read — neither the sentinel nor a real id belongs on screen here.
    expect(text).not.toContain('already-committed');
    expect(
      [...fixture.nativeElement.querySelectorAll('ion-button')].some(
        (el: HTMLElement) => el.textContent?.trim() === 'Cancel order',
      ),
    ).toBe(false);
  });

  it('drives a new :id through the route and updates what a reused instance shows', async () => {
    const { fixture, paramMap } = mount(GUID_A);
    controller = TestBed.inject(HttpTestingController);

    // Cancel order A on this instance...
    fixture.componentInstance.cancel();
    controller
      .expectOne((r) => r.url.endsWith('/cancel'))
      .flush(null, { status: 204, statusText: 'No Content' });
    await fixture.whenStable();
    expect(fixture.componentInstance.cancelled()).toBe(true);

    // ...then simulate Angular's default RouteReuseStrategy reusing this
    // SAME component across placed/A -> placed/B: advanceActivatedRoute
    // swaps `snapshot` in place and emits the new ParamMap on `paramMap`
    // without a new component ever being constructed. IonicRouteStrategy
    // (now installed in app.config.ts) prevents this reuse app-wide, but the
    // page must be correct even if it were not.
    paramMap.next(GUID_B);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.orderId()).toBe(GUID_B);
    expect(fixture.nativeElement.textContent).toContain(GUID_B);
    expect(fixture.nativeElement.textContent).not.toContain(GUID_A);

    // Order A's "cancelled" note must not bleed onto order B, which this
    // instance has never touched.
    expect(fixture.componentInstance.cancelled()).toBe(false);
    expect(fixture.nativeElement.textContent).not.toContain('Cancelled. The platform answered 204.');
  });
});
