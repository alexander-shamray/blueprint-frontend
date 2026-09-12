import { Injectable, InjectionToken, Signal, computed, inject, signal } from '@angular/core';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { environment } from '@core/config/environment';
import { AuthService, CurrentUser } from './auth.service';
import { decodeUser } from './current-user';

/**
 * The one key this strategy writes. Named rather than inlined because the
 * spec asserts it and `signOut` removes it: three literals would be three
 * chances for a sign-out that silently leaves a credential behind.
 */
export const REFRESH_TOKEN_KEY = 'blueprint.refresh';

/**
 * The three platform capabilities this strategy needs, each as a port with a
 * default factory rather than a direct import. The defaults are the real
 * Capacitor plugins, so production wiring is `NativeAuthStrategy` and nothing
 * else; a test overrides what it needs and runs with no device attached.
 *
 * The ports are narrower than the plugins on purpose. `SecureStore` is three
 * methods of a plugin that offers fourteen, and the ones left out are the
 * ones this strategy must not reach for: `keys()`, `clear()` and the iCloud
 * `setSynchronize` would each put the refresh token somewhere its owner did
 * not ask for.
 */
export interface SecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface SystemBrowser {
  open(options: { url: string }): Promise<void>;
  close(): Promise<void>;
  /**
   * Fires when the user dismisses the browser. Needed because `signIn()`
   * settles on the outcome of the flow (#3), and a sign-in the user backed
   * out of produces no callback at all — without this its promise would
   * never settle and every awaiting caller would wait for the life of the app.
   */
  onFinished(handler: () => void): Promise<void>;
}

export interface UrlOpenEvents {
  onUrlOpen(handler: (url: string) => void): Promise<void>;
}

export const SECURE_STORAGE = new InjectionToken<SecureStore>('SECURE_STORAGE', {
  factory: (): SecureStore => ({
    // getItem/setItem/removeItem, not get/set/remove: the plugin's `get`
    // parses ISO-8601-looking strings back into Date objects, which is the
    // wrong shape for an opaque credential. The string-in/string-out pair is
    // the one that hands back exactly what was stored.
    get: (key) => SecureStorage.getItem(key),
    set: (key, value) => SecureStorage.setItem(key, value),
    remove: (key) => SecureStorage.removeItem(key),
  }),
});

export const SYSTEM_BROWSER = new InjectionToken<SystemBrowser>('SYSTEM_BROWSER', {
  factory: (): SystemBrowser => ({
    open: (options) => Browser.open(options),
    close: () => Browser.close(),
    onFinished: async (handler) => {
      await Browser.addListener('browserFinished', handler);
    },
  }),
});

export const URL_OPEN_EVENTS = new InjectionToken<UrlOpenEvents>('URL_OPEN_EVENTS', {
  factory: (): UrlOpenEvents => ({
    onUrlOpen: async (handler) => {
      await App.addListener('appUrlOpen', (event) => handler(event.url));
    },
  }),
});

interface TokenResponse {
  readonly access_token?: string;
  readonly refresh_token?: string;
}

/**
 * What a token or revocation request came back as. The two failures are kept
 * apart because they call for opposite handling: Keycloak refusing a rotated
 * refresh token means that token is dead and no retry can revive it, while an
 * unreachable Keycloak says nothing about the token at all.
 */
type PostResult =
  | { readonly outcome: 'ok'; readonly body: TokenResponse }
  | { readonly outcome: 'refused' }
  | { readonly outcome: 'unreachable' };

