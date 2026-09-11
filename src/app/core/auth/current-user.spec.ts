import { describe, expect, it } from 'vitest';
import { decodeUser } from './current-user';

/** Builds an unsigned JWT. The client never verifies a signature — the platform does. */
function token(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.signature`;
}

describe('decodeUser', () => {
  it('reads preferred_username, sub, permission and exp', () => {
    const user = decodeUser(
      token({
        preferred_username: 'demo',
        sub: '00000000-0000-0000-0000-000000000001',
        permission: ['catalog:write', 'orders:write', 'orders:cancel'],
        exp: 1_800_000_300,
      }),
    );

    expect(user).toEqual({
      username: 'demo',
      subject: '00000000-0000-0000-0000-000000000001',
      permissions: ['catalog:write', 'orders:write', 'orders:cancel'],
      expiresAt: 1_800_000_300,
    });
  });

  it('treats a single-valued permission claim as one permission', () => {
    // Keycloak collapses a multivalued claim to a scalar when there is one
    // value, so the browser user holding exactly one permission would
    // otherwise decode as a string being spread into characters.
    expect(decodeUser(token({ preferred_username: 'x', sub: 's', permission: 'orders:write', exp: 1 }))
      ?.permissions).toEqual(['orders:write']);
  });

  it('yields an empty permission list when the claim is absent', () => {
    // The `browser` user holds no client roles, so the mapper emits nothing.
    expect(decodeUser(token({ preferred_username: 'browser', sub: 's', exp: 1 }))?.permissions)
      .toEqual([]);
  });

  it('returns null for a token that is not a JWT', () => {
    expect(decodeUser('not-a-token')).toBeNull();
  });
});
