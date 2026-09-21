import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '@crypton/db';
import {
  ActorKind,
  AuditOutcome,
  BotStatus,
  CLAVE_INTERRUPTOR_CANAL,
  EstadoIntencion,
  EventSeverity,
  MotivoConsulta,
  StrategyKind,
  claveValeCanal,
  esValeCanal,
  interruptorCerrado,
  type BotConfig,
  type CandidatoOperacion,
  type EleccionOperacion,
  type FalloGuardado,
  type RespuestaModeloCanal,
  type SalidaHerramienta,
  type ValeCanal,
  type Venue,
} from '@crypton/shared';
import { leerConfigCanal, type ConfigCanal } from '@crypton/strategy-core';
import { AuditService, BUS_CHANNELS, BusService, CacheService, DbService } from 'src/libs';
import { OpenRouterClient } from '../advisor/openrouter.client';
import { BotsService } from '../bots/bots.service';
import { esquemaDecision, parseDecision, recortarSinPartir, validarEleccion } from './contrato';
import { ofertaDe, renderHerramienta, type OfertaCanal } from './herramienta';
import { systemPromptCanal, versionPrompt } from './prompt';

/**
 * El lazo de la IA del canal (spec 059): de una solicitud del worker a una
 * decisión escrita.
 *
 * El reparto es el de siempre: el worker calculó la oferta y ejecutará la
 * decisión con datos frescos; aquí solo se pregunta. Y se pregunta poco:
 * - una solicitud se reclama con una actualización condicional, así que dos
 *   réplicas nunca llaman por la misma;
 * - antes de llamar se comprueba todo lo que haría inútil la llamada, y el
 *   cupo se cuenta ANTES, no después de acertar;
 * - sin respuesta válida no hay decisión, y un fallo cuenta para dormir las
 *   consultas de ese bot.
 *
 * Nunca manda órdenes ni toca configuración. No importa
 * `ExchangeAccountsModule`: aquí no hace falta descifrar nada.
 */

/** Lo mínimo que tiene que quedar hasta el plazo para que merezca la pena llamar. */
export const MIN_PLAZO_LLAMADA_MS = 8_000;
/** Lo que se reserva tras la llamada para escribir la decisión y que el worker llegue. */
export const MARGEN_ESCRITURA_MS = 3_000;
/** Fallos seguidos del modelo antes de dormir las consultas del bot. */
export const TOPE_FALLOS = 5;
export const PAUSA_FALLOS_MS = 6 * 3_600_000;
/** Lo que se guarda de una respuesta fuera del contrato, para poder mirarla. */
const MAX_BRUTO = 2_000;
const DIA_MS = 86_400_000;

/** El dueño de un bot del canal: administrador y con la cuenta habilitada. */
export const DUENO_CON_CANAL = { role: Role.ADMIN, disabled: false } as const;

/**
 * Las claves de los cupos diarios, por día UTC. Las cuenta este servicio y las
 * lee la consola: una sola definición, para que no lean una y escriban otra.
 */
export const diaDelCupo = (ahora: number): string => new Date(ahora).toISOString().slice(0, 10);
export const claveCupoBot = (botId: string, dia: string): string =>
  `ai:quota-canal:bot:${botId}:${dia}`;
export const claveCupoGlobal = (dia: string): string => `ai:quota-canal:global:${dia}`;

export interface ResultadoConsulta {
  estado: EstadoIntencion;
  motivo: string | null;
  /** false si la intención cambió mientras se consultaba y no se escribió. */
  escrita: boolean;
}

/** Lo que devuelve el canje del botón de pausa. */
export type ResultadoPausa = 'PAUSADO' | 'SIN_VALE' | 'AJENO' | 'DUENO' | 'NO_VIVO';

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
 * La herramienta guardada tiene la forma que el render necesita. La escribió
 * el worker, pero sale de una columna JSON.
 */
