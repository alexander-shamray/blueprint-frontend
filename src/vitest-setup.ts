// Ionic's web components are custom elements; registering them once here keeps
// every component test from doing it, and keeps a page test from silently
// rendering an empty <ion-content> that asserts nothing.
import { defineCustomElements } from '@ionic/core/loader';

defineCustomElements(window);
