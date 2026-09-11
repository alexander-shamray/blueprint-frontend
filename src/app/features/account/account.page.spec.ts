import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AuthService, CurrentUser } from '@core/auth/auth.service';
import { AccountPage } from './account.page';

function mount(user: CurrentUser | null, sessionEndsOnReload: boolean, denied?: string) {
  TestBed.resetTestingModule();
  const signIn = vi.fn(async () => undefined);
  const signOut = vi.fn(async () => undefined);
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
          user: () => signal(user),
          sessionEndsOnReload,
          signIn,
          signOut,
          hasPermission: (n: string) => user?.permissions.includes(n) ?? false,
        },
      },
    ],
  });

  const fixture: ComponentFixture<AccountPage> = TestBed.createComponent(AccountPage);
  fixture.detectChanges();
  return { fixture, signIn, signOut, queryParams };
}

const demo: CurrentUser = {
  username: 'demo',
  subject: 's',
  permissions: ['catalog:write', 'orders:write', 'orders:cancel'],
  expiresAt: 0,
};

describe('AccountPage', () => {
  it('offers sign-in when signed out', () => {
    const { fixture, signIn } = mount(null, true);
    fixture.componentInstance.signIn();

    expect(fixture.componentInstance.username()).toBeNull();
    expect(signIn).toHaveBeenCalledOnce();
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

  it('states the web token posture', () => {
    expect(mount(demo, true).fixture.componentInstance.tokenPosture()).toBe(
      'Session ends on reload, no refresh token.',
    );
  });

  it('states the native token posture', () => {
    expect(mount(demo, false).fixture.componentInstance.tokenPosture()).toBe(
      'Refresh token in secure storage, rotated.',
    );
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

    expect(fixture.componentInstance.error()).not.toBeNull();
  });

  it('renders the permission a refused route needed', () => {
    const { fixture } = mount(demo, true, 'catalog:write');

    expect(fixture.componentInstance.denied()).toBe('catalog:write');
    expect(fixture.nativeElement.textContent).toContain('Route refused');
    expect(fixture.nativeElement.querySelector('code')?.textContent).toBe('catalog:write');
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
    expect(fixture.nativeElement.querySelector('code')?.textContent).toBe('orders:cancel');
  });
});
