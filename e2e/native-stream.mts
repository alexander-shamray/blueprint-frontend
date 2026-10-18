/**
 * #243: reads the order status stream from inside the app's Android WebView,
 * where the unit suite cannot reach. Not a Playwright spec — nothing in CI has
 * an emulator — but a measurement `docs/testing.md` (*The emulator round
 * trip*) says how to repeat: the app installed and running, its WebView's
 * DevTools socket forwarded to `tcp:9222`, the backend's stack up. Then
 *
 *   node e2e/native-stream.mts [orderId]
 *
 * places an order for the `demo` user when no id is given, opens
 * `GET /bff/v1/orders/{id}/events` from the WebView's own origin, and prints
 * when each chunk arrived. It opens the stream twice: the second time with
 * the first's last id as `Last-Event-ID`, the request a reconnect makes.
 *
 * What it answers is the transport: `HttpClient` here is the XHR backend
 * (`app.config.ts` asks for no `withFetch()`), whose download progress event
 * carries `responseText` as `partialText`, so an XHR with a progress
 * listener is what `OrdersApi.stream` stands on. A WebView that buffers the
 * response shows every chunk at the stream's end instead of as it was written.
 */
import { environment } from '../src/app/core/config/environment.android.ts';
import { GATEWAY, KEYCLOAK } from './helpers.ts';

const DEVTOOLS = 'http://localhost:9222';

interface Chunk {
  readonly ms: number;
  readonly readyState: number;
  readonly length: number;
  readonly statuses: readonly string[];
  readonly keepAlives: number;
}

interface Run {
  readonly origin: string;
  readonly status: number;
  readonly endMs: number;
  readonly ids: readonly string[];
  readonly chunks: readonly Chunk[];
  readonly notFound: number;
}

async function demoToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: 'web-app',
    username: 'demo',
    password: 'demo',
  });
  const response = await fetch(`${KEYCLOAK}/realms/commerce/protocol/openid-connect/token`, {
    method: 'POST',
    body,
  });
  if (!response.ok) throw new Error(`Keycloak refused the demo user a token: ${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

/** The newest product, which the smoke's own publishes keep out of stock: one placed, one cancelled. */
async function placeOrder(token: string): Promise<string> {
  const page = (await (await fetch(`${GATEWAY}/api/v1/catalog/products?limit=1`)).json()) as {
    items: { productId: string; currency: string }[];
  };
  const product = page.items[0];
  if (product === undefined) throw new Error('the catalogue is empty; publish a product first');

  const response = await fetch(`${GATEWAY}/api/v1/orders`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: crypto.randomUUID(),
      items: [{ productId: product.productId, quantity: 1 }],
      shippingAddress: {
        line1: '1 Test Street',
        line2: null,
        city: 'Testville',
        postalCode: '12345',
        country: 'DE',
      },
      currency: product.currency,
    }),
  });
  if (!response.ok) throw new Error(`placing the order failed: ${response.status}`);
  return (await response.json()) as string;
}

/**
 * Serialised into the WebView and run there, so it may close over nothing.
 * A 404 is the read not having recorded the order yet (§12), and is retried.
 */
function inWebView(url: string, token: string, lastEventId: string | null): Promise<Run> {
  const open = () =>
    new Promise<Omit<Run, 'notFound'>>((resolve) => {
      const xhr = new XMLHttpRequest();
      const start = performance.now();
      const chunks: Chunk[] = [];
      xhr.open('GET', url);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('Accept', 'text/event-stream');
      if (lastEventId !== null) xhr.setRequestHeader('Last-Event-ID', lastEventId);
      xhr.onprogress = () => {
        const text = xhr.responseText;
        chunks.push({
          ms: Math.round(performance.now() - start),
          readyState: xhr.readyState,
          length: text.length,
          statuses: [...text.matchAll(/"status":"([a-z_]+)"/g)].map((match) => match[1]),
          keepAlives: (text.match(/^: keep-alive$/gm) ?? []).length,
        });
      };
      xhr.onloadend = () =>
        resolve({
          origin: location.origin,
          status: xhr.status,
          endMs: Math.round(performance.now() - start),
          ids: [...xhr.responseText.matchAll(/^id: (.+)$/gm)].map((match) => match[1]),
          chunks,
        });
      xhr.send();
    });

  return (async () => {
    for (let notFound = 0; ; notFound++) {
      const run = await open();
      if (run.status !== 404 || notFound === 20) return { ...run, notFound };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  })();
}

async function webView(): Promise<{
  url: string;
  evaluate: (expression: string) => Promise<unknown>;
  close: () => void;
}> {
  const targets = (await (await fetch(`${DEVTOOLS}/json`)).json()) as {
    type: string;
    url: string;
    webSocketDebuggerUrl: string;
  }[];
  const target = targets.find((candidate) => candidate.type === 'page');
  if (target === undefined) {
    throw new Error(`no WebView page behind ${DEVTOOLS}; is the app running?`);
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const pending = new Map<number, (reply: unknown) => void>();
  socket.onmessage = (message) => {
    const reply = JSON.parse(String(message.data)) as { id: number };
    pending.get(reply.id)?.(reply);
    pending.delete(reply.id);
  };

  let next = 0;
  return {
    url: target.url,
    evaluate: (expression) =>
      new Promise((resolve) => {
        const id = ++next;
        pending.set(id, resolve);
        socket.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        );
      }),
    close: () => socket.close(),
  };
}

const token = await demoToken();
const orderId = process.argv[2] ?? (await placeOrder(token));
const page = await webView();
const url = `${environment.gatewayBaseUrl}/bff/v1/orders/${orderId}/events`;

async function measure(lastEventId: string | null): Promise<Run> {
  const args = [url, token, lastEventId].map((value) => JSON.stringify(value)).join(', ');
  const reply = (await page.evaluate(`(${inWebView.toString()})(${args})`)) as {
    result: { result?: { value?: Run }; exceptionDetails?: unknown };
  };
  const run = reply.result.result?.value;
  if (run === undefined) throw new Error(`the WebView did not answer: ${JSON.stringify(reply)}`);
  return run;
}

console.log(JSON.stringify({ page: page.url, orderId }));
const first = await measure(null);
console.log('opened', JSON.stringify(first, null, 1));
const resumed = await measure(first.ids.at(-1) ?? null);
console.log('resumed', JSON.stringify(resumed, null, 1));
page.close();
