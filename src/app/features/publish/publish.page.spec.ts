import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CatalogRefresh } from '@core/catalog/catalog-refresh';
import { PublishPage } from './publish.page';

describe('PublishPage', () => {
  let fixture: ComponentFixture<PublishPage>;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [PublishPage],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });

    fixture = TestBed.createComponent(PublishPage);
    controller = TestBed.inject(HttpTestingController);
    fixture.detectChanges();

    fixture.componentInstance.form.setValue({
      name: 'A widget', thumbnailUrl: '', amount: 12.5, currency: 'EUR',
    });
  });

  afterEach(() => controller.verify());

  it('sends a PublishProductCommand with a null thumbnail when blank', () => {
    fixture.componentInstance.publish();

    const body = controller.expectOne('http://localhost:5000/api/v1/catalog/products').request.body;

    expect(body).toMatchObject({
      name: 'A widget', thumbnailUrl: null, amount: 12.5, currency: 'EUR',
    });
    expect(body.commandId).toMatch(/^[0-9a-f-]{36}$/);
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
  });

  it('mints a fresh commandId after a success', async () => {
    fixture.componentInstance.publish();
    const first = controller.expectOne('http://localhost:5000/api/v1/catalog/products');
    const firstId = first.request.body.commandId;
    first.flush('55555555-5555-5555-5555-555555555555', { status: 200, statusText: 'OK' });
    await fixture.whenStable();

    expect(fixture.componentInstance.identity.current()).not.toBe(firstId);
    expect(fixture.componentInstance.publishedId()).toBe('55555555-5555-5555-5555-555555555555');
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
  });

  it('publishes a free product, because the backend allows an amount of zero', () => {
    fixture.componentInstance.form.setValue({
      name: 'A free widget', thumbnailUrl: '', amount: 0, currency: 'EUR',
    });

    // Validators.required treats 0 as present (isEmptyInputValue checks
    // null and length, not falsiness), and PublishProductValidator.cs uses
    // GreaterThanOrEqualTo(0). A client that refused 0 would refuse
    // something the platform accepts.
    expect(fixture.componentInstance.form.valid).toBe(true);

    fixture.componentInstance.publish();

    expect(
      controller.expectOne('http://localhost:5000/api/v1/catalog/products').request.body.amount,
    ).toBe(0);
  });

  it('names catalog:write on a 403', async () => {
    fixture.componentInstance.publish();
    controller
      .expectOne('http://localhost:5000/api/v1/catalog/products')
      .flush({ title: 'Forbidden', status: 403 }, { status: 403, statusText: 'Forbidden' });
    await fixture.whenStable();

    expect(fixture.componentInstance.error()?.permission).toBe('catalog:write');
  });
});
