import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '@crypton/db';
import {
  AccionTrader,
  BotStatus,
  CLAVE_INTERRUPTOR_CANAL,
  EstadoIntencion,
  EventSeverity,
  MotivoConsulta,
  NivelConfianza,
  StrategyKind,
  interruptorCerrado,
  type BotConfig,
  type EspacioTrader,
  type FalloGuardado,
  type RespuestaTrader,
  type VeredictoTrader,
  type Venue,
} from '@crypton/shared';
import {
  cuantiza,
  estadoTrader,
  leerConfigTrader,
  type ConfigTrader,
} from '@crypton/strategy-core';
import { BUS_CHANNELS, BusService, CacheService, DbService } from 'src/libs';
import { parseRespuestaTrader } from './contrato';
import { VERSION_PREGUNTAS, preguntasTrader } from './preguntas';
import { TypeSafeClient } from './typesafe.client';

/**
 * El lazo del «Bot de IA» (spec 069): de una solicitud del worker a una
 * decisión escrita.
 *
 * Es hermano del del canal y **no comparte código con él a propósito**. El plan
 * proponía extraer el lazo a un servicio común; se descartó al escribirlo: son
 * doscientas líneas de ganancia contra tocar un camino pagado con incidentes y
 * con dinero dentro. Lo que sí se comparte es lo que de verdad importaba —el
 * vocabulario del resultado—, así que dos decisiones de dos proveedores se
 * comparan en `bot_ai_intents` sin saber de qué estrategia son.
 *
 * El reparto es el de siempre: el worker calculó la oferta y la ejecutará con
 * datos frescos; aquí solo se pregunta. Y se pregunta poco:
 * - una solicitud se reclama con una actualización CONDICIONAL, así que dos
 *   réplicas nunca llaman por la misma;
 * - antes de llamar se comprueba todo lo que haría inútil la llamada, y el cupo
 *   se cuenta ANTES, no después de acertar;
 * - sin respuesta válida no hay decisión, y un fallo cuenta para dormir las
 *   consultas de ese bot.
 *
 * Nunca manda órdenes ni toca configuración. No importa
 * `ExchangeAccountsModule`: aquí no hace falta descifrar nada (invariante 8).
 */

/** Lo mínimo que tiene que quedar hasta el plazo para que merezca la pena llamar. */
export const MIN_PLAZO_LLAMADA_MS = 8_000;
/** Lo que se reserva tras la llamada para escribir la decisión y que el worker llegue. */
export const MARGEN_ESCRITURA_MS = 3_000;
/** Fallos seguidos del proveedor antes de dormir las consultas del bot. */
export const TOPE_FALLOS = 5;
export const PAUSA_FALLOS_MS = 6 * 3_600_000;
const DIA_MS = 86_400_000;

/** El dueño de un «Bot de IA»: administrador y con la cuenta habilitada. */
export const DUENO_CON_TRADER = { role: Role.ADMIN, disabled: false } as const;

/**
 * Las claves de los cupos diarios, por día UTC.
 *
 * **Propias, y distintas de las del canal**: los dos bots compiten por la misma
 * factura pero no por el mismo presupuesto, y mezclarlas haría que un canal
 * hablador dejara sin consultas a un «Bot de IA» que apenas pregunta.
 */
export const diaDelCupo = (ahora: number): string => new Date(ahora).toISOString().slice(0, 10);
export const claveCupoBot = (botId: string, dia: string): string =>
  `ai:quota-trader:bot:${botId}:${dia}`;
export const claveCupoGlobal = (dia: string): string => `ai:quota-trader:global:${dia}`;

export interface ResultadoConsulta {
  estado: EstadoIntencion;
  motivo: string | null;
  /** false si la intención cambió mientras se consultaba y no se escribió. */
  escrita: boolean;
}

interface BotDeLaSolicitud {
  id: string;
  user_id: string;
  strategy: string;
  status: string;
  venue: string;
  config_version: number;
  user: { role: string; disabled: boolean };
}

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * La oferta guardada tiene la forma que hace falta. La escribió el worker, pero
 * sale de una columna JSON, así que no se da por buena sin mirar.
 */
