import { CurrentUser } from './auth.service';

/**
 * Decodes the access token's claims. It does NOT verify the signature: every
 * host validates its own tokens (the backend's §11.2), and a client that
 * checked one would be asserting something it cannot enforce. What is read
 * here decides what is shown, never what is allowed — the guard hides, the
 * backend decides (spec §4.3).
 */
export function decodeUser(accessToken: string): CurrentUser | null {
  const segments = accessToken.split('.');
  if (segments.length !== 3) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(segments[1])) as Record<string, unknown>;

    return {
      username: String(payload['preferred_username'] ?? ''),
      subject: String(payload['sub'] ?? ''),
      permissions: toPermissions(payload['permission']),
      expiresAt: Number(payload['exp'] ?? 0),
    };
  } catch {
    return null;
  }
}

/**
 * Keycloak's multivalued mapper emits an array for two or more values and a
 * bare string for one. Spreading the scalar case would turn "orders:write"
 * into eleven single-character permissions, none of which match anything — a
 * button that silently stays hidden for the user who has exactly one grant.
 */
function toPermissions(claim: unknown): readonly string[] {
  if (Array.isArray(claim)) return claim.map(String);
  if (typeof claim === 'string' && claim.length > 0) return [claim];
  return [];
}

function base64UrlDecode(segment: string): string {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    segment.length + ((4 - (segment.length % 4)) % 4),
    '=',
  );

  // decodeURIComponent/escape round-trip, so a username outside Latin-1
  // survives. atob alone mangles it.
  return decodeURIComponent(
    Array.from(atob(padded), (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''),
  );
}
