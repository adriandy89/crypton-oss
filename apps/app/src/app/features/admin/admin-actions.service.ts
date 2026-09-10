import { Injectable, inject } from '@angular/core';
import { AlertController } from '@ionic/angular/standalone';
import { ToastService } from '../../core/services';
import {
  AdminBotsService,
  ETIQUETA_COMANDO,
  type AdminBotCommand,
} from '../../core/services/admin-bots.service';
import { AdminUsersService } from '../../core/services/admin-users.service';
import { errorText } from '../../core/utils';

/**
 * Las acciones de la consola, con su confirmacion.
 *
 * `AlertController` y no `window.confirm`: es lo que usan las seis pantallas que
 * confirman algo en esta app —`window.confirm` aparece una sola vez, en el
 * kill-switch, y es la excepcion, no el patron.
 *
 * Tres cosas separan estas confirmaciones de las de un usuario sobre su propio
 * bot, y son la razon de que este servicio exista:
 *
 * 1. El DUEÑO va siempre en el mensaje. Una confirmacion sobre el dinero de otra
 *    persona que no dice de quien es no es una confirmacion.
 * 2. El MOTIVO es obligatorio y viaja a la bitacora. Es lo unico que hace
 *    revisable despues una accion sobre la cuenta de alguien.
 * 3. Se avisa de lo que la accion NO hace, que es lo que el administrador va a
 *    suponer mal.
 */
@Injectable({ providedIn: 'root' })
export class AdminActionsService {
  private readonly alerts = inject(AlertController);
  private readonly toast = inject(ToastService);
  private readonly bots = inject(AdminBotsService);
  private readonly users = inject(AdminUsersService);

  /** El campo de motivo, identico en las tres acciones que lo piden. */
  private readonly campoMotivo = {
    name: 'reason',
    type: 'text' as const,
    placeholder: 'Motivo (queda en la bitácora)',
    attributes: { maxlength: 200 },
  };

  /**
   * Valida el motivo dentro del `handler`.
   *
   * Devolver `false` mantiene el dialogo abierto, que es justo lo que se quiere:
   * el servidor lo exige igual, y dejarlo viajar solo conseguiria un 400 que no
   * explica por que.
   */
  private motivoDe(datos: { reason?: string }): string | null {
    const reason = (datos?.reason ?? '').trim();
    if (reason.length < 3) {
      void this.toast.error('Escribe el motivo: queda en la bitácora.');
      return null;
    }
    return reason;
  }

  /** Contener un bot ajeno. Ninguno de los dos comandos cierra posicion. */
  async comandoDeBot(
    bot: { id: string; name: string; owner: { email: string } },
    command: AdminBotCommand,
    onDone?: () => void | Promise<void>,
  ): Promise<void> {
    const alert = await this.alerts.create({
      header: ETIQUETA_COMANDO[command],
      message:
        `Vas a actuar sobre ${bot.name}, de ${bot.owner.email}. ` +
        'La posición sigue abierta y su dueño sigue siendo el responsable: esto no cierra nada, ' +
        'no realiza el resultado y conserva el stop-loss del venue.',
      inputs: [this.campoMotivo],
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Confirmar',
          role: 'destructive',
          handler: (datos: { reason?: string }) => {
            const reason = this.motivoDe(datos);
            if (!reason) return false;
            void this.correr(
              () => this.bots.command(bot.id, command, reason),
              `${ETIQUETA_COMANDO[command]}: enviado.`,
              onDone,
            );
            return true;
          },
        },
      ],
    });
    await alert.present();
  }

  /**
   * Deshabilitar una cuenta.
   *
   * El aviso de los bots vivos es lo importante del mensaje: el motor NO consulta
   * `disabled`, asi que los bots de esa persona siguen operando con su
   * credencial. Un administrador que deshabilita una cuenta creyendo que ha
   * contenido el riesgo se va tranquilo y no ha contenido nada.
   */
  async deshabilitar(
    user: { id: string; name: string; email: string; bots: { live: number } },
    onDone?: () => void | Promise<void>,
  ): Promise<void> {
    const vivos =
      user.bots.live > 0
        ? ` OJO: tiene ${user.bots.live} bot(s) en marcha y SEGUIRÁN operando.`
        : '';
    const alert = await this.alerts.create({
      header: '¿Deshabilitar la cuenta?',
      message:
        `${user.name} (${user.email}) no podrá entrar ni renovar la sesión, y se le cerrarán ` +
        `las sesiones abiertas al instante.${vivos}`,
      inputs: [this.campoMotivo],
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Deshabilitar',
          role: 'destructive',
          handler: (datos: { reason?: string }) => {
            const reason = this.motivoDe(datos);
            if (!reason) return false;
            void this.enviarDeshabilitar(user.id, reason, onDone);
            return true;
          },
        },
      ],
    });
    await alert.present();
  }

  /** Rehabilitar es el deshacer: confirmacion seca, sin ceremonia ni motivo. */
  async rehabilitar(
    user: { id: string; name: string },
    onDone?: () => void | Promise<void>,
  ): Promise<void> {
    const alert = await this.alerts.create({
      header: '¿Rehabilitar la cuenta?',
      message: `${user.name} volverá a poder entrar y a usar la plataforma con normalidad.`,
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Rehabilitar',
          handler: () => {
            void this.correr(() => this.users.enable(user.id), 'Cuenta rehabilitada.', onDone);
            return true;
          },
        },
      ],
    });
    await alert.present();
  }

  async cerrarSesiones(
    user: { id: string; name: string },
    onDone?: () => void | Promise<void>,
  ): Promise<void> {
    const alert = await this.alerts.create({
      header: '¿Cerrar todas sus sesiones?',
      message:
        `${user.name} tendrá que volver a entrar con Google en todos sus dispositivos. ` +
        'La cuenta sigue habilitada.',
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Cerrar sesiones',
          role: 'destructive',
          handler: () => {
            void this.correr(
              () => this.users.revokeSessions(user.id),
              'Sesiones cerradas.',
              onDone,
            );
            return true;
          },
        },
      ],
    });
    await alert.present();
  }

  private async enviarDeshabilitar(
    id: string,
    reason: string,
    onDone?: () => void | Promise<void>,
  ): Promise<void> {
    try {
      const res = await this.users.disable(id, reason);
      // Se dice la verdad: si la marca de revocacion no se pudo escribir, la
      // cuenta queda cerrada pero su token vigente aguanta unos minutos, y quien
      // acaba de pulsar el boton tiene que saberlo — puede ser justo el rato que
      // importa.
      if (res.sesionCortada) await this.toast.success('Cuenta deshabilitada y sesiones cerradas.');
      else
        await this.toast.error(
          'Cuenta deshabilitada, pero no se pudo cortar su sesión en curso: aguantará unos minutos.',
        );
      await onDone?.();
    } catch (e) {
      await this.toast.error(errorText(e));
    }
  }

  private async correr(
    accion: () => Promise<unknown>,
    exito: string,
    onDone?: () => void | Promise<void>,
  ): Promise<void> {
    try {
      await accion();
      await this.toast.success(exito);
      await onDone?.();
    } catch (e) {
      await this.toast.error(errorText(e));
    }
  }
}
