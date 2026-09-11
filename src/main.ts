import { bootstrapApplication } from '@angular/platform-browser';
import { addIcons } from 'ionicons';
import {
  alertCircleOutline,
  cartOutline,
  cloudUploadOutline,
  gridOutline,
  personOutline,
} from 'ionicons/icons';
import { appConfig } from './app/app.config';
import { App } from './app/app';

/**
 * The standalone Ionic build that `@ionic/angular`'s package export map
 * resolves to (see app.config.ts) tree-shakes icon SVGs: an `<ion-icon
 * name="...">` renders nothing unless the icon was registered here first —
 * there is no lazy network fetch to fall back on. One global registration,
 * done once before bootstrap, covers every `<ion-icon>` in the tree: the
 * four in tabs.page.ts (grid/cart/cloud-upload/person-outline) and
 * alert-circle-outline in shared/error-banner.component.ts. Every screen
 * task after this one that adds an `<ion-icon>` must add its icon here too.
 */
addIcons({
  alertCircleOutline,
  cartOutline,
  cloudUploadOutline,
  gridOutline,
  personOutline,
});

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
