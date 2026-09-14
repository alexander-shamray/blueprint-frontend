import { Injectable, InjectionToken, Signal, computed, inject, signal } from '@angular/core';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
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
  factory: (): SystemBrowser => adaptBrowser(Browser, Capacitor.getPlatform()),
});

/** The three members of `@capacitor/browser` the adapter drives. */
export interface BrowserPlugin {
  open(options: { url: string }): Promise<void>;
  close(): Promise<void>;
  addListener(eventName: 'browserFinished', handler: () => void): Promise<unknown>;
}

/**
 * How long an Android `close()` waits for the `browserFinished` its own close
 * produces (#28). Past it the event is no longer absorbed, and a later one is
 * forwarded as a dismissal like any other.
 */
export const CLOSE_EVENT_BOUND_MS = 3_000;

/**
 * Wraps the plugin so that a close this app makes never reaches the strategy
 * as the user dismissing a browser (#28).
 *
 * `browserFinished` carries no payload, so it cannot say which tab it is
 * about. On Android `Browser.close()` resolves at once and the event follows
 * later, once the plugin's `EventGroup` of `TAB_HIDDEN` and `onPause`/
 * `onResume` drains — so a sign-out's close, followed at once by a new
 * sign-in, can deliver the old tab's event after the new tab has opened, and
 * the strategy would reject a flow the user never touched. Here, a close of a
 * tab this adapter saw open and not yet finish waits for that event, bounded,
 * and consumes it. The close runs inside the strategy's lifecycle queue, so
 * the next flow cannot open until the old tab's event has been spent.
 *
 * iOS resolves `close` in the dismissal's completion and sends no event for
 * it — `browserFinished` there is only the Done button — so waiting on iOS
 * would spend the whole bound on every close for nothing. Only Android waits.
 */
