import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  EstadoIntencion,
  MotivoRechazo,
  OrigenDecision,
  VIDA_VALE_CANAL_S,
  claveValeCanal,
  eleccionDe,
  type DecisionIa,
  type MarcaDecision,
  type SolicitudIa,
  type ValeCanal,
} from '@crypton/shared';
import { BUS_CHANNELS, BusService, DbService } from '../libs';

/**
 * Las intenciones de operación del canal con IA (`bot_ai_intents`, spec 058).
 *
 * El worker es quien decide si una intención se ejecuta, y lo hace aquí, con
 * actualizaciones CONDICIONALES por estado: una intención que otro proceso ya
 * ha movido —la API la dio por caducada, otro worker la aceptó— no se acepta
 * dos veces. La base tiene además un índice único parcial de «una operación
 * viva por bot» (`ACEPTADA` o `ABIERTA`), así que ni dos réplicas ni un tick
 * repetido pueden abrir dos operaciones a la vez.
 *
 * Lo que devuelve `false` es un NO: el runner quita la entrada del plan antes
 * de hablar con el venue.
 */
export interface AiIntentsLike {
  /** La última intención del bot, en cualquier estado. La estrategia decide si le sirve. */
  vigente(botId: string): Promise<DecisionIa | null>;
  /** Escribe la solicitud y avisa a la API. `false` si esa vela ya tenía la suya. */
  solicitar(
    bot: { id: string; user_id: string },
    cycleSeq: number,
    solicitud: SolicitudIa,
  ): Promise<boolean>;
  /** Anota lo que el plan hace con una intención. `false` = no se puede usar. */
  anotar(botId: string, cycleSeq: number, marca: MarcaDecision): Promise<boolean>;
  /**
   * La entrada se llenó. `true` si la intención pasó a `ABIERTA` con esta
   * llamada: es lo que decide si se avisa de la entrada, y un reinicio con la
   * posición abierta no lo repite.
   */
  abrir(botId: string, intentId: string): Promise<boolean>;
  /**
   * Un vale de un solo uso para el botón «⏸ Pausar» del aviso de entrada
   * (spec 059), o null si no se pudo guardar: el aviso sale sin botón.
   */
  valeDePausa(bot: { id: string; user_id: string }): Promise<string | null>;
  /** La operación terminó: el ciclo se cerró. */
  cerrar(botId: string): Promise<void>;
  /** Lo pendiente ya no tiene sentido: un comando, una recarga, una pausa. */
  caducarPendientes(botId: string): Promise<number>;
}

const ENTRADA = 'ENTRADA';

/** Los estados en los que una intención todavía puede acabar en una entrada. */
const PENDIENTES = [
  EstadoIntencion.SOLICITADA,
  EstadoIntencion.CONSULTANDO,
  EstadoIntencion.DECIDIDA,
];

/** El plazo de una decisión de reglas: el mismo que el de la IA, el cierre más un minuto. */
const PLAZO_TRAS_CIERRE_MS = 5 * 60_000 + 60_000;

/** El prefijo de las intenciones que crea el juez (`reglas:<bot>:<vela>`). */
const PREFIJO_REGLAS = 'reglas:';

/** Lo que se espera a Redis para guardar el vale del botón. */
const PLAZO_VALE_MS = 1_000;

const esUnicidad = (e: unknown): boolean => (e as { code?: string } | null)?.code === 'P2002';

/**
 * La elección guardada, si tiene la forma del contrato. La escribe la API desde
 * la respuesta del modelo, y aquí no se da por buena sin mirar: algo que no
 * encaja se lee como «sin elección» y la estrategia no opera. Vive en `shared`
 * desde el spec 059: la consola la lee igual para enseñarla.
 */
export { eleccionDe };

@Injectable()
export class AiIntentStore implements AiIntentsLike {
  constructor(
    private readonly db: DbService,
    private readonly bus: BusService,
  ) {}

  async vigente(botId: string): Promise<DecisionIa | null> {
    // El índice único (bot, vela, clase) sirve la consulta al revés: una fila.
    const fila = await this.db.botAiIntent.findFirst({
      where: { bot_id: botId, kind: ENTRADA },
      orderBy: [{ bar_t: 'desc' }, { created_at: 'desc' }],
    });
    if (!fila) return null;
    return {
      intentId: fila.id,
      estado: fila.estado,
      origen: fila.origen as OrigenDecision,
      barT: fila.bar_t.getTime(),
      huella: fila.huella,
      eleccion: eleccionDe(fila.decision),
      motivo: fila.motivo,
      expiresAt: fila.expires_at.getTime(),
      cycleSeq: fila.cycle_seq,
    };
  }

