import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CLAVE_INTERRUPTOR_CANAL,
  D,
  LAZO_VACIO,
  StrategyKind,
  eleccionDe,
  falloDe,
  interruptorCerrado,
  rachaDePerdidas,
  resumenPlanDe,
  respuestaModeloDe,
  type BotCanalResumen,
  type EstadoPropioCanal,
  type BotConfig,
  type DecisionCanalDetalle,
  type DecisionCanalVista,
  type EstadoCanalBot,
  type EstadoIntencion,
  type HoyCanal,
  type InterruptoresCanal,
  type LazoCanal,
  type OrigenDecision,
  type ResumenCanalAdmin,
  type Venue,
} from '@crypton/shared';
import { leerConfigCanal } from '@crypton/strategy-core';
import { CacheService, DbService } from 'src/libs';
import { AiChannelService, claveCupoGlobal, diaDelCupo } from './ai-channel.service';

/**
 * Lo que la consola enseña del canal con IA (spec 059): los interruptores, el
 * lazo de cada bot, su día y sus decisiones.
 *
 * Solo lectura, salvo el interruptor global de entradas. Y solo bots PROPIOS
 * del administrador que pregunta, como el Modo IA: la consola mira y contiene
 * los bots de otros, y este panel es del dueño.
 */

const DIA_MS = 86_400_000;
/** Las decisiones que acompañan al estado de un bot. */
const ULTIMAS = 5;
const PAGINA_POR_DEFECTO = 20;
/** Los cierres que se miran para la racha, como el motor. */
const RACHA_MAXIMA = 50;

const SELECT_DECISION = {
  id: true,
  bar_t: true,
  created_at: true,
  estado: true,
  origen: true,
  motivo: true,
  candidato_id: true,
  decision: true,
  plan: true,
  modelo: true,
  prompt_version: true,
  latencia_ms: true,
  coste: true,
} as const;

interface FilaDecision {
  id: string;
  bar_t: Date;
  created_at: Date;
  estado: string;
  origen: string;
  motivo: string | null;
  candidato_id: string | null;
  decision: unknown;
  plan: unknown;
  modelo: string | null;
  prompt_version: string | null;
  latencia_ms: number | null;
  coste: { toString(): string } | null;
}

interface FilaLazo {
  fallos: number;
  pausado_hasta: Date | null;
  ultimo_error: string | null;
  dia: Date | null;
  llamadas_hoy: number;
  coste_hoy: { toString(): string };
}

const inicioDelDia = (ahora: number): number => Math.floor(ahora / DIA_MS) * DIA_MS;

/** La fila del lazo tal y como se enseña. Los contadores de otro día cuentan cero. */
export function lazoDe(fila: FilaLazo | null, ahora: number): LazoCanal {
  if (!fila) return LAZO_VACIO;
  const deHoy = fila.dia?.getTime() === inicioDelDia(ahora);
  return {
    fallos: fila.fallos,
    pausadoHasta: fila.pausado_hasta?.toISOString() ?? null,
    ultimoError: fila.ultimo_error,
    llamadasHoy: deHoy ? fila.llamadas_hoy : 0,
    costeHoy: deHoy ? D(fila.coste_hoy.toString()).toFixed() : '0',
  };
}

export function decisionDe(f: FilaDecision): DecisionCanalVista {
  return {
    id: f.id,
    barT: f.bar_t.toISOString(),
    creadaEn: f.created_at.toISOString(),
    // Frontera Prisma: calcan los enums de `shared`.
    estado: f.estado as EstadoIntencion,
    origen: f.origen as OrigenDecision,
    motivo: f.motivo,
    candidatoId: f.candidato_id,
    eleccion: eleccionDe(f.decision),
    respuesta: respuestaModeloDe(f.decision),
    plan: resumenPlanDe(f.plan),
    fallo: falloDe(f.decision),
    modelo: f.modelo,
    promptVersion: f.prompt_version,
    latenciaMs: f.latencia_ms,
    coste: f.coste === null ? null : D(f.coste.toString()).toFixed(),
  };
}

