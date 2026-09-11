import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { ProductSummary } from '@core/api/types';
import { CartPersistence } from './cart.persistence';

/**
 * The backend has no cart, so the cart is client state (spec §3). `amount` is
 * the LISTING price, and the cart labels it as such: the quote is the price
 * that counts, and it comes from the BFF.
 */
export interface CartLine {
  readonly productId: string;
  readonly name: string;
  readonly amount: number;
  readonly currency: string;
  readonly quantity: number;
}

/**
 * In core rather than in a feature, because two features share it — the
 * products page writes and the cart and checkout pages read. That sharing is
 * the whole reason spec §3 puts it here instead of under features/cart.
 */
@Injectable({ providedIn: 'root' })
export class CartStore {
  // The exact array the signal is constructed with, kept by reference so the
  // effect below can recognise "nothing has actually happened yet" and
  // refuse to write it. Under zoneless change detection the persistence
  // effect is SCHEDULED at construction, not run there — its first flush can
  // land while `restore()` is still awaiting `persistence.read()`. At that
  // moment `state()` is still this exact array, so without this guard the
  // flush writes `[]` over whatever real cart storage was holding, `restore`
  // then overwrites the in-memory state with the real cart a moment later,
  // and the screen ends up correct while storage is gone — silently, until
  // the NEXT restore reads the now-empty storage back.
  //
  // The distinction that matters is "not yet read from storage" versus
  // "emptied by the user": both are an empty array, and only object identity
  // tells them apart. `clear()` sets a FRESH `[]` literal, a different
  // object from this one, so a genuinely emptied cart still persists — the
  // guard below only ever matches the one array the store was born with.
  //
  // This is deliberately not a `hydrated` boolean flipped by `restore()`.
  // Two reasons. First, the flag-in-a-finally-block version of that idea
  // does not work at all: the effect is scheduled, not synchronous, so by
  // the time it runs, a boolean set and then reset within `restore()` has
  // already gone back to its "handled" state and the guard never fires — it
  // is a structurally no-op guard, not a race-prone one. Second, even a
  // correctly-wired boolean is worse than this: it gates persistence on
  // "was restore() ever called", so any CartStore whose caller forgets to
  // call `restore()` — including, quietly, a future test — would stop
  // persisting entirely with no error and no signal that anything is wrong.
  // Reference identity has no such failure mode: it answers a narrower
  // question ("is this literally the value nothing has touched yet?") that
  // stays correct whether or not `restore()` is ever called.
  private static readonly INITIAL: readonly CartLine[] = [];

  private readonly persistence = inject(CartPersistence);
  private readonly state = signal<readonly CartLine[]>(CartStore.INITIAL);
  /**
   * Bumped by every mutation that actually changes the basket, and by
   * `restore()`, which replaces it wholesale.
   *
   * This exists so that "the basket changed" is a fact about the STORE rather
   * than about the screen that happened to change it. Quote invalidation used
   * to hang off `CartPage`'s own steppers and currency select, which meant
   * `ProductsPage.addToCart()` — a mutation from a different feature, calling
   * `add()` here directly — left a quote standing that was priced for a
   * basket the customer no longer had. A quote whose whole job is telling
   * someone what they will pay had told them something false.
   *
   * A version rather than a subscription, for the reason `CatalogRefresh`
   * uses one: an observer that has to be wired up is an observer someone can
   * forget to wire up, whereas a number that only ever goes forward lets a
   * holder of a quote record what it was quoted for and compare. Readers are
   * `CheckoutHandoff` (which the checkout route guard consults) and
   * `CartPage` (which decides whether Checkout is enabled at all) — and
   * because both compare against the SAME counter, they cannot disagree about
   * whether a quote is still good.
   *
   * Private-writable, public `asReadonly()`: this repo's convention for state
   * one class owns and others may only observe — `CartStore.lines` itself,
   * `CommandIdentity.current`, `CatalogRefresh.current`.
   */
  private readonly versionState = signal(0);
  // Set to the exact array `restore()` just handed to `state.set`, so the
  // effect below can recognise "this run is the echo of a restore" and
  // suppress the write-back. A boolean flag cleared synchronously in a
  // `finally` block does NOT work here: under zoneless change detection the
  // effect is scheduled, not run synchronously on signal write, so by the
  // time it runs a boolean would already have been reset back to false and
  // the guard would never fire. Reference identity survives that delay
  // regardless of how many ticks pass before the effect is flushed.
  private pendingRestore: readonly CartLine[] | null = null;

  readonly lines = this.state.asReadonly();
  readonly version = this.versionState.asReadonly();
  readonly count = computed(() => this.state().reduce((total, line) => total + line.quantity, 0));
  readonly isEmpty = computed(() => this.state().length === 0);

