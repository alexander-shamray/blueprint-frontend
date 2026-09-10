import { Component } from '@angular/core';
import { IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular';

@Component({
  selector: 'app-order-placed',
  standalone: true,
  imports: [IonContent, IonHeader, IonTitle, IonToolbar],
  template: `
    <ion-header><ion-toolbar><ion-title>Order placed</ion-title></ion-toolbar></ion-header>
    <ion-content></ion-content>
  `,
})
export class OrderPlacedPage {}