export function esEspacioTrader(v: unknown): v is EspacioTrader {
  if (!esObjeto(v) || v['version'] !== 1 || typeof v['barT'] !== 'number') return false;
  if (typeof v['huella'] !== 'string' || !Array.isArray(v['esqueletos'])) return false;
  const b = v['banda'];
  return esObjeto(esObjeto(v['senal']) ? v['senal'] : null) && esObjeto(b);
}

@Injectable()
export class AiTraderService {
  private readonly logger = new Logger(AiTraderService.name);
  /** Consultas en marcha en esta réplica. */
  private enCurso = 0;

  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly bus: BusService,
    private readonly config: ConfigService,
    private readonly modelo: TypeSafeClient,
  ) {}

  // ── Configuración ────────────────────────────────────────────────────────

  private num(nombre: string, defecto: number, min: number, max: number): number {
    const v = Number(this.config.get<string>(nombre, String(defecto)));
    return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : defecto;
  }

  /** El interruptor del servidor Y la clave: las dos cosas hacen falta para llamar. */
  get encendido(): boolean {
    return this.modelo.disponible;
  }

  get soloSombra(): boolean {
    return this.config.get<string>('AI_TRADER_SHADOW_ONLY', 'false') === 'true';
  }

  get modeloId(): string {
    return this.modelo.modelo;
  }

  get concurrencia(): number {
    return this.num('AI_TRADER_CONCURRENCY', 4, 1, 32);
  }

  /** El plazo de una llamada, con el tope duro del transporte. */
  get plazoLlamadaMs(): number {
    return this.num('AI_TRADER_TIMEOUT_MS', 20_000, 1_000, 25_000);
  }

  get limiteBot(): number {
    // 300 y no 48 (spec 070): el maximo teorico a 5 min son 288 velas al dia, y
    // a 0,000081 $ la llamada eso son dos centimos y medio AL MES. El 48 venia
    // calibrado para un modelo trescientas veces mas caro.
    return this.num('AI_TRADER_DAILY_LIMIT', 300, 1, 10_000);
  }

  get limiteGlobal(): number {
    // Una docena de bots a la cadencia mas rapida caben de sobra.
    return this.num('AI_TRADER_GLOBAL_DAILY_LIMIT', 5_000, 1, 1_000_000);
  }

  /** Cuántas consultas más caben ahora en esta réplica. */
  get huecos(): number {
    return Math.max(0, this.concurrencia - this.enCurso);
  }

  // ── El lazo ──────────────────────────────────────────────────────────────

  /**
   * Atiende una solicitud. Devuelve null si no le toca a esta réplica: no hay
   * hueco, o la solicitud ya no está pendiente.
   *
   * El hueco se reserva ANTES del primer `await`: dos llamadas en el mismo
   * instante no pueden pasar las dos por un hueco que solo es de una.
   */
  async atender(intentId: string): Promise<ResultadoConsulta | null> {
    if (this.enCurso >= this.concurrencia) return null;
    this.enCurso++;
    try {
      const reclamada = await this.db.botAiIntent.updateMany({
        where: {
          id: intentId,
          estado: EstadoIntencion.SOLICITADA,
          expires_at: { gt: new Date() },
        },
        data: { estado: EstadoIntencion.CONSULTANDO },
      });
      if (reclamada.count !== 1) return null;
      return await this.consultar(intentId);
    } finally {
      this.enCurso--;
    }
  }

  private async consultar(id: string): Promise<ResultadoConsulta> {
    const fila = await this.db.botAiIntent.findUnique({
      where: { id },
      select: {
        id: true,
        expires_at: true,
        snapshot: true,
        bot: {
          select: {
            id: true,
            user_id: true,
            strategy: true,
            status: true,
            venue: true,
            config_version: true,
            user: { select: { role: true, disabled: true } },
          },
        },
      },
    });
    if (!fila) return { estado: EstadoIntencion.CADUCADA, motivo: null, escrita: false };
    const bot: BotDeLaSolicitud = fila.bot;
    const cerrar = (estado: EstadoIntencion, motivo: MotivoConsulta) =>
      this.cerrar(id, estado, motivo, {});

    // Las barreras, en orden. La primera que falla cierra sin llamar.
    if (!this.encendido) return cerrar(EstadoIntencion.SIN_ENTRADA, MotivoConsulta.IA_APAGADA);
    if (bot.user.role !== DUENO_CON_TRADER.role || bot.user.disabled) {
      return cerrar(EstadoIntencion.SIN_ENTRADA, MotivoConsulta.DUENO);
    }
    // Simétrico al del canal: lo que es del otro lazo se SUELTA, no se cierra.
    if (bot.strategy === StrategyKind.AI_CHANNEL) return this.soltar(id);
    if (bot.status !== BotStatus.RUNNING || bot.strategy !== StrategyKind.AI_TRADER) {
      return cerrar(EstadoIntencion.SIN_ENTRADA, MotivoConsulta.ESTADO_BOT);
    }
    const ahora = Date.now();
    const lazo = await this.db.botAiLoop.findUnique({
      where: { bot_id: bot.id },
      select: { pausado_hasta: true },
    });
    if (lazo?.pausado_hasta && lazo.pausado_hasta.getTime() > ahora) {
      return cerrar(EstadoIntencion.SIN_ENTRADA, MotivoConsulta.PAUSA_FALLOS);
    }
    let cortado: boolean;
    try {
      // El MISMO interruptor que el canal, no uno propio: el worker ya lo aplica
      // a las dos estrategias, y dos interruptores serían un operador cerrando
      // uno y creyendo que ha cerrado todo.
      cortado = interruptorCerrado(await this.cache.getTextoOrThrow(CLAVE_INTERRUPTOR_CANAL));
    } catch {
      return cerrar(EstadoIntencion.SIN_ENTRADA, MotivoConsulta.REDIS);
    }
    if (cortado) return cerrar(EstadoIntencion.SIN_ENTRADA, MotivoConsulta.INTERRUPTOR);
    const restante = fila.expires_at.getTime() - ahora;
    if (restante < MIN_PLAZO_LLAMADA_MS) {
      return cerrar(EstadoIntencion.CADUCADA, MotivoConsulta.PLAZO);
    }

    // Lo que se ofrece, ANTES del cupo: una oferta sin celdas viables no gasta
    // una llamada ni una de las del día.
    const espacio = esEspacioTrader(fila.snapshot) ? fila.snapshot : null;
    const cfg = await this.configDe(bot);
    const hayCelda = espacio?.esqueletos.some((x) => x.viable) ?? false;
    if (!espacio || !cfg || !hayCelda) {
      if (!espacio) this.logger.error(`La solicitud ${id} no trae una oferta legible.`);
      return cerrar(EstadoIntencion.SIN_ENTRADA, MotivoConsulta.OFERTA);
    }

    const cupo = await this.cabeLlamada(bot.id, Math.min(cfg.presupuestoIaDia, this.limiteBot));
    if (cupo) return cerrar(EstadoIntencion.SIN_ENTRADA, cupo);

    return this.llamar(id, bot, espacio, cfg, restante);
  }

  private async llamar(
    id: string,
    bot: BotDeLaSolicitud,
    espacio: EspacioTrader,
    cfg: ConfigTrader,
    restante: number,
  ): Promise<ResultadoConsulta> {
    const plazo = this.plazoLlamadaMs;
    const limite = Math.min(plazo, restante - MARGEN_ESCRITURA_MS);
    // El estado lo genera `strategy-core`, no la API: el backtest tiene que
    // poder producir el mismo byte a byte para replicar al modelo sin red.
    const estado = estadoTrader(espacio, cfg);
    const r = await this.modelo.preguntar({
      estado,
      preguntas: preguntasTrader(estado),
      limiteMs: limite,
    });
    const ahora = Date.now();
    const comun = {
      modelo: r.modelo,
      prompt_version: VERSION_PREGUNTAS,
      latencia_ms: r.latenciaMs,
      // TypeSafe no publica tarifas: `null` y los tokens dentro de la decisión.
      // Un número inventado en una columna Decimal(38,18) no tiene vuelta atrás.
      coste: null,
    };
    const tokens = r.uso ? { tokens_entrada: r.uso.entrada, tokens_salida: r.uso.salida } : {};

    // Sin respuesta.
    if (r.answers === null || r.fallo !== null) {
      const fallo = r.fallo ?? 'VACIA';
      // Un tiempo agotado con el plazo ya recortado es de la solicitud, que
      // llegó tarde, no del proveedor: no cuenta como fallo suyo.
      if (fallo === 'TIEMPO' && limite < plazo) {
        await this.anotarLazo(bot.id, 'NADA', null, ahora);
        const res = await this.cerrar(id, EstadoIntencion.CADUCADA, MotivoConsulta.PLAZO, {
          ...comun,
          decision: { fallo, ...tokens } satisfies FalloGuardado & Record<string, unknown>,
        });
        await this.anotarDecision(bot, id, res, null, null, fallo);
        return res;
      }
      return this.fallo(id, bot, { fallo, ...tokens }, comun, ahora);
    }

    const c = parseRespuestaTrader(r.answers);
    if (!c.respuesta) {
      return this.fallo(
        id,
        bot,
        { fallo: 'CONTRATO', bruto: c.fallo.faltan.join(','), ...tokens },
        comun,
        ahora,
      );
    }

    // Una respuesta válida, opere o no, rompe la racha de fallos.
    await this.anotarLazo(bot.id, 'CERO', null, ahora);

    // ── La frontera del invariante 13 ──
    // Aquí es donde los números de opinión del proveedor —probabilidades y
    // confianzas— se convierten en enumeraciones. Nada aguas abajo vuelve a
    // verlos: se guardan en crudo solo como constancia.
    const veredicto = cuantiza(c.respuesta, cfg);
    const motivo = this.motivoDe(veredicto);
    const decision = { ...veredicto, respuesta: c.respuesta, ...tokens };
    const candidato = `${veredicto.stop}|${veredicto.objetivo}`;

    let res: ResultadoConsulta;
    if (motivo) {
      res = await this.cerrar(id, EstadoIntencion.SIN_ENTRADA, motivo, { ...comun, decision });
    } else if (this.soloSombra) {
      res = await this.cerrar(id, EstadoIntencion.SIN_ENTRADA, MotivoConsulta.SOMBRA, {
        ...comun,
        decision,
        candidato_id: candidato,
      });
    } else {
      res = await this.cerrar(id, EstadoIntencion.DECIDIDA, null, {
        ...comun,
        decision,
        candidato_id: candidato,
      });
    }
    await this.anotarDecision(bot, id, res, c.respuesta, veredicto, null);
    if (res.estado === EstadoIntencion.DECIDIDA && res.escrita) {
      // Solo adelanta: el worker también mira en cada latido.
      await this.bus
        .publish(BUS_CHANNELS.BOT_AI_INTENTS, {
          userId: bot.user_id,
          botId: bot.id,
          type: 'AI_INTENT_DECIDED',
          data: { intentId: id },
        })
        .catch(() => undefined);
    }
    return res;
  }

  /**
   * Por qué una respuesta válida no llega a ser una decisión ejecutable, o null
   * si sí lo es.
   *
   * Las tres puertas son las del invariante del spec: **todo lo que no es el
   * `choice` solo puede restar**. Ninguna amplía nada.
   */
  private motivoDe(v: VeredictoTrader): MotivoConsulta | null {
    if (v.accion !== AccionTrader.TOMAR) return MotivoConsulta.NO_OPERAR;
    if (!v.acuerdo) return MotivoConsulta.DESACUERDO;
    if (v.confianza === NivelConfianza.BAJA) return MotivoConsulta.CONFIANZA;
    return null;
  }

  /** El proveedor no dio una respuesta utilizable: cuenta, puede dormir el lazo y avisa. */
  private async fallo(
    id: string,
    bot: BotDeLaSolicitud,
    fallo: FalloGuardado & Record<string, unknown>,
    comun: Record<string, unknown>,
    ahora: number,
  ): Promise<ResultadoConsulta> {
    const motivo = fallo.fallo === 'CONTRATO' ? MotivoConsulta.CONTRATO : MotivoConsulta.MODELO;
    const fallos = await this.anotarLazo(bot.id, 'SUMA', `${motivo}:${fallo.fallo}`, ahora);
    const res = await this.cerrar(id, EstadoIntencion.FALLIDA, motivo, {
      ...comun,
      decision: fallo,
    });
    await this.anotarDecision(bot, id, res, null, null, fallo.fallo);
    // Uno por bot y hora: un fallo que avisa en cada vela enseña a silenciar
    // justo antes del aviso que sí había que leer (spec 029). Salvo el que
    // anuncia la PAUSA de 6 h, que es un cambio de estado del bot y pasa una
    // sola vez (spec 062, F-13).
    const pausa = fallos >= TOPE_FALLOS;
    const toca =
      pausa || (await this.cache.setnx(`ai:fail-trader:${bot.id}`, 1, 3600).catch(() => false));
    if (toca) {
      await this.avisar(
        bot,
        'AI_FAILED',
        pausa
          ? 'La IA del «Bot de IA» falla repetidamente: sin consultas durante 6 h. El bot no ' +
              'abre operaciones mientras tanto; las abiertas siguen con su stop.'
          : 'La IA no ha dado una respuesta válida: esa vela no abre operación.',
        EventSeverity.WARN,
        true,
      );
    }
    return res;
  }

  /**
   * Devuelve la solicitud a `SOLICITADA`: no era de este lazo (spec 069).
   *
   * No cuenta como consulta, no gasta cupo y no escribe evento. El lazo del
   * canal la recoge en su sondeo siguiente.
   */
  private async soltar(id: string): Promise<ResultadoConsulta> {
    const r = await this.db.botAiIntent.updateMany({
      where: { id, estado: EstadoIntencion.CONSULTANDO },
      data: { estado: EstadoIntencion.SOLICITADA },
    });
    return { estado: EstadoIntencion.SOLICITADA, motivo: null, escrita: r.count === 1 };
  }

  /**
   * Escribe el resultado si la intención sigue en `CONSULTANDO`. Si el worker
   * la caducó mientras tanto —un comando, una recarga—, no se pisa.
   */
  private async cerrar(
    id: string,
    estado: EstadoIntencion,
    motivo: string | null,
    extra: Record<string, unknown>,
  ): Promise<ResultadoConsulta> {
    const r = await this.db.botAiIntent.updateMany({
      where: { id, estado: EstadoIntencion.CONSULTANDO },
      // Frontera Prisma-JSON: `decision` es un objeto plano y serializable.
      data: { estado, motivo, ...extra } as never,
    });
    if (r.count !== 1) {
      this.logger.warn(
        `La intención ${id} cambió mientras se consultaba: no se escribe ${estado}.`,
      );
    }
    return { estado, motivo, escrita: r.count === 1 };
  }

  /** La configuración vigente del bot, leída como la lee el motor. */
  private async configDe(bot: BotDeLaSolicitud): Promise<ConfigTrader | null> {
    const revision = await this.db.botConfigRevision.findUnique({
      where: { bot_id_version: { bot_id: bot.id, version: bot.config_version } },
      select: { config: true },
    });
    if (!revision || !esObjeto(revision.config)) return null;
    // Frontera Prisma-JSON: la configuración se guardó validada.
    return leerConfigTrader(revision.config as unknown as BotConfig, bot.venue as Venue);
  }

  /**
   * ¿Cabe otra llamada? Devuelve null si cabe, o por qué no.
   *
   * Se cuenta ANTES de llamar: contando solo los aciertos, veinte solicitudes a
   * la vez pasarían todas antes de que terminara ninguna. El del bot va
   * primero, para que un bot sin cupo no gaste el de los demás. Sin Redis no
   * hay contador, y sin contador no se llama: al otro lado hay una factura.
   */
  private async cabeLlamada(botId: string, topeBot: number): Promise<MotivoConsulta | null> {
    const dia = diaDelCupo(Date.now());
    const porBot = await this.cache
      .incrWithExpire(claveCupoBot(botId, dia), 86_400)
      .catch(() => -1);
    if (porBot < 0) return MotivoConsulta.REDIS;
    if (porBot > topeBot) return MotivoConsulta.CUPO_BOT;
    const global = await this.cache.incrWithExpire(claveCupoGlobal(dia), 86_400).catch(() => -1);
    if (global < 0) return MotivoConsulta.REDIS;
    if (global > this.limiteGlobal) {
      this.logger.warn('Cupo diario global del «Bot de IA» agotado.');
      return MotivoConsulta.CUPO_GLOBAL;
    }
    return null;
  }

  /**
   * El contador del lazo: la llamada y la racha de fallos. Devuelve los fallos
   * seguidos que quedan.
   *
   * El coste va siempre a cero porque **este proveedor no publica tarifas**: lo
   * que se puede contar son las llamadas, y eso se cuenta.
   */
  private async anotarLazo(
    botId: string,
    fallo: 'SUMA' | 'CERO' | 'NADA',
    error: string | null,
    ahora: number,
  ): Promise<number> {
    const dia = new Date(Math.floor(ahora / DIA_MS) * DIA_MS);
    const previa = await this.db.botAiLoop.findUnique({
      where: { bot_id: botId },
      select: { dia: true },
    });
    const uso =
      previa?.dia?.getTime() === dia.getTime()
        ? { llamadas_hoy: { increment: 1 } }
        : { dia, llamadas_hoy: 1, coste_hoy: '0' };
    const racha =
      fallo === 'SUMA'
        ? { fallos: { increment: 1 }, ultimo_error: error }
        : fallo === 'CERO'
          ? { fallos: 0 }
          : {};
    const f = await this.db.botAiLoop.upsert({
      where: { bot_id: botId },
      create: {
        bot_id: botId,
        dia,
        llamadas_hoy: 1,
        coste_hoy: '0',
        fallos: fallo === 'SUMA' ? 1 : 0,
        ultimo_error: error,
      },
      update: { ...uso, ...racha },
      select: { fallos: true },
    });
    if (fallo === 'SUMA' && f.fallos >= TOPE_FALLOS) {
      // Sin esto, un proveedor caído genera una llamada por vela y por bot.
      await this.db.botAiLoop.update({
        where: { bot_id: botId },
        data: { pausado_hasta: new Date(ahora + PAUSA_FALLOS_MS) },
      });
    }
    return f.fallos;
  }

  // ── Avisos ───────────────────────────────────────────────────────────────

  /** La decisión en la línea de tiempo del bot. En INFO y sin entrega forzada. */
  private async anotarDecision(
    bot: BotDeLaSolicitud,
    intentId: string,
    res: ResultadoConsulta,
    respuesta: RespuestaTrader | null,
    veredicto: VeredictoTrader | null,
    fallo: string | null,
  ): Promise<void> {
    await this.avisar(
      bot,
      'AI_DECISION',
      textoDecisionTrader(res, respuesta, veredicto, fallo),
      EventSeverity.INFO,
      false,
      { intentId, estado: res.estado, motivo: res.motivo },
    );
  }

  /** Escribe el evento y lo publica. */
  private async avisar(
    bot: { id: string; user_id: string },
    tipo: string,
    mensaje: string,
    severidad: EventSeverity,
    forzada: boolean,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    await this.db.botEvent
      .create({
        data: {
          bot_id: bot.id,
          type: tipo,
          severity: severidad,
          message: mensaje,
          payload: payload as never,
        },
      })
      .catch(() => undefined);
    await this.bus
      .publish(BUS_CHANNELS.BOT_EVENTS, {
        userId: bot.user_id,
        botId: bot.id,
        type: tipo,
        ...(forzada ? { entregaForzada: true } : {}),
        data: { ...payload, severity: severidad, message: mensaje },
      })
      .catch(() => undefined);
  }

  // ── Mantenimiento ────────────────────────────────────────────────────────

  /**
   * Caduca lo que nadie terminó a tiempo.
   *
   * SIN filtrar por estrategia, y no es un descuido: una intención vencida está
   * vencida sea de quien sea, y los dos lazos hacen el mismo trabajo idempotente
   * con su propio cerrojo. Filtrarlo obligaría a que cada uno dependiera de que
   * el otro esté vivo para limpiar lo suyo.
   */
  async caducarVencidas(ahora: number): Promise<number> {
    const r = await this.db.botAiIntent.updateMany({
      where: {
        estado: {
          in: [EstadoIntencion.SOLICITADA, EstadoIntencion.CONSULTANDO, EstadoIntencion.DECIDIDA],
        },
        expires_at: { lt: new Date(ahora - 30_000) },
      },
      data: { estado: EstadoIntencion.CADUCADA, motivo: MotivoConsulta.PLAZO },
    });
    return r.count;
  }

  /** Las solicitudes pendientes y vigentes de ESTA estrategia, las más antiguas primero. */
  async pendientes(limite: number): Promise<string[]> {
    if (limite <= 0) return [];
    const filas = await this.db.botAiIntent.findMany({
      where: {
        estado: EstadoIntencion.SOLICITADA,
        expires_at: { gt: new Date() },
        bot: { strategy: StrategyKind.AI_TRADER },
      },
      orderBy: { created_at: 'asc' },
      take: limite,
      select: { id: true },
    });
    return filas.map((f) => f.id);
  }

  /** La solicitud de un bot para una vela, si sigue pendiente. */
  async solicitudDe(botId: string, barT: number): Promise<string | null> {
    const fila = await this.db.botAiIntent.findFirst({
      where: {
        bot_id: botId,
        bar_t: new Date(barT),
        kind: 'ENTRADA',
        estado: EstadoIntencion.SOLICITADA,
        bot: { strategy: StrategyKind.AI_TRADER },
      },
      select: { id: true },
    });
    return fila?.id ?? null;
  }
}

