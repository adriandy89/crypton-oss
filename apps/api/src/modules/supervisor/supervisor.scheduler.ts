import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AiDecisionState } from '@crypton/db';
import { BUS_CHANNELS, BusService, CacheService, DbService, type BusMessage } from 'src/libs';
import { SupervisorPolicyService } from './supervisor.policy.service';
import { SupervisorService } from './supervisor.service';

/**
 * Cuando mira el supervisor.
 *
 * Dos disparos, y la diferencia entre ellos es todo lo que hay que entender:
 *
 *   - **Periodico**, cada pocos minutos, para los bots a los que les toca.
 *   - **Por operacion**, y «operacion» significa CICLO CERRADO, nunca un fill.
 *     Para un market maker un fill no es un acontecimiento —genera decenas por
 *     minuto— y lo que hay que juzgar es una media, no un evento. Ademas
 *     disparan los avisos de riesgo, que si son acontecimientos.
 *
 * `FILL` no entra en la tuberia, y es una constante y no una configuracion
 * precisamente para que nadie pueda encenderlo sin darse cuenta de lo que cuesta.
 */
@Injectable()
export class SupervisorScheduler implements OnModuleInit {
  private readonly logger = new Logger(SupervisorScheduler.name);

  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly bus: BusService,
    private readonly config: ConfigService,
    private readonly policy: SupervisorPolicyService,
    private readonly supervisor: SupervisorService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Se escucha aunque el interruptor este apagado, y es deliberado: si alguien
    // lo apaga con sugerencias ya enviadas, los botones de esos mensajes tienen
    // que poder al menos DESCARTARSE. Lo que el interruptor corta es preguntar
    // al modelo, no atender lo que ya se pregunto.
    const eventos$ = await this.bus.listen(BUS_CHANNELS.BOT_EVENTS);
    eventos$.subscribe((mensaje) => {
      // Con `catch`: esto consulta la base, y una promesa sin manejar tumba el
      // proceso entero en Node (001/F-07).
      void this.onEvento(mensaje).catch((e: Error) =>
        this.logger.warn(`Evento sin procesar por el supervisor: ${e.message}`),
      );
    });
    this.logger.log('Supervisor de IA activo');
  }

  /**
   * Un evento del motor puede adelantar una revision.
   *
   * No hace falta filtrar por replica: `reservarTurno` usa `setnx`, asi que de
   * las N replicas que reciben el mismo mensaje solo una se queda con el turno.
   * Es la misma primitiva que resuelve el enfriamiento, y resuelve las dos cosas
   * por el mismo precio.
   */
  private async onEvento(mensaje: BusMessage): Promise<void> {
    // La pulsacion de un boton de Telegram, que llega del worker que sondea.
    // No lleva `botId` a proposito: el vale es opaco y es la API quien sabe a que
    // decision corresponde.
    if (mensaje.type === 'AI_DECISION_TAKEN') {
      const datos = mensaje.data as { token?: string; aplicar?: boolean };
      if (typeof datos?.token !== 'string') return;
      await this.supervisor.canjearVale(mensaje.userId, datos.token, datos.aplicar === true);
      return;
    }

    if (!mensaje.botId || !DISPARAN.has(mensaje.type)) return;

    const severidad = (mensaje.data as { severity?: string })?.severity ?? 'INFO';
    // Un rechazo de orden solo cuenta si es grave: un market maker rechazado por
    // post-only es su conducta normal, y el spec 029 ya pago el precio de tratar
    // eso como una incidencia.
    if (mensaje.type === 'ORDER_REJECTED' && !['WARN', 'ERROR', 'CRITICAL'].includes(severidad)) {
      return;
    }

    const ajuste = await this.db.botAiSetting.findUnique({
      where: { bot_id: mensaje.botId },
      include: { bot: { select: BOT_SELECT } },
    });
    if (!ajuste || ajuste.mode === 'OFF') return;
    // Quien pidio solo revisiones periodicas no quiere que un evento le adelante
    // una: es la diferencia entre vigilar y reaccionar.
    if (ajuste.trigger === 'PERIODICO') return;
    if (ajuste.paused_until && ajuste.paused_until > new Date()) return;

    await this.supervisor.revisarBot(
      ajuste,
      ajuste.bot,
      mensaje.type === 'CYCLE_CLOSED' ? 'OPERACION' : 'RIESGO',
    );
  }

  /**
   * El barrido periodico.
   *
   * Cada cinco minutos y en SERIE, con un tope de bots por vuelta. En serie
   * porque cada revision es una llamada al modelo de hasta veinticinco segundos:
   * en paralelo competirian por el mismo presupuesto de caudal hacia los venues
   * al pedir las velas, y el peor caso dejaria de estar acotado.
   *
   * Detras de un cerrojo, como `markets-sync`: `@Cron` dispara en TODAS las
   * replicas, y sin esto cada ciclo pagaria N veces las mismas llamadas.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async barrer(): Promise<void> {
    if (this.config.get<string>('AI_AGENT_ENABLE', 'false') !== 'true') return;
    if (!(await this.cache.setnx('lock:ai-sweep', Date.now(), 280).catch(() => false))) return;

    const tope = Number(this.config.get<string>('AI_AGENT_SWEEP_MAX', '5')) || 5;
    const pendientes = await this.policy.pendientesDeRevision(tope);

    for (const ajuste of pendientes) {
      try {
        await this.supervisor.revisarBot(ajuste, ajuste.bot, 'CRON');
      } catch (e) {
        // Un bot que falla no puede llevarse por delante el barrido de los demas.
        this.logger.warn(`Revisión fallida de ${ajuste.bot_id}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Caduca lo que nadie aprobo a tiempo.
   *
   * Va aparte del barrido y con su propio cerrojo porque no cuesta nada y tiene
   * que ocurrir aunque el Modo IA este apagado: si alguien lo apaga con
   * propuestas vivas, esas propuestas no pueden quedarse esperando para siempre.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async caducar(): Promise<void> {
    if (!(await this.cache.setnx('lock:ai-expire', Date.now(), 540).catch(() => false))) return;

    const { count } = await this.db.botAiDecision.updateMany({
      where: { state: AiDecisionState.PROPUESTA, expires_at: { lt: new Date() } },
      data: { state: AiDecisionState.CADUCADA, discard_reason: 'PLAZO' },
    });
    if (count > 0) this.logger.debug(`${count} sugerencia(s) del supervisor caducadas.`);
  }
}

/**
 * Los eventos que adelantan una revision.
 *
 * `FILL` NO esta, y es lo mas importante de esta lista. Para un market maker un
 * fill es su conducta normal —decenas por minuto—, asi que dispararse con cada
 * uno seria pagar una llamada al modelo por cada ejecucion. Lo que el usuario
 * entiende por «una operacion» es un ciclo cerrado, y eso si esta.
 */
const DISPARAN = new Set([
  'CYCLE_CLOSED',
  'RISK_GUARD_TRIPPED',
  'LIQUIDATION_NEAR',
  'INSUFFICIENT_FUNDS',
  'POSITION_BELOW_MINIMUM',
  'ORDER_REJECTED',
]);

const BOT_SELECT = {
  id: true,
  user_id: true,
  strategy: true,
  venue: true,
  symbol: true,
  status: true,
  dry_run: true,
  config_version: true,
  exchange_account_id: true,
  started_at: true,
} as const;
