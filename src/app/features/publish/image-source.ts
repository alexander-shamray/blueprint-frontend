import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';

/**
 * Where Publish gets an image from: one interface, in the way `AuthService`
 * has two strategies behind one. The page asks for a file and does not know
 * whether a file input, a camera or a photo library answered.
 *
 * One strategy so far. `WebImageSource` serves the web build, and Android
 * too: Capacitor's WebView answers a file input with the system picker. The
 * `@capacitor/camera` strategy, and the camera and photo permissions it needs
 * in `AndroidManifest.xml` and `Info.plist`, are a change to `package.json`
 * and the native trees, which `/ship` may not edit; #108 stays open for them.
 */
@Injectable({ providedIn: 'root', useFactory: () => inject(WebImageSource) })
export abstract class ImageSource {
  /**
   * Why this platform offers no image, said where the chooser would be, or
   * null where it does offer one. A stated outcome rather than a control that
   * does nothing, or worse.
   */
  abstract readonly unavailable: string | null;

  /** The file the user chose, or null when they dismissed the chooser. */
  abstract pick(): Promise<File | null>;
}

/**
 * A file input that is never rendered. Attached for the length of the choice,
 * because a WebView may not open a chooser for an input outside the document,
 * and removed however the choice ends.
 *
 * `accept` is `image/*` and not the BFF's closed list: the list is the
 * server's, which answers anything outside it with a 400 keyed `ContentType`
 * that the form shows under the image (#82). A second copy here would be the
 * copy that drifts.
 *
 * A browser with no `cancel` event leaves a dismissed chooser's promise
 * pending. Nothing waits on it: the page shows no state for a choice in
 * progress, so an unanswered pick is a pick that did nothing.
 */
@Injectable({ providedIn: 'root' })
export class WebImageSource extends ImageSource {
  private readonly document = inject(DOCUMENT);

  /**
   * Not on iOS. WKWebView offers its camera from a file input, and with no
   * `NSCameraUsageDescription` in `Info.plist` the system ends the app when
   * the seller chooses it. Until the native strategy brings that key (#108),
   * the iOS app says so rather than offering the choice that crashes it.
   */
  readonly unavailable =
    Capacitor.getPlatform() === 'ios' ? 'Adding an image is not available in the iOS app yet.' : null;

  pick(): Promise<File | null> {
    if (this.unavailable !== null) return Promise.resolve(null);

    const input = this.document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.hidden = true;
    this.document.body.append(input);

    return new Promise<File | null>((resolve) => {
      const settle = (file: File | null) => {
        input.remove();
        resolve(file);
      };
      input.addEventListener('change', () => settle(input.files?.item(0) ?? null), { once: true });
      input.addEventListener('cancel', () => settle(null), { once: true });
      input.click();
    });
  }
}