  constructor() {
    effect(() => {
      const lines = this.state();
      // Still the array the store was born with: nothing has been read from
      // storage and nothing has been mutated, so there is nothing to write.
      // Writing it anyway is exactly the data-loss bug this guard exists to
      // close — see the comment on `INITIAL` above for the full mechanism.
      if (lines === CartStore.INITIAL) return;
      // Not the echo of a restore: writing back what was just read is a
      // wasted round trip, and on a slow device it can race the read it
      // followed.
      if (lines === this.pendingRestore) {
        this.pendingRestore = null;
        return;
      }
      void this.persistence.write(lines);
    });
  }

  async restore(): Promise<void> {
    const lines = await this.persistence.read();
    this.pendingRestore = lines;
    this.state.set(lines);
    // A restore replaces the basket wholesale, so anything priced for what
    // was in memory a moment ago is priced for a different basket. Bumping
    // here is belt-and-braces rather than load-bearing — `app.config.ts`
    // blocks bootstrap on this promise, so no quote can exist yet — but the
    // version's meaning is "the lines changed", and they did.
    this.versionState.update((n) => n + 1);
  }

  /**
   * The one path every mutator takes, so that "the basket changed" and "the
   * version moved" cannot come apart — a mutator that wrote `state` directly
   * would leave a stale quote looking fresh, which is the whole defect the
   * version exists to close.
   *
   * Returning the same array means nothing happened: `setQuantity` does that
   * for a product the cart no longer holds, and neither the persistence
   * effect nor a quote should be disturbed by a call that changed nothing.
   */
  private mutate(update: (lines: readonly CartLine[]) => readonly CartLine[]): void {
    const before = this.state();
    const after = update(before);
    if (after === before) return;

    this.state.set(after);
    this.versionState.update((n) => n + 1);
  }

  /**
   * None of the mutators below — this one, `setQuantity`, `remove`,
   * `clear` — defend against being called before `restore()` has resolved.
   * If `state()` is still `CartStore.INITIAL` when one of them fires, the
   * result is a new array that is no longer identical to `INITIAL`, so the
   * persistence effect above no longer suppresses the write: the mutation
   * persists over whatever real cart storage is holding, unread. That is
   * the same clobber the `INITIAL` guard above exists to close — only
   * triggered by a genuine mutator call instead of the effect's own
   * spurious first flush, and the guard does not and cannot distinguish
   * the two.
   *
   * This is benign today ONLY because `app.config.ts`'s
   * `provideAppInitializer(() => inject(CartStore).restore())` RETURNS the
   * promise `restore()` produces. Angular blocks application bootstrap on a
   * returned initializer promise, so nothing renders — and so no mutator on
   * this class is reachable from the UI — until `restore()` has resolved.
   * If that provider is ever changed to invoke `restore()` without
   * returning its promise (fire-and-forget), this class gains no
   * protection of its own: a mutator reachable before `restore()` resolves
   * will silently overwrite real cart storage that was never read, with no
   * error and no signal anything went wrong.
   *
   * Not fixed here by deferring writes until hydration (queuing and
   * replaying mutations for a code path that, given the constraint above,
   * cannot currently occur) or by a `hydrated` boolean gate (rejected
   * earlier for the same reason `INITIAL` uses identity instead of a flag:
   * it would make a `CartStore` whose caller forgets to call `restore()`
   * — including, quietly, a future test — stop persisting entirely, with
   * no error and no signal that anything is wrong).
   */
  add(product: ProductSummary): void {
    this.mutate((lines) => {
      const existing = lines.find((line) => line.productId === product.productId);

      return existing
        ? lines.map((line) =>
            line.productId === product.productId ? { ...line, quantity: line.quantity + 1 } : line,
          )
        : [
            ...lines,
            {
              productId: product.productId,
              name: product.name,
              amount: product.amount,
              currency: product.currency,
              quantity: 1,
            },
          ];
    });
  }

  setQuantity(productId: string, quantity: number): void {
    this.mutate((lines) => {
      // Both .map() and .filter() allocate a new array even when nothing
      // matches, and the persistence effect writes on every new array this
      // signal takes regardless of whether its contents actually changed
      // (see the effect above — it only special-cases the two arrays it was
      // born with or just restored from, not "changed" in general). Without
      // this early return, a call for a productId no longer in the cart —
      // plausible from a UI still holding a stale reference — would persist
      // unchanged content on every call. Wasteful, not data-lossy, but worth
      // skipping since nothing downstream needs the reference to change when
      // nothing did.
      if (!lines.some((line) => line.productId === productId)) return lines;

      // Zero and negative both remove. A stepper that can reach zero is the
      // ordinary way a line is deleted, and PlaceOrderItem has no meaning at
      // a quantity of nought.
      return quantity <= 0
        ? lines.filter((line) => line.productId !== productId)
        : lines.map((line) => (line.productId === productId ? { ...line, quantity } : line));
    });
  }

  remove(productId: string): void {
    this.setQuantity(productId, 0);
  }

  clear(): void {
    // Through `mutate` like every other mutator, so an emptied basket moves
    // the version too: a quote priced for the basket that has just been spent
    // (CheckoutPage.spendQuote) or emptied must not survive it.
    this.mutate(() => []);
  }
}