/**
 * The native half of spec §4.2.
 *
 * Sign-in is an authorization code flow with PKCE opened in the SYSTEM
 * browser and returned to over `blueprint://auth/callback`. A web view would
 * be a browser this application controls, and controlling it is precisely the
 * property a system browser has that a web view does not: the credentials the
 * user types are never in reach of this code, and the realm session is shared
 * with the rest of the device rather than sealed inside one app.
 *
 * The access token lives in memory, as it does on the web. The refresh token
 * lives in secure storage — the Keychain on iOS, EncryptedSharedPreferences
 * on Android — and NOT in Capacitor Preferences, where the cart lives: the
 * cart is a list of product ids, and this is a credential that mints access
 * tokens. Because it is stored, a relaunch restores the session, which is why
 * `sessionEndsOnReload` is false here and true on the web (spec §5.6).
 *
 * The realm rotates: `revokeRefreshToken: true` with `refreshTokenMaxReuse: 0`
 * (realm-export.json). Every renewal therefore returns a new refresh token and
 * kills the one it was redeemed with, so the stored value must be replaced on
 * each renewal or the next one presents a token Keycloak has already retired.
 */
@Injectable()
export class NativeAuthStrategy extends AuthService {
  readonly sessionEndsOnReload = false;

  private readonly secure = inject(SECURE_STORAGE);
  private readonly browser = inject(SYSTEM_BROWSER);
  private readonly urlOpen = inject(URL_OPEN_EVENTS);

  private readonly token = signal<string | null>(null);
  private readonly currentUser = computed<CurrentUser | null>(() => {
    const raw = this.token();
    return raw ? decodeUser(raw) : null;
  });

  /**
   * The sign-in currently in flight: its one-time PKCE values and the promise
   * `signIn()` handed its caller. All of it in memory, and correctly so — a
   * native sign-in never destroys this heap the way a web redirect does; the
   * system browser opens over the app rather than replacing it, so there is
   * nothing to survive and nothing to write down.
   *
   * One object rather than four fields because they are one fact, and because
   * the invariant that matters is that they move together: settling the
   * promise while leaving the verifier behind, or minting a second verifier
   * under a promise already waiting on the first, are both #3.
   */
  private pending: {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
    readonly reject: (reason: unknown) => void;
    readonly verifier: string;
    readonly state: string;
  } | null = null;

  private renewalTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Bumped every time the session ends. A renewal reads it before its request
   * and again after, and adopts nothing if the number moved: the timer can
   * have a token request in flight when the user presses Sign out, and that
   * response — a perfectly valid rotated token — would otherwise write a
   * credential back into storage the user just asked to have cleared and
   * signal them back in seconds after they left.
   */
  private sessionGeneration = 0;

  /**
   * Incremented by every successful adoption. `sessionGeneration` says when a
   * session ENDED; this says when one BEGAN, and sign-out needs both: it ends
   * the session it was asked about, then does asynchronous work, and must not
   * clear shared state if a new session was established in the meantime. A
   * sign-in does not advance the generation — only an ending does — so the
   * generation alone cannot tell the difference.
   */
  private adoptions = 0;

  /** Fraction of the token's life at which renewal fires, as on the web (spec §4.1). */
  private static readonly RENEW_AT = 0.75;

  async initialize(): Promise<void> {
    try {
      // Registered before the stored credential is read, so a callback that
      // arrives while the restore is still in flight is not dropped.
      await this.urlOpen.onUrlOpen((url) => void this.handleCallback(url));
      await this.browser.onFinished(() => this.abandonPendingSignIn());

      const stored = await this.secure.get(REFRESH_TOKEN_KEY);
      if (stored) await this.renewNow();
    } catch {
      // Must never reject: `provideAuth()` hands this promise to
      // provideAppInitializer, and a rejected initializer aborts bootstrap —
      // main.ts's bootstrapApplication(...).catch only logs it, so the whole
      // application would render blank. A locked Keychain or an unreadable
      // store leaves the user signed out on a working catalog instead
      // (AuthService#initialize, spec §5.1).
    }
  }

