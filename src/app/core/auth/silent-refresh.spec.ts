import { HttpParams, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Injectable } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MemoryStorage, OAuthService, provideOAuthClient } from 'angular-oauth2-oidc';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #373: `public/silent-refresh.html` is the page `WebAuthStrategy.renew()`'s hidden iframe
 * lands on, and what it posts to its parent is the only way the renewed code reaches the
 * library. The subject is the page's own script, read from the file and run against the URL
 * the identity provider redirects to, so an edit to the page is what these cases see.
 */
const page = readFileSync(join(process.cwd(), 'public/silent-refresh.html'), 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? '';

const ORIGIN = 'http://localhost:5173';
const REDIRECT = `${ORIGIN}/silent-refresh.html`;

/** Runs the page's script as the iframe would on `url`; returns what it posted, and where. */
function postedOn(url: string): { message: unknown; targetOrigin: unknown } {
  const at = new URL(url);
  const posts: { message: unknown; targetOrigin: unknown }[] = [];
  runInNewContext(script, {
    location: { hash: at.hash, search: at.search, origin: at.origin },
    parent: {
      postMessage: (message: unknown, targetOrigin: unknown) =>
        posts.push({ message, targetOrigin }),
    },
  });
  expect(posts).toHaveLength(1);
  return posts[0];
}

describe('silent-refresh.html posts the authorization response to its parent (#373)', () => {
  it('holds one inline script, so the cases below run the page rather than nothing', () => {
    expect(script.trim()).not.toBe('');
  });

  it('posts a query-string code response, the code flow default, behind a leading #', () => {
    const posted = postedOn(`${REDIRECT}?state=s1&session_state=ss&code=c1`);

    expect(posted.message).toBe('#state=s1&session_state=ss&code=c1');
    expect(posted.targetOrigin).toBe(ORIGIN);
  });

  it('posts a prompt=none refusal from the query, so renewal ends at once, not on timeout', () => {
    expect(postedOn(`${REDIRECT}?error=login_required&state=s1`).message).toBe(
      '#error=login_required&state=s1',
    );
  });

  it('posts a fragment response as it stands, for a response mode that uses the hash', () => {
    expect(postedOn(`${REDIRECT}#state=s1&code=c1`).message).toBe('#state=s1&code=c1');
  });

  describe("what it posts, handed to angular-oauth2-oidc's own silent-refresh listener", () => {
    const TOKEN_ENDPOINT = 'http://idp.test/token';
    let controller: HttpTestingController;
    let oauth: ListeningOAuthService;

    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [
          provideHttpClient(),
          provideHttpClientTesting(),
          provideOAuthClient(),
          { provide: OAuthService, useClass: ListeningOAuthService },
        ],
      });
      controller = TestBed.inject(HttpTestingController);
      oauth = TestBed.inject(OAuthService) as ListeningOAuthService;
      oauth.configure({
        clientId: 'web-app',
        redirectUri: `${ORIGIN}/`,
        silentRefreshRedirectUri: REDIRECT,
        tokenEndpoint: TOKEN_ENDPOINT,
        responseType: 'code',
        requireHttps: false,
        disablePKCE: false,
      });
      // What the authorize request would have stored: the nonce `state` carries back, which the
      // library's own check compares, and the PKCE verifier the exchange must send, as
      // `WebAuthStrategy` keeps PKCE on.
      const storage = new MemoryStorage();
      storage.setItem('nonce', 'n1');
      storage.setItem('PKCE_verifier', 'v1');
      oauth.setStorage(storage);
      oauth.listen();
    });

    afterEach(() => {
      oauth.stopListening();
      controller.verify();
    });

    const deliver = (message: unknown) =>
      window.dispatchEvent(new MessageEvent('message', { data: message, origin: ORIGIN }));

    it('exchanges the code the query carried, at the redirect the library chose', async () => {
      deliver(postedOn(`${REDIRECT}?state=n1&code=c1`).message);

      const request = await vi.waitFor(() => controller.expectOne(TOKEN_ENDPOINT));
      const body = request.request.body as HttpParams;
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('c1');
      expect(body.get('code_verifier')).toBe('v1');
      expect(body.get('redirect_uri')).toBe(REDIRECT);
      request.flush({ error: 'invalid_grant' }, { status: 400, statusText: 'Bad Request' });
    });

    it.each([
      ['the bare hash the page used to post', ''],
      ['the query without its leading #', 'state=n1&code=c1'],
    ])('exchanges nothing for %s, which is the #373 time-out', async (_, message) => {
      deliver(message);

      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.expectNone(TOKEN_ENDPOINT);
    });
  });
});

/** Opens the library's protected listener, which `silentRefresh()` otherwise installs. */
@Injectable()
class ListeningOAuthService extends OAuthService {
  listen(): void {
    this.setupSilentRefreshEventListener();
  }

  stopListening(): void {
    this.removeSilentRefreshEventListener();
  }
}
