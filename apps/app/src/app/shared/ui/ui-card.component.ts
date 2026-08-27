import { Component } from '@angular/core';

/**
 * La superficie de la casa.
 *
 * Antes cada pantalla se dibujaba su propia tarjeta: `.hero`, `.c`, `.pos`,
 * `.bot`, `.row`, `.scard`, `.plan` y `.metrics` eran la misma caja repetida
 * con radios de 12, 13, 14, 15 y 16 px en siete hojas SCSS distintas.
 *
 *   tone="hero"  destaca la cifra principal de una pantalla (mesh de marca)
 *   tone="inset" superficie dentro de otra tarjeta
 *   flush        sin padding, para cuando la tarjeta contiene filas propias
 *
 * `flush` NO significa «sin margen»: significa que el relleno lo pone cada
 * fila de dentro, y esas filas usan la misma escala (--space-4 al lado) para
 * que el texto de una tarjeta suelta y el de una tarjeta con filas caigan
 * sobre la misma vertical.
 */
@Component({
  selector: 'ui-card',
  standalone: true,
  template: '<ng-content />',
  styles: [
    `
      :host {
        display: block;
        /* Sin esto, una tarjeta que sea celda de una rejilla no baja de su
           tamano intrinseco y se sale de su columna arrastrando el borde. */
        min-width: 0;
        background: var(--surface-1);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        padding: var(--space-4);
        /* Red de seguridad contra lo que motivo este cambio: dentro de una
           tarjeta hay cifras, direcciones y codigos de orden que son UNA sola
           palabra sin sitio donde partir. Sin esto el navegador los deja
           desbordar, y el texto acaba pisando el borde de la tarjeta o
           saliendose por el lado. El valor «anywhere» ademas hace que la caja
           pueda encogerse de verdad en una rejilla; «break-word» no. El texto
           corriente sigue partiendo por los espacios primero. */
        overflow-wrap: anywhere;
      }

      :host([flush]) {
        padding: 0;
        overflow: hidden;
      }

      /* El mesh violeta-cian solo aparece aqui. Si estuviera en cada tarjeta
         competiria con el rojo y el verde del resultado, que es lo que el
         usuario ha abierto la app para mirar. */
      :host([tone='hero']) {
        border-radius: var(--radius-lg);
        border-color: var(--border-strong);
        padding: 22px 20px 20px;
        background:
          radial-gradient(120% 105% at 12% 0%, rgba(var(--brand-rgb), 0.32), transparent 58%),
          radial-gradient(95% 95% at 96% 8%, rgba(var(--brand-2-rgb), 0.18), transparent 60%),
          var(--surface-1);
      }

      :host([tone='inset']) {
        background: var(--surface-2);
        border-color: transparent;
        border-radius: var(--radius-sm);
        padding: var(--space-3) var(--space-4);
      }
    `,
  ],
})
export class UiCardComponent {}