  /**
   * Opens the flow and resolves when it has COMPLETED — not when the browser
   * opened (#3). `Browser.open()` resolving says a tab is showing, nothing
   * about whether anybody authenticated, and callers act on this promise as
   * though it meant the latter: `CheckoutPage.signInAndReplay()` replays the
   * customer's order on it, which under the old timing meant replaying with
   * the same expired token and collecting a second 401.
   *
   * Rejects when the exchange fails or the user dismisses the browser, so a
   * caller's failure path runs instead of its success path. It never leaves
   * the promise unsettled: the dismissal listener `initialize()` registers is
   * the backstop for the flow that produces no callback at all.
   */
  async signIn(): Promise<void> {
    // A second sign-in while one is in flight used to open a second browser
    // and overwrite the verifier the first was waiting to redeem, invalidating
    // whichever tab the user was part-way through. Hand back the flow already
    // running instead: both callers then settle on the one outcome.
    if (this.pending) return this.pending.promise;

    // Both random values are synchronous, so the whole record can be built
    // and claimed BEFORE this method's first await. That ordering is the
    // guard: claiming the slot after `await s256(...)` let two callers racing
    // inside that await both pass the check above, and the loser's promise
    // was then overwritten and abandoned unsettled.
    const verifier = randomUrlSafe(32);
    const state = randomUrlSafe(16);

    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.pending = { promise, resolve, reject, verifier, state };

    let challenge: string;
    try {
      challenge = await s256(verifier);
    } catch (failure) {
      // The record is claimed above, before this await, which is what makes
      // the in-flight guard work — and what makes a throw here dangerous: it
      // would leave the record set and its promise unsettled, and the next
      // sign-in would join a flow that has no browser and so no dismissal
      // event to rescue it. Settle and release the slot.
      this.pending = null;
      reject(failure);
      return promise;
    }

    const params = new URLSearchParams({
      client_id: environment.auth.nativeClientId,
      response_type: 'code',
      redirect_uri: environment.auth.nativeRedirectUri,
      scope: environment.auth.scope,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });

    try {
      await this.browser.open({ url: `${endpoint('auth')}?${params}` });
    } catch (failure) {
      // No browser opened, so no callback and no dismissal event will ever
      // come. Reject the record rather than only throwing: a caller that
      // joined this flow holds `promise` and nothing else would ever settle
      // it. Returning the now-rejected promise below gives this caller the
      // same failure by the same route, so there is one rejection path
      // instead of two.
      this.pending = null;
      reject(failure);
    }

    return promise;
  }

