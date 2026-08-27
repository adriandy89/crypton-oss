import { Component } from '@angular/core';

/**
 * Franja que avisa de que se está mirando testnet.
 *
 * Se monta UNA vez, en `AppComponent`, encima del `ion-router-outlet`. No es un
 * atajo por comodidad: en esta app no hay cabecera compartida —cada pantalla
 * declara su propio `ion-header`— así que un distintivo dentro de la barra
 * habría que repetirlo en catorce sitios y una pantalla nueva nacería sin él.
 * Aquí es imposible que falte en ninguna.
 *
 * Ocupa alto de verdad en lugar de flotar por encima: superpuesta taparía el
 * título de cada pantalla, y una franja que tapa contenido acaba tratándose
 * como ruido a los dos minutos.
 */
@Component({
  selector: 'ui-network-banner',
  standalone: true,
  template: `<span class="dot"></span>TESTNET · fondos de prueba, sin valor real`,
  styles: [
    `
      :host {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        flex-shrink: 0;
        height: 26px;
        color: var(--signal-warn);
        background: rgba(var(--signal-warn-rgb), 0.14);
        border-bottom: 1px solid rgba(var(--signal-warn-rgb), 0.28);
        font-family: var(--font-ui);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.06em;
      }

      .dot {
        width: 6px;
        height: 6px;
        border-radius: var(--radius-pill);
        background: var(--signal-warn);
      }
    `,
  ],
})
export class UiNetworkBannerComponent {}