export function esSalidaHerramienta(v: unknown): v is SalidaHerramienta {
  if (!esObjeto(v) || v['version'] !== 1 || typeof v['barT'] !== 'number') return false;
  const m = v['mercado'];
  const u = v['uso'];
  const c = v['canal'];
  return (
    esObjeto(m) &&
    typeof m['precio'] === 'string' &&
    typeof m['atr15m'] === 'string' &&
    esObjeto(u) &&
    Array.isArray(v['candidatos']) &&
    (c === null || (esObjeto(c) && typeof c['soporte'] === 'string'))
  );
}

@Injectable()
export class AiChannelService {
  private readonly logger = new Logger(AiChannelService.name);
  /** Consultas en marcha en esta réplica. */
  private enCurso = 0;

  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly bus: BusService,
    private readonly config: ConfigService,
    private readonly modelo: OpenRouterClient,
    private readonly bots: BotsService,
    private readonly audit: AuditService,
  ) {}

  // ── Configuración ────────────────────────────────────────────────────────

  private num(nombre: string, defecto: number, min: number, max: number): number {
    const v = Number(this.config.get<string>(nombre, String(defecto)));
    return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : defecto;
  }

  /** El interruptor del servidor Y la clave: las dos cosas que hacen falta para llamar. */
  get encendido(): boolean {
    return (
      this.config.get<string>('AI_CHANNEL_ENABLE', 'false') === 'true' &&
      this.modelo.canalDisponible
    );
  }

  get soloSombra(): boolean {
    return this.config.get<string>('AI_CHANNEL_SHADOW_ONLY', 'false') === 'true';
  }

  get modeloId(): string {
    return this.modelo.canalModelo;
  }

  get concurrencia(): number {
    return this.num('AI_CHANNEL_CONCURRENCY', 4, 1, 32);
  }

  /** El plazo de una llamada, con el tope de 25 s del transporte. */
  get plazoLlamadaMs(): number {
    return this.num('AI_CHANNEL_TIMEOUT_MS', 20_000, 1_000, 25_000);
  }

  get limiteBot(): number {
    return this.num('AI_CHANNEL_DAILY_LIMIT', 48, 1, 10_000);
  }

  get limiteGlobal(): number {
    return this.num('AI_CHANNEL_GLOBAL_DAILY_LIMIT', 400, 1, 1_000_000);
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
    if (bot.user.role !== DUENO_CON_CANAL.role || bot.user.disabled) {
      return cerrar(EstadoIntencion.SIN_ENTRADA, MotivoConsulta.DUENO);
    }
    // Desde el spec 069 hay dos lazos mirando esta misma tabla. Una solicitud
    // que es del OTRO no se cierra: se SUELTA, y su lazo la recoge en el sondeo
    // siguiente. Cerrarla la mataba —el «Bot de IA» no operaba nunca y el motivo
    // parecia un problema suyo—, y no reclamarla no es posible: el filtro tendria
    // que ir en la actualizacion condicional, y ahi no caben relaciones.
    //
    // Solo se suelta lo que es de alguien. Una solicitud de una estrategia que no
    // tiene lazo no la va a recoger nadie, asi que esa si se cierra.
    if (bot.strategy === StrategyKind.AI_TRADER) return this.soltar(id);
    if (bot.status !== BotStatus.RUNNING || bot.strategy !== StrategyKind.AI_CHANNEL) {
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
      cortado = interruptorCerrado(await this.cache.getTextoOrThrow(CLAVE_INTERRUPTOR_CANAL));
    } catch {
      return cerrar(EstadoIntencion.SIN_ENTRADA, MotivoConsulta.REDIS);
    }
    if (cortado) return cerrar(EstadoIntencion.SIN_ENTRADA, MotivoConsulta.INTERRUPTOR);
    const restante = fila.expires_at.getTime() - ahora;
    if (restante < MIN_PLAZO_LLAMADA_MS) {
      return cerrar(EstadoIntencion.CADUCADA, MotivoConsulta.PLAZO);
    }

    // Lo que se ofrece, antes del cupo: una oferta vacía no gasta una llamada.
    const salida = esSalidaHerramienta(fila.snapshot) ? fila.snapshot : null;
    const cfg = await this.configDe(bot);
    const oferta = salida && cfg ? ofertaDe(salida, cfg) : null;
    if (!salida || !cfg || !oferta || oferta.etiquetas.length === 0) {
      if (!salida) this.logger.error(`La solicitud ${id} no trae una herramienta legible.`);
      return cerrar(EstadoIntencion.SIN_ENTRADA, MotivoConsulta.OFERTA);
    }

    const cupo = await this.cabeLlamada(bot.id, Math.min(cfg.presupuestoIaDia, this.limiteBot));
    if (cupo) return cerrar(EstadoIntencion.SIN_ENTRADA, cupo);

    return this.llamar(id, bot, salida, oferta, cfg, restante);
  }

  private async llamar(
    id: string,
    bot: BotDeLaSolicitud,
    salida: SalidaHerramienta,
    oferta: OfertaCanal,
    cfg: ConfigCanal,
    restante: number,
  ): Promise<ResultadoConsulta> {
    const plazo = this.plazoLlamadaMs;
    const limite = Math.min(plazo, restante - MARGEN_ESCRITURA_MS);
    const r = await this.modelo.decidirCanal({
      esquema: esquemaDecision(oferta.etiquetas),
      system: systemPromptCanal(),
      usuario: renderHerramienta(salida, oferta, cfg),
      limiteMs: limite,
    });
    const ahora = Date.now();
    const coste = r.uso?.coste ?? null;
    const comun = {
      modelo: r.modelo,
      prompt_version: versionPrompt(),
      latencia_ms: r.latenciaMs,
      coste,
    };

    // Sin respuesta.
    if (r.contenido === null || r.fallo !== null) {
      const fallo = r.fallo ?? 'VACIA';
      // Un tiempo agotado con el plazo ya recortado es de la solicitud, que
      // llegó tarde, no del modelo: no cuenta como fallo.
      if (fallo === 'TIEMPO' && limite < plazo) {
        await this.anotarLazo(bot.id, coste, 'NADA', null, ahora);
        const res = await this.cerrar(id, EstadoIntencion.CADUCADA, MotivoConsulta.PLAZO, {
          ...comun,
          decision: { fallo } satisfies FalloGuardado,
        });
        await this.anotarDecision(bot, id, res, null, null, fallo);
        return res;
      }
      return this.fallo(id, bot, { fallo }, comun, ahora);
    }

    const respuesta = parseDecision(r.contenido, oferta.etiquetas);
    if (!respuesta) {
      const bruto = recortarSinPartir(r.contenido, MAX_BRUTO);
      return this.fallo(id, bot, { fallo: 'CONTRATO', bruto }, comun, ahora);
    }

    // Una respuesta válida, opere o no, rompe la racha de fallos.
    await this.anotarLazo(bot.id, coste, 'CERO', null, ahora);
    const v = validarEleccion(respuesta, oferta, cfg.confianzaMinima);
    const candidato = v.eleccion ? (oferta.porEtiqueta.get(respuesta.opcion) ?? null) : null;
    let res: ResultadoConsulta;
    if (!v.eleccion) {
      res = await this.cerrar(id, EstadoIntencion.SIN_ENTRADA, v.motivo, {
        ...comun,
        decision: { respuesta },
      });
    } else if (this.soloSombra) {
      res = await this.cerrar(id, EstadoIntencion.SIN_ENTRADA, MotivoConsulta.SOMBRA, {
        ...comun,
        decision: { ...v.eleccion, respuesta },
        candidato_id: v.eleccion.opcion,
      });
    } else {
      res = await this.cerrar(id, EstadoIntencion.DECIDIDA, null, {
        ...comun,
        decision: { ...v.eleccion, respuesta },
        candidato_id: v.eleccion.opcion,
      });
    }
    await this.anotarDecision(
      bot,
      id,
      res,
      respuesta,
      v.eleccion ? { eleccion: v.eleccion, candidato } : null,
      null,
    );
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

  /** El modelo no dio una respuesta utilizable: cuenta, puede dormir el lazo y avisa. */
  private async fallo(
    id: string,
    bot: BotDeLaSolicitud,
    fallo: FalloGuardado,
    comun: Record<string, unknown>,
    ahora: number,
  ): Promise<ResultadoConsulta> {
    const motivo = fallo.fallo === 'CONTRATO' ? MotivoConsulta.CONTRATO : MotivoConsulta.MODELO;
    const coste = typeof comun['coste'] === 'string' ? comun['coste'] : null;
    const fallos = await this.anotarLazo(bot.id, coste, 'SUMA', `${motivo}:${fallo.fallo}`, ahora);
    const res = await this.cerrar(id, EstadoIntencion.FALLIDA, motivo, {
      ...comun,
      decision: fallo,
    });
    await this.anotarDecision(bot, id, res, null, null, fallo.fallo);
    // Uno por bot y hora: un fallo que avisa en cada vela enseña a silenciar el
    // canal justo antes del aviso que sí había que leer (spec 029).
    //
    // Salvo el que anuncia la PAUSA de 6 h, que se salta el límite: es un
    // cambio de estado del bot, pasa una sola vez y con el límite se lo comía
    // el aviso del primer fallo de esa hora — el usuario veía «esa vela no abre
    // operación» y nunca se enteraba de que el bot dejaba de consultar durante
    // seis horas (spec 062, F-13).
    const pausa = fallos >= TOPE_FALLOS;
    const toca =
      pausa || (await this.cache.setnx(`ai:fail-canal:${bot.id}`, 1, 3600).catch(() => false));
    if (toca) {
      await this.avisar(
        bot,
        'AI_FAILED',
        pausa
          ? 'La IA del canal falla repetidamente: sin consultas durante 6 h. El bot no abre ' +
              'operaciones mientras tanto; las abiertas siguen con su stop.'
          : 'La IA del canal no ha dado una respuesta válida: esa vela no abre operación.',
        EventSeverity.WARN,
        true,
      );
    }
    return res;
  }

  /**
   * Devuelve la solicitud a `SOLICITADA`: no era de este lazo (spec 069).
   *
   * No cuenta como consulta, no gasta cupo y no escribe evento: aquí no ha
   * pasado nada. El lazo del «Bot de IA» la encontrará en su sondeo, como
   * mucho diez segundos después, y su plazo es de media hora.
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
  private async configDe(bot: BotDeLaSolicitud): Promise<ConfigCanal | null> {
    const revision = await this.db.botConfigRevision.findUnique({
      where: { bot_id_version: { bot_id: bot.id, version: bot.config_version } },
      select: { config: true },
    });
    if (!revision || !esObjeto(revision.config)) return null;
    // Frontera Prisma-JSON: la configuración se guardó validada.
    return leerConfigCanal(revision.config as unknown as BotConfig, bot.venue as Venue);
  }

  /**
   * ¿Cabe otra llamada? Devuelve null si cabe, o por qué no.
   *
   * Se cuenta ANTES de llamar: contando solo los aciertos, veinte solicitudes a
   * la vez pasarían todas antes de que terminara ninguna. El del bot va primero,
   * para que un bot sin cupo no gaste el de los demás. Sin Redis no hay
   * contador, y sin contador no se llama: al otro lado hay una factura.
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
      this.logger.warn('Cupo diario global de la IA del canal agotado.');
      return MotivoConsulta.CUPO_GLOBAL;
    }
    return null;
  }

  /**
   * El contador del lazo: la llamada, su coste y la racha de fallos. Devuelve
   * los fallos seguidos que quedan.
   *
   * Leer y escribir no es atómico, y no hace falta que lo sea: un bot tiene una
   * solicitud por vela de 5 min, y lo que se juega es un contador que se
   * enseña y la pausa por fallos, no dinero.
   */
  private async anotarLazo(
    botId: string,
    coste: string | null,
    fallo: 'SUMA' | 'CERO' | 'NADA',
    error: string | null,
    ahora: number,
  ): Promise<number> {
    const dia = new Date(Math.floor(ahora / DIA_MS) * DIA_MS);
    const previa = await this.db.botAiLoop.findUnique({
      where: { bot_id: botId },
      select: { dia: true },
    });
    const importe = coste ?? '0';
    const uso =
      previa?.dia?.getTime() === dia.getTime()
        ? { llamadas_hoy: { increment: 1 }, coste_hoy: { increment: importe } }
        : { dia, llamadas_hoy: 1, coste_hoy: importe };
    const racha =
      fallo === 'SUMA'
        ? { fallos: { increment: 1 }, ultimo_error: error }
        : fallo === 'CERO'
          ? { fallos: 0 }
          : {};
    const fila = await this.db.botAiLoop.upsert({
      where: { bot_id: botId },
      create: {
        bot_id: botId,
        dia,
        llamadas_hoy: 1,
        coste_hoy: importe,
        fallos: fallo === 'SUMA' ? 1 : 0,
        ultimo_error: error,
      },
      update: { ...uso, ...racha },
      select: { fallos: true },
    });
    if (fallo === 'SUMA' && fila.fallos >= TOPE_FALLOS) {
      // Sin esto, un proveedor caído genera una llamada por vela y por bot.
      await this.db.botAiLoop.update({
        where: { bot_id: botId },
        data: { pausado_hasta: new Date(ahora + PAUSA_FALLOS_MS) },
      });
    }
    return fila.fallos;
  }

  // ── Avisos ───────────────────────────────────────────────────────────────

  /**
   * La decisión en la línea de tiempo del bot. En INFO y sin entrega forzada:
   * el notificador no la manda a Telegram, ni debe. Solo si hubo llamada.
   */
  private async anotarDecision(
    bot: BotDeLaSolicitud,
    intentId: string,
    res: ResultadoConsulta,
    respuesta: RespuestaModeloCanal | null,
    elegida: { eleccion: EleccionOperacion; candidato: CandidatoOperacion | null } | null,
    fallo: string | null,
  ): Promise<void> {
    await this.avisar(
      bot,
      'AI_DECISION',
      textoDecision(res, respuesta, elegida, fallo),
      EventSeverity.INFO,
      false,
      { intentId, estado: res.estado, motivo: res.motivo },
    );
  }

  /**
   * Escribe el evento y lo publica. `forzada` porque lo que nace en la API solo
   * llega a Telegram con la marca (spec 046, R-27).
   */
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

  /** Caduca lo que nadie terminó a tiempo. Devuelve cuántas. */
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

  /** Las solicitudes pendientes y vigentes, las más antiguas primero. */
  async pendientes(limite: number): Promise<string[]> {
    if (limite <= 0) return [];
    const filas = await this.db.botAiIntent.findMany({
      where: {
        estado: EstadoIntencion.SOLICITADA,
        expires_at: { gt: new Date() },
        // Solo lo propio (spec 069). Sin esto, el sondeo reclamaba cada diez
        // segundos las solicitudes del «Bot de IA» para soltarlas acto seguido:
        // correcto, pero un ir y venir constante contra la base y diez segundos
        // de retraso en cada decision ajena.
        bot: { strategy: StrategyKind.AI_CHANNEL },
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
        bot: { strategy: StrategyKind.AI_CHANNEL },
      },
      select: { id: true },
    });
    return fila?.id ?? null;
  }

  // ── El botón de pausa ────────────────────────────────────────────────────

  /**
   * Canjea el vale del botón «⏸ Pausar» de un aviso de entrada.
   *
   * - `GETDEL` es atómico: el vale sirve una vez, también entre réplicas.
   * - El vale tiene que ser de quien pulsa: el chat demuestra que ese Telegram
   *   es de la cuenta; esto, que la cuenta es la dueña del bot.
   * - El dueño tiene que seguir siendo administrador habilitado.
   * - La pausa va por `BotsService.command`, como la del botón de la app, y se
   *   audita aquí porque no pasa por el interceptor HTTP.
   */
  async canjearPausa(userId: string, vale: unknown): Promise<ResultadoPausa> {
    if (!esValeCanal(vale)) return 'SIN_VALE';
    const v = await this.cache.getDel<ValeCanal>(claveValeCanal(vale));
    if (!v || typeof v.botId !== 'string') return 'SIN_VALE';
    if (v.userId !== userId) return 'AJENO';
    const dueno = await this.db.user.findUnique({
      where: { id: userId },
      select: { role: true, disabled: true },
    });
    // A partir de aquí el vale era bueno y es de quien lo pulsa: pase lo que
    // pase, se le dice. El botón contestaba «Pausando…» y, si no se podía
    // pausar, no quedaba nada en ninguna parte: ni evento, ni mensaje, ni rastro
    // en la app. El usuario se quedaba creyendo que su bot estaba pausado
    // (spec 062, F-14).
    const bot = { id: v.botId, user_id: userId };
    if (!dueno || dueno.role !== DUENO_CON_CANAL.role || dueno.disabled) {
      await this.avisar(
        bot,
        'ACTION_FAILED',
        'El botón «⏸ Pausar» no ha pausado el bot: su dueño ya no puede operar el canal con IA. ' +
          'Párralo desde la app.',
        EventSeverity.WARN,
        true,
      );
      return 'DUENO';
    }
    try {
      await this.bots.command(userId, v.botId, { command: 'PAUSE' });
    } catch (e) {
      // Ya no está vivo, o ya no es suyo: no hay nada que pausar.
      if (e instanceof HttpException) {
        await this.avisar(
          bot,
          'ACTION_FAILED',
          `El botón «⏸ Pausar» no ha pausado el bot: ${e.message}. Míralo en la app.`,
          EventSeverity.WARN,
          true,
        );
        return 'NO_VIVO';
      }
      throw e;
    }
    // Y la confirmación de que sí: el `BOT_PAUSED` del motor es INFO y no se
    // entrega, así que quien pulsa desde el móvil no recibía nada.
    await this.avisar(
      bot,
      'BOT_PAUSED',
      'Bot pausado desde el botón del aviso: no abrirá más operaciones. La que esté abierta ' +
        'conserva su stop y sus objetivos.',
      EventSeverity.WARN,
      true,
    );
    await this.audit.recordNow({
      actor: ActorKind.USER,
      actorId: userId,
      botId: v.botId,
      action: 'bot.ai_channel.pause_button',
      severity: EventSeverity.WARN,
      outcome: AuditOutcome.OK,
      message: 'Pausa desde el botón de un aviso del canal con IA.',
      meta: { origen: 'telegram' },
    });
    return 'PAUSADO';
  }
}

