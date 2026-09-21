import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { BUS_CHANNELS, BusService, CacheService, type BusMessage } from 'src/libs';
import { AiTraderService } from './ai-trader.service';

/**
 * Cuándo se consulta a la IA del «Bot de IA» (spec 069).
 *
 * Dos caminos hacia la misma puerta, y la puerta es la actualización condicional
 * de `atender`: da igual por cuál llegue una solicitud, o si llega por los dos a
 * la vez en dos réplicas, solo una la reclama.
 * - **El bus** (`BOT_AI_REQUESTS`): el worker avisa al escribir la solicitud.
 * - **El sondeo**, cada 10 s: pub/sub no garantiza la entrega, y una solicitud
 *   cuyo aviso se perdió tiene que encontrarse igual antes de su plazo.
 *
 * El canal escucha el MISMO bus, así que los dos reciben todos los avisos. Lo
 * que impide que uno atienda lo del otro es el filtro por estrategia, que está
 * en las consultas del servicio y no aquí: si estuviera aquí, el sondeo de
 * respaldo se lo saltaría.
 */
@Injectable()
export class AiTraderScheduler implements OnModuleInit {
  private readonly logger = new Logger(AiTraderScheduler.name);

  constructor(
    private readonly bus: BusService,
    private readonly cache: CacheService,
    private readonly trader: AiTraderService,
  ) {}

  async onModuleInit(): Promise<void> {
    const solicitudes$ = await this.bus.listen(BUS_CHANNELS.BOT_AI_REQUESTS);
    solicitudes$.subscribe((mensaje) => {
      // Con `catch`: esto consulta la base, y una promesa sin manejar tumba el
      // proceso entero en Node (001/F-07).
      void this.onSolicitud(mensaje).catch((e: Error) =>
        this.logger.warn(`Solicitud del «Bot de IA» sin atender: ${e.message}`),
      );
    });
    this.logger.log('IA del «Bot de IA» activa');
  }

  /** El worker ha escrito una solicitud: se busca por bot y vela. */
  async onSolicitud(mensaje: BusMessage): Promise<void> {
    if (!mensaje.botId) return;
    const barT = Number((mensaje.data as { barT?: unknown } | null)?.barT);
    if (!Number.isFinite(barT)) return;
    // Devuelve null si la solicitud no es de esta estrategia: el aviso del canal
    // llega aquí también, y aquí se ignora sin tocar nada.
    const id = await this.trader.solicitudDe(mensaje.botId, barT);
    if (id) await this.trader.atender(id);
  }

  /**
   * El respaldo del bus. Sin esperar a que terminen las consultas: cada una
   * reserva su hueco, y el sondeo siguiente llena los que queden.
   */
  @Interval(10_000)
  async sondear(): Promise<void> {
    const ids = await this.trader.pendientes(this.trader.huecos);
    for (const id of ids) {
      void this.trader
        .atender(id)
        .catch((e: Error) => this.logger.warn(`Solicitud ${id} sin atender: ${e.message}`));
    }
  }

  /**
   * Caduca lo vencido. Con cerrojo propio, como los demás crons: `@Cron` dispara
   * en todas las réplicas, y el del canal no sirve porque cada uno caduca solo
   * lo suyo.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async caducar(): Promise<void> {
    if (!(await this.cache.setnx('lock:ai-trader-expire', Date.now(), 50).catch(() => false))) {
      return;
    }
    const n = await this.trader.caducarVencidas(Date.now());
    if (n > 0) this.logger.debug(`${n} intención(es) del «Bot de IA» caducadas.`);
  }
}
