import { Signal } from '@angular/core';

/** The claims the client reads, and nothing else the token carries. */
export interface CurrentUser {
  readonly username: string;
  readonly subject: string;
  /**
   * The `permission` claim: multivalued String, mapped from `commerce-api`
   * client roles by the realm's protocol mapper. Claims, not roles — the
   * client reads exactly what RequireClaim reads (spec §2.1, §4.3).
   */
  readonly permissions: readonly string[];
  /** `exp`, in epoch seconds. Read from the token so a realm change moves the schedule. */
  readonly expiresAt: number;
}

/**
 * One interface, two implementations, one factory (spec §4). Nothing in the
 * application asks which platform it is on; auth.providers.ts asks once.
 * Abstract class rather than an InjectionToken plus interface, because Angular
 * can then use the class itself as the token and a component's constructor
 * reads as the dependency it is.
 */
export abstract class AuthService {
  /**
   * Called once by the application initialiser. On the web it completes a
   * pending code flow; on native it restores a refresh token from secure
   * storage. It is on the interface rather than on each strategy because the
   * initialiser must call it without knowing which one it got — a cast there
   * would defeat the one-interface property §4 rests on.
   *
   * Must never reject. `provideAuth()` (auth.providers.ts) hands this promise
   * to `provideAppInitializer`, which Angular awaits before finishing
   * bootstrap — a rejection there aborts the whole app, not just the
   * signed-in parts of it, and `main.ts`'s `bootstrapApplication(...).catch`
   * only logs the failure rather than recovering from it. The identity
   * provider being unreachable (WebAuthStrategy: Keycloak down) or a stored
   * credential being invalid (the native strategy's equivalent, against
   * secure storage) is exactly the kind of failure an implementation must
   * catch, record for itself, and resolve past — the caller finds out by
   * staying signed out, not by this rejecting.
   */
  abstract initialize(): Promise<void>;
  abstract signIn(): Promise<void>;
  abstract signOut(): Promise<void>;
  /** Null when signed out. Callers attach it; nobody stores it. */
  abstract accessToken(): string | null;
  abstract user(): Signal<CurrentUser | null>;
  abstract hasPermission(name: string): boolean;
  /**
   * True on the web, where a reload signs the user out because the realm
   * issues no refresh token and nothing is written to storage. The account
   * page states the consequence rather than hiding it (spec §5.6).
   */
  abstract readonly sessionEndsOnReload: boolean;
}
