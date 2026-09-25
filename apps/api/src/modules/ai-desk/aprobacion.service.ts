import 'reflect-metadata';
import { HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  ActorKind,
  AuditOutcome,
  ClaseAccion,
  EfectoAccion,
  EstadoAgente,
  EstadoPropuestaAgente,
  EventSeverity,
  EventoAgente,
  MotivoPropuestaAgente,
  StrategyKind,
  VerboAgente,
  efectoDe,
  planAgenteDe,
  type IntervaloAgente,
  type PlanAgente,
  type ResultadoDecisionAgente,
} from '@crypton/shared';
import {
  atrLiquidacionDe,
  configDeOperacion,
  leerLimitesAgente,
  recalcularPropuesta,
} from '@crypton/strategy-core';
import { AuditService, DbService } from 'src/libs';
import { CreateBotDto } from '../bots/dtos';
import { BotsService } from '../bots/bots.service';
import { AiDeskConfig } from './ai-desk.config';
import { AiDeskAgentesService, DUENO_DE_AGENTES } from './agentes.service';
import { AiDeskAvisosService } from './avisos.service';
import { AiDeskInterruptoresService } from './interruptores.service';
import { AiDeskLecturaService } from './lectura.service';
import { autonomiaDe, esCuentaReal } from './vistas';

/** Quién decide una propuesta: una persona desde la app o Telegram, o el agente solo. */
export const OrigenDecision = { APP: 'APP', TELEGRAM: 'TELEGRAM', AUTO: 'AUTO' } as const;
export type OrigenDecision = (typeof OrigenDecision)[keyof typeof OrigenDecision];

/** En qué acabó aprobar o rechazar, para quien lo pidió. */
/** La forma vive en shared: la app la lee tal cual. */
export type ResultadoDecision = ResultadoDecisionAgente;

/** Lo que tiene la operación para entrar desde que se aprueba: pasado, ya no entra. */
export const VIDA_ENTRADA_MS = 5 * 60_000;
/** Una aprobación a medias más vieja que esto se recupera: el proceso que la llevaba cayó. */
export const APROBACION_COLGADA_MS = 2 * 60_000;
/** Los estados de un bot vivo, que ocupan su par en la cuenta (invariante 11). */
const BOT_VIVO = ['STARTING', 'RUNNING', 'PAUSED'] as const;

const SELECT_PROPUESTA = {
  id: true,
  state: true,
  expires_at: true,
  plan: true,
  symbol: true,
  side: true,
  bot_id: true,
  agent: {
    select: {
      id: true,
      name: true,
      user_id: true,
      state: true,
      interval: true,
      limits: true,
      auto_entry: true,
      auto_reduce: true,
      auto_close: true,
      venue: true,
      exchange_account: {
        select: { id: true, venue: true, paper: true, testnet: true, status: true },
      },
      user: { select: { role: true, disabled: true } },
    },
  },
} as const;

