import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { PropuestaVista } from '@crypton/shared';
import { price, qty, signed, shortDate } from '../../core/utils';
import {
  ESTADO_PROPUESTA,
  FAMILIA,
  SALIDA,
  ladoTexto,
  rTexto,
  textoDe,
  tonoPropuesta,
  tonoR,
} from '../../core/utils/agentes-ia';
import { AccionItemComponent } from '../../shared/ia/accion-item.component';
import { UiBadgeComponent } from '../../shared/ui';

/**
 * Una operación de un agente en una lista (spec 074): cómo va —o cómo salió—,
 * su stop de ahora y la última acción del seguimiento, con sus botones si
 * espera a una persona.
 */
@Component({
  selector: 'app-operacion-fila',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, UiBadgeComponent, AccionItemComponent],
  template: `
    @let p = propuesta();
    <a class="cab" [routerLink]="['/ia/propuestas', p.id]">
      <div class="l1">
        <span class="sim">{{ p.simbolo }} {{ ladoTexto(p.lado) }}</span>
        <span class="fam">{{ textoDe(FAMILIA, p.familia) }}</span>
        <ui-badge size="sm" [tone]="tonoPropuesta(p.estado)">
          {{ textoDe(ESTADO_PROPUESTA, p.estado) }}
        </ui-badge>
        @if (p.real) {
          <ui-badge size="sm" tone="down" variant="outline">dinero real</ui-badge>
        }
        @if (p.operacion; as op) {
          <ui-badge size="sm" [tone]="tonoR(op.r)">{{ rTexto(op.r) }}</ui-badge>
        }
      </div>
      <p class="l2">
        {{ p.agente }}
        @if (p.operacion?.abiertaEn; as t) {
          · abierta {{ shortDate(t) }}
        }
        @if (p.operacion?.cerradaEn; as t) {
          · cerrada {{ shortDate(t) }}
        }
      </p>
      @if (linea(); as l) {
        <p class="l2 num">{{ l }}</p>
      }
    </a>
    @if (p.operacion?.ultimaAccion; as a) {
      <app-accion-item [accion]="a" [ahora]="ahora()" (cambiado)="cambiado.emit()" />
    }
  `,
  styles: [
    `
      :host {
        display: block;
        padding: var(--space-3);
        border-bottom: 1px solid rgba(46, 43, 82, 0.6);
      }

      :host(:last-child) {
        border-bottom: 0;
      }

      .cab {
        display: block;
        color: inherit;
        text-decoration: none;
      }

      .l1 {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
      }

      .sim {
        font-size: 14px;
        font-weight: 600;
      }

      .fam {
        font-size: 12px;
        color: var(--text-2);
      }

      .l2 {
        margin: 3px 0 0;
        font-size: 11.5px;
        color: var(--text-3);
      }
    `,
  ],
})
export class OperacionFilaComponent {
  readonly propuesta = input.required<PropuestaVista>();
  readonly ahora = input<number>(Date.now());
  readonly cambiado = output<void>();

  readonly textoDe = textoDe;
  readonly ladoTexto = ladoTexto;
  readonly shortDate = shortDate;
  readonly rTexto = rTexto;
  readonly tonoR = tonoR;
  readonly FAMILIA = FAMILIA;
  readonly ESTADO_PROPUESTA = ESTADO_PROPUESTA;
  readonly tonoPropuesta = tonoPropuesta;

  /** Lo de ahora si vive; cómo salió si terminó. */
  readonly linea = computed(() => {
    const op = this.propuesta().operacion;
    if (!op) return '';
    if (op.salida) {
      return `salió por ${textoDe(SALIDA, op.salida)} · ${signed(op.resultado)}`;
    }
    const partes: string[] = [];
    if (op.resultado !== null) partes.push(`resultado ${signed(op.resultado)}`);
    if (op.stop) partes.push(`stop ${price(op.stop)}`);
    if (op.posicion) partes.push(`posición ${qty(op.posicion)}`);
    if (op.tp1Hecho) partes.push('primer objetivo cobrado');
    return partes.join(' · ');
  });
}
