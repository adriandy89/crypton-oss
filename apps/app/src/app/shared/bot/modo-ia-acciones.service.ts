import { Injectable, inject } from '@angular/core';
import { AlertController } from '@ionic/angular/standalone';
import { ToastService } from '../../core/services';
import {
  AYUDA_MODO_IA,
  AdminBotsService,
  ETIQUETA_DISPARO,
  ETIQUETA_MODO_IA,
  type AiSetting,
} from '../../core/services/admin-bots.service';
import { ModoIaService } from '../../core/services/modo-ia.service';
import { errorText } from '../../core/utils';
import { INTERVALO_IA_POR_DEFECTO, LIMITES_IA, type CambioIa } from '../../core/utils/modo-ia';
import { AVISO_SIN_MOTIVO, CAMPO_MOTIVO, motivoValido } from './motivo';

/** El bot, en lo que a la confirmación le importa. */
export interface BotDeIa {
  id: string;
  name: string;
  dryRun: boolean;
}

/**
 * Cambiar el Modo IA de un bot, con su confirmación (spec 053).
 *
 * Vivía en `AdminActionsService` con un solo llamador, la ficha de la consola.
 * Desde el spec 053 también lo usa el detalle del bot, y un servicio de
 * `features/admin` no es algo que otra funcionalidad deba importar: por eso vive
 * en `shared/bot`, junto a la hoja de comandos, que es el mismo caso.
 *
 * Tres cosas que no se negocian:
 *
 * 1. El MOTIVO es obligatorio y viaja a la bitácora. Que el bot sea propio no
 *    hace menos revisable encender un agente que reescribe su configuración:
 *    lo hace más fácil de olvidar.
 * 2. La confirmación dice lo que el supervisor NO puede hacer, y en automático
 *    sobre un bot real dice que es dinero real.
 * 3. La promesa se resuelve cuando el `PUT` TERMINA, no cuando se abre el
 *    diálogo. Antes la pantalla soltaba su «guardando» al abrirlo, y el botón
 *    quedaba libre mientras la petición seguía en vuelo.
 */
@Injectable({ providedIn: 'root' })
export class ModoIaAccionesService {
  private readonly alerts = inject(AlertController);
  private readonly toast = inject(ToastService);
  private readonly api = inject(AdminBotsService);
  private readonly modoIa = inject(ModoIaService);

  /**
   * Pide confirmación y motivo, y guarda. Devuelve el Modo IA nuevo, o `null` si
   * se canceló o falló (el fallo ya se ha contado con un aviso).
   *
   * @param actual el modo guardado ahora mismo, para decir qué cambia.
   */
  async guardar(
    bot: BotDeIa,
    cambio: CambioIa,
    actual: AiSetting['mode'],
  ): Promise<AiSetting | null> {
    const alerta = await this.alerts.create({
      header: this.encabezado(cambio, actual),
      message: this.mensaje(bot, cambio, actual),
      inputs: [CAMPO_MOTIVO],
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Confirmar',
          role: 'confirm',
          // Solo valida. Devolver `false` deja el diálogo abierto, que es lo que
          // se quiere: el servidor lo exigiría igual, con un 400 que no explica
          // nada. El `PUT` va DESPUÉS de cerrarse, para poder esperarlo.
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
    if (role !== 'confirm' || !reason) return null;

    try {
      const ajuste = await this.api.setAiMode(bot.id, { ...cambio, reason });
      this.modoIa.anotar(ajuste);
      await this.toast.success(
        cambio.mode === 'OFF' && actual !== 'OFF' ? 'Modo IA apagado.' : 'Modo IA actualizado.',
      );
      return ajuste;
    } catch (e) {
      await this.toast.error(errorText(e));
      return null;
    }
  }

  private encabezado(cambio: CambioIa, actual: AiSetting['mode']): string {
    if (cambio.mode === actual) return 'Opciones del Modo IA';
    return cambio.mode === 'OFF' ? 'Apagar el Modo IA' : ETIQUETA_MODO_IA[cambio.mode];
  }

  private mensaje(bot: BotDeIa, cambio: CambioIa, actual: AiSetting['mode']): string {
    if (cambio.mode === 'OFF') {
      return (
        `${bot.name} volverá a funcionar solo con la configuración que le pusiste. ` +
        'Las sugerencias que estuvieran esperando se descartan.'
      );
    }
    const partes: string[] = [];
    if (cambio.mode !== actual) partes.push(AYUDA_MODO_IA[cambio.mode]);
    const opciones = this.opciones(cambio);
    if (opciones) partes.push(`Cambia: ${opciones}.`);
    // Lo que alguien con prisa da por supuesto al revés.
    if (cambio.mode === 'AUTO' && !bot.dryRun) {
      partes.push(
        'OJO: este bot opera con DINERO REAL, y en este modo la IA aplica los cambios sin ' +
          'preguntarte.',
      );
    }
    partes.push(LIMITES_IA);
    return partes.join(' ');
  }

  /** Las opciones que cambian, en castellano. Vacío si solo cambia el modo. */
  private opciones(cambio: CambioIa): string {
    const lineas: string[] = [];
    if (cambio.trigger !== undefined) {
      lineas.push(`cuándo revisa → ${ETIQUETA_DISPARO[cambio.trigger].toLowerCase()}`);
    }
    if (cambio.reviewEveryMinutes !== undefined) {
      lineas.push(
        cambio.reviewEveryMinutes === null
          ? `cada cuánto → el de la estrategia (${INTERVALO_IA_POR_DEFECTO} min)`
          : `cada cuánto → ${cambio.reviewEveryMinutes} min`,
      );
    }
    if (cambio.allowWarm !== undefined) {
      lineas.push(
        cambio.allowWarm ? 'puede recolocar las órdenes' : 'no recoloca órdenes, solo ajusta',
      );
    }
    return lineas.join('; ');
  }
}
