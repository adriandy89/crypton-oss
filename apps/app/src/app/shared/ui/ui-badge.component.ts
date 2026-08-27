import { Component, input } from '@angular/core';

export type BadgeTone = 'up' | 'down' | 'warn' | 'brand' | 'neutral';

/**
 * La pastilla de la casa.
 *
 * Antes cada pantalla se dibujaba la suya: `.sim`, `.net`, `.tag`, `.pill`,
 * `.count`, `.actual`, `.flag`, `.venue` y `.bots` eran la misma caja repetida
 * en ocho hojas SCSS con nueve geometrias distintas —relleno vertical de 1, 2,
 * 3, 4 y 5 px; tamanos de 9.5, 10, 10.5 y 11 px—. Dos etiquetas del mismo
 * significado salian con alturas distintas segun la pantalla.
 *
 * Lo que arregla, aparte de unificar:
 *
 *   1. INTERLINEADO. Ninguna de las nueve fijaba `line-height`, asi que cada
 *      pastilla heredaba el del parrafo que la contenia (1.4 en una lista, 1.6
 *      en un aviso). El mismo rotulo salia con dos alturas de caja y el texto
 *      descentrado. Aqui va `line-height: 1` y el centrado lo hace el flex.
 *   2. RELLENO VERTICAL. Con 1 o 2 px la altura de la mayuscula ocupaba casi
 *      toda la caja y las tildes y los rabos de las letras («simulación»)
 *      llegaban al borde. El minimo son 4 px.
 *   3. VERSALITAS. `letter-spacing` mete el hueco DESPUES de cada letra, la
 *      ultima incluida; con relleno simetrico la palabra se ve pegada a la
 *      izquierda. Se le descuenta al lado de cierre.
 *
 *   tone      up | down | warn | brand | neutral   — el color, que es semantico
 *   variant   soft (relleno tenue) | solid | outline
 *   size      md (por defecto) | sm
 *   caps      versalitas con espaciado, para etiquetas de una palabra
 *   square    radio de esquina en vez de pastilla, para etiquetas de dato
 */
@Component({
  selector: 'ui-badge',
  standalone: true,
  template: '<ng-content />',
  host: {
    '[attr.data-tone]': 'tone()',
    '[attr.data-variant]': 'variant()',
    '[attr.data-size]': 'size()',
  },
  styles: [
    `
      :host {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        flex-shrink: 0;
        box-sizing: border-box;
        min-height: 22px;
        padding: 5px 10px;
        border: 1px solid transparent;
        border-radius: var(--radius-pill);
        font-family: var(--font-ui);
        font-size: 11px;
        font-weight: 700;
        line-height: 1;
        white-space: nowrap;
      }

      :host([data-size='sm']) {
        min-height: 19px;
        padding: 4px 8px;
        font-size: 10px;
      }

      :host([caps]) {
        text-transform: uppercase;
        letter-spacing: 0.07em;
        padding-inline-end: calc(10px - 0.07em);
      }

      :host([caps][data-size='sm']) {
        padding-inline-end: calc(8px - 0.07em);
      }

      :host([square]) {
        border-radius: var(--radius-xs);
      }

      /* ── Relleno tenue: el reparto por defecto ─────────────────────────── */
      :host([data-tone='up']) {
        color: var(--pnl-up);
        background: rgba(var(--pnl-up-rgb), 0.14);
      }

      :host([data-tone='down']) {
        color: var(--pnl-down);
        background: rgba(var(--pnl-down-rgb), 0.14);
      }

      :host([data-tone='warn']) {
        color: var(--signal-warn);
        background: rgba(var(--signal-warn-rgb), 0.15);
      }

      :host([data-tone='brand']) {
        color: var(--brand-2);
        background: rgba(var(--brand-2-rgb), 0.16);
      }

      :host([data-tone='neutral']) {
        color: var(--text-2);
        background: var(--surface-3);
      }

      /* ── Relleno solido: para lo terminal, que no debe leerse como un
         estado mas de una lista ──────────────────────────────────────────── */
      :host([data-variant='solid'][data-tone='up']) {
        color: var(--surface-base);
        background: var(--pnl-up);
      }

      :host([data-variant='solid'][data-tone='down']) {
        color: var(--surface-base);
        background: var(--pnl-down);
      }

      :host([data-variant='solid'][data-tone='warn']) {
        color: var(--surface-base);
        background: var(--signal-warn);
      }

      :host([data-variant='solid'][data-tone='brand']) {
        color: #fff;
        background: var(--brand-strong);
      }

      :host([data-variant='solid'][data-tone='neutral']) {
        color: var(--surface-base);
        background: var(--text-2);
      }

      /* ── Contorno: mismo color, distinta textura. Existe para separar dos
         etiquetas que comparten tono y NO significan lo mismo —«simulación» y
         «testnet» son las dos ambar, y confundirlas es confundir el dinero. ─ */
      :host([data-variant='outline']) {
        background: transparent;
      }

      :host([data-variant='outline'][data-tone='up']) {
        border-color: rgba(var(--pnl-up-rgb), 0.5);
      }

      :host([data-variant='outline'][data-tone='down']) {
        border-color: rgba(var(--pnl-down-rgb), 0.5);
      }

      :host([data-variant='outline'][data-tone='warn']) {
        border-color: rgba(var(--signal-warn-rgb), 0.5);
      }

      :host([data-variant='outline'][data-tone='brand']) {
        border-color: rgba(var(--brand-2-rgb), 0.5);
      }

      :host([data-variant='outline'][data-tone='neutral']) {
        border-color: var(--border-strong);
      }
    `,
  ],
})
export class UiBadgeComponent {
  readonly tone = input<BadgeTone>('neutral');
  readonly variant = input<'soft' | 'solid' | 'outline'>('soft');
  readonly size = input<'sm' | 'md'>('md');
}