/** Lo que se dice de cada final, sin jerga. */
const MENSAJES: Readonly<Record<string, string>> = {
  [MotivoPropuestaAgente.CADUCIDAD]: 'La propuesta ha caducado sin respuesta.',
  [MotivoPropuestaAgente.PRECIO_PASO_STOP]:
    'El precio ya ha pasado el stop de la propuesta: no se ha abierto nada.',
  [MotivoPropuestaAgente.PRECIO_MOVIDO]:
    'El precio se ha movido más de media distancia de stop desde la propuesta: ya no es la ' +
    'misma operación, así que no se ha abierto.',
  [MotivoPropuestaAgente.LIMITES]:
    'Con el saldo, lo operado hoy y los límites de ahora ya no cabe: no se ha abierto nada.',
  [MotivoPropuestaAgente.PAR_OCUPADO]: 'Ese par ya tiene una operación viva en la cuenta.',
  [MotivoPropuestaAgente.AGENTE_PAUSADO]: 'El agente está en pausa.',
  [MotivoPropuestaAgente.AGENTE_CAMBIADO]: 'El agente cambió desde la propuesta.',
  [MotivoPropuestaAgente.INTERRUPTOR]: 'Las entradas de los agentes están cortadas.',
  [MotivoPropuestaAgente.DUENO]: 'Solo un administrador habilitado puede operar agentes.',
  [MotivoPropuestaAgente.CUENTA]: 'La conexión del agente no está disponible.',
  [MotivoPropuestaAgente.IA_APAGADA]: 'Los agentes están apagados en este servidor.',
  [MotivoPropuestaAgente.SIN_DATOS]:
    'No hay precio o saldo de la cuenta en este momento. Vuelve a intentarlo en un minuto.',
  [MotivoPropuestaAgente.SOLO_SOMBRA]: 'El servidor está en modo sombra: solo se mide.',
  [MotivoPropuestaAgente.SOLO_SIMULACION]:
    'El servidor solo deja operar en simulación: en esta cuenta solo se mide.',
  [MotivoPropuestaAgente.PERSONA]: 'Propuesta descartada.',
};

type FilaPropuesta = NonNullable<Awaited<ReturnType<AiDeskAprobacionService['leer']>>>;

/**
 * Aprobar y rechazar propuestas de entrada (spec 074, R-19 a R-21).
 *
 * UNA sola rutina de aprobación para el botón de Telegram, la app y el modo
 * automático, porque es por donde el dinero sale de la cuenta:
 * 1. reclamo condicional `PROPUESTA → APROBANDO`: quien lo gana es el único
 *    que sigue, así que no hay doble aprobación posible, tampoco entre
 *    réplicas; y el índice de una operación viva por agente y par salta aquí;
 * 2. todo lo que da permiso se relee de la base: el dueño, el agente, la
 *    cuenta, el interruptor y los frenos del servidor;
 * 3. **recálculo** con el precio, el saldo y lo operado de AHORA: caduca con
 *    su motivo si el precio pasó el stop, se movió más de media distancia de
 *    stop o ya no cabe;
 * 4. el bot nace por `BotsService.create` —validación, vista previa y límites
 *    de riesgo, como el de cualquier usuario— y se enlaza a la propuesta ANTES
 *    de arrancarlo: tras una caída, la propuesta sabe cuál es su bot;
 * 5. si el arranque falla, el borrador se borra y la propuesta queda FALLIDA.
 *
 * Cada salida deja la propuesta en un estado: ninguna se queda en `APROBANDO`
 * salvo que el proceso muera, y eso lo recoge `recuperar`.
 */
@Injectable()
export class AiDeskAprobacionService {
  private readonly logger = new Logger(AiDeskAprobacionService.name);

  constructor(
    private readonly db: DbService,
    private readonly cfg: AiDeskConfig,
    private readonly interruptores: AiDeskInterruptoresService,
    private readonly lectura: AiDeskLecturaService,
    private readonly agentes: AiDeskAgentesService,
    private readonly bots: BotsService,
    private readonly avisos: AiDeskAvisosService,
    private readonly audit: AuditService,
  ) {}

  // ── Aprobar ──────────────────────────────────────────────────────────────

