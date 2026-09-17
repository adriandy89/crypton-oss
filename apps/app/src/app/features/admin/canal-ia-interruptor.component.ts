import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { AlertController, IonButton } from '@ionic/angular/standalone';
import type { InterruptoresCanal } from '@crypton/shared';
import { ToastService } from '../../core/services';
import { CanalIaService } from '../../core/services/canal-ia.service';
import { errorText } from '../../core/utils';
import { AVISO_SIN_MOTIVO, CAMPO_MOTIVO, motivoValido } from '../../shared/bot/motivo';
import { UiCardComponent } from '../../shared/ui/ui-card.component';

/**
 * El interruptor global de entradas del canal con IA (spec 059).
 *
 * Corta o abre las entradas de TODOS los bots del canal a la vez, sin tocar sus
 * posiciones: la abierta sigue con su stop y sus objetivos. Es lo que se busca
 * con prisa —un dato macro, un exchange raro— y por eso vive en el índice de la
 * consola y no tres pantallas más abajo.
 *
 * Pide sus datos él solo, con `CanalIaService`, y si no llegan no pinta nada:
 * el índice sigue siendo puro enrutado y no puede fallar por esto. El motivo es
 * obligatorio y va a la bitácora, como en el resto de la consola.
 */
@Component({
  selector: 'app-canal-ia-interruptor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonButton, UiCardComponent],
  template: `
    @if (canal.interruptores(); as i) {
      <ui-card>
        <div class="fila">
          <div class="txt">
            <span class="tit">Canal con IA</span>
            <p>
              IA {{ i.encendido ? 'encendida' : 'apagada' }} · {{ i.modelo
              }}{{ i.soloSombra ? ' · solo sombra' : '' }} · {{ consultas(i) }}
            </p>
            <p [class.mal]="i.entradas !== 'ABIERTAS'">{{ entradas(i) }}</p>
          </div>
          <ion-button
            size="small"
            fill="outline"
            [color]="i.entradas === 'ABIERTAS' ? 'warning' : 'primary'"
            [disabled]="ocupado() || i.entradas === 'DESCONOCIDO'"
            (click)="cambiar(i)"
          >
            {{ i.entradas === 'ABIERTAS' ? 'Cortar entradas' : 'Abrir entradas' }}
          </ion-button>
        </div>
      </ui-card>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        margin-top: var(--space-3);
      }

      .fila {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
      }

      .tit {
        font-size: 13px;
        color: var(--text-1);
      }

      p {
        margin: 2px 0 0;
        font-size: 11px;
        line-height: 1.45;
        color: var(--text-3);
      }

      p.mal {
        color: var(--signal-warn);
      }
    `,
  ],
})
export class CanalIaInterruptorComponent {
  readonly canal = inject(CanalIaService);
  private readonly alerts = inject(AlertController);
  private readonly toast = inject(ToastService);

  readonly ocupado = signal(false);

  consultas(i: InterruptoresCanal): string {
    return i.llamadasGlobalesHoy === null
      ? 'consultas de hoy desconocidas'
      : `${i.llamadasGlobalesHoy} de ${i.limiteGlobal} consultas hoy`;
  }

  entradas(i: InterruptoresCanal): string {
    if (i.entradas === 'ABIERTAS') return 'Entradas abiertas en todos los bots del canal.';
    if (i.entradas === 'CERRADAS') {
      return 'Entradas cortadas en todos los bots del canal. Las posiciones abiertas siguen con su stop y sus objetivos.';
    }
    return 'No se puede leer el interruptor, y sin él ningún bot del canal abre nada.';
  }

  async cambiar(i: InterruptoresCanal): Promise<void> {
    if (this.ocupado()) return;
    const abrir = i.entradas !== 'ABIERTAS';
    const alerta = await this.alerts.create({
      header: abrir ? 'Abrir las entradas' : 'Cortar las entradas',
      message: abrir
        ? 'Todos los bots del canal con IA vuelven a poder abrir operaciones.'
        : 'Ningún bot del canal con IA abrirá operaciones nuevas hasta que las abras. Las abiertas siguen con su stop y sus objetivos.',
      inputs: [CAMPO_MOTIVO],
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Confirmar',
          role: 'confirm',
          handler: (datos: { reason?: string }) => {
            if (motivoValido(datos?.reason)) return true;
            void this.toast.error(AVISO_SIN_MOTIVO);
            return false;
          },
        },
      ],
    });
    await alerta.present();
    const { role, data } = await alerta.onDidDismiss<{ values?: { reason?: string } }>();
    const reason = motivoValido(data?.values?.reason);
    if (role !== 'confirm' || !reason) return;

    this.ocupado.set(true);
    try {
      const nuevos = await this.canal.fijarEntradas(abrir, reason);
      await this.toast.success(
        nuevos.entradas === 'ABIERTAS' ? 'Entradas abiertas.' : 'Entradas cortadas.',
      );
    } catch (e) {
      await this.toast.error(errorText(e));
    } finally {
      this.ocupado.set(false);
    }
  }
}