export function adaptBrowser(
  plugin: BrowserPlugin,
  platform: string,
  boundMs = CLOSE_EVENT_BOUND_MS,
): SystemBrowser {
  let forward: (() => void) | null = null;
  // A tab opened through this adapter whose `browserFinished` has not arrived.
  let showing = false;
  // Set while a close waits for its own event; the event resolves it instead
  // of being forwarded.
  let absorb: (() => void) | null = null;

  return {
    open: async (options) => {
      await plugin.open(options);
      showing = true;
    },
    close: async () => {
      if (platform !== 'android' || !forward || !showing) return plugin.close();

      let timer: ReturnType<typeof setTimeout> | undefined;
      const consumed = new Promise<void>((resolve) => (absorb = resolve));
      const bound = new Promise<void>((resolve) => (timer = setTimeout(resolve, boundMs)));
      try {
        await plugin.close();
        await Promise.race([consumed, bound]);
      } finally {
        clearTimeout(timer);
        absorb = null;
      }
    },
    onFinished: async (handler) => {
      forward = handler;
      await plugin.addListener('browserFinished', () => {
        showing = false;
        if (absorb) {
          absorb();
          absorb = null;
          return;
        }
        forward?.();
      });
    },
  };
}

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
   * **The one piece of state that outlives a lifecycle operation (#8).**
   * Everything else is read and written inside `serialize`, where nothing
   * interleaves. This cannot be: between `signIn` opening the browser and
   * `handleCallback` redeeming the code the user spends minutes at a login
   * screen, and holding the queue for that would freeze sign-out and renewal
   * behind a human. So every step that resumes after such a gap asks
   * `this.pending === flow` before it acts, and a sign-out that abandoned the
   * flow in the meantime has made the answer no.
   */
  private pending: Flow | null = null;

  /**
   * The tail of the lifecycle queue (#8). Five review rounds on #2 found the
   * same bug each time — state read on one side of an `await` and changed on
   * the other — and each guard added for one interleaving left the next one
   * open. `signIn`'s mint-and-open, `handleCallback`'s redemption, `renewNow`
   * and `signOut` now each run to completion before the next begins, which
   * removes the class rather than catching its instances: the session
   * generation, the adoption counter and the value-checked rollback that stood
   * in for this are gone.
   */
  private lifecycle: Promise<unknown> = Promise.resolve();

  private renewalTimer: ReturnType<typeof setTimeout> | null = null;

  /** Fraction of the token's life at which renewal fires, as on the web (spec §4.1). */
  private static readonly RENEW_AT = 0.75;

  /**
   * How long a request to Keycloak may hold the lifecycle queue. Without a
   * bound, a request lost to a network that neither answers nor refuses would
   * leave every sign-out behind it waiting for the life of the app — a cost
   * the unserialised strategy never had, because nothing waited on anything.
   */
  private static readonly REQUEST_TIMEOUT_MS = 15_000;

  async initialize(): Promise<void> {
    try {
      // Registered before the stored credential is read, so a callback that
      // arrives while the restore is still in flight is not dropped.
      await this.urlOpen.onUrlOpen((url) => void this.handleCallback(url));
      // Only a flow whose browser is showing can be dismissed. Closing it
      // once the code has come back is this strategy's own act, and fires
      // this event too; and a flow still queued to open has no browser, so an
      // event then is the close of the flow before it, queued by a sign-out.
      // Once the next flow HAS opened, the stage cannot tell its dismissal from
      // the old tab's late event; on Android the adapter absorbs that event
      // inside the close that caused it, before the next flow can open (#28).
      await this.browser.onFinished(() => {
        if (this.pending?.stage === 'open') this.abandonPendingSignIn();
      });

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
   * Rejects when the exchange fails, the user dismisses the browser or a
   * sign-out abandons the flow, so a caller's failure path runs instead of its
   * success path. It never leaves the promise unsettled.
   */
  async signIn(): Promise<void> {
    // A second sign-in while one is in flight used to open a second browser
    // and overwrite the verifier the first was waiting to redeem. Hand back
    // the flow already running instead: both callers settle on one outcome.
    if (this.pending) return this.pending.promise;

    // Claimed synchronously, so the guard above holds from the first call, and
    // the caller holds the promise before anything can reject it.
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const flow: Flow = {
      promise,
      resolve,
      reject,
      verifier: randomUrlSafe(32),
      state: randomUrlSafe(16),
      stage: 'opening',
    };
    this.pending = flow;

    void this.serialize(async () => {
      try {
        const challenge = await s256(flow.verifier);
        // Abandoned while it waited its turn or its digest (#8). Opening now
        // would put a dead flow's login page over whatever came after it.
        if (this.pending !== flow) return;

        const params = new URLSearchParams({
          client_id: environment.auth.nativeClientId,
          response_type: 'code',
          redirect_uri: environment.auth.nativeRedirectUri,
          scope: environment.auth.scope,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state: flow.state,
        });
        await this.browser.open({ url: `${endpoint('auth')}?${params}` });
        if (flow.stage === 'opening') flow.stage = 'open';
      } catch (failure) {
        // No browser opened, so no callback and no dismissal event will ever
        // come. Settle the record and release the slot, or every caller that
        // joined it would wait for the life of the app.
        this.release(flow);
        reject(failure);
      }
    });

    return promise;
  }

  /**
   * The return leg, delivered by @capacitor/app's `appUrlOpen` — which fires
   * because AndroidManifest.xml and Info.plist claim the `blueprint` scheme.
   */
  async handleCallback(url: string): Promise<void> {
    const flow = this.pending;
    const params = new URL(url).searchParams;

    // Not this flow's callback, or this flow's callback a second time. Refuse,
    // and leave the flow in place: clearing it would let anyone able to fire
    // an intent at this app cancel a sign-in in progress with one wrong
    // `state`. The code and verifier are single-use, so a replay gets nothing.
    // The `redeeming` refusal is the cheap one, not the only one: a replay that
    // got past it would find the flow released by the time its turn came, and
    // `redeem`'s identity check would end it there.
    if (!flow || flow.stage === 'redeeming' || params.get('state') !== flow.state) return;

    // Marked, not cleared (#8). Clearing the flow here dropped the in-flight
    // guard while its caller was still waiting, so a second `signIn` opened a
    // second browser and this callback's `close()` then dismissed it.
    flow.stage = 'redeeming';
    return this.serialize(() => this.redeem(flow, params));
  }

  /**
   * Renews from the stored refresh token. Public because the renewal timer is
   * not the only caller: `initialize` uses it to turn a stored credential
   * back into a session at launch, which is the whole reason the credential
   * is stored.
   */
  async renewNow(): Promise<void> {
    return this.serialize(async () => {
      try {
        await this.renew();
      } catch (failure) {
        // A store that refuses the read or the rotated token's write leaves a
        // token in memory that nothing will renew — and `initialize` and the
        // timer both swallow this. End the in-memory session before reporting.
        this.endInMemory();
        throw failure;
      }
    });
  }

  async signOut(): Promise<void> {
    // Two things happen at the moment of asking rather than at this call's
    // turn in the queue. The timer stops, so no renewal is queued behind the
    // sign-out to redeem the token it is about to revoke. And a sign-in in
    // flight is abandoned, because signing out is the later instruction:
    // a flow begun before it must not sign the user back in after it, and
    // its caller must hear so now rather than when the queue reaches here.
    this.clearRenewal();
    this.abandonPendingSignIn('Sign-in was abandoned by a sign-out.');

    return this.serialize(async () => {
      // Closes the login page still sitting in front of the app. Harmless when
      // no browser is open.
      await this.closeBrowserQuietly();

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
        // token at the realm and nothing left on the device to revoke it with.
        // Serialised, `stored` is the newest token there is: a renewal queued
        // ahead of this has already rotated and written, so it is the rotated
        // token that is revoked, not the one it replaced (#8).
        //
        // The result is deliberately not consulted. A revocation that could
        // not be delivered leaves a live token at the realm, and the
        // alternative — keeping the credential on the device and asking the
        // user to try signing out again — is worse in the case that actually
        // matters: a credential kept on a device whose owner has just said they
        // are done with it is available to whoever picks the device up. The
        // realm-side session expires on its own idle timeout.
        await this.post(
          endpoint('revoke'),
          new URLSearchParams({
            client_id: environment.auth.nativeClientId,
            token: stored,
            token_type_hint: 'refresh_token',
          }),
        );
      }

      await this.abandonSession();
    });
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
   * Runs one lifecycle operation after every operation queued before it has
   * settled, whichever way it settled. A rejection is handed to this
   * operation's caller and never to the next operation, which runs regardless.
   * Nothing queued here may await another queued operation: it would wait
   * for itself.
   */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(operation, operation);
    this.lifecycle = run.catch(() => undefined);
    return run;
  }

  /** `handleCallback`'s turn in the queue. Settles `flow` on every path and never throws. */
  private async redeem(flow: Flow, params: URLSearchParams): Promise<void> {
    // A sign-out abandoned it while this waited, and rejected its caller.
    if (this.pending !== flow) return;

    const code = params.get('code');
    if (!code) {
      // This IS our flow, and it failed. A denial or a cancellation at the
      // Keycloak login screen redirects to the same redirect_uri with `error`
      // and the original `state` and no `code` (RFC 6749 §4.1.2.1). Leaving
      // the flow pending left the tab over the app and no clean retry.
      this.release(flow);
      await this.closeBrowserQuietly();
      const reason = params.get('error');
      flow.reject(
        new Error(
          reason
            ? `Sign-in failed: ${reason}`
            : 'The authorization server returned no code and no error.',
        ),
      );
      return;
    }

    const result = await this.post(
      endpoint('token'),
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: environment.auth.nativeClientId,
        redirect_uri: environment.auth.nativeRedirectUri,
        code,
        code_verifier: flow.verifier,
      }),
    );

    // Closed on every outcome: the system browser is showing a page that has
    // already redirected, and leaving it in front of the app on a failed
    // exchange strands the user on it. Best-effort, because a rejection here
    // would skip every settlement below.
    await this.closeBrowserQuietly();

    // A sign-out during the exchange abandoned the flow. These tokens belong
    // to a session the user has already left, and none of them was stored.
    if (this.pending !== flow) return;

    if (result.outcome !== 'ok' || !result.body.access_token) {
      // The code came back and could not be redeemed — a spent code, a realm
      // mid-restart, a network that dropped between the redirect and the POST.
      // Reject so the caller's failure path runs: replaying an order here would
      // send it with no new token and collect the same 401 that started this.
      this.release(flow);
      flow.reject(new Error('The authorization code could not be exchanged for a token.'));
      return;
    }

    try {
      await this.adopt(result.body);
    } catch (failure) {
      // `adopt` puts the access token in memory before it writes the refresh
      // token, so a store that refuses the write leaves a half session.
      this.release(flow);
      this.endInMemory();
      flow.reject(failure);
      return;
    }

    // A sign-out crossed the write. Its caller has already been told, and the
    // sign-out's own turn is next in the queue and revokes what was written;
    // what is left here is the token in memory, which no caller should use.
    if (this.pending !== flow) {
      this.endInMemory();
      return;
    }

    this.release(flow);
    flow.resolve();
  }

  /** `renewNow`'s body, run inside its turn. */
  private async renew(): Promise<void> {
    const stored = await this.secure.get(REFRESH_TOKEN_KEY);
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

    if (result.outcome === 'ok' && result.body.access_token) {
      await this.adopt(result.body);
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

    this.endInMemory();
  }

  /**
   * Takes a token set into the session. Called only from inside a queued
   * operation, so no sign-out can land between its steps and nothing here
   * needs to ask whose session this still is.
   */
  private async adopt(tokens: TokenResponse): Promise<void> {
    this.token.set(tokens.access_token ?? null);

    // Replace, because rotation is on: the token just redeemed is dead and
    // keeping it would break the next renewal. Absent rather than new is not
    // expected from this realm, and overwriting a working credential with
    // nothing would be worse than leaving it, so absent means keep.
    if (tokens.refresh_token) await this.secure.set(REFRESH_TOKEN_KEY, tokens.refresh_token);

    this.scheduleRenewal();
  }

  /** Clears `pending` if it still names `flow`, and never a flow that replaced it. */
  private release(flow: Flow): void {
    if (this.pending === flow) this.pending = null;
  }

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

  /**
   * The flow will produce no callback — the user closed the browser, or a
   * sign-out abandoned it — so settle the promise `signIn()` handed out. A
   * rejection rather than a resolution, because a caller's success path means
   * "signed in" and nobody is.
   */
  private abandonPendingSignIn(reason = 'Sign-in was dismissed before it completed.'): void {
    const flow = this.pending;
    if (!flow) return;
    this.pending = null;
    flow.reject(new Error(reason));
  }

  /**
   * Ends the session: no token in memory, no renewal scheduled, and nothing
   * left in storage for `initialize` to restore.
   *
   * THROWS if the stored credential survives. When revocation failed AND the
   * entry cannot be removed, the credential is still live and `initialize()`
   * restores it on the next launch: a sign-out that silently signed nobody
   * out. Memory is cleared either way, so the caller's failure path reports an
   * incomplete sign-out rather than an imaginary one.
   */
  private async abandonSession(): Promise<void> {
    this.endInMemory();

    try {
      await this.secure.remove(REFRESH_TOKEN_KEY);
      return;
    } catch (removeFailure) {
      // Second attempt by a different route: an empty value is what renewal
      // and `initialize` already treat as no credential (`if (!stored)`). A
      // store that refuses a delete may still accept an overwrite.
      try {
        await this.secure.set(REFRESH_TOKEN_KEY, '');
      } catch {
        throw removeFailure;
      }
    }
  }

  private endInMemory(): void {
    this.clearRenewal();
    this.token.set(null);
  }

  private scheduleRenewal(): void {
    this.clearRenewal();

    const user = this.currentUser();
    if (!user?.expiresAt) return;

    const lifetimeMs = user.expiresAt * 1000 - Date.now();
    if (lifetimeMs <= 0) return;

    this.renewalTimer = setTimeout(() => {
      // Nothing awaits this call, so a rejection — a locked Keychain is the
      // realistic way — would be unhandled. `renewNow` has already ended the
      // in-memory session by then; the next protected action prompts an
      // interactive sign-in, which is the only thing that can help.
      void this.renewNow().catch(() => undefined);
    }, lifetimeMs * NativeAuthStrategy.RENEW_AT);
  }

  private clearRenewal(): void {
    if (this.renewalTimer !== null) clearTimeout(this.renewalTimer);
    this.renewalTimer = null;
  }

  private async post(url: string, body: URLSearchParams): Promise<PostResult> {
    // The bound covers the body as well as the headers: `fetch` resolves once
    // the headers arrive, and a server that then stalls the body would hold
    // the queue from inside `response.json()` instead.
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), NativeAuthStrategy.REQUEST_TIMEOUT_MS);
    try {
      return await this.send(url, body, abort.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async send(url: string, body: URLSearchParams, signal: AbortSignal): Promise<PostResult> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal,
      });
    } catch {
      return { outcome: 'unreachable' };
    }

    if (!response.ok) {
      // A 5xx or a 429 is the identity provider having a bad minute, not a
      // verdict on the credential — Keycloak restarting, or this client's own
      // token bucket. `renew` deletes the refresh token on a refusal, so
      // folding these in with `invalid_grant` would turn one bad minute into
      // a forced interactive sign-in. Only a 4xx that is not a 429 is an
      // answer about the grant itself.
      const retryable = response.status >= 500 || response.status === 429;
      return { outcome: retryable ? 'unreachable' : 'refused' };
    }

    try {
      return { outcome: 'ok', body: (await response.json()) as TokenResponse };
    } catch {
      // A body abandoned at the bound was never an answer, so it is not read as
      // the empty one below.
      if (signal.aborted) return { outcome: 'unreachable' };
      // A 200 whose body is not JSON is the revocation endpoint's normal
      // answer, and it is not a failure: it carries no tokens and none are
      // wanted. Callers check `body.access_token` before adopting anything.
      return { outcome: 'ok', body: {} };
    }
  }
}

/**
 * A sign-in between `signIn` and its callback. One object rather than five
 * fields because they are one fact and must move together: settling the
 * promise while leaving the verifier behind, or minting a second verifier
 * under a promise already waiting on the first, are both #3.
 */
interface Flow {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly verifier: string;
  readonly state: string;
  /**
   * `opening` until its browser shows, `open` while the user is at the login
   * screen and the only stage a dismissal can end, `redeeming` once its
   * callback has arrived and the code is spent.
   */
  stage: 'opening' | 'open' | 'redeeming';
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