  /**
   * Aprueba una propuesta y, si todo cabe, abre su operación. Nunca lanza por
   * lo que le pase a la propuesta: devuelve en qué acabó. Solo responde 404 si
   * la propuesta no es de quien pregunta.
   */
  async aprobar(
    userId: string,
    propuestaId: string,
    origen: OrigenDecision,
  ): Promise<ResultadoDecision> {
    const p = await this.leer(userId, propuestaId);
    if (!p) throw new NotFoundException('Propuesta no encontrada.');
    const ahora = new Date();
    if (p.state !== EstadoPropuestaAgente.PROPUESTA) return this.yaDecidida(p);
    if (p.expires_at <= ahora) {
      await this.escribir(p.id, EstadoPropuestaAgente.PROPUESTA, {
        state: EstadoPropuestaAgente.CADUCADA,
        reason: MotivoPropuestaAgente.CADUCIDAD,
      });
      return this.resultado(p.id, EstadoPropuestaAgente.CADUCADA, MotivoPropuestaAgente.CADUCIDAD);
    }

    // 1. El reclamo. El índice parcial de una operación viva por agente y par
    //    se comprueba aquí: APROBANDO ya cuenta como viva.
    let reclamada: number;
    try {
      reclamada = await this.escribir(p.id, EstadoPropuestaAgente.PROPUESTA, {
        state: EstadoPropuestaAgente.APROBANDO,
        decided_by: origen,
        decided_at: ahora,
      });
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e;
      await this.escribir(p.id, EstadoPropuestaAgente.PROPUESTA, {
        state: EstadoPropuestaAgente.DESCARTADA,
        reason: MotivoPropuestaAgente.PAR_OCUPADO,
        decided_by: origen,
        decided_at: ahora,
      });
      return this.cerrarConAviso(
        p,
        origen,
        EstadoPropuestaAgente.DESCARTADA,
        MotivoPropuestaAgente.PAR_OCUPADO,
      );
    }
    if (reclamada !== 1) return this.yaDecidida((await this.leer(userId, propuestaId)) ?? p);

    // A partir de aquí la propuesta es de esta llamada, y toda salida la deja
    // en un estado. Lo inesperado también: FALLIDA con el error, y se sigue.
    try {
      return await this.ejecutar(p, origen, ahora);
    } catch (e) {
      this.logger.error(`Aprobación de ${p.id} fallida: ${(e as Error).message}`);
      await this.escribir(p.id, EstadoPropuestaAgente.APROBANDO, {
        state: EstadoPropuestaAgente.FALLIDA,
        reason: MotivoPropuestaAgente.CREAR,
      });
      return this.cerrarConAviso(
        p,
        origen,
        EstadoPropuestaAgente.FALLIDA,
        MotivoPropuestaAgente.CREAR,
        'Algo ha fallado al abrir la operación y no se ha abierto nada.',
      );
    }
  }

