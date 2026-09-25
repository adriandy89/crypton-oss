import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { IonButton } from '@ionic/angular/standalone';
import type { AccionVista } from '@crypton/shared';
import { ago, price, qty } from '../../core/utils';
import {
  ACCION,
  ESTADO_ACCION,
  MOTIVO_MODELO,
  quedaTexto,
  rTexto,
  textoDe,
} from '../../core/utils/agentes-ia';
import { UiBadgeComponent } from '../ui/ui-badge.component';
import { AgentesAccionesService } from './agentes-acciones.service';

/**
 * Una acción del seguimiento de una operación (spec 074): qué pide, en qué
 * acabó y, si espera a una persona, sus dos botones. Todas reducen el riesgo;
 * aquí se dice cuánto deja.
 */
@Component({
  selector: 'app-accion-item',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonButton, UiBadgeComponent],
  template: `
    @let a = accion();
    <div class="acc">
      <div class="l1">
        <b>{{ textoDe(ACCION, a.accion) }}</b>
        <ui-badge size="sm" [tone]="a.estado === 'PROPUESTA' ? 'brand' : 'neutral'">
          {{ textoDe(ESTADO_ACCION, a.estado) }}
        </ui-badge>
        @if (a.decididaPor === 'AUTO') {
          <ui-badge size="sm" variant="outline">automática</ui-badge>
        }
      </div>
      <p class="l2 num">
        @if (a.stopNuevo) {
          stop a {{ price(a.stopNuevo) }}
        }
        @if (a.posicionNueva) {
          {{ a.posicionNueva === '0' ? 'cerrar' : 'posición a ' + qty(a.posicionNueva) }}
        }
        @if (a.riesgoRestanteR !== null) {
          · si salta el stop, {{ rTexto(-a.riesgoRestanteR) }}
        }
        · {{ ago(creada()) }}
      </p>
      @if (a.respuesta; as r) {
        <p class="l3">
          @if (r.texto) {
            «{{ r.texto }}»
          }
          {{ motivos() }}
        </p>
      }
      @if (pendiente()) {
        <div class="bts">
          <ion-button size="small" [disabled]="ocupado()" (click)="aplicar()"> Aplicar </ion-button>
          <ion-button size="small" fill="outline" [disabled]="ocupado()" (click)="descartar()">
            Descartar
          </ion-button>
          <span class="queda">{{ quedaTexto(a.caducaEn, ahora()) }}</span>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .acc {
        padding: var(--space-2) 0;
      }

      .l1 {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 13px;
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
export class AccionItemComponent {
  private readonly acciones = inject(AgentesAccionesService);

  readonly accion = input.required<AccionVista>();
  /** La hora de ahora, para la cuenta atrás. La pone quien la pinta. */
  readonly ahora = input<number>(Date.now());
  /** Se aplicó o se descartó: quien la pinta vuelve a pedir lo suyo. */
  readonly cambiado = output<void>();

  readonly ocupado = signal(false);

  readonly ACCION = ACCION;
  readonly ESTADO_ACCION = ESTADO_ACCION;
  readonly textoDe = textoDe;
  readonly price = price;
  readonly qty = qty;
  readonly ago = ago;
  readonly rTexto = rTexto;
  readonly quedaTexto = quedaTexto;

  readonly creada = computed(() => Date.parse(this.accion().creadaEn));
  readonly pendiente = computed(
    () => this.accion().estado === 'PROPUESTA' && Date.parse(this.accion().caducaEn) > this.ahora(),
  );
  readonly motivos = computed(() =>
    (this.accion().respuesta?.motivos ?? []).map((m) => textoDe(MOTIVO_MODELO, m)).join(' · '),
  );

  async aplicar(): Promise<void> {
    await this.hacer(() => this.acciones.aplicar(this.accion()));
  }

  async descartar(): Promise<void> {
    await this.hacer(() => this.acciones.descartar(this.accion()));
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
