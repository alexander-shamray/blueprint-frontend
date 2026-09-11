import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '@core/auth/auth.service';
import { ALREADY_COMMITTED } from '@core/commands/command-id';
import { CatalogRefresh } from '@core/catalog/catalog-refresh';
import { PublishPage } from './publish.page';

describe('PublishPage', () => {
  let fixture: ComponentFixture<PublishPage>;
  let controller: HttpTestingController;
  let navigate: ReturnType<typeof vi.fn>;
  let signIn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    signIn = vi.fn(async () => undefined);

    TestBed.configureTestingModule({
      imports: [PublishPage],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: AuthService,
          useValue: { signIn, user: () => signal({ username: 'demo' }), accessToken: () => 't' },
        },
      ],
    });

    navigate = vi.fn(async () => true);
    vi.spyOn(TestBed.inject(Router), 'navigate').mockImplementation(navigate as never);

    fixture = TestBed.createComponent(PublishPage);
    controller = TestBed.inject(HttpTestingController);
    fixture.detectChanges();

    fixture.componentInstance.form.setValue({
      name: 'A widget', thumbnailUrl: '', amount: 12.5, currency: 'EUR',
    });
  });

  afterEach(() => controller.verify());

  it('sends a PublishProductCommand with a null thumbnail when blank', async () => {
    fixture.componentInstance.publish();

    const request = controller.expectOne('http://localhost:5000/api/v1/catalog/products');
    const body = request.request.body;

    expect(body).toMatchObject({
      name: 'A widget', thumbnailUrl: null, amount: 12.5, currency: 'EUR',
    });
    expect(body.commandId).toMatch(/^[0-9a-f-]{36}$/);

    // Not left dangling — see "reuses the commandId across a retried 503"
    // below for what an unflushed request would hide: expectOne() removes it
    // from the testing backend's open list, so afterEach's verify() cannot
    // catch a request this test itself forgot to answer.
    request.flush('55555555-5555-5555-5555-555555555555', { status: 200, statusText: 'OK' });
    await fixture.whenStable();
  });

  it('reuses the commandId across a retried 503', async () => {
    fixture.componentInstance.publish();
    const first = controller.expectOne('http://localhost:5000/api/v1/catalog/products');
    const firstId = first.request.body.commandId;
    first.flush({ title: 'Service Unavailable', status: 503 }, { status: 503, statusText: '' });
    await fixture.whenStable();

    fixture.componentInstance.publish();
    const second = controller.expectOne('http://localhost:5000/api/v1/catalog/products');

    expect(second.request.body.commandId).toBe(firstId);
    second.flush('55555555-5555-5555-5555-555555555555', { status: 200, statusText: 'OK' });
    await fixture.whenStable();
  });

  it('mints a fresh commandId after a success and resets the form so a second click cannot resubmit the same product', async () => {
    fixture.componentInstance.publish();
    const first = controller.expectOne('http://localhost:5000/api/v1/catalog/products');
    const firstId = first.request.body.commandId;
    first.flush('55555555-5555-5555-5555-555555555555', { status: 200, statusText: 'OK' });
    await fixture.whenStable();

    expect(fixture.componentInstance.identity.current()).not.toBe(firstId);
    expect(fixture.componentInstance.publishedId()).toBe('55555555-5555-5555-5555-555555555555');

    // The line the page's "no null-quote-style window" reasoning rests on:
    // identity.isSpent() alone is false again after onSuccess(), so without
    // form.reset() making form.invalid true in the same synchronous
    // callback, the submit button would re-enable over a form still holding
    // the product just published — one click from a duplicate.
    expect(fixture.componentInstance.form.invalid).toBe(true);
  });

  it('mints a new commandId after the form is edited following a validation failure', async () => {
    fixture.componentInstance.publish();
    const first = controller.expectOne('http://localhost:5000/api/v1/catalog/products');
    const firstId = first.request.body.commandId;
    first.flush(
      { status: 400, errors: { Amount: ["'Amount' must be greater than or equal to '0'."] } },
      { status: 400, statusText: 'Bad Request' },
    );
    await fixture.whenStable();

    fixture.componentInstance.form.controls.amount.setValue(5);
    fixture.componentInstance.publish();

    const second = controller.expectOne('http://localhost:5000/api/v1/catalog/products');
    expect(second.request.body.commandId).not.toBe(firstId);
    second.flush('55555555-5555-5555-5555-555555555555', { status: 200, statusText: 'OK' });
    await fixture.whenStable();
  });

  it('treats command.already_committed as success and leaves the page usable', async () => {
    const refresh = TestBed.inject(CatalogRefresh);
    const before = refresh.current();

    fixture.componentInstance.publish();
    const first = controller.expectOne('http://localhost:5000/api/v1/catalog/products');
    const firstId = first.request.body.commandId;
    first.flush(
      { status: 409, code: 'command.already_committed', detail: 'Already applied.' },
      { status: 409, statusText: 'Conflict' },
    );
    await fixture.whenStable();

    // The product exists — the platform just no longer holds the result to
    // hand an id back for — so this is the "success" note, not an error.
    expect(fixture.componentInstance.publishedId()).toBe(ALREADY_COMMITTED);
    expect(fixture.componentInstance.error()).toBeNull();
    expect(refresh.current()).toBe(before + 1);

    // Unlike checkout — which escapes a spent identity by navigating away
    // and being rebuilt — this page never navigates, so if the id stayed
    // spent here the Publish tab would be dead for the rest of the session.
    expect(fixture.componentInstance.identity.isSpent()).toBe(false);
    expect(fixture.componentInstance.form.invalid).toBe(true);

    fixture.componentInstance.form.setValue({
      name: 'Another widget', thumbnailUrl: '', amount: 3, currency: 'EUR',
    });
    fixture.componentInstance.publish();

    const second = controller.expectOne('http://localhost:5000/api/v1/catalog/products');
    expect(second.request.body.commandId).not.toBe(firstId);
    second.flush('66666666-6666-6666-6666-666666666666', { status: 200, statusText: 'OK' });
    await fixture.whenStable();
  });

  it('shows field errors from a 400 keyed as the validator keyed them', async () => {
    fixture.componentInstance.publish();
    controller.expectOne('http://localhost:5000/api/v1/catalog/products').flush(
      { status: 400, errors: { Amount: ["'Amount' must be greater than or equal to '0'."] } },
      { status: 400, statusText: 'Bad Request' },
    );
    await fixture.whenStable();

    expect(fixture.componentInstance.error()?.fields).toEqual({
      Amount: ["'Amount' must be greater than or equal to '0'."],
    });
  });

  it('asks the products tab to refresh rather than relying on navigation', async () => {
    const refresh = TestBed.inject(CatalogRefresh);
    const before = refresh.current();

    fixture.componentInstance.publish();
    controller
      .expectOne('http://localhost:5000/api/v1/catalog/products')
      .flush('55555555-5555-5555-5555-555555555555', { status: 200, statusText: 'OK' });
    await fixture.whenStable();

    // ProductsPage is constructed once per app session, so it cannot learn
    // of this publish by being visited. If this assertion fails, a
    // published product is invisible until the app restarts.
    expect(refresh.current()).toBe(before + 1);

    // The other half of the test's own name: a page that both navigated AND
    // refreshed would still pass the assertion above.
    expect(navigate).not.toHaveBeenCalled();
  });

  it('publishes a free product, because the backend allows an amount of zero', async () => {
    fixture.componentInstance.form.setValue({
      name: 'A free widget', thumbnailUrl: '', amount: 0, currency: 'EUR',
    });

    // Validators.required treats 0 as present (isEmptyInputValue checks
    // null and length, not falsiness), and PublishProductValidator.cs uses
    // GreaterThanOrEqualTo(0). A client that refused 0 would refuse
    // something the platform accepts.
    expect(fixture.componentInstance.form.valid).toBe(true);

    fixture.componentInstance.publish();

    const request = controller.expectOne('http://localhost:5000/api/v1/catalog/products');
    expect(request.request.body.amount).toBe(0);

    request.flush('55555555-5555-5555-5555-555555555555', { status: 200, statusText: 'OK' });
    await fixture.whenStable();
  });

  it('invokes sign-in on a 401 and replays the publish under the same commandId', async () => {
    fixture.componentInstance.publish();
    const first = controller.expectOne('http://localhost:5000/api/v1/catalog/products');
    const firstId = first.request.body.commandId;

    first.flush({ title: 'Unauthorized', status: 401 }, { status: 401, statusText: 'Unauthorized' });
    await fixture.whenStable();

    expect(signIn).toHaveBeenCalledOnce();

    // "…and replays after" (spec §6). The same commandId is what makes the
    // automatic resubmission a replay rather than a second product:
    // IdempotencyBehavior keys on it. (The 401 was refused at the edge, so
    // nothing was published to duplicate either way.)
    const replay = controller.expectOne('http://localhost:5000/api/v1/catalog/products');
    expect(replay.request.body.commandId).toBe(firstId);

    replay.flush('55555555-5555-5555-5555-555555555555', { status: 200, statusText: 'OK' });
    await fixture.whenStable();

    // The form's values were still in front of the user throughout — this
    // page never navigates — so the publish they asked for is the publish
    // that happened.
    expect(fixture.componentInstance.publishedId()).toBe('55555555-5555-5555-5555-555555555555');
  });

  it('does not loop when the replay is refused with another 401', async () => {
    fixture.componentInstance.publish();
    controller
      .expectOne('http://localhost:5000/api/v1/catalog/products')
      .flush({ title: 'Unauthorized', status: 401 }, { status: 401, statusText: 'Unauthorized' });
    await fixture.whenStable();

    controller
      .expectOne('http://localhost:5000/api/v1/catalog/products')
      .flush({ title: 'Unauthorized', status: 401 }, { status: 401, statusText: 'Unauthorized' });
    await fixture.whenStable();

    // Sign-in is offered every time a 401 arrives — that is what the row
    // says — but the automatic replay is spent after one, so this is two
    // requests and not an unbounded chain of them.
    expect(signIn).toHaveBeenCalledTimes(2);
    controller.expectNone('http://localhost:5000/api/v1/catalog/products');
  });

  it('disables Publish while a 429 window is open', async () => {
    fixture.componentInstance.publish();
    controller.expectOne('http://localhost:5000/api/v1/catalog/products').flush(
      { title: 'Too many requests', status: 429 },
      { status: 429, statusText: 'Too Many Requests' },
    );
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.rateLimit.blocked()).toBe(true);

    const publish = [...fixture.nativeElement.querySelectorAll('ion-button')].find(
      (el: HTMLElement) => el.textContent?.trim() === 'Publish',
    );
    expect(publish.disabled).toBe(true);
  });

  it('names catalog:write on a 403', async () => {
    fixture.componentInstance.publish();
    controller
      .expectOne('http://localhost:5000/api/v1/catalog/products')
      .flush({ title: 'Forbidden', status: 403 }, { status: 403, statusText: 'Forbidden' });
    await fixture.whenStable();

    expect(fixture.componentInstance.error()?.permission).toBe('catalog:write');
  });

  it('does nothing when publish() is called on an invalid form', () => {
    fixture.componentInstance.form.controls.name.setValue('');

    fixture.componentInstance.publish();

    controller.expectNone('http://localhost:5000/api/v1/catalog/products');
  });

  it('clears a stale publishedId when a new attempt starts', async () => {
    fixture.componentInstance.publish();
    controller
      .expectOne('http://localhost:5000/api/v1/catalog/products')
      .flush('55555555-5555-5555-5555-555555555555', { status: 200, statusText: 'OK' });
    await fixture.whenStable();
    expect(fixture.componentInstance.publishedId()).not.toBeNull();

    fixture.componentInstance.form.setValue({
      name: 'Another widget', thumbnailUrl: '', amount: 3, currency: 'EUR',
    });
    fixture.componentInstance.publish();

    // Cleared the moment the new attempt starts, not only once its response
    // lands — an error banner for THIS attempt must never sit under a
    // "Published as ..." note left over from the LAST one.
    expect(fixture.componentInstance.publishedId()).toBeNull();

    controller
      .expectOne('http://localhost:5000/api/v1/catalog/products')
      .flush('66666666-6666-6666-6666-666666666666', { status: 200, statusText: 'OK' });
    await fixture.whenStable();
  });
});
