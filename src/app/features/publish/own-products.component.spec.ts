import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { WritableSignal, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OwnProduct } from '@core/api/types';
import { AuthService, CurrentUser } from '@core/auth/auth.service';
import { CatalogRefresh } from '@core/catalog/catalog-refresh';
import { RateLimitWindows } from '@core/errors/rate-limit';
import { rateLimitInterceptor } from '@core/errors/rate-limit.interceptor';
import { OwnProductsComponent } from './own-products.component';

/** A Stencil host element: resolves once its lazily loaded component has rendered. */
interface StencilHost extends Element {
  componentOnReady(): Promise<unknown>;
}

/**
 * Longer than any wait here takes, and shorter than Vitest's 10 s test limit.
 * In some full runs every test after the first hung until that limit with no
 * word of which wait it was (#261); a wait that gives up first can say.
 */
const WAIT_MS = 6_000;

async function within<T>(
  what: string,
  work: Promise<T>,
  stuck: () => string = () => '',
  ms = WAIT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} did not settle within ${ms} ms${stuck()}`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tags whose lazily loaded component failed to load in this process (#261).
 * Stencil logs `Constructor for "ion-x#undefined" was not found` once, does not
 * retry, and that tag's `componentOnReady()` never resolves, in this test and
 * every later one. In the runs that hung it was whichever Ionic component the
 * first test happened to load first, `ion-spinner` in one and `ion-input` in
 * the next, so it is the load that is unreliable and not any one component. A
 * host that never became ready cannot hydrate late either, which is all this
 * wait guards against, so a tag that missed its bound once is not waited on
 * again.
 */
const neverReady = new Set<string>();
const HOST_WAIT_MS = 2_000;

/**
 * `publish.page.spec.ts`'s wait, for the reason it gives (#71), with a bound
 * on each host and the failure named rather than hung on (#261).
 */
async function hydrated(root: Element): Promise<void> {
  const hosts = [...root.querySelectorAll('*')].filter(
    (el): el is StencilHost =>
      el.tagName.startsWith('ION-') && 'componentOnReady' in el && !neverReady.has(el.tagName),
  );
  await Promise.all(
    hosts.map(async (host) => {
      try {
        await within(
          `${host.tagName.toLowerCase()}.componentOnReady()`,
          host.componentOnReady(),
          () => '',
          HOST_WAIT_MS,
        );
      } catch (failure) {
        neverReady.add(host.tagName);
        console.warn(`${(failure as Error).message}; not waited on again in this run`);
      }
    }),
  );
}

const MINE = 'http://localhost:5000/api/v1/catalog/products/mine';
const withdrawalOf = (id: string) => `http://localhost:5000/api/v1/catalog/products/${id}/withdrawal`;

function product(id: string, withdrawnAt: string | null = null): OwnProduct {
  return {
    productId: id,
    name: `Product ${id}`,
    thumbnailUrl: null,
    amount: 12.5,
    currency: 'EUR',
    publishedAt: '2026-10-18T02:57:27Z',
    withdrawnAt,
    quantityAvailable: null,
  };
}

