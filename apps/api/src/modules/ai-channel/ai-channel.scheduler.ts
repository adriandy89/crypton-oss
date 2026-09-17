import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { PULSACION_PAUSA_CANAL } from '@crypton/shared';
import { BUS_CHANNELS, BusService, CacheService, type BusMessage } from 'src/libs';
import { AiChannelService } from './ai-channel.service';

/**
 * Cuándo se consulta a la IA del canal (spec 059).
 *
 * Dos caminos hacia la misma puerta, y la puerta es la actualización
 * condicional de `atender`: da igual por cuál llegue una solicitud, o si llega
 * por los dos a la vez en dos réplicas, solo una la reclama.
 * - **El bus** (`BOT_AI_REQUESTS`): el worker avisa al escribir la solicitud.
 *   Es el camino rápido.
 * - **El sondeo**, cada 10 s: pub/sub no garantiza la entrega, y una solicitud
 *   cuyo aviso se perdió tiene que encontrarse igual antes de su plazo.
 *
 * Además caduca lo que nadie terminó y canjea el botón de pausa de los avisos.
 */
@Injectable()
export class AiChannelScheduler implements OnModuleInit {
  private readonly logger = new Logger(AiChannelScheduler.name);

  constructor(
    private readonly bus: BusService,
    private readonly cache: CacheService,
    private readonly canal: AiChannelService,
  ) {}

  async onModuleInit(): Promise<void> {
    const solicitudes$ = await this.bus.listen(BUS_CHANNELS.BOT_AI_REQUESTS);
    solicitudes$.subscribe((mensaje) => {
      // Con `catch`: esto consulta la base, y una promesa sin manejar tumba el
      // proceso entero en Node (001/F-07).
      void this.onSolicitud(mensaje).catch((e: Error) =>
        this.logger.warn(`Solicitud del canal sin atender: ${e.message}`),
      );
    });
    const eventos$ = await this.bus.listen(BUS_CHANNELS.BOT_EVENTS);
    eventos$.subscribe((mensaje) => {
      if (mensaje.type !== PULSACION_PAUSA_CANAL) return;
      void this.onPulsacion(mensaje).catch((e: Error) =>
        this.logger.warn(`Pausa desde Telegram sin atender: ${e.message}`),
      );
    });
    this.logger.log('IA del canal activa');
  }

  /** El worker ha escrito una solicitud: se busca por bot y vela. */
  async onSolicitud(mensaje: BusMessage): Promise<void> {
    if (!mensaje.botId) return;
    const barT = Number((mensaje.data as { barT?: unknown } | null)?.barT);
    if (!Number.isFinite(barT)) return;
    const id = await this.canal.solicitudDe(mensaje.botId, barT);
    if (id) await this.canal.atender(id);
  }

  /**
   * El respaldo del bus. Sin esperar a que terminen las consultas: cada una
   * reserva su hueco, y el sondeo siguiente llena los que queden.
   */
  @Interval(10_000)
  async sondear(): Promise<void> {
    const ids = await this.canal.pendientes(this.canal.huecos);
    for (const id of ids) {
      void this.canal
        .atender(id)
        .catch((e: Error) => this.logger.warn(`Solicitud ${id} sin atender: ${e.message}`));
    }
  }

  /**
   * Caduca lo vencido. Con cerrojo, como los demás crons: `@Cron` dispara en
   * todas las réplicas.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async caducar(): Promise<void> {
    if (!(await this.cache.setnx('lock:ai-channel-expire', Date.now(), 50).catch(() => false))) {
      return;
    }
    const n = await this.canal.caducarVencidas(Date.now());
    if (n > 0) this.logger.debug(`${n} intención(es) del canal caducadas.`);
  }

  /**
   * Alguien ha pulsado «⏸ Pausar» en un aviso. El poller del worker solo hace
   * de mensajero: el vale se canjea aquí, una vez, aunque lo reciban todas las
   * réplicas.
   */
  async onPulsacion(mensaje: BusMessage): Promise<void> {
    if (!mensaje.userId) return;
    const vale = (mensaje.data as { vale?: unknown } | null)?.vale;
    const r = await this.canal.canjearPausa(mensaje.userId, vale);
    if (r !== 'PAUSADO' && r !== 'SIN_VALE') {
      this.logger.warn(`Botón de pausa rechazado (${r}).`);
    }
  }
}