const LADO: Readonly<Record<string, string>> = { LONG: 'largo', SHORT: 'corto' };

/** El texto del evento `AI_DECISION`. */
export function textoDecision(
  res: ResultadoConsulta,
  respuesta: RespuestaModeloCanal | null,
  elegida: { eleccion: EleccionOperacion; candidato: CandidatoOperacion | null } | null,
  fallo: string | null,
): string {
  const cita = respuesta?.texto ? ` «${respuesta.texto}»` : '';
  if (fallo) {
    return res.estado === EstadoIntencion.CADUCADA
      ? 'La IA no respondió a tiempo: la solicitud llegó tarde.'
      : `La IA no dio una respuesta válida (${fallo}).`;
  }
  if (elegida) {
    const { eleccion: e, candidato: c } = elegida;
    const que = c ? `${c.setup} ${LADO[c.lado] ?? c.lado}` : e.opcion;
    const detalle =
      `${que} con stop ${e.stop}, salida ${e.objetivo}, banda ${e.apalancamiento}, ` +
      `tamaño ${e.tamano} (confianza ${e.confianza}).`;
    return res.motivo === MotivoConsulta.SOMBRA
      ? `Modo sombra: la IA habría elegido ${detalle}${cita}`
      : `La IA elige ${detalle}${cita}`;
  }
  if (res.motivo === MotivoConsulta.NO_OPERAR) return `La IA no opera esta vela.${cita}`;
  return `La IA eligió algo que no se puede ejecutar (${res.motivo ?? 'sin motivo'}).${cita}`;
}
