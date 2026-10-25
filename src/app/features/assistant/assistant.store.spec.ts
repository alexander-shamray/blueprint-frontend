import { Component, LOCALE_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Preferences } from '@capacitor/preferences';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@core/api/types';
import { AssistantClient } from '@core/assistant/assistant-client';
import { AssistantTransport } from '@core/assistant/assistant-transport';
import { OpenConversation } from '@core/assistant/protocol';
import { FakeHost, json, settle } from '@core/assistant/testing/assistant-fakes';
import { AuthService, CurrentUser } from '@core/auth/auth.service';
import { AssistantStore, CLIENT, CONVERSATION_KEY, NOTICE_KEY } from './assistant.store';

const BASE = '/bff/v1/assistant';
const ON = { enabled: true, provider: 'anthropic', model: 'm', reason: null };
const OFF = { enabled: false, provider: null, model: null, reason: 'off' };

@Component({ selector: 'app-blank', standalone: true, template: '' })
class BlankPage {}

function customer(subject: string, permissions: readonly string[] = []): CurrentUser {
  return { username: subject, subject, permissions, expiresAt: 0 };
}

function setup(options: { status?: object; user?: CurrentUser | null } = {}) {
  TestBed.resetTestingModule();
  const host = new FakeHost()
    .on('GET', /\/assistant$/, () => json(options.status ?? ON))
    .on('POST', /\/conversations$/, () => json({ id: 'c1' }))
    .on('POST', /\/turns$/, () => new Response(null, { status: 202 }))
    .on('POST', /\/tool-results$/, () => new Response(null, { status: 204 }));
  const user = signal<CurrentUser | null>(
    options.user === undefined ? customer('s1') : options.user,
  );

  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        {
          path: 'tabs',
          children: [
            { path: 'cart', component: BlankPage },
            { path: 'orders/:id', component: BlankPage },
          ],
        },
      ]),
      { provide: LOCALE_ID, useValue: 'en-GB' },
      {
        provide: AuthService,
        useValue: {
          user: () => user,
          hasPermission: (name: string) => user()?.permissions.includes(name) ?? false,
        },
      },
      {
        provide: AssistantTransport,
        useValue: { client: () => new AssistantClient(BASE, host.fetch, host.openStream) },
      },
    ],
  });

  const store = TestBed.inject(AssistantStore);
  TestBed.tick();
  return { store, host, user };
}

function statusReads(host: FakeHost): number {
  return host.requests.filter((r) => r.method === 'GET' && r.url === BASE).length;
}

