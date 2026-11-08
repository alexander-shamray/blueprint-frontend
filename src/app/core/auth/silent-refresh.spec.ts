import { HttpParams, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { OAuthService, provideOAuthClient } from 'angular-oauth2-oidc';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

  describe('what it posts, read by the library as its silent-refresh listener reads it', () => {
    let controller: HttpTestingController;

    afterEach(() => controller.verify());

    it("reaches angular-oauth2-oidc's code exchange with the code the query carried", async () => {
      TestBed.configureTestingModule({
        providers: [provideHttpClient(), provideHttpClientTesting(), provideOAuthClient()],
      });
      controller = TestBed.inject(HttpTestingController);
      const oauth = TestBed.inject(OAuthService);
      oauth.configure({
        clientId: 'web-app',
        redirectUri: `${ORIGIN}/`,
        tokenEndpoint: 'http://idp.test/token',
        responseType: 'code',
        requireHttps: false,
        disablePKCE: true,
      });

      const { message } = postedOn(`${REDIRECT}?state=s1&code=c1`);
      expect(typeof message).toBe('string');
      // The listener hands the message on as `customHashFragment`; the nonce in `state` is the
      // library's own check, out of this page's reach, so it is switched off here.
      const exchange = oauth.tryLoginCodeFlow({
        customHashFragment: String(message),
        preventClearHashAfterLogin: true,
        disableNonceCheck: true,
        customRedirectUri: REDIRECT,
      });

      const request = await vi.waitFor(() => controller.expectOne('http://idp.test/token'));
      const body = request.request.body as HttpParams;
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('c1');
      expect(body.get('redirect_uri')).toBe(REDIRECT);

      request.flush({ error: 'invalid_grant' }, { status: 400, statusText: 'Bad Request' });
      await expect(exchange).rejects.toBeDefined();
    });
  });
});
