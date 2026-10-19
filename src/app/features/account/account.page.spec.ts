import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { BehaviorSubject, Observable, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { SavedAddressApi } from '@core/api/saved-address.api';
import { Address } from '@core/api/types';
import { AuthService, CurrentUser } from '@core/auth/auth.service';
import { AccountPage } from './account.page';

const savedHome: Address = {
  line1: '9 Saved Road', line2: 'Flat 2', city: 'Leeds', postalCode: 'LS1 1AA', country: 'GB',
};

function mount(
  user: CurrentUser | null,
  sessionEndsOnReload: boolean,
  denied?: string,
  saved: Address | null = null,
) {
  TestBed.resetTestingModule();
  const signIn = vi.fn(async () => undefined);
  const signOut = vi.fn(async () => undefined);
  // Writable, so a test can end the session or hand it to somebody else.
  const session = signal(user);
  const read = vi.fn((): Observable<Address | null> => of(saved));
  const remove = vi.fn((): Observable<void> => of(undefined));
  // A BehaviorSubject rather than of(): one test pushes a SECOND value
  // through it, which is the only way to exercise a reused component
  // receiving a different `denied` without a fresh construction.
  const queryParams = new BehaviorSubject(convertToParamMap(denied ? { denied } : {}));

  TestBed.configureTestingModule({
    imports: [AccountPage],
    providers: [
      provideRouter([]),
      {
        provide: ActivatedRoute,
        useValue: {
          queryParamMap: queryParams.asObservable(),
          snapshot: { queryParamMap: queryParams.value },
        },
      },
      {
        provide: AuthService,
        useValue: {
          user: () => session,
          sessionEndsOnReload,
          signIn,
          signOut,
          hasPermission: (n: string) => user?.permissions.includes(n) ?? false,
        },
      },
      { provide: SavedAddressApi, useValue: { read, remove } },
    ],
  });

  const fixture: ComponentFixture<AccountPage> = TestBed.createComponent(AccountPage);
  fixture.detectChanges();
  return { fixture, signIn, signOut, queryParams, session, read, remove };
}

const demo: CurrentUser = {
  username: 'demo',
  subject: 's',
  permissions: ['catalog:write', 'orders:write', 'orders:cancel'],
  expiresAt: 0,
};

/** Finds the `ion-button` whose visible text matches `label` exactly. */
function findButton(fixture: ComponentFixture<AccountPage>, label: string): HTMLElement {
  const button = [...fixture.nativeElement.querySelectorAll('ion-button')].find(
    (el: HTMLElement) => el.textContent?.trim() === label,
  ) as HTMLElement | undefined;
  expect(button).toBeTruthy();
  return button as HTMLElement;
}

/**
 * The `code` inside the "Route refused" item, specifically — not the first
 * `code` in document order. `app-error-banner` precedes it in the template
 * and also renders `code` (for `permission` and `correlationId`), so an
 * unscoped `querySelector('code')` would silently target the wrong element
 * the moment `error()` is non-null in the same render.
 */
function deniedCode(fixture: ComponentFixture<AccountPage>): string | null | undefined {
  const item = [...fixture.nativeElement.querySelectorAll('ion-item')].find(
    (el: HTMLElement) => el.textContent?.includes('Route refused'),
  ) as HTMLElement | undefined;
  return item?.querySelector('code')?.textContent;
}

describe('AccountPage', () => {
  it('offers a Sign in button, which calls AuthService.signIn() when clicked', () => {
    const { fixture, signIn } = mount(null, true);

    // The rendered button, not a direct componentInstance.signIn() call —
    // a direct call proves the method works but not that the page OFFERS
    // it, and both the button and the @if/@else branch it lives in are
    // deletable with a green suite otherwise (this branch's recurring
    // defect class: df9bd25 fixed the same shape for the chips).
    findButton(fixture, 'Sign in').click();

    expect(fixture.componentInstance.username()).toBeNull();
    expect(signIn).toHaveBeenCalledOnce();
  });

  it('offers a Sign out button, which calls AuthService.signOut() when clicked', () => {
    const { fixture, signOut } = mount(demo, true);

    // Zero coverage before this test: signOut(), the button and its click
    // binding could all three be deleted and the suite would stay green.
    // Spec §5.6 asks for sign in AND out.
    findButton(fixture, 'Sign out').click();

    expect(signOut).toHaveBeenCalledOnce();
  });

  it('surfaces a sign-out failure rather than leaving the user unsure whether they signed out', async () => {
    // signOut() is .catch()'d for the same reason signIn() is, and this one
    // matters more than symmetry: a swallowed rejection leaves the user
    // believing they signed out when they did not.
    const { fixture, signOut } = mount(demo, true);
    signOut.mockRejectedValueOnce('signOut rejected');

    findButton(fixture, 'Sign out').click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.error()).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Something went wrong.');
  });

  it('clears the banner when sign-out is attempted, exactly as sign-in does', async () => {
    const { fixture, signOut } = mount(demo, true);

    // A failed sign-out leaves a banner...
    signOut.mockRejectedValueOnce('signOut rejected');
    findButton(fixture, 'Sign out').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance.error()).not.toBeNull();

    // ...and the next attempt, which succeeds, must not leave the failed
    // one's banner sitting beside a signed-out shell. signIn() has cleared
    // first thing since it was written; this is the other half of that pair.
    findButton(fixture, 'Sign out').click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.error()).toBeNull();
  });

  it('shows the username and every permission held as a chip', () => {
    const { fixture } = mount(demo, true);

    expect(fixture.componentInstance.username()).toBe('demo');
    expect(fixture.componentInstance.permissions()).toEqual([
      'catalog:write', 'orders:write', 'orders:cancel',
    ]);

    // Spec §5.6 asks for the permissions held AS CHIPS. Asserting the
    // computed alone would pass with the whole template deleted.
    const chips = Array.from(
      fixture.nativeElement.querySelectorAll('ion-chip') as NodeListOf<HTMLElement>,
    ).map((chip) => chip.textContent?.trim());

    expect(chips).toEqual(['catalog:write', 'orders:write', 'orders:cancel']);
    expect(fixture.nativeElement.textContent).toContain('demo');
  });

  it('says plainly that an account with no permissions can write nothing', () => {
    const { fixture } = mount({ ...demo, permissions: [] }, true);

    expect(fixture.nativeElement.querySelectorAll('ion-chip')).toHaveLength(0);
    expect(fixture.nativeElement.textContent).toContain(
      'Every write in this application will answer 403.',
    );
  });

  it('states the web token posture, on screen', () => {
    const { fixture } = mount(demo, true);
    const sentence = 'Session ends on reload, no refresh token.';

    expect(fixture.componentInstance.tokenPosture()).toBe(sentence);
    // The computed alone is deletable with the template line gone; this is
    // the posture a browser sees, and the sibling test below covers the
    // posture a device sees.
    expect(fixture.nativeElement.textContent).toContain(sentence);
  });

  it('shows the native token posture sentence for a strategy whose session survives a reload', () => {
    // Reachable for real since plan Task 19: NativeAuthStrategy reports
    // sessionEndsOnReload === false, which is the `false` branch below. What
    // this test still does NOT prove is that secure-storage rotation works —
    // that belongs to native-auth.strategy.spec.ts, which tests it directly.
    // This one proves only that the page renders the other sentence.
    const { fixture } = mount(demo, false);
    const sentence = 'Refresh token in secure storage, rotated.';

    expect(fixture.componentInstance.tokenPosture()).toBe(sentence);
    expect(fixture.nativeElement.textContent).toContain(sentence);
  });

  it('shows an error when sign-in cannot reach the identity provider', async () => {
    // signIn() rejects when discovery is unreachable — WebAuthStrategy retries
    // it, because initCodeFlow() with no loginUrl does nothing at all. A bare
    // `void` here would leave a button that looks broken and says nothing.
    // A bare string, because that is what angular-oauth2-oidc's
    // loadDiscoveryDocument() actually rejects with. Rejecting with an
    // HttpErrorResponse here would make this test agree with an annotation
    // the runtime does not honour, and pass even if mapError still
    // required one.
    const { fixture, signIn } = mount(null, true);
    signIn.mockRejectedValueOnce('Error loading discovery document');

    fixture.componentInstance.signIn();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.error()).not.toBeNull();
    // `<app-error-banner>` is deletable if only `error()` is checked — the
    // banner must actually render. mapError() on a bare string returns kind
    // 'retry', which ErrorBannerComponent's GENERIC map resolves to this text.
    expect(fixture.nativeElement.textContent).toContain('Something went wrong.');
  });

  it('renders the permission a refused route needed', () => {
    const { fixture } = mount(demo, true, 'catalog:write');

    expect(fixture.componentInstance.denied()).toBe('catalog:write');
    expect(fixture.nativeElement.textContent).toContain('Route refused');
    expect(deniedCode(fixture)).toBe('catalog:write');
  });

  it('follows a later refusal on the same cached instance', async () => {
    // The bug this guards: Account is a tab, Ionic caches its page, and
    // IonicRouteStrategy compares route params rather than query params —
    // so a redirect from permissionGuard reaches an ALREADY CONSTRUCTED
    // component. A snapshot read would still be showing the first value,
    // which for most users is no value at all.
    const { fixture, queryParams } = mount(demo, true, 'catalog:write');

    queryParams.next(convertToParamMap({ denied: 'orders:cancel' }));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.denied()).toBe('orders:cancel');
    expect(deniedCode(fixture)).toBe('orders:cancel');
  });

  it('says a refused History route needs a session, on a cached instance too', async () => {
    const { fixture, queryParams } = mount(null, true);
    expect(fixture.nativeElement.textContent).not.toContain('needs you to be signed in');

    queryParams.next(convertToParamMap({ signIn: 'required' }));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.signInRequired()).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('needs you to be signed in');
  });

  it('drops the sign-in sentence once somebody is signed in, though the query param remains', () => {
    const { fixture, queryParams } = mount(demo, true);
    queryParams.next(convertToParamMap({ signIn: 'required' }));
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).not.toContain('needs you to be signed in');
  });

  describe('the saved address (#109)', () => {
    const shown = (fixture: ComponentFixture<AccountPage>) =>
      fixture.nativeElement.querySelector('[data-testid="saved-address"]') as HTMLElement | null;

    it('shows it to the signed-in buyer, over the lines it has', async () => {
      const { fixture } = mount(demo, true, undefined, savedHome);
      await fixture.whenStable();
      fixture.detectChanges();

      const text = (shown(fixture)?.textContent ?? '').replace(/\s+/g, ' ');
      expect(text).toContain('9 Saved Road');
      expect(text).toContain('Flat 2');
      expect(text).toContain('LS1 1AA Leeds, GB');
    });

    it('leaves out a second line it does not have', async () => {
      const { fixture } = mount(demo, true, undefined, { ...savedHome, line2: null });
      await fixture.whenStable();
      fixture.detectChanges();

      expect(shown(fixture)?.querySelectorAll('p').length).toBe(2);
    });

    it('shows nothing, and offers nothing to forget, when none is saved', async () => {
      const { fixture } = mount(demo, true);
      await fixture.whenStable();
      fixture.detectChanges();

      expect(shown(fixture)).toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="forget-address"]')).toBeNull();
    });

    it('asks for nothing while nobody is signed in', async () => {
      const { fixture, read } = mount(null, true, undefined, savedHome);
      await fixture.whenStable();
      fixture.detectChanges();

      expect(read).not.toHaveBeenCalled();
      expect(shown(fixture)).toBeNull();
    });

    it('empties it the moment the session ends, so a signed-out tab holds no address', async () => {
      const { fixture, session } = mount(demo, true, undefined, savedHome);
      await fixture.whenStable();
      expect(fixture.componentInstance.savedAddress()).toEqual(savedHome);

      session.set(null);
      fixture.detectChanges();
      await fixture.whenStable();

      expect(fixture.componentInstance.savedAddress()).toBeNull();
      expect(fixture.nativeElement.textContent).not.toContain('9 Saved Road');
    });

    it('does not read it again when a renewal hands over a new object for the same buyer', async () => {
      const { fixture, session, read } = mount(demo, true, undefined, savedHome);
      await fixture.whenStable();

      session.set({ ...demo, expiresAt: 99 });
      fixture.detectChanges();
      await fixture.whenStable();

      expect(read).toHaveBeenCalledOnce();
      expect(fixture.componentInstance.savedAddress()).toEqual(savedHome);
    });

    it('reads it afresh for the next buyer', async () => {
      const { fixture, session, read } = mount(demo, true, undefined, savedHome);
      await fixture.whenStable();

      session.set({ ...demo, subject: 'someone-else' });
      fixture.detectChanges();
      await fixture.whenStable();

      expect(read).toHaveBeenCalledTimes(2);
    });

    it('shows nothing when the read fails, rather than an error about a convenience', async () => {
      const { fixture } = mount(demo, true);
      TestBed.inject(SavedAddressApi).read = (() => throwError(() => new Error('down'))) as never;
      fixture.componentInstance['loadSavedAddress']('s');
      fixture.detectChanges();

      expect(shown(fixture)).toBeNull();
      expect(fixture.componentInstance.error()).toBeNull();
    });

    it('forgets it on the buyer’s say-so, and stops showing it', async () => {
      const { fixture, remove } = mount(demo, true, undefined, savedHome);
      await fixture.whenStable();
      fixture.detectChanges();

      findButton(fixture, 'Forget this address').click();
      fixture.detectChanges();

      expect(remove).toHaveBeenCalledOnce();
      expect(shown(fixture)).toBeNull();
    });

    it('keeps showing it, with the banner, when forgetting fails', async () => {
      const { fixture, remove } = mount(demo, true, undefined, savedHome);
      remove.mockReturnValue(throwError(() => new Error('refused')));
      await fixture.whenStable();
      fixture.detectChanges();

      fixture.componentInstance.forgetAddress();
      fixture.detectChanges();

      expect(fixture.componentInstance.error()).not.toBeNull();
      expect(shown(fixture)).not.toBeNull();
    });
  });
});