  /**
   * The return leg, delivered by @capacitor/app's `appUrlOpen` — which fires
   * because AndroidManifest.xml and Info.plist claim the `blueprint` scheme.
   */
  async handleCallback(url: string): Promise<void> {
    const pending = this.pending;
    const params = new URL(url).searchParams;
    const code = params.get('code');

    if (!pending || params.get('state') !== pending.state) {
      // Not this flow's callback. Refuse, and deliberately leave the pending
      // flow in place: clearing it here would let anyone able to fire an
      // intent at this app cancel a sign-in in progress by sending one
      // callback with the wrong state, and the legitimate return would then
      // arrive to find no verifier and fail. Nothing is spent, so nothing
      // needs resetting.
      return;
    }

    if (!code) {
      // This IS our flow, and it failed. A denial or a cancellation at the
      // Keycloak login screen redirects to the same redirect_uri with `error`
      // and the original `state` and no `code` (RFC 6749 §4.1.2.1). Matching
      // the state and then returning as though the callback were a stranger's
      // left the tab sitting over the app with the flow still pending, and the
      // user with no way to retry cleanly — they had to dismiss the browser
      // and wait for the dismissal path to notice.
      this.pending = null;
      await this.closeBrowserQuietly();
      const reason = params.get('error');
      pending.reject(
        new Error(
          reason
            ? `Sign-in failed: ${reason}`
            : 'The authorization server returned no code and no error.',
        ),
      );
      return;
    }

    // Captured before the exchange, and handed to `adopt` below. A sign-out
    // can land while the exchange is in flight, and adopting on whatever
    // generation is current when the response arrives would sign the user
    // straight back in after they left.
    const generation = this.sessionGeneration;

    // Spent now, before the exchange: this code and verifier are single-use,
    // and a replayed callback must not get a second exchange out of them.
    // Clearing it before `browser.close()` below also means the dismissal
    // listener sees no pending flow when closing fires browserFinished, so a
    // successful sign-in cannot reject itself.
    this.pending = null;

    const result = await this.post(
      endpoint('token'),
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: environment.auth.nativeClientId,
        redirect_uri: environment.auth.nativeRedirectUri,
        code,
        code_verifier: pending.verifier,
      }),
    );

    // Closed on every outcome: the system browser is showing a page that has
    // already redirected, and leaving it in front of the app on a failed
    // exchange strands the user on it. Best-effort, though: `pending` is
    // already cleared by this point, so a rejection here would skip both the
    // adoption below and every `pending.reject()`, and the caller of
    // `signIn()` would wait for the life of the app on a promise nothing can
    // settle. Closing a tab is not worth that.
    await this.closeBrowserQuietly();

    if (result.outcome === 'ok' && result.body.access_token) {
      let adopted: boolean;
      try {
        adopted = await this.adopt(result.body, generation);
      } catch (failure) {
        // `adopt` puts the access token in memory before it writes the
        // refresh token, so a store that refuses the write leaves a half
        // session behind: a token in memory, no renewal scheduled, and a
        // promise nobody is left to settle. Undo the half and fail the
        // caller.
        this.clearRenewal();
        this.token.set(null);
        pending.reject(failure);
        return;
      }

      if (adopted) {
        pending.resolve();
        return;
      }

      // `adopt` declined: the session this code was minted for ended while the
      // exchange was in flight. Resolving anyway would tell the caller that
      // authentication completed when there is no access token to show for it
      // — and `CheckoutPage.signInAndReplay()` acts on exactly that, replaying
      // the order straight into another 401.
      pending.reject(new Error('The session ended before sign-in completed.'));
      return;
    }

    // The code came back and could not be redeemed — a spent code, a realm
    // mid-restart, a network that dropped between the redirect and the POST.
    // Reject so the caller's failure path runs: replaying an order here would
    // send it with no new token and collect the same 401 that started this.
    pending.reject(new Error('The authorization code could not be exchanged for a token.'));
  }

  /**
   * Renews from the stored refresh token. Public because the renewal timer is
   * not the only caller: `initialize` uses it to turn a stored credential
   * back into a session at launch, which is the whole reason the credential
   * is stored.
   */
  async renewNow(): Promise<void> {
    const generation = this.sessionGeneration;
    const stored = await this.secure.get(REFRESH_TOKEN_KEY);

    // The read is an await too. A sign-out and a fresh sign-in can both land
    // while it is suspended, and then this branch would end a session it knows
    // nothing about — the same mistake the post-request check below exists to
    // prevent, on the path that reaches it first.
    if (generation !== this.sessionGeneration) return;

    if (!stored) {
      await this.abandonSession();
      return;
    }

    const result = await this.post(
      endpoint('token'),
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: environment.auth.nativeClientId,
        refresh_token: stored,
      }),
    );

    // The session may have ended while that request was in flight. Anything
    // this response would do now — adopt a token, or clear one that a
    // sign-out has already cleared — is about a session that no longer exists.
    if (generation !== this.sessionGeneration) return;

    if (result.outcome === 'ok' && result.body.access_token) {
      try {
        await this.adopt(result.body, generation);
      } catch (failure) {
        // Same half-session `handleCallback` guards against, on the path that
        // matters more: `initialize` calls this and swallows what it throws,
        // so a Keychain that refuses the write at launch would otherwise
        // leave an access token in memory that nothing will ever renew.
        this.clearRenewal();
        this.token.set(null);
        throw failure;
      }
      return;
    }

    if (result.outcome === 'refused') {
      // Keycloak rejected the token. Under rotation there is no second
      // chance: either it was already redeemed or the realm retired it, and
      // in both cases retrying presents the same dead string. Drop it and
      // require an interactive sign-in.
      await this.abandonSession();
      return;
    }

    // Unreachable, not refused. Neither credential is known to be bad: the
    // stored refresh token may be perfectly good, and so may the access token
    // still in memory — renewal fires at 75% of the token's life, so a
    // quarter of it is still ahead. Ending the session at the first failed
    // attempt would turn a network blink into an interactive login the realm
    // never asked for, a minute before it was due.
    //
    // So keep both and try again. `scheduleRenewal` recomputes from the
    // token's own `exp`, which makes the retry interval 75% of whatever life
    // remains — a backoff that converges on expiry without a number chosen
    // here. Only once there is no life left is there nothing to keep.
    const user = this.currentUser();
    if (user && user.expiresAt * 1000 > Date.now()) {
      this.scheduleRenewal();
      return;
    }

    this.clearRenewal();
    this.token.set(null);
  }

  async signOut(): Promise<void> {
    // Ends the session BEFORE anything is read or revoked. Two things follow
    // from doing it first: the timer cannot start a new renewal, and a
    // renewal already in flight fails `adopt`'s generation check instead of
    // rotating the very token this method is about to revoke.
    //
    // It does not make the race impossible. A renewal that has already
    // reached Keycloak can still rotate R1 to R2 before the revocation
    // arrives, and then the revoke of R1 is refused and R2 lives at the realm
    // until its idle timeout — with nobody holding it, because `adopt`'s
    // rollback discards it. That residual is the same one the unreachable
    // case accepts, and closing it properly would mean serialising every
    // token request against sign-out.
    this.sessionGeneration++;
    this.clearRenewal();

    // A sign-in already in flight is abandoned with the session. Bumping the
    // generation is not enough on its own: `handleCallback` captures whatever
    // generation is current when the return arrives, which after this line is
    // the NEW one, so the exchange would succeed and adopt — an authorization
    // flow begun before the sign-out signing the user back in after it.
    // Signing out is the later instruction and it wins.
    this.abandonPendingSignIn('Sign-in was abandoned by a sign-out.');
    // Closes the login page still sitting in front of the app. Harmless when
    // no browser is open.
    await this.closeBrowserQuietly();

    // Recorded before the asynchronous work below, and compared after it.
    const adoptions = this.adoptions;

    let stored: string | null = null;
    try {
      stored = await this.secure.get(REFRESH_TOKEN_KEY);
    } catch {
      // A store that cannot be read cannot be revoked from either, and there
      // is nothing to revoke WITH. Carry on and clear locally: rejecting here
      // left the access token in memory and the UI signed in because the
      // Keychain was briefly busy, which is the one outcome nobody asked for.
    }

    if (stored) {
      // Revoke BEFORE clearing. Clearing first would leave a live refresh
      // token at the realm and nothing left on the device to revoke it with —
      // the session would outlive the sign-out by its full idle timeout.
      //
      // The result is deliberately not consulted. A revocation that could not
      // be delivered leaves a live token at the realm, and the alternative —
      // keeping the credential on the device and asking the user to try
      // signing out again — is worse in the case that actually matters. The
      // realm-side session expires on its own idle timeout and nobody holds a
      // token to use in the meantime, because the only copy is about to be
      // deleted. A credential kept on a device whose owner has just said they
      // are done with it is a credential available to whoever picks the
      // device up. So: always clear locally, and accept the realm session
      // outliving the sign-out when the network will not carry the
      // revocation.
      await this.post(
        endpoint('revoke'),
        new URLSearchParams({
          client_id: environment.auth.nativeClientId,
          token: stored,
          token_type_hint: 'refresh_token',
        }),
      );
    }

    // A sign-in that STARTED after this sign-out did and completed while the
    // revocation was in flight owns the session now — the checkout 401 path
    // can do exactly that. Clearing shared state here would delete its
    // credential and sign it out, on behalf of a session that ended before it
    // began. The user's most recent completed action wins.
    if (this.adoptions !== adoptions) return;

    await this.abandonSession();
  }

  accessToken(): string | null {
    return this.token();
  }

  user(): Signal<CurrentUser | null> {
    return this.currentUser;
  }

  hasPermission(name: string): boolean {
    return this.currentUser()?.permissions.includes(name) ?? false;
  }

  /** The pending flow's `state`, for the callback to be checked against. */
  pendingState(): string | null {
    return this.pending?.state ?? null;
  }

  /**
   * Takes a token set into the session, but only for the session it was
   * minted for. `generation` is the value the CALLER read before its network
   * request, not the value current now: a sign-out during that request ends
   * the session these tokens belong to, and adopting them afterwards would
   * undo it.
   */
  private async adopt(tokens: TokenResponse, generation: number): Promise<boolean> {
    if (generation !== this.sessionGeneration) {
      await this.discard(tokens.refresh_token);
      return false;
    }

    this.token.set(tokens.access_token ?? null);

    // Replace, because rotation is on: the token just redeemed is dead and
    // keeping it would break the next renewal. Absent rather than new is not
    // expected from this realm, and overwriting a working credential with
    // nothing would be worse than leaving it, so absent means keep.
    if (tokens.refresh_token) await this.secure.set(REFRESH_TOKEN_KEY, tokens.refresh_token);

    // Checking before the write is not enough: the write is itself an await,
    // and a sign-out crossing it put the credential back into storage the
    // user had just had cleared.
    if (generation !== this.sessionGeneration) {
      // Undo only what THIS call did, and note what that excludes: the
      // in-memory token is deliberately NOT cleared here. The generation only
      // moves through `abandonSession`, which sets it to null itself and does
      // so after this call put it there — so whatever is in the signal now
      // belongs to a session that came later, and clearing it would log out
      // the session that replaced this one. (Comparing the token strings is
      // no help: two sessions minted a second apart from the same realm
      // produce byte-identical JWTs.)
      await this.discard(tokens.refresh_token);
      return false;
    }

    this.adoptions++;
    this.scheduleRenewal();
    // One residual is left here knowingly: a write suspended long enough to
    // cross a sign-out AND a fresh sign-in lands on top of the new session's
    // stored value, and the rollback above then removes it, leaving the new
    // session signed in on its in-memory token with nothing stored until its
    // next renewal. Closing that would need a compare-and-set the storage API
    // does not offer, or a write queue re-checking the generation inside its
    // critical section — a lot of machinery for a millisecond window whose
    // consequence repairs itself on the next renewal.
    return true;
  }

  /**
   * Removes a stored refresh token only if it is still the one named — so a
   * rollback from an ended session cannot delete the credential of the
   * session that replaced it. The key is fixed and shared; the value is what
   * identifies the owner.
   */
  /**
   * Dismisses the system browser and never fails doing it. Every caller is
   * mid-way through settling something more important than a tab — a flow's
   * promise, or a session ending — and none of them can afford to be skipped
   * by a rejection from here.
   */
  private async closeBrowserQuietly(): Promise<void> {
    try {
      await this.browser.close();
    } catch {
      // The tab stays up. Nothing downstream depends on it having gone.
    }
  }

  private async discard(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    try {
      if ((await this.secure.get(REFRESH_TOKEN_KEY)) === refreshToken) {
        await this.secure.remove(REFRESH_TOKEN_KEY);
      }
    } catch {
      // A store that cannot be read or written cannot be tidied. The session
      // this value belonged to has ended either way.
    }
  }

  /**
   * The user closed the system browser without completing the flow. There is
   * no callback coming, so settle the promise `signIn()` handed out — a
   * rejection rather than a resolution, because a caller's success path means
   * "signed in" and nobody is.
   */
  private abandonPendingSignIn(reason = 'Sign-in was dismissed before it completed.'): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.reject(new Error(reason));
  }

  /**
   * Ends the session: no token in memory, no renewal scheduled, and nothing
   * left in storage for `initialize` to restore.
   *
   * THROWS if the stored credential survives. That is deliberate and it
   * corrects an earlier comment here which claimed a leftover entry was
   * harmless because the realm would refuse it — true only if the revocation
   * got through. When revocation failed AND the entry cannot be removed, the
   * credential is still live and `initialize()` restores it on the next
   * launch: a sign-out that silently signed nobody out. Memory is cleared
   * either way, so the caller's failure path reports an incomplete sign-out
   * rather than an imaginary one.
   */
  private async abandonSession(): Promise<void> {
    this.sessionGeneration++;
    this.clearRenewal();
    this.token.set(null);

    try {
      await this.secure.remove(REFRESH_TOKEN_KEY);
      return;
    } catch (removeFailure) {
      // Second attempt by a different route: an empty value is what `read`
      // already treats as no cart— here, as no credential (`if (!stored)` in
      // renewNow and initialize). A store that refuses a delete may still
      // accept an overwrite.
      try {
        await this.secure.set(REFRESH_TOKEN_KEY, '');
      } catch {
        throw removeFailure;
      }
    }
  }

  private scheduleRenewal(): void {
    this.clearRenewal();

    const user = this.currentUser();
    if (!user?.expiresAt) return;

    const lifetimeMs = user.expiresAt * 1000 - Date.now();
    if (lifetimeMs <= 0) return;

    this.renewalTimer = setTimeout(() => {
      // Nothing awaits this call, so `renewNow` rejecting here — a locked
      // Keychain is the realistic way — would be an unhandled rejection and
      // would leave the session with a token nobody will renew and no
      // explanation anywhere. Catch it and end the session instead: the next
      // protected action prompts an interactive sign-in, which is the only
      // thing that can help.
      void this.renewNow().catch(() => {
        this.clearRenewal();
        this.token.set(null);
      });
    }, lifetimeMs * NativeAuthStrategy.RENEW_AT);
  }

  private clearRenewal(): void {
    if (this.renewalTimer !== null) clearTimeout(this.renewalTimer);
    this.renewalTimer = null;
  }

  private async post(url: string, body: URLSearchParams): Promise<PostResult> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch {
      return { outcome: 'unreachable' };
    }

    if (!response.ok) {
      // A 5xx or a 429 is the identity provider having a bad minute, not a
      // verdict on the credential — Keycloak restarting, or this client's own
      // token bucket. `renewNow` deletes the refresh token on a refusal, so
      // folding these in with `invalid_grant` would turn one bad minute into
      // a forced interactive sign-in. Only a 4xx that is not a 429 is an
      // answer about the grant itself.
      const retryable = response.status >= 500 || response.status === 429;
      return { outcome: retryable ? 'unreachable' : 'refused' };
    }

    try {
      return { outcome: 'ok', body: (await response.json()) as TokenResponse };
    } catch {
      // A 200 whose body is not JSON is the revocation endpoint's normal
      // answer, and it is not a failure: it carries no tokens and none are
      // wanted. Callers check `body.access_token` before adopting anything.
      return { outcome: 'ok', body: {} };
    }
  }
}

/**
 * Keycloak's endpoint layout, built from the configured issuer rather than
 * fetched from `.well-known/openid-configuration`. The realm is this
 * deployment's own (realm-export.json) and the paths are fixed by Keycloak,
 * so a discovery round trip at launch would buy nothing and cost the one
 * request that stands between a stored credential and a restored session.
 */
function endpoint(name: 'auth' | 'token' | 'revoke'): string {
  return `${environment.auth.issuer}/protocol/openid-connect/${name}`;
}

/**
 * `crypto.subtle` requires a secure context. Both platforms have one: Capacitor
 * serves the bundle from `https://localhost` on Android and `capacitor://localhost`
 * on iOS, and neither is a plain-http origin. (jsdom has no `subtle` at all,
 * which is why the spec stubs Node's WebCrypto over it.)
 */
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function randomUrlSafe(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64Url(buffer);
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