  private async ejecutar(
    p: FilaPropuesta,
    origen: OrigenDecision,
    ahora: Date,
  ): Promise<ResultadoDecision> {
    const { agent } = p;
    const cuenta = agent.exchange_account;
    const descartar = (motivo: MotivoPropuestaAgente) =>
      this.acabar(p, origen, EstadoPropuestaAgente.DESCARTADA, motivo);

    // 2. Lo que da permiso, releído.
    if (!this.cfg.encendido) return descartar(MotivoPropuestaAgente.IA_APAGADA);
    if (
      agent.user.role !== DUENO_DE_AGENTES.role ||
      agent.user.disabled !== DUENO_DE_AGENTES.disabled
    ) {
      return descartar(MotivoPropuestaAgente.DUENO);
    }
    if (agent.state !== EstadoAgente.ACTIVO) return descartar(MotivoPropuestaAgente.AGENTE_PAUSADO);
    // Cerrado ante la duda: con Redis caído no se sabe si están cortadas.
    if ((await this.interruptores.entradasAbiertas()) !== true) {
      return descartar(MotivoPropuestaAgente.INTERRUPTOR);
    }
    if (!cuenta.paper && !['VERIFIED', 'ACTIVE'].includes(cuenta.status)) {
      return descartar(MotivoPropuestaAgente.CUENTA);
    }
    const real = esCuentaReal(cuenta);
    const efecto = efectoDe(ClaseAccion.ENTRAR, autonomiaDe(agent), this.cfg.frenos, real);
    if (efecto === EfectoAccion.MIDE) {
      return descartar(
        this.cfg.frenos.soloSombra
          ? MotivoPropuestaAgente.SOLO_SOMBRA
          : MotivoPropuestaAgente.SOLO_SIMULACION,
      );
    }
    const ocupado = await this.db.bot.findFirst({
      where: {
        exchange_account_id: cuenta.id,
        symbol: p.symbol,
        status: { in: [...BOT_VIVO] },
        dry_run: false,
      },
      select: { id: true },
    });
    if (ocupado) return descartar(MotivoPropuestaAgente.PAR_OCUPADO);

    // 3. El recálculo, con los datos de ahora.
    const plan = planAgenteDe(p.plan);
    if (!plan) {
      this.logger.error(`La propuesta ${p.id} no trae un plan legible.`);
      return this.acabar(p, origen, EstadoPropuestaAgente.FALLIDA, MotivoPropuestaAgente.CREAR);
    }
    // Frontera Prisma: el intervalo se validó al guardar el agente.
    const intervalo = agent.interval as IntervaloAgente;
    const venue = cuenta.venue;
    const [lectura, saldo, historial, maxApalancamientoUsuario] = await Promise.all([
      this.lectura.par(venue, p.symbol, cuenta.testnet, intervalo),
      this.lectura.saldoLibre(agent.user_id, cuenta.id, p.symbol),
      this.agentes.historial(agent, ahora.getTime(), p.id),
      this.lectura.maxApalancamiento(agent.user_id),
    ]);
    const atr = lectura ? atrLiquidacionDe(lectura.par.velas, intervalo, ahora.getTime()) : null;
    if (!lectura?.par.ticker || lectura.sinTramos || saldo === null || atr === null) {
      return this.sinDatos(p, origen);
    }
    const r = recalcularPropuesta(
      plan,
      {
        ticker: lectura.par.ticker,
        saldoLibre: saldo,
        historial,
        niveles: lectura.par.niveles,
        maxApalancamientoUsuario,
        atrLiquidacion: atr,
      },
      {
        limites: leerLimitesAgente(agent.limits),
        venue,
        market: lectura.par.market,
        intervalo,
        ahora: ahora.getTime(),
        vidaMs: VIDA_ENTRADA_MS,
      },
    );
    if (!r.plan) return this.acabar(p, origen, EstadoPropuestaAgente.CADUCADA, r.motivo);

    // 4. El bot, por el camino de siempre.
    return this.crearBot(p, origen, r.plan, real);
  }

