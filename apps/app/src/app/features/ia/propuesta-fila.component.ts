import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { IonButton } from '@ionic/angular/standalone';
import type { PropuestaVista } from '@crypton/shared';
import { money, price, shortDate } from '../../core/utils';
import {
  ESTADO_PROPUESTA,
  FAMILIA,
  MOTIVO_PROPUESTA,
  RESULTADO_HIPOTETICO,
  SALIDA,
  ladoTexto,
  porcentaje,
  quedaTexto,
  rTexto,
  textoDe,
  tonoPropuesta,
} from '../../core/utils/agentes-ia';
import { AgentesAccionesService } from '../../shared/ia/agentes-acciones.service';
import { UiBadgeComponent } from '../../shared/ui';

/**
 * Una propuesta en una lista (spec 074). Si espera a una persona, con sus dos
 * botones y su cuenta atrás; si no, en qué acabó y qué habría pasado.
 */
@Component({
  selector: 'app-propuesta-fila',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IonButton, UiBadgeComponent],
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
      </div>
      <p class="l2">{{ p.agente }} · {{ shortDate(p.creadaEn) }}</p>
      @if (p.plan; as plan) {
        <p class="l2 num">
          entrada ≤ {{ price(plan.entradaTope) }} · stop {{ price(plan.stop) }} · riesgo
          {{ money(plan.riesgo) }} ({{ porcentaje(plan.riesgoPctCapital) }}) ·
          {{ rTexto(plan.rNeto) }}
        </p>
      }
      @if (resumen(); as r) {
        <p class="l3">{{ r }}</p>
      }
    </a>
    @if (pendiente()) {
      <div class="bts">
        <ion-button size="small" [disabled]="ocupado()" (click)="aprobar()">Ejecutar</ion-button>
        <ion-button size="small" fill="outline" [disabled]="ocupado()" (click)="rechazar()">
          Descartar
        </ion-button>
        <span class="queda">{{ quedaTexto(p.caducaEn, ahora()) }}</span>
      </div>
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

      p {
        margin: 3px 0 0;
        font-size: 11.5px;
        color: var(--text-3);
      }

      .l3 {
        color: var(--text-2);
      }

      .bts {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        margin-top: var(--space-2);
      }

      .queda {
        font-size: 11px;
        color: var(--text-3);
      }
    `,
  ],
})
export class PropuestaFilaComponent {
  private readonly acciones = inject(AgentesAccionesService);

  readonly propuesta = input.required<PropuestaVista>();
  readonly ahora = input<number>(Date.now());
  readonly cambiado = output<void>();

  readonly ocupado = signal(false);

  readonly textoDe = textoDe;
  readonly ladoTexto = ladoTexto;
  readonly price = price;
  readonly money = money;
  readonly porcentaje = porcentaje;
  readonly shortDate = shortDate;
  readonly rTexto = rTexto;
  readonly quedaTexto = quedaTexto;
  readonly FAMILIA = FAMILIA;
  readonly ESTADO_PROPUESTA = ESTADO_PROPUESTA;
  readonly tonoPropuesta = tonoPropuesta;

  readonly pendiente = computed(
    () =>
      this.propuesta().estado === 'PROPUESTA' &&
      Date.parse(this.propuesta().caducaEn) > this.ahora(),
  );

  /** En qué acabó, en una línea: el motivo, cómo salió y qué habría pasado. */
  readonly resumen = computed(() => {
    const p = this.propuesta();
    const partes: string[] = [];
    if (p.motivo) partes.push(textoDe(MOTIVO_PROPUESTA, p.motivo));
    const op = p.operacion;
    if (op?.salida) partes.push(`salió por ${textoDe(SALIDA, op.salida)}: ${rTexto(op.r)}`);
    else if (op && (p.estado === 'ABIERTA' || p.estado === 'EJECUTANDO')) {
      partes.push(`va ${rTexto(op.r)}`);
    }
    if (p.hipotetico && p.estado !== 'CERRADA') {
      partes.push(
        `${textoDe(RESULTADO_HIPOTETICO, p.hipotetico.resultado)} (${rTexto(p.hipotetico.r)})`,
      );
    }
    return partes.join(' · ');
  });

  async aprobar(): Promise<void> {
    await this.hacer(() => this.acciones.aprobar(this.propuesta()));
  }

  async rechazar(): Promise<void> {
    await this.hacer(() => this.acciones.rechazar(this.propuesta()));
  }

  private async hacer(f: () => Promise<unknown>): Promise<void> {
    if (this.ocupado()) return;
    this.ocupado.set(true);
    try {
      await f();
      this.cambiado.emit();
    } finally {
      this.ocupado.set(false);
    }
  }
}