const ACCION_ES: Readonly<Record<string, string>> = {
  TOMAR: 'tomar el toque',
  ESPERAR: 'esperar un toque mejor',
  ENTORNO_EQUIVOCADO: 'no operar: entorno equivocado',
};

/** El texto del evento `AI_DECISION` del «Bot de IA». */
export function textoDecisionTrader(
  res: ResultadoConsulta,
  respuesta: RespuestaTrader | null,
  veredicto: VeredictoTrader | null,
  fallo: string | null,
): string {
  if (fallo) {
    return res.estado === EstadoIntencion.CADUCADA
      ? 'La IA no respondió a tiempo: la solicitud llegó tarde.'
      : `La IA no dio una respuesta válida (${fallo}).`;
  }
  if (!veredicto) return 'La IA no dejó una decisión legible.';
  const que = ACCION_ES[veredicto.accion] ?? veredicto.accion;
  // Las probabilidades del enrutado son la explicación más rica que hay, y son
  // números, no prosa: se enseñan en vez de pedirle al modelo una frase.
  const p = respuesta
    ? Math.round((respuesta.accion.probabilidades[veredicto.accion] ?? 0) * 100)
    : 0;
  const detalle =
    `${que} (${p} %, confianza ${veredicto.confianza}), stop ${veredicto.stop}, ` +
    `objetivo ${veredicto.objetivo}, tamaño ${veredicto.tamano}`;
  if (res.motivo === MotivoConsulta.SOMBRA) return `Modo sombra: la IA habría elegido ${detalle}.`;
  if (res.motivo === MotivoConsulta.DESACUERDO) {
    return `La IA elige ${detalle}, pero una puerta de contexto lo veta: no se opera.`;
  }
  if (res.motivo === MotivoConsulta.CONFIANZA) {
    return `La IA elige ${detalle}, con menos confianza de la pedida: no se opera.`;
  }
  if (res.motivo === MotivoConsulta.NO_OPERAR) return `La IA prefiere ${que}.`;
  return `La IA elige ${detalle}.`;
}