  private async crearBot(
    p: FilaPropuesta,
    origen: OrigenDecision,
    plan: PlanAgente,
    real: boolean,
  ): Promise<ResultadoDecision> {
    const { agent } = p;
    const cuenta = agent.exchange_account;
    const dto = plainToInstance(CreateBotDto, {
      name: nombreDelBot(agent.name, plan),
      exchangeAccountId: cuenta.id,
      symbol: plan.simbolo,
      strategy: StrategyKind.AGENT_TRADE,
      config: configDeOperacion(plan, { exchangeAccountId: cuenta.id, agentProposalId: p.id }),
      dryRun: cuenta.paper,
      startActive: false,
    });
    const invalido = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true });
    if (invalido.length > 0) {
      this.logger.error(`El bot de la propuesta ${p.id} no pasa su DTO: ${String(invalido)}`);
      return this.acabar(p, origen, EstadoPropuestaAgente.FALLIDA, MotivoPropuestaAgente.CREAR);
    }

    let botId: string;
    try {
      botId = (await this.bots.create(agent.user_id, dto)).id;
    } catch (e) {
      if (!(e instanceof HttpException)) throw e;
      return this.acabar(
        p,
        origen,
        EstadoPropuestaAgente.FALLIDA,
        MotivoPropuestaAgente.CREAR,
        `No se ha podido crear la operación: ${mensajeDe(e)}`,
      );
    }

    // Enlazado ANTES de arrancar: tras una caída, la propuesta sabe cuál es su bot.
    const enlazada = await this.escribir(p.id, EstadoPropuestaAgente.APROBANDO, {
      bot_id: botId,
      final_plan: plan,
    });
    if (enlazada !== 1) {
      // Alguien la sacó de APROBANDO mientras tanto —la recuperación, un
      // barrido—: el borrador sobra.
      await this.bots.remove(agent.user_id, botId).catch(() => undefined);
      const actual = await this.leer(agent.user_id, p.id);
      return this.yaDecidida(actual ?? p);
    }

    try {
      await this.bots.command(agent.user_id, botId, { command: 'START' });
    } catch (e) {
      if (!(e instanceof HttpException)) throw e;
      await this.bots
        .remove(agent.user_id, botId)
        .catch((err: Error) =>
          this.logger.error(`El borrador ${botId} no se pudo borrar: ${err.message}`),
        );
      return this.acabar(
        p,
        origen,
        EstadoPropuestaAgente.FALLIDA,
        MotivoPropuestaAgente.ARRANCAR,
        `No se ha podido arrancar la operación: ${mensajeDe(e)}`,
      );
    }

    await this.escribir(p.id, EstadoPropuestaAgente.APROBANDO, {
      state: EstadoPropuestaAgente.EJECUTANDO,
    });
    await this.audit.recordNow({
      actor: origen === OrigenDecision.AUTO ? ActorKind.SYSTEM : ActorKind.ADMIN,
      actorId: origen === OrigenDecision.AUTO ? null : agent.user_id,
      botId,
      action: 'admin.ai_desk.proposal_approve',
      severity: real ? EventSeverity.WARN : EventSeverity.INFO,
      outcome: AuditOutcome.OK,
      message:
        `Operación ${plan.lado === 'LONG' ? 'larga' : 'corta'} en ${plan.simbolo} del agente ` +
        `«${agent.name}» (${origen}).`,
      meta: { agentId: agent.id, propuestaId: p.id, origen, real, riesgo: plan.riesgo },
    });
    return {
      propuestaId: p.id,
      estado: EstadoPropuestaAgente.EJECUTANDO,
      motivo: null,
      botId,
      mensaje: 'Operación en marcha: el aviso de la entrada llega cuando se llene.',
    };
  }

  /**
   * Sin precio, saldo o tramos no se puede recalcular. Si lo pidió una persona,
   * la propuesta vuelve a esperar —mientras viva— para que lo intente otra vez;
   * si lo pidió el agente solo, caduca: nadie va a volver a pulsar.
   */
  private async sinDatos(p: FilaPropuesta, origen: OrigenDecision): Promise<ResultadoDecision> {
    if (origen !== OrigenDecision.AUTO) {
      const vuelta = await this.escribir(p.id, EstadoPropuestaAgente.APROBANDO, {
        state: EstadoPropuestaAgente.PROPUESTA,
        decided_by: null,
        decided_at: null,
      });
      if (vuelta === 1) {
        return this.resultado(
          p.id,
          EstadoPropuestaAgente.PROPUESTA,
          MotivoPropuestaAgente.SIN_DATOS,
        );
      }
    }
    return this.acabar(p, origen, EstadoPropuestaAgente.CADUCADA, MotivoPropuestaAgente.SIN_DATOS);
  }

  // ── Rechazar ─────────────────────────────────────────────────────────────

  async rechazar(
    userId: string,
    propuestaId: string,
    origen: OrigenDecision,
  ): Promise<ResultadoDecision> {
    const p = await this.leer(userId, propuestaId);
    if (!p) throw new NotFoundException('Propuesta no encontrada.');
    const escritas = await this.escribir(p.id, EstadoPropuestaAgente.PROPUESTA, {
      state: EstadoPropuestaAgente.RECHAZADA,
      reason: MotivoPropuestaAgente.PERSONA,
      decided_by: origen,
      decided_at: new Date(),
    });
    if (escritas !== 1) return this.yaDecidida((await this.leer(userId, propuestaId)) ?? p);
    return this.resultado(p.id, EstadoPropuestaAgente.RECHAZADA, MotivoPropuestaAgente.PERSONA);
  }

  // ── Telegram ─────────────────────────────────────────────────────────────

  /**
   * Una pulsación de un botón de propuesta. El poller del worker solo la
   * reenvía; aquí se canjea el vale, una vez, y tiene que ser de quien pulsa.
   * Devuelve false si el vale no es de una propuesta (lo es de una acción).
   */
  async pulsacion(
    userId: string,
    vale: { userId: string; propuestaId: string; accionId: string | null },
    verbo: VerboAgente,
  ): Promise<boolean> {
    if (vale.accionId !== null) return false;
    if (vale.userId !== userId) return true;
    try {
      if (verbo === VerboAgente.SI) {
        await this.aprobar(userId, vale.propuestaId, OrigenDecision.TELEGRAM);
      } else if (verbo === VerboAgente.NO) {
        await this.rechazar(userId, vale.propuestaId, OrigenDecision.TELEGRAM);
      }
    } catch (e) {
      if (!(e instanceof NotFoundException)) throw e;
    }
    return true;
  }

  // ── Mantenimiento ────────────────────────────────────────────────────────

  /** Caduca lo que nadie respondió a tiempo. Devuelve cuántas. */
  async caducar(ahora: number): Promise<number> {
    const r = await this.db.aiDeskProposal.updateMany({
      where: { state: EstadoPropuestaAgente.PROPUESTA, expires_at: { lt: new Date(ahora) } },
      data: { state: EstadoPropuestaAgente.CADUCADA, reason: MotivoPropuestaAgente.CADUCIDAD },
    });
    return r.count;
  }

  /**
   * Recoge las aprobaciones que se quedaron a medias porque el proceso que las
   * llevaba cayó (R-21). Sin duplicar nada:
   * - con su bot ya arrancado, la operación sigue: EJECUTANDO;
   * - con el bot en borrador, nunca arrancó: se borra y queda FALLIDA;
   * - sin bot, no llegó a crearse o no llegó a enlazarse: FALLIDA, y los
   *   borradores de agente sin propuesta se borran.
   */
  async recuperar(ahora: number): Promise<number> {
    const limite = new Date(ahora - APROBACION_COLGADA_MS);
    const colgadas = await this.db.aiDeskProposal.findMany({
      where: { state: EstadoPropuestaAgente.APROBANDO, decided_at: { lt: limite } },
      select: {
        id: true,
        bot_id: true,
        agent: { select: { user_id: true } },
        bot: { select: { id: true, status: true } },
      },
    });
    for (const c of colgadas) {
      if (c.bot && c.bot.status !== 'DRAFT') {
        await this.escribir(c.id, EstadoPropuestaAgente.APROBANDO, {
          state: EstadoPropuestaAgente.EJECUTANDO,
        });
        continue;
      }
      if (c.bot) {
        await this.bots.remove(c.agent.user_id, c.bot.id).catch(() => undefined);
      }
      await this.escribir(c.id, EstadoPropuestaAgente.APROBANDO, {
        state: EstadoPropuestaAgente.FALLIDA,
        reason: c.bot ? MotivoPropuestaAgente.ARRANCAR : MotivoPropuestaAgente.CREAR,
      });
    }
    // Los borradores de una operación de agente sin propuesta que los reclame:
    // el proceso cayó entre crearlos y enlazarlos. Solo en borrador: uno que
    // arrancó es una operación y no se toca.
    const huerfanos = await this.db.bot.findMany({
      where: {
        strategy: StrategyKind.AGENT_TRADE,
        status: 'DRAFT',
        created_at: { lt: limite },
        ai_desk_proposal: { is: null },
      },
      select: { id: true, user_id: true },
    });
    for (const h of huerfanos) {
      await this.bots.remove(h.user_id, h.id).catch(() => undefined);
    }
    return colgadas.length + huerfanos.length;
  }

  // ── Interno ──────────────────────────────────────────────────────────────

  /** La propuesta, si es de un agente de quien pregunta. */
  async leer(userId: string, propuestaId: string) {
    return this.db.aiDeskProposal.findFirst({
      where: { id: propuestaId, agent: { user_id: userId } },
      select: SELECT_PROPUESTA,
    });
  }

  /** Escribe si la propuesta sigue en el estado que se leyó. Devuelve cuántas escribió. */
  private async escribir(
    id: string,
    desde: EstadoPropuestaAgente,
    data: Record<string, unknown>,
  ): Promise<number> {
    const r = await this.db.aiDeskProposal.updateMany({
      where: { id, state: desde },
      // Frontera Prisma: `final_plan` es un objeto plano y serializable.
      data: data as never,
    });
    return r.count;
  }

  /** Termina una aprobación en curso con su estado y su motivo, y avisa si toca. */
  private async acabar(
    p: FilaPropuesta,
    origen: OrigenDecision,
    estado: EstadoPropuestaAgente,
    motivo: MotivoPropuestaAgente,
    mensaje?: string,
  ): Promise<ResultadoDecision> {
    await this.escribir(p.id, EstadoPropuestaAgente.APROBANDO, { state: estado, reason: motivo });
    return this.cerrarConAviso(p, origen, estado, motivo, mensaje);
  }

  /**
   * Quien pulsó en Telegram solo vio «Ejecutando…»: si no se abrió, se le dice.
   * En el automático, solo lo que es una avería —crear o arrancar—: que el
   * precio se moviera no es una noticia. Desde la app, la respuesta ya lo dice.
   */
  private async cerrarConAviso(
    p: FilaPropuesta,
    origen: OrigenDecision,
    estado: EstadoPropuestaAgente,
    motivo: MotivoPropuestaAgente,
    mensaje?: string,
  ): Promise<ResultadoDecision> {
    const r = this.resultado(p.id, estado, motivo, mensaje);
    const averia = estado === EstadoPropuestaAgente.FALLIDA;
    if (origen === OrigenDecision.TELEGRAM || (origen === OrigenDecision.AUTO && averia)) {
      await this.avisos.agente(
        p.agent.user_id,
        EventoAgente.RESULTADO_PROPUESTA,
        averia ? EventSeverity.ERROR : EventSeverity.WARN,
        `${p.symbol} ${p.side === 'LONG' ? 'largo' : 'corto'}: ${r.mensaje}`,
        { agentId: p.agent.id, propuestaId: p.id },
      );
    }
    return r;
  }

  private yaDecidida(p: { id: string; state: string; bot_id: string | null }): ResultadoDecision {
    return {
      propuestaId: p.id,
      // Frontera Prisma: calca `EstadoPropuestaAgente`.
      estado: p.state as EstadoPropuestaAgente,
      motivo: null,
      botId: p.bot_id,
      mensaje: 'La propuesta ya no está pendiente.',
    };
  }

  private resultado(
    id: string,
    estado: EstadoPropuestaAgente,
    motivo: MotivoPropuestaAgente,
    mensaje?: string,
  ): ResultadoDecision {
    return {
      propuestaId: id,
      estado,
      motivo,
      botId: null,
      mensaje: mensaje ?? MENSAJES[motivo] ?? 'No se ha abierto nada.',
    };
  }
}

/** El nombre del bot de una operación: el agente, el par y el lado. Cabe en 64. */
export function nombreDelBot(agente: string, plan: Pick<PlanAgente, 'simbolo' | 'lado'>): string {
  const cola = ` · ${plan.simbolo} ${plan.lado === 'LONG' ? 'largo' : 'corto'}`;
  return `${agente.slice(0, Math.max(1, 64 - cola.length))}${cola}`.slice(0, 64);
}

/** El mensaje de un error HTTP de Nest, sin su cuerpo entero. */
function mensajeDe(e: HttpException): string {
  const cuerpo = e.getResponse();
  if (typeof cuerpo === 'string') return cuerpo;
  const m = (cuerpo as { message?: unknown }).message;
  return typeof m === 'string' ? m : Array.isArray(m) ? m.join('; ') : e.message;
}