describe('AssistantStore', () => {
  beforeEach(async () => {
    sessionStorage.clear();
    await Preferences.clear();
  });

  afterEach(async () => {
    sessionStorage.clear();
    await Preferences.clear();
  });

  it('reads nothing and offers nothing while nobody is signed in', async () => {
    const { store, host } = setup({ user: null });
    await settle();

    expect(statusReads(host)).toBe(0);
    expect(store.available()).toBe(false);
  });

  it('is available once a signed-in read says enabled, and names the provider', async () => {
    const { store, host } = setup();
    await settle();

    expect(statusReads(host)).toBe(1);
    expect(store.available()).toBe(true);
    expect(store.provider()).toBe('anthropic');
  });

  it('is not available when the BFF has the assistant off, or cannot say', async () => {
    const off = setup({ status: OFF });
    await settle();
    expect(off.store.available()).toBe(false);

    const failing = setup();
    failing.host.on('GET', /\/assistant$/, () => json({}, 401));
    failing.user.set(customer('s2'));
    TestBed.tick();
    await settle();
    expect(failing.store.available()).toBe(false);
  });

  it('holds the first message until the notice is acknowledged, and remembers it', async () => {
    const { store, host } = setup();
    await settle();
    expect(store.noticePending()).toBe(true);

    await store.send('where is my order?');
    expect(host.requests.some((r) => r.url.endsWith('/turns'))).toBe(false);

    await store.acknowledgeNotice();
    expect(store.noticePending()).toBe(false);
    expect((await Preferences.get({ key: NOTICE_KEY })).value).toBe('anthropic');

    const again = setup();
    await settle();
    expect(again.store.noticePending()).toBe(false);
  });

  it('asks again when the provider is not the one the customer was told about', async () => {
    await Preferences.set({ key: NOTICE_KEY, value: 'another' });
    const { store } = setup();
    await settle();

    expect(store.noticePending()).toBe(true);
  });

  it("opens with the shop's client, locale, catalogue and tools, and sends the route", async () => {
    await Preferences.set({ key: NOTICE_KEY, value: 'anthropic' });
    const { store, host } = setup();
    await settle();
    await TestBed.inject(Router).navigateByUrl('/tabs/cart');

    await store.send('what is in my cart?');

    const opening = host.requests.find((r) => r.url.endsWith('/conversations'))
      ?.body as OpenConversation;
    expect(opening.client).toEqual(CLIENT);
    expect(opening.locale).toBe('en-GB');
    expect(opening.catalogue.map((e) => e.id)).not.toContain('publish');
    expect(opening.clientTools.map((t) => t.name)).toEqual([
      'open_product',
      'open_order',
      'open_cart',
      'open_page',
    ]);
    expect(host.requests.find((r) => r.url.endsWith('/turns'))?.body).toEqual({
      text: 'what is in my cart?',
      context: { route: '/tabs/cart' },
      locale: 'en-GB',
      hostOptions: null,
    });
    expect(sessionStorage.getItem(CONVERSATION_KEY)).toBe('c1');
  });

  it('lists Publish in the catalogue for a customer who may publish', async () => {
    await Preferences.set({ key: NOTICE_KEY, value: 'anthropic' });
    const { store, host } = setup({ user: customer('s1', [PERMISSIONS.catalogWrite]) });
    await settle();

    await store.send('how do I sell something?');

    const opening = host.requests.find((r) => r.url.endsWith('/conversations'))
      ?.body as OpenConversation;
    expect(opening.catalogue.map((e) => e.id)).toContain('publish');
  });

  it("redraws the tab's conversation when the signed-in customer returns", async () => {
    sessionStorage.setItem(CONVERSATION_KEY, 'c9');
    const { store, host, user } = setup({ user: null });
    host.on('GET', /\/conversations\/c9$/, () =>
      json({
        id: 'c9',
        items: [{ kind: 'operator', text: 'hello' }],
        running: false,
        lastEventId: 2,
        pendingCalls: [],
      }),
    );

    user.set(customer('s1'));
    TestBed.tick();
    await settle();

    expect(store.state().id).toBe('c9');
    expect(store.state().items).toEqual([{ kind: 'operator', text: 'hello' }]);
  });

  it('drops the conversation and the assistant on sign-out, asking the host nothing', async () => {
    await Preferences.set({ key: NOTICE_KEY, value: 'anthropic' });
    const { store, host, user } = setup();
    await settle();
    await store.send('hello');
    const asked = host.requests.length;

    user.set(null);
    TestBed.tick();
    await settle();

    expect(store.available()).toBe(false);
    expect(store.state().id).toBeNull();
    expect(sessionStorage.getItem(CONVERSATION_KEY)).toBeNull();
    expect(host.requests.length).toBe(asked);
  });

  it('drops a status read answered after the customer it was for signed out', async () => {
    const { store, host, user } = setup();
    // Signed out before the read's answer is taken.
    user.set(null);
    TestBed.tick();
    await settle();

    expect(statusReads(host)).toBe(1);
    expect(store.available()).toBe(false);
  });

  it('a UI tool opens the route and says so, so the panel can step aside', async () => {
    await Preferences.set({ key: NOTICE_KEY, value: 'anthropic' });
    const { store, host } = setup();
    await settle();
    await store.send('show my cart');
    host.stream.emit('client_tool_call', { callId: 'k1', name: 'open_cart', input: {} }, 1);
    await settle();

    expect(TestBed.inject(Router).url).toBe('/tabs/cart');
    expect(store.navigated()).toBe(1);
    expect(host.requests.find((r) => r.url.endsWith('/tool-results'))?.body).toEqual({
      callId: 'k1',
      ok: true,
      content: 'Opened /tabs/cart.',
    });
  });
});
