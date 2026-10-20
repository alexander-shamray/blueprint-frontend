import { describe, expect, it } from 'vitest';
import { serviceWorkerEnabled } from './service-worker';

describe('serviceWorkerEnabled', () => {
  it('registers in a production web build', () => {
    expect(serviceWorkerEnabled(false, false)).toBe(true);
  });

  it('does not register in a development build', () => {
    expect(serviceWorkerEnabled(true, false)).toBe(false);
  });

  it('does not register in a native build, production or not', () => {
    expect(serviceWorkerEnabled(false, true)).toBe(false);
    expect(serviceWorkerEnabled(true, true)).toBe(false);
  });
});