  async solicitar(
    bot: { id: string; user_id: string },
    cycleSeq: number,
    s: SolicitudIa,
  ): Promise<boolean> {
    try {
      await this.db.botAiIntent.create({
        data: {
          bot_id: bot.id,
          bar_t: new Date(s.barT),
          kind: ENTRADA,
          origen: OrigenDecision.IA,
          estado: EstadoIntencion.SOLICITADA,
          huella: s.huella,
          // Frontera Prisma-JSON: la herramienta es un objeto plano y serializable.
          snapshot: s.snapshot as never,
          expires_at: new Date(s.expiresAt),
          cycle_seq: cycleSeq,
        },
      });
    } catch (e) {
      // Esa vela ya tiene su intención: otra réplica o un tick anterior.
      if (esUnicidad(e)) return false;
      throw e;
    }
    // El aviso solo adelanta: la API también encuentra la solicitud sondeando.
    await this.bus
      .publish(BUS_CHANNELS.BOT_AI_REQUESTS, {
        userId: bot.user_id,
        botId: bot.id,
        type: 'AI_REQUEST',
        data: { barT: s.barT, expiresAt: s.expiresAt },
      })
      .catch(() => undefined);
    return true;
  }

  async anotar(botId: string, cycleSeq: number, marca: MarcaDecision): Promise<boolean> {
    const { intentId, estado, motivo, plan } = marca;
    const deReglas = intentId.startsWith(PREFIJO_REGLAS);
    try {
      if (estado === EstadoIntencion.ACEPTADA) {
        if (!plan) return false;
        if (deReglas) {
          await this.crearDeReglas(botId, cycleSeq, marca);
          return true;
        }
        // Solo desde DECIDIDA: una intención que ya se movió no se acepta.
        const r = await this.db.botAiIntent.updateMany({
          where: { id: intentId, bot_id: botId, estado: EstadoIntencion.DECIDIDA },
          data: {
            estado: EstadoIntencion.ACEPTADA,
            candidato_id: plan.candidatoId,
            plan: plan as never,
            motivo: null,
          },
        });
        return r.count === 1;
      }

      // RECHAZADA: una decidida que no se usa, o una aceptada cuya entrada no
      // llegó a llenarse.
      const r = await this.db.botAiIntent.updateMany({
        where: {
          id: intentId,
          bot_id: botId,
          estado: { in: [EstadoIntencion.DECIDIDA, EstadoIntencion.ACEPTADA] },
        },
        data: {
          estado: EstadoIntencion.RECHAZADA,
          motivo,
          ...(plan ? { plan: plan as never } : {}),
        },
      });
      if (r.count > 0) return true;
      // Una de reglas que no llegó a entrar —solo observar— se guarda con sus
      // números: es la constancia de lo que habría hecho.
      if (!deReglas || !plan) return false;
      await this.crearDeReglas(botId, cycleSeq, marca);
      return true;
    } catch (e) {
      // Otra operación viva, o esa vela ya decidida: no se usa.
      if (esUnicidad(e)) return false;
      throw e;
    }
  }

  private async crearDeReglas(botId: string, cycleSeq: number, marca: MarcaDecision) {
    const plan = marca.plan!;
    await this.db.botAiIntent.create({
      data: {
        id: marca.intentId,
        bot_id: botId,
        bar_t: new Date(plan.barT),
        kind: ENTRADA,
        origen: OrigenDecision.REGLAS,
        estado: marca.estado,
        candidato_id: plan.candidatoId,
        huella: plan.huella,
        decision: plan.eleccion as never,
        plan: plan as never,
        motivo: marca.motivo,
        expires_at: new Date(plan.barT + PLAZO_TRAS_CIERRE_MS),
        cycle_seq: cycleSeq,
      },
    });
  }

  async abrir(botId: string, intentId: string): Promise<boolean> {
    const r = await this.db.botAiIntent.updateMany({
      where: { id: intentId, bot_id: botId, estado: EstadoIntencion.ACEPTADA },
      data: { estado: EstadoIntencion.ABIERTA },
    });
    return r.count === 1;
  }

  /**
   * El vale se guarda en Redis con quién puede usarlo y sobre qué bot, y lo
   * canjea la API con `GETDEL`. Con plazo: con Redis caído el cliente encola la
   * orden, y el aviso no puede quedarse esperando.
   */
  async valeDePausa(bot: { id: string; user_id: string }): Promise<string | null> {
    const vale = randomUUID().replace(/-/g, '');
    const datos: ValeCanal = { userId: bot.user_id, botId: bot.id };
    let timer: NodeJS.Timeout | undefined;
    const plazo = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Redis no contesta')), PLAZO_VALE_MS);
    });
    try {
      await Promise.race([
        this.bus.cacheSet(claveValeCanal(vale), datos, VIDA_VALE_CANAL_S),
        plazo,
      ]);
      return vale;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async cerrar(botId: string): Promise<void> {
    await this.db.botAiIntent.updateMany({
      where: {
        bot_id: botId,
        estado: { in: [EstadoIntencion.ACEPTADA, EstadoIntencion.ABIERTA] },
      },
      data: { estado: EstadoIntencion.CERRADA },
    });
  }

  async caducarPendientes(botId: string): Promise<number> {
    const r = await this.db.botAiIntent.updateMany({
      where: { bot_id: botId, estado: { in: PENDIENTES } },
      data: { estado: EstadoIntencion.CADUCADA, motivo: MotivoRechazo.ESTADO },
    });
    return r.count;
  }
}
