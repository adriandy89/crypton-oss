import { Injectable, inject } from '@angular/core';
import { ActionSheetController, AlertController } from '@ionic/angular/standalone';
import { BotsService, ToastService } from '../../core/services';
import { DESTRUCTIVE_COMMANDS, type BotCommand } from '../../core/models';
import { errorText } from '../../core/utils';

/**
 * Etiquetas de los comandos, en el orden en que se ofrecen.
 *
 * Reparar va primero y sin rol destructivo a propósito: es lo que se busca
 * cuando algo «se ve raro», y no toca ni el libro ni la posición.
 */
export const COMMAND_LABELS: readonly {
  command: BotCommand;
  label: string;
  role?: 'destructive';
}[] = [
  { command: 'REPAIR', label: 'Reparar (resincronizar con el exchange)' },
  { command: 'PAUSE', label: 'Pausar (mantiene la posición)' },
  { command: 'RESUME', label: 'Reanudar' },
  { command: 'CANCEL_ALL_ORDERS', label: 'Cancelar todas las órdenes' },
  { command: 'ADD_SAFETY_NOW', label: 'Adelantar orden de seguridad' },
  { command: 'REANCHOR_GRID', label: 'Recentrar la retícula' },
  { command: 'TAKE_PROFIT_NOW', label: 'Tomar beneficio ya', role: 'destructive' },
  { command: 'CLOSE_NOW', label: 'Cerrar posición ya', role: 'destructive' },
  { command: 'STOP_KEEP_POSITION', label: 'Parar conservando la posición' },
  { command: 'STOP_AND_CLOSE', label: 'Parar y cerrar', role: 'destructive' },
  { command: 'PANIC', label: 'PÁNICO: cancelar y cerrar todo', role: 'destructive' },
];

/**
 * La hoja de acciones de un bot y sus confirmaciones, en UN solo sitio.
 *
 * Vivía dentro del detalle del bot. Al abrirla también desde el gráfico —el
 * momento en que el precio se acerca a la liquidación es justo cuando se quiere
 * actuar sin cambiar de pantalla—, copiarla habría dejado dos listas de
 * comandos y dos textos de confirmación que se desalinean con el primer cambio.
 * Y una confirmación de un comando que cierra a mercado no es un detalle de
 * estilo: es lo que separa un toque accidental de una posición realizada
 * (spec 005, R-4).
 *
 * Es un servicio y no un componente porque la hoja es un `ActionSheet`, que se
 * crea por código y no tiene plantilla que compartir.
 */
@Injectable({ providedIn: 'root' })
export class BotCommandsService {
  private readonly bots = inject(BotsService);
  private readonly toast = inject(ToastService);
  private readonly sheets = inject(ActionSheetController);
  private readonly alerts = inject(AlertController);

  /**
   * Abre la hoja con todos los comandos. `onSent` corre tras enviar uno con
   * éxito: la pantalla que la abrió decide cómo recargarse.
   */
  async open(botId: string, opts: { onSent?: () => void | Promise<void> } = {}): Promise<void> {
    const sheet = await this.sheets.create({
      header: 'Acciones del bot',
      buttons: [
        ...COMMAND_LABELS.map((c) => ({
          text: c.label,
          role: c.role,
          handler: () => void this.run(botId, c.command, opts),
        })),
        { text: 'Cerrar', role: 'cancel' },
      ],
    });
    await sheet.present();
  }

  /**
   * Envía un comando, con confirmación si cierra a mercado.
   *
   * Los comandos que cierran a mercado realizan el resultado al instante y no
   * se pueden deshacer: se pregunta SIEMPRE, aunque la API también lo exija.
   */
  async run(
    botId: string,
    command: BotCommand,
    opts: { onSent?: () => void | Promise<void> } = {},
  ): Promise<void> {
    if (DESTRUCTIVE_COMMANDS.includes(command)) {
      const alert = await this.alerts.create({
        header: '¿Seguro?',
        message:
          'Esta acción cierra la posición a mercado y realiza el resultado al instante. No se puede deshacer.',
        buttons: [
          { text: 'Cancelar', role: 'cancel' },
          {
            text: 'Confirmar',
            role: 'destructive',
            handler: () => void this.send(botId, command, true, opts.onSent),
          },
        ],
      });
      await alert.present();
      return;
    }
    await this.send(botId, command, false, opts.onSent);
  }

  private async send(
    botId: string,
    command: BotCommand,
    confirm: boolean,
    onSent?: () => void | Promise<void>,
  ): Promise<void> {
    try {
      await this.bots.command(botId, command, confirm);
      await this.toast.success(`Comando ${command} enviado.`);
      await onSent?.();
    } catch (e) {
      await this.toast.error(errorText(e));
    }
  }
}
