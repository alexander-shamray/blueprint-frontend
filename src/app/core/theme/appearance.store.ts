import { DOCUMENT } from '@angular/common';
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';

/** What the user chose: a sheet, or whichever the device is on. */
export const APPEARANCES = ['system', 'light', 'dark'] as const;
export type Appearance = (typeof APPEARANCES)[number];

/**
 * The Preferences key. On the web Preferences is localStorage under the group
 * prefix `CapacitorStorage.`, and `index.html`'s first-paint script reads it
 * from there by that full name, so the two must agree: a spec holds them to it.
 */
export const APPEARANCE_KEY = 'appearance';

/** The class on the root that Ionic's class-based dark palette is keyed on. */
export const DARK_CLASS = 'ion-palette-dark';

function isAppearance(value: unknown): value is Appearance {
  return typeof value === 'string' && (APPEARANCES as readonly string[]).includes(value);
}

/**
 * The appearance the user picked, kept in Capacitor Preferences and put on the
 * root element as Ionic's dark class (#92).
 *
 * "System" is this class asking the operating system's media query and
 * following it, and not the stylesheet doing so: the stylesheet is the
 * class-based palette, so a user who chose light on a dark device gets light.
 * `index.html` sets the class before first paint from the same stored value,
 * so a user who chose dark does not see a light flash while this starts.
 *
 * Preferences is not secret, and the cart sits beside it.
 */
@Injectable({ providedIn: 'root' })
export class AppearanceStore {
  private readonly document = inject(DOCUMENT);
  private readonly choiceState = signal<Appearance>('system');
  private readonly systemDarkState = signal(false);

  /** The user's choice, which is `system` until they make one. */
  readonly choice = this.choiceState.asReadonly();

  /** Whether the dark sheet is on: chosen, or the device's own while the choice is system. */
  readonly isDark = computed(
    () => this.choiceState() === 'dark' || (this.choiceState() === 'system' && this.systemDarkState()),
  );

  constructor() {
    const query = this.document.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
    if (query) {
      this.systemDarkState.set(query.matches);
      query.addEventListener('change', (event) => this.systemDarkState.set(event.matches));
    }

    effect(() => {
      this.document.documentElement.classList.toggle(DARK_CLASS, this.isDark());
    });
  }

  /**
   * Reads the stored choice, once, at start-up. A stored value that is not one
   * of the three, or no stored value, leaves `system`; a read that fails does
   * the same, because an appearance is never worth a start that does not happen.
   */
  async restore(): Promise<void> {
    try {
      const { value } = await Preferences.get({ key: APPEARANCE_KEY });
      if (isAppearance(value)) this.choiceState.set(value);
    } catch {
      // Left on system.
    }
  }

  /**
   * Applies the choice at once and keeps it. A write that fails costs the next
   * launch the choice and nothing more, so it is not allowed to fail this one.
   */
  async choose(appearance: Appearance): Promise<void> {
    this.choiceState.set(appearance);
    try {
      await Preferences.set({ key: APPEARANCE_KEY, value: appearance });
    } catch {
      // Applied for this session; the next launch starts on system.
    }
  }
}
