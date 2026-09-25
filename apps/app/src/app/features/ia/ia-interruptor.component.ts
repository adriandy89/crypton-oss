import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AlertController, IonButton } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { powerOutline } from 'ionicons/icons';
import type { InterruptoresAgentes } from '@crypton/shared';
import { ToastService } from '../../core/services';
import { AgentesIaService } from '../../core/services/agentes-ia.service';
import { errorText } from '../../core/utils';
import { AVISO_SIN_MOTIVO, CAMPO_MOTIVO, motivoValido } from '../../shared/bot/motivo';
import { UiCardComponent, UiNoticeComponent } from '../../shared/ui';

/**
 * El estado del servidor para los agentes y su interruptor global de entradas
 * (spec 074). Es lo primero que se ve en la pestaña IA porque es lo que se
 * busca con prisa: un dato macro, un exchange raro. Cortar las entradas no
 * toca lo abierto, que sigue con su stop, sus objetivos y su seguimiento.
 */
@Component({
  selector: 'app-ia-interruptor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonButton, UiCardComponent, UiNoticeComponent],
  template: `
    @if (agentes.interruptores(); as i) {
      @if (!i.encendido) {
        <ui-notice tone="warn" icon="power-outline">
          Los agentes están apagados en el servidor: no corre ninguna ronda, tampoco en modo reglas.
          Lo abierto sigue con su stop y sus objetivos.
        </ui-notice>
      } @else if (!i.modeloDisponible) {
        <ui-notice tone="warn">
          El servidor no tiene clave del modelo: solo analizan los agentes en modo reglas.
        </ui-notice>
      }
      @if (frenos(); as f) {
        <ui-notice tone="info">Frenos del servidor: {{ f }}.</ui-notice>
      }
      <ui-card>
        <div class="fila">
          <div class="txt">
            <span class="tit">Entradas de todos los agentes</span>
            <p [class.mal]="i.entradas !== 'ABIERTAS'">{{ entradas(i) }}</p>
            <p>{{ i.modelo }} · {{ consultas(i) }}</p>
          </div>
          <ion-button
            size="small"
            fill="outline"
            [color]="i.entradas === 'ABIERTAS' ? 'warning' : 'primary'"
            [disabled]="ocupado() || i.entradas === 'DESCONOCIDO'"
            (click)="cambiar(i)"
          >
            {{ i.entradas === 'ABIERTAS' ? 'Cortar' : 'Abrir' }}
          </ion-button>
        </div>
      </ui-card>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        margin-bottom: var(--space-3);
      }

      ui-notice {
        display: block;
        margin-bottom: var(--space-2);
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
export class IaInterruptorComponent {
  readonly agentes = inject(AgentesIaService);
  private readonly alerts = inject(AlertController);
  private readonly toast = inject(ToastService);

  readonly ocupado = signal(false);

  constructor() {
    addIcons({ powerOutline });
  }

  /** Los frenos encendidos, en castellano; vacío si no hay ninguno. */
  readonly frenos = computed(() => {
    const f = this.agentes.interruptores()?.frenos;
    if (!f) return '';
    const lista: string[] = [];
    if (f.soloSombra) lista.push('solo sombra —nada se ejecuta en ninguna cuenta—');
    if (f.soloSimulacion) lista.push('solo simulación —nada se abre en una cuenta real—');
    if (f.forzarManual) lista.push('todo lo automático pasa a propuesta');
    return lista.join('; ');
  });

  consultas(i: InterruptoresAgentes): string {
    return i.llamadasGlobalesHoy === null
      ? 'consultas de hoy desconocidas'
      : `${i.llamadasGlobalesHoy} de ${i.limiteGlobal} consultas hoy`;
  }

  entradas(i: InterruptoresAgentes): string {
    if (i.entradas === 'ABIERTAS') return 'Abiertas.';
    if (i.entradas === 'CERRADAS') {
      return `Cortadas${i.motivoEntradas ? `: «${i.motivoEntradas}»` : ''}. Lo abierto sigue su curso.`;
    }
    return 'No se puede leer el interruptor, y sin él ningún agente abre nada.';
  }

  async cambiar(i: InterruptoresAgentes): Promise<void> {
    if (this.ocupado()) return;
    const abrir = i.entradas !== 'ABIERTAS';
    const alerta = await this.alerts.create({
      header: abrir ? 'Abrir las entradas' : 'Cortar las entradas',
      message: abrir
        ? 'Todos los agentes vuelven a poder proponer y abrir operaciones.'
        : 'Ningún agente propondrá ni abrirá operaciones nuevas hasta que las abras. Las abiertas siguen con su stop, sus objetivos y su seguimiento.',
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
      const nuevos = await this.agentes.fijarEntradas(abrir, reason);
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