@Injectable()
export class AiChannelEstadoService {
  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly canal: AiChannelService,
  ) {}

  /** Los interruptores del servidor y el global de entradas, como están ahora. */
  async interruptores(): Promise<InterruptoresCanal> {
    let entradas: InterruptoresCanal['entradas'];
    let llamadasGlobalesHoy: number | null;
    try {
      const texto = await this.cache.getTextoOrThrow(CLAVE_INTERRUPTOR_CANAL);
      entradas = interruptorCerrado(texto) ? 'CERRADAS' : 'ABIERTAS';
    } catch {
      entradas = 'DESCONOCIDO';
    }
    try {
      const clave = claveCupoGlobal(diaDelCupo(Date.now()));
      const n = Number(await this.cache.getTextoOrThrow(clave));
      llamadasGlobalesHoy = Number.isInteger(n) && n > 0 ? n : 0;
    } catch {
      llamadasGlobalesHoy = null;
    }
    return {
      encendido: this.canal.encendido,
      modelo: this.canal.modeloId,
      soloSombra: this.canal.soloSombra,
      entradas,
      limiteBot: this.canal.limiteBot,
      limiteGlobal: this.canal.limiteGlobal,
      llamadasGlobalesHoy,
    };
  }

  /**
   * Abre o corta las entradas de todos los bots del canal. Se comprueba leyendo
   * lo escrito: la caché calla sus fallos, y la consola no puede decir
   * «cortadas» si no lo están.
   */
  async fijarEntradas(abiertas: boolean): Promise<InterruptoresCanal> {
    if (abiertas) {
      await this.cache.del(CLAVE_INTERRUPTOR_CANAL);
    } else {
      await this.cache.set(CLAVE_INTERRUPTOR_CANAL, 'off');
    }
    let cerrado: boolean;
    try {
      cerrado = interruptorCerrado(await this.cache.getTextoOrThrow(CLAVE_INTERRUPTOR_CANAL));
    } catch {
      throw new ServiceUnavailableException(
        'Redis no responde: el interruptor de entradas no se ha podido cambiar.',
      );
    }
    if (cerrado === abiertas) {
      throw new ServiceUnavailableException(
        'El interruptor de entradas no ha quedado como se pidió. Inténtalo de nuevo.',
      );
    }
    return this.interruptores();
  }

  /** Los bots del canal del administrador, con su lazo y su última decisión. */
  async resumen(adminId: string): Promise<ResumenCanalAdmin> {
    const ahora = Date.now();
    const filas = await this.db.bot.findMany({
      where: { user_id: adminId, strategy: StrategyKind.AI_CHANNEL },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        name: true,
        symbol: true,
        venue: true,
        status: true,
        dry_run: true,
        config_version: true,
        ai_loop: true,
        ai_intents: {
          orderBy: { created_at: 'desc' },
          take: 1,
          select: { estado: true, motivo: true, created_at: true },
        },
      },
    });
    // La configuración vigente de cada uno: la pastilla tiene que saber si este
    // bot consulta a la IA y si tiene las entradas encendidas (spec 062, F-46).
    const revisiones = await this.db.botConfigRevision.findMany({
      where: { OR: filas.map((b) => ({ bot_id: b.id, version: b.config_version })) },
      select: { bot_id: true, version: true, config: true },
    });
    const porBot = new Map(revisiones.map((r) => [`${r.bot_id}:${r.version}`, r.config]));
    const bots: BotCanalResumen[] = filas.map((b) => {
      const ultima = b.ai_intents[0];
      return {
        id: b.id,
        name: b.name,
        symbol: b.symbol,
        venue: b.venue,
        status: b.status,
        dryRun: b.dry_run,
        lazo: lazoDe(b.ai_loop, ahora),
        propio: this.propioSuyo(
          // Frontera Prisma-JSON: la configuración se guardó validada.
          leerConfigCanal(
            (porBot.get(`${b.id}:${b.config_version}`) ?? {}) as unknown as BotConfig,
            b.venue,
          ),
        ),
        ultima: ultima
          ? {
              estado: ultima.estado,
              motivo: ultima.motivo,
              creadaEn: ultima.created_at.toISOString(),
            }
          : null,
      };
    });
    return { interruptores: await this.interruptores(), bots };
  }

  /** El estado de un bot propio del canal. */
  async estado(adminId: string, botId: string): Promise<EstadoCanalBot> {
    const bot = await this.botPropio(adminId, botId);
    const ahora = Date.now();
    const [lazo, hoy, decisiones, interruptores] = await Promise.all([
      this.db.botAiLoop.findUnique({ where: { bot_id: botId } }),
      this.hoy(bot, ahora),
      this.db.botAiIntent.findMany({
        where: { bot_id: botId },
        orderBy: { created_at: 'desc' },
        take: ULTIMAS,
        select: SELECT_DECISION,
      }),
      this.interruptores(),
    ]);
    return {
      botId,
      interruptores,
      lazo: lazoDe(lazo, ahora),
      hoy: hoy.dia,
      decisiones: decisiones.map(decisionDe),
      propio: hoy.propio,
    };
  }

  /** Las decisiones de un bot propio, de la más reciente hacia atrás. */
  async decisiones(
    adminId: string,
    botId: string,
    antes: string | undefined,
    limite = PAGINA_POR_DEFECTO,
  ): Promise<DecisionCanalVista[]> {
    await this.botPropio(adminId, botId);
    const filas = await this.db.botAiIntent.findMany({
      where: { bot_id: botId, ...(antes ? { created_at: { lt: new Date(antes) } } : {}) },
      orderBy: { created_at: 'desc' },
      take: limite,
      select: SELECT_DECISION,
    });
    return filas.map(decisionDe);
  }

  /** Una decisión con la herramienta que vio el modelo. */
  async detalle(adminId: string, botId: string, intentId: string): Promise<DecisionCanalDetalle> {
    await this.botPropio(adminId, botId);
    const fila = await this.db.botAiIntent.findFirst({
      where: { id: intentId, bot_id: botId },
      select: { ...SELECT_DECISION, snapshot: true },
    });
    if (!fila) throw new NotFoundException('Esa decisión no existe en este bot.');
    return { ...decisionDe(fila), herramienta: fila.snapshot };
  }

  /**
   * El bot, si es del canal y del administrador que pregunta. Sobre uno ajeno,
   * 403: este panel es del dueño, como el del Modo IA.
   */
  private async botPropio(adminId: string, botId: string) {
    const bot = await this.db.bot.findUnique({
      where: { id: botId },
      select: { id: true, user_id: true, strategy: true, venue: true, config_version: true },
    });
    if (!bot) throw new NotFoundException('Bot no encontrado.');
    if (bot.user_id !== adminId) {
      throw new ForbiddenException('El canal con IA solo se consulta sobre bots propios.');
    }
    if (bot.strategy !== StrategyKind.AI_CHANNEL) {
      throw new NotFoundException('Ese bot no es del canal con IA.');
    }
    return bot;
  }

  /** Lo del día UTC: operaciones, resultado, pérdida frente al tope y racha. */
  /** El modo y las entradas de un bot, leídos de su configuración vigente. */
  private propioSuyo(cfg: ReturnType<typeof leerConfigCanal>): EstadoPropioCanal {
    return { modo: cfg.modo === 'IA' ? 'IA' : 'REGLAS', entradas: cfg.entradasActivas };
  }

  private async hoy(
    bot: { id: string; venue: string; config_version: number },
    ahora: number,
  ): Promise<{ dia: HoyCanal; propio: EstadoPropioCanal }> {
    const [revision, delDia, recientes] = await Promise.all([
      this.db.botConfigRevision.findUnique({
        where: { bot_id_version: { bot_id: bot.id, version: bot.config_version } },
        select: { config: true },
      }),
      this.db.botCycle.aggregate({
        where: { bot_id: bot.id, closed_at: { gte: new Date(inicioDelDia(ahora)) } },
        _sum: { realized_pnl: true },
        _count: { _all: true },
      }),
      this.db.botCycle.findMany({
        where: { bot_id: bot.id, closed_at: { not: null } },
        orderBy: { seq: 'desc' },
        take: RACHA_MAXIMA,
        select: { realized_pnl: true },
      }),
    ]);
    // Frontera Prisma-JSON: la configuración se guardó validada.
    const cfg = leerConfigCanal(
      (revision?.config ?? {}) as unknown as BotConfig,
      bot.venue as Venue,
    );
    const realizado = D(delDia._sum.realized_pnl?.toString() ?? 0);
    const perdida =
      realizado.lt(0) && cfg.capital.gt(0) ? realizado.neg().div(cfg.capital).mul(100) : D(0);
    return {
      dia: {
        operaciones: delDia._count._all,
        realizado: realizado.toFixed(),
        perdidaPct: perdida.toDecimalPlaces(4).toNumber(),
        topePct: cfg.topeDiarioPct.toNumber(),
        topeOperaciones: cfg.maxOperacionesDia,
        // El que de verdad aplica el lazo: `min(presupuesto del bot, tope del
        // servidor)`. La pantalla enseñaba el del servidor a secas (spec 062, F-45).
        topeConsultas: Math.min(cfg.presupuestoIaDia, this.canal.limiteBot),
        rachaPerdidas: rachaDePerdidas(recientes.map((c) => c.realized_pnl.toString())),
      },
      propio: this.propioSuyo(cfg),
    };
  }
}