describe('OwnProductsComponent', () => {
  let fixture: ComponentFixture<OwnProductsComponent>;
  let controller: HttpTestingController;
  let user: WritableSignal<CurrentUser | null>;
  let signIn: ReturnType<typeof vi.fn>;

  const page = () => fixture.componentInstance;
  const mine = (match?: (cursor: string | null) => boolean) =>
    controller.expectOne(
      (r) => r.url === MINE && (match ? match(r.params.get('cursor')) : true),
    );

  async function settle(): Promise<void> {
    await within('fixture.whenStable()', fixture.whenStable());
    fixture.detectChanges();
  }

  beforeEach(async () => {
    signIn = vi.fn(async () => undefined);
    user = signal<CurrentUser | null>({
      username: 'demo', subject: 'subject-demo', permissions: ['catalog:write'], expiresAt: 0,
    });

    TestBed.configureTestingModule({
      imports: [OwnProductsComponent],
      providers: [
        provideHttpClient(withInterceptors([rateLimitInterceptor])),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { signIn, user: () => user, accessToken: () => 't' } },
      ],
    });

    fixture = TestBed.createComponent(OwnProductsComponent);
    controller = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    await hydrated(fixture.nativeElement);
  });

  afterEach(async () => {
    controller.verify();
    fixture.detectChanges();
    await hydrated(fixture.nativeElement);
  });

  it('reads the first page of the seller’s own products on construction, with a skeleton until it lands', async () => {
    expect(page().showSkeleton()).toBe(true);

    mine((cursor) => cursor === null).flush({ items: [product('a')], nextCursor: null });
    await settle();

    expect(page().products().map((p) => p.productId)).toEqual(['a']);
    expect(page().reachedEnd()).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="end-of-own-list"]')).not.toBeNull();
  });

  it('says so when this account has published nothing', async () => {
    mine().flush({ items: [], nextCursor: null });
    await settle();

    expect(page().isEmpty()).toBe(true);
    expect(fixture.nativeElement.querySelector('app-empty-state')).not.toBeNull();
  });

  it('pages on with the cursor the last page gave', async () => {
    mine().flush({ items: [product('a')], nextCursor: 'next' });
    await settle();
    expect(page().canLoadMore()).toBe(true);

    const complete = vi.fn();
    page().loadMore({ target: { complete } });
    mine((cursor) => cursor === 'next').flush({ items: [product('b')], nextCursor: null });
    await settle();

    expect(complete).toHaveBeenCalled();
    expect(page().products().map((p) => p.productId)).toEqual(['a', 'b']);
  });

  it('marks a withdrawn product with its time and offers it no Withdraw', async () => {
    mine().flush({
      items: [product('a', '2026-10-18T02:57:29Z'), product('b')],
      nextCursor: null,
    });
    await settle();

    const rows = fixture.nativeElement.querySelectorAll('[data-testid="own-product"]');
    expect(rows[0].querySelector('[data-testid="withdrawn"]')).not.toBeNull();
    expect(rows[0].querySelector('[data-testid="withdraw"]')).toBeNull();
    expect(rows[1].querySelector('[data-testid="withdraw"]')).not.toBeNull();
  });

  it('shows a failed page with its banner and a Try again that resumes at that page', async () => {
    mine().flush({ items: [product('a')], nextCursor: 'next' });
    await settle();

    page().loadMore();
    mine((cursor) => cursor === 'next').flush(
      { title: 'Service Unavailable', status: 503 },
      { status: 503, statusText: '' },
    );
    await settle();

    expect(page().error()?.kind).toBe('unavailable');
    expect(page().canLoadMore()).toBe(false);

    page().retryLoad();
    mine((cursor) => cursor === 'next').flush({ items: [product('b')], nextCursor: null });
    await settle();
    expect(page().error()).toBeNull();
    expect(page().products()).toHaveLength(2);
  });

  it('names catalog:write on a 403, the claim the read is behind', async () => {
    mine().flush({ title: 'Forbidden', status: 403 }, { status: 403, statusText: 'Forbidden' });
    await settle();

    expect(page().error()?.permission).toBe('catalog:write');
  });

  it('asks before it withdraws, and Keep sends nothing', async () => {
    mine().flush({ items: [product('a')], nextCursor: null });
    await settle();

    page().askToWithdraw(page().products()[0]);
    fixture.detectChanges();
    expect(page().confirming()).toBe('a');
    expect(fixture.nativeElement.querySelector('[data-testid="confirm-withdraw"]')).not.toBeNull();

    page().cancelWithdraw();
    expect(page().confirming()).toBeNull();
    controller.expectNone(withdrawalOf('a'));
  });

  it('withdraws under a command id, then asks the catalogue to refresh and reads its own row back', async () => {
    mine().flush({ items: [product('a')], nextCursor: null });
    await settle();
    const refresh = TestBed.inject(CatalogRefresh);
    const before = refresh.current();

    page().askToWithdraw(page().products()[0]);
    page().withdraw(page().products()[0]);
    const request = controller.expectOne(withdrawalOf('a'));
    expect(request.request.body.commandId).toMatch(/^[0-9a-f-]{36}$/);
    expect(page().isPending(page().products()[0])).toBe(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="withdrawing"]')).not.toBeNull();

    request.flush(null, { status: 204, statusText: 'No Content' });
    await settle();

    // The Products tab hears this to drop the product; this list hears it too.
    expect(refresh.current()).toBe(before + 1);
    // The rows stay until the fresh page replaces them (#202).
    expect(page().products()).toHaveLength(1);
    mine().flush({ items: [product('a', '2026-10-18T02:57:29Z')], nextCursor: null });
    await settle();
    expect(page().products()[0].withdrawnAt).toBe('2026-10-18T02:57:29Z');
    expect(page().isPending(page().products()[0])).toBe(false);
  });

  it('sends a second press while the first is out under the same id, as client-architecture §4 has it', async () => {
    mine().flush({ items: [product('a')], nextCursor: null });
    await settle();

    page().withdraw(page().products()[0]);
    page().withdraw(page().products()[0]);
    const [first, second] = controller.match(withdrawalOf('a'));
    expect(second.request.body.commandId).toBe(first.request.body.commandId);

    // The platform refuses the replay while the first holds the key.
    second.flush(
      { title: 'Conflict', status: 409, code: 'request.in_progress' },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();
    expect(page().actionError()?.kind).toBe('inProgress');
    // One is still out, so the row still says so.
    expect(page().isPending(page().products()[0])).toBe(true);

    first.flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    // The withdrawal the replay was waiting on is the answer that counts.
    expect(page().actionError()).toBeNull();
    mine().flush({ items: [product('a', '2026-10-18T02:57:29Z')], nextCursor: null });
    await settle();
  });

  it('signs in on a 401 and sends the same withdrawal once more, for the same subject', async () => {
    mine().flush({ items: [product('a')], nextCursor: null });
    await settle();

    page().withdraw(page().products()[0]);
    const first = controller.expectOne(withdrawalOf('a'));
    const id = first.request.body.commandId;
    first.flush({ title: 'Unauthorized', status: 401 }, { status: 401, statusText: '' });
    await settle();

    expect(signIn).toHaveBeenCalledTimes(1);
    const replay = controller.expectOne(withdrawalOf('a'));
    expect(replay.request.body.commandId).toBe(id);

    // A second 401 is a loop, not a replay: no third request.
    replay.flush({ title: 'Unauthorized', status: 401 }, { status: 401, statusText: '' });
    await settle();
    controller.expectNone(withdrawalOf('a'));
    expect(page().actionError()?.kind).toBe('signIn');
  });

  it('replays nothing when a different subject signs in', async () => {
    mine().flush({ items: [product('a')], nextCursor: null });
    await settle();
    signIn.mockImplementation(async () => {
      user.set({
        username: 'other', subject: 'subject-other', permissions: ['catalog:write'], expiresAt: 0,
      });
    });

    page().withdraw(page().products()[0]);
    controller
      .expectOne(withdrawalOf('a'))
      .flush({ title: 'Unauthorized', status: 401 }, { status: 401, statusText: '' });
    await settle();

    controller.expectNone(withdrawalOf('a'));
    // The next subject's list, which the subject change asked for.
    mine().flush({ items: [], nextCursor: null });
    await settle();
  });

  it('shows a sign-in that fails', async () => {
    mine().flush({ items: [product('a')], nextCursor: null });
    await settle();
    signIn.mockImplementation(async () => {
      throw 'discovery failed';
    });

    page().withdraw(page().products()[0]);
    controller
      .expectOne(withdrawalOf('a'))
      .flush({ title: 'Unauthorized', status: 401 }, { status: 401, statusText: '' });
    await settle();

    expect(page().actionError()?.kind).toBe('retry');
  });

  it('retries a failed withdrawal under the same id, since it may have committed', async () => {
    mine().flush({ items: [product('a')], nextCursor: null });
    await settle();

    page().withdraw(page().products()[0]);
    const first = controller.expectOne(withdrawalOf('a'));
    const id = first.request.body.commandId;
    first.flush({ title: 'Bad Gateway', status: 502 }, { status: 502, statusText: '' });
    await settle();
    expect(page().actionError()?.kind).toBe('retry');

    page().withdraw(page().products()[0]);
    const second = controller.expectOne(withdrawalOf('a'));
    expect(second.request.body.commandId).toBe(id);
    second.flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    mine().flush({ items: [product('a', '2026-10-18T02:57:29Z')], nextCursor: null });
    await settle();
  });

  it('reads already_committed as the withdrawal it reports, not as an error', async () => {
    mine().flush({ items: [product('a')], nextCursor: null });
    await settle();
    const refresh = TestBed.inject(CatalogRefresh);
    const before = refresh.current();

    page().withdraw(page().products()[0]);
    controller.expectOne(withdrawalOf('a')).flush(
      { title: 'Conflict', status: 409, code: 'command.already_committed' },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();

    expect(page().actionError()).toBeNull();
    expect(refresh.current()).toBe(before + 1);
    mine().flush({ items: [product('a', '2026-10-18T02:57:29Z')], nextCursor: null });
    await settle();
  });

  it('shows product.withdrawn as sent and reads the list again, since the row was stale', async () => {
    mine().flush({ items: [product('a')], nextCursor: null });
    await settle();

    page().withdraw(page().products()[0]);
    controller.expectOne(withdrawalOf('a')).flush(
      {
        title: 'Unprocessable Entity', status: 422, code: 'product.withdrawn',
        detail: 'The product has been withdrawn.',
      },
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    await settle();

    expect(page().actionError()?.detail).toBe('The product has been withdrawn.');
    mine().flush({ items: [product('a', '2026-10-18T02:57:29Z')], nextCursor: null });
    await settle();
    expect(page().products()[0].withdrawnAt).not.toBeNull();
  });

  it('reads the list again on a 404, a product this account no longer owns', async () => {
    mine().flush({ items: [product('a')], nextCursor: null });
    await settle();

    page().withdraw(page().products()[0]);
    controller.expectOne(withdrawalOf('a')).flush(
      { title: 'Not Found', status: 404, detail: 'No product with that id.' },
      { status: 404, statusText: 'Not Found' },
    );
    await settle();

    expect(page().actionError()?.detail).toBe('No product with that id.');
    mine().flush({ items: [], nextCursor: null });
    await settle();
  });

  it('withdraws nothing already withdrawn, or inside a closed window', async () => {
    mine().flush({ items: [product('a', '2026-10-18T02:57:29Z'), product('b')], nextCursor: null });
    await settle();

    page().withdraw(page().products()[0]);
    controller.expectNone(withdrawalOf('a'));

    TestBed.inject(RateLimitWindows).forPartition('authenticated').open({
      kind: 'rateLimited', title: '', detail: null, retryAfterSeconds: 30,
    });
    page().withdraw(page().products()[1]);
    controller.expectNone(withdrawalOf('b'));
  });

  it('holds a refresh asked for inside a closed window, and takes it when the window ends', async () => {
    mine().flush({ items: [product('a')], nextCursor: null });
    await settle();

    const window = TestBed.inject(RateLimitWindows).forPartition('authenticated');
    window.open({ kind: 'rateLimited', title: '', detail: null, retryAfterSeconds: 30 });
    TestBed.inject(CatalogRefresh).request();
    await settle();
    controller.expectNone(MINE);

    window.close();
    await settle();
    mine((cursor) => cursor === null).flush({ items: [product('a')], nextCursor: null });
    await settle();
  });

  it('forgets the last subject’s list and reads the next one’s', async () => {
    mine().flush({ items: [product('a')], nextCursor: null });
    await settle();
    page().askToWithdraw(page().products()[0]);

    user.set({
      username: 'other', subject: 'subject-other', permissions: ['catalog:write'], expiresAt: 0,
    });
    fixture.detectChanges();

    expect(page().products()).toEqual([]);
    expect(page().confirming()).toBeNull();
    mine().flush({ items: [product('b')], nextCursor: null });
    await settle();
    expect(page().products().map((p) => p.productId)).toEqual(['b']);
  });

  it('drops a withdrawal reply that lands for a subject who has gone', async () => {
    mine().flush({ items: [product('a')], nextCursor: null });
    await settle();
    const refresh = TestBed.inject(CatalogRefresh);
    const before = refresh.current();

    page().withdraw(page().products()[0]);
    const request = controller.expectOne(withdrawalOf('a'));
    user.set(null);
    fixture.detectChanges();

    request.flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    expect(refresh.current()).toBe(before);
  });

  it('drops a refusal that lands for a subject who has gone', async () => {
    mine().flush({ items: [product('a')], nextCursor: null });
    await settle();

    page().withdraw(page().products()[0]);
    const request = controller.expectOne(withdrawalOf('a'));
    user.set(null);
    fixture.detectChanges();

    request.flush({ title: 'Bad Gateway', status: 502 }, { status: 502, statusText: '' });
    await settle();
    expect(page().actionError()).toBeNull();
  });

  it('drops a page that lands after a reload superseded it', async () => {
    mine().flush({ items: [product('a')], nextCursor: 'next' });
    await settle();

    page().loadMore();
    const stale = mine((cursor) => cursor === 'next');
    page().reload();
    const fresh = mine((cursor) => cursor === null);

    fresh.flush({ items: [product('c')], nextCursor: null });
    stale.flush({ items: [product('b')], nextCursor: null });
    await settle();
    expect(page().products().map((p) => p.productId)).toEqual(['c']);
  });

  it('drops a failure that lands after a reload superseded it', async () => {
    mine().flush({ items: [product('a')], nextCursor: 'next' });
    await settle();

    page().loadMore();
    const stale = mine((cursor) => cursor === 'next');
    page().reload();
    const fresh = mine((cursor) => cursor === null);

    stale.flush({ title: 'Bad Gateway', status: 502 }, { status: 502, statusText: '' });
    fresh.flush({ items: [product('a')], nextCursor: null });
    await settle();
    expect(page().error()).toBeNull();
  });

  describe('repricing (#176)', () => {
    const priceOf = (id: string) => `http://localhost:5000/api/v1/catalog/products/${id}/price`;

    async function listed(...items: OwnProduct[]): Promise<void> {
      mine().flush({ items, nextCursor: null });
      await settle();
    }

    function type(amount: number | null): void {
      page().priceControl.setValue(amount);
    }

    it('offers Reprice on a live row and none on a withdrawn one', async () => {
      await listed(product('a'), product('b', '2026-10-18T02:57:29Z'));

      const rows = fixture.nativeElement.querySelectorAll('[data-testid="own-product"]');
      expect(rows[0].querySelector('[data-testid="reprice"]')).not.toBeNull();
      expect(rows[1].querySelector('[data-testid="reprice"]')).toBeNull();
    });

    it('opens on the product’s own price, in its own currency, and Cancel sends nothing', async () => {
      await listed(product('a'));

      page().askToReprice(page().products()[0]);
      fixture.detectChanges();

      expect(page().pricing()).toBe('a');
      expect(page().priceControl.value).toBe(12.5);
      const input: HTMLElement & { label?: string } =
        fixture.nativeElement.querySelector('[data-testid="price-input"]');
      // A property binding on the Ionic element, so a property and not an attribute.
      expect(input.label).toBe('New price in EUR');

      page().cancelReprice();
      expect(page().pricing()).toBeNull();
      controller.expectNone(priceOf('a'));
    });

    it('puts the amount as typed with the product’s currency, then refreshes and reads the row back', async () => {
      await listed(product('a'));
      const refresh = TestBed.inject(CatalogRefresh);
      const before = refresh.current();

      page().askToReprice(page().products()[0]);
      type(54.9);
      page().reprice(page().products()[0]);
      const request = controller.expectOne(priceOf('a'));
      expect(request.request.method).toBe('PUT');
      expect(request.request.body.amount).toBe(54.9);
      expect(request.request.body.currency).toBe('EUR');
      expect(request.request.body.commandId).toMatch(/^[0-9a-f-]{36}$/);
      expect(page().isRepricing()).toBe(true);

      request.flush(null, { status: 204, statusText: 'No Content' });
      await settle();

      expect(refresh.current()).toBe(before + 1);
      expect(page().pricing()).toBeNull();
      expect(page().isRepricing()).toBe(false);
      // The server's price is the one shown: the row is read back, never patched.
      expect(page().products()[0].amount).toBe(12.5);
      mine().flush({ items: [{ ...product('a'), amount: 54.9 }], nextCursor: null });
      await settle();
      expect(page().products()[0].amount).toBe(54.9);
    });

    it('sends a price of nothing, since nothing is a price', async () => {
      await listed(product('a'));

      page().askToReprice(page().products()[0]);
      type(0);
      expect(page().priceControl.valid).toBe(true);
      page().reprice(page().products()[0]);

      expect(controller.expectOne(priceOf('a')).request.body.amount).toBe(0);
    });

    it('sends nothing for a blank field, rather than a null the backend would turn into a 400', async () => {
      await listed(product('a'));

      page().askToReprice(page().products()[0]);
      type(null);
      page().reprice(page().products()[0]);

      controller.expectNone(priceOf('a'));
      expect(page().priceControl.invalid).toBe(true);
    });

    it('sends nothing for a withdrawn product', async () => {
      const withdrawn = product('a', '2026-10-18T02:57:29Z');
      await listed(withdrawn);

      page().askToReprice(withdrawn);
      type(3);
      page().reprice(withdrawn);

      controller.expectNone(priceOf('a'));
    });

    it('puts a 400’s Amount messages under the field and keeps the rest in the banner', async () => {
      await listed(product('a'));

      page().askToReprice(page().products()[0]);
      type(-1);
      page().reprice(page().products()[0]);
      controller.expectOne(priceOf('a')).flush(
        { status: 400, errors: { Amount: ['Must be at least 0.'], CommandId: ['Required.'] } },
        { status: 400, statusText: 'Bad Request' },
      );
      await settle();
      fixture.detectChanges();

      expect(page().priceMessages()).toEqual(['Must be at least 0.']);
      expect(page().actionError()?.fields).toEqual({ CommandId: ['Required.'] });
      expect(fixture.nativeElement.querySelector('[data-field="amount"]')?.textContent)
        .toContain('Must be at least 0.');
      // The editor stays open, with what was typed.
      expect(page().pricing()).toBe('a');
      expect(page().priceControl.value).toBe(-1);
    });

    it('drops the banner’s fields when every key landed on the field', async () => {
      await listed(product('a'));

      page().askToReprice(page().products()[0]);
      type(-1);
      page().reprice(page().products()[0]);
      controller.expectOne(priceOf('a')).flush(
        { status: 400, errors: { Amount: ['Must be at least 0.'] } },
        { status: 400, statusText: 'Bad Request' },
      );
      await settle();

      expect(page().actionError()?.kind).toBe('validation');
      expect(page().actionError()?.fields).toBeUndefined();
    });

    it('mints a new id after an edit that follows a validation failure, and clears the messages', async () => {
      await listed(product('a'));

      page().askToReprice(page().products()[0]);
      type(-1);
      page().reprice(page().products()[0]);
      const first = controller.expectOne(priceOf('a'));
      const firstId = first.request.body.commandId;
      first.flush(
        { status: 400, errors: { Amount: ['Must be at least 0.'] } },
        { status: 400, statusText: 'Bad Request' },
      );
      await settle();

      type(5);
      expect(page().priceMessages()).toEqual([]);
      page().reprice(page().products()[0]);
      const second = controller.expectOne(priceOf('a'));
      expect(second.request.body.commandId).not.toBe(firstId);
      second.flush(null, { status: 204, statusText: 'No Content' });
      await settle();
      mine().flush({ items: [product('a')], nextCursor: null });
      await settle();
    });

    it('retries a failed reprice under the same id, since it may have committed', async () => {
      await listed(product('a'));

      page().askToReprice(page().products()[0]);
      type(9);
      page().reprice(page().products()[0]);
      const first = controller.expectOne(priceOf('a'));
      const id = first.request.body.commandId;
      first.flush({ title: 'Bad Gateway', status: 502 }, { status: 502, statusText: '' });
      await settle();
      expect(page().actionError()?.kind).toBe('retry');
      expect(page().pricing()).toBe('a');

      page().reprice(page().products()[0]);
      const second = controller.expectOne(priceOf('a'));
      expect(second.request.body.commandId).toBe(id);
      second.flush(null, { status: 204, statusText: 'No Content' });
      await settle();
      mine().flush({ items: [product('a')], nextCursor: null });
      await settle();
    });

    it('uses a fresh id for the next reprice once one has landed', async () => {
      await listed(product('a'));

      page().askToReprice(page().products()[0]);
      type(9);
      page().reprice(page().products()[0]);
      const first = controller.expectOne(priceOf('a'));
      const id = first.request.body.commandId;
      first.flush(null, { status: 204, statusText: 'No Content' });
      await settle();
      mine().flush({ items: [product('a')], nextCursor: null });
      await settle();

      page().askToReprice(page().products()[0]);
      type(10);
      page().reprice(page().products()[0]);
      const second = controller.expectOne(priceOf('a'));
      expect(second.request.body.commandId).not.toBe(id);
      second.flush(null, { status: 204, statusText: 'No Content' });
      await settle();
      mine().flush({ items: [product('a')], nextCursor: null });
      await settle();
    });

    it('keeps a reprice’s id apart from the same product’s withdrawal', async () => {
      await listed(product('a'));

      page().withdraw(page().products()[0]);
      const withdrawal = controller.expectOne(withdrawalOf('a'));
      page().askToReprice(page().products()[0]);
      type(9);
      page().reprice(page().products()[0]);
      const reprice = controller.expectOne(priceOf('a'));

      expect(reprice.request.body.commandId).not.toBe(withdrawal.request.body.commandId);
      withdrawal.flush({ title: 'Bad Gateway', status: 502 }, { status: 502, statusText: '' });
      reprice.flush({ title: 'Bad Gateway', status: 502 }, { status: 502, statusText: '' });
      await settle();
    });

    it('reads already_committed as the reprice it reports', async () => {
      await listed(product('a'));
      const refresh = TestBed.inject(CatalogRefresh);
      const before = refresh.current();

      page().askToReprice(page().products()[0]);
      type(9);
      page().reprice(page().products()[0]);
      controller.expectOne(priceOf('a')).flush(
        { title: 'Conflict', status: 409, code: 'command.already_committed' },
        { status: 409, statusText: 'Conflict' },
      );
      await settle();

      expect(page().actionError()).toBeNull();
      expect(page().pricing()).toBeNull();
      expect(refresh.current()).toBe(before + 1);
      mine().flush({ items: [product('a')], nextCursor: null });
      await settle();
    });

    it('says an edited reprice was not applied when its id was already used, and reads the list', async () => {
      await listed(product('a'));

      page().askToReprice(page().products()[0]);
      type(9);
      page().reprice(page().products()[0]);
      controller.expectOne(priceOf('a')).flush(
        { title: 'Conflict', status: 409, code: 'command.id_reused' },
        { status: 409, statusText: 'Conflict' },
      );
      await settle();

      expect(page().actionError()?.kind).toBe('idReused');
      expect(page().pricing()).toBeNull();
      mine().flush({ items: [product('a')], nextCursor: null });
      await settle();
    });

    it.each([
      ['a 422 product.withdrawn', 422],
      ['a 422 product.currency_fixed', 422],
      ['a 404 for a product this account no longer owns', 404],
    ])('closes the editor, shows why and reads the list again on %s', async (_name, status) => {
      await listed(product('a'));

      page().askToReprice(page().products()[0]);
      type(9);
      page().reprice(page().products()[0]);
      controller.expectOne(priceOf('a')).flush(
        { title: 'Refused', status },
        { status, statusText: '' },
      );
      await settle();

      expect(page().actionError()).not.toBeNull();
      expect(page().pricing()).toBeNull();
      mine().flush({ items: [product('a')], nextCursor: null });
      await settle();
    });

    it('signs in on a 401 and sends the same reprice once more, for the same subject', async () => {
      await listed(product('a'));

      page().askToReprice(page().products()[0]);
      type(9);
      page().reprice(page().products()[0]);
      const first = controller.expectOne(priceOf('a'));
      const id = first.request.body.commandId;
      first.flush({ title: 'Unauthorized', status: 401 }, { status: 401, statusText: '' });
      await settle();

      expect(signIn).toHaveBeenCalledOnce();
      const replay = controller.expectOne(priceOf('a'));
      expect(replay.request.body.commandId).toBe(id);
      expect(replay.request.body.amount).toBe(9);

      // A second 401 is a loop, not a replay.
      replay.flush({ title: 'Unauthorized', status: 401 }, { status: 401, statusText: '' });
      await settle();
      controller.expectNone(priceOf('a'));
    });

    it('replays nothing when a different subject signs in, and forgets the open editor', async () => {
      await listed(product('a'));
      signIn.mockImplementation(async () => {
        user.set({
          username: 'other', subject: 'subject-other', permissions: ['catalog:write'], expiresAt: 0,
        });
      });

      page().askToReprice(page().products()[0]);
      type(9);
      page().reprice(page().products()[0]);
      controller
        .expectOne(priceOf('a'))
        .flush({ title: 'Unauthorized', status: 401 }, { status: 401, statusText: '' });
      await settle();

      controller.expectNone(priceOf('a'));
      expect(page().pricing()).toBeNull();
      mine().flush({ items: [], nextCursor: null });
      await settle();
    });

    it('drops a reply that lands for a subject who has gone', async () => {
      await listed(product('a'));

      page().askToReprice(page().products()[0]);
      type(9);
      page().reprice(page().products()[0]);
      const request = controller.expectOne(priceOf('a'));
      user.set({
        username: 'other', subject: 'subject-other', permissions: ['catalog:write'], expiresAt: 0,
      });
      fixture.detectChanges();
      await settle();
      mine().flush({ items: [], nextCursor: null });

      request.flush(null, { status: 204, statusText: 'No Content' });
      await settle();

      expect(page().isRepricing()).toBe(false);
      expect(page().actionError()).toBeNull();
    });

    it('stays shut while the gateway’s window is closed', async () => {
      await listed(product('a'));
      TestBed.inject(RateLimitWindows).forPartition('authenticated').open({
        kind: 'rateLimited', title: '', detail: null, retryAfterSeconds: 30,
      });

      page().askToReprice(page().products()[0]);
      type(9);
      page().reprice(page().products()[0]);

      controller.expectNone(priceOf('a'));
    });
  });
});
