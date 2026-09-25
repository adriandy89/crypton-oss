import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AccionSeguimiento,
  ActorKind,
  AuditOutcome,
  D,
  EfectoAccion,
  EstadoAccionAgente,
  EstadoAgente,
  EstadoPropuestaAgente,
  EstadoRondaAgente,
  EventSeverity,
  EventoAgente,
  ModoDecision,
  MotivoRonda,
  TipoRondaAgente,
  VerboAgente,
  cambioSeguimientoDe,
  efectoDe,
  planAgenteDe,
  type BotConfig,
  type ClaseAccion,
  type DisparadorSeguimiento,
  type EstadoOperacionAgente,
  type IntervaloAgente,
  type OpcionSeguimiento,
  type RespuestaModeloSeguimiento,
  type ResultadoAccionAgente,
  type RondaVista,
} from '@crypton/shared';
import {
  estadoOperacion,
  huellaSeguimiento,
  juezSeguimiento,
  leerLimitesAgente,
  leerOperacionAgente,
  ofreciblesSegun,
  opcionesSeguimiento,
  soloReduceRiesgo,
  ultimaCerradaEsperada,
  type OperacionViva,
} from '@crypton/strategy-core';
import { AuditService, CacheService, DbService } from 'src/libs';
import { OpenRouterClient, type RespuestaDecision } from '../advisor/openrouter.client';
import { BotsService } from '../bots/bots.service';
import { AiDeskConfig } from './ai-desk.config';
import { DUENO_DE_AGENTES } from './agentes.service';
import { OrigenDecision } from './aprobacion.service';
import { AiDeskAvisosService } from './avisos.service';
import { AiDeskConsumoService } from './consumo.service';
import { recortarSinPartir } from './contrato';
import { accionEfectiva, esquemaSeguimiento, parseSeguimiento } from './contrato-seguimiento';
import { AiDeskLecturaService } from './lectura.service';
import { systemPromptSeguimiento, versionPromptSeguimiento } from './prompt-seguimiento';
import { renderSeguimiento } from './render-seguimiento';
import { textoAccion } from './textos';
import { SELECT_RONDA_VISTA, autonomiaDe, esCuentaReal, rondaVista } from './vistas';

/** Lo que se guarda de una respuesta fuera del contrato, para poder mirarla. */
const MAX_BRUTO = 2_000;

/** Quién dispara un seguimiento. */
export type DisparadorRonda = DisparadorSeguimiento;

/** En qué acabó decidir una acción, para quien lo pidió. */
/** La forma vive en shared: la app la lee tal cual. */
export type ResultadoAccion = ResultadoAccionAgente;

const SELECT_OPERACION = {
  id: true,
  state: true,
  symbol: true,
  side: true,
  plan: true,
  final_plan: true,
  opened_at: true,
  bot_id: true,
  agent: {
    select: {
      id: true,
      name: true,
      user_id: true,
      state: true,
      interval: true,
      decision_mode: true,
      limits: true,
      auto_entry: true,
      auto_reduce: true,
      auto_close: true,
      sleeping_until: true,
      usage_day: true,
      cost_today: true,
      exchange_account: {
        select: { id: true, venue: true, paper: true, testnet: true },
      },
      user: { select: { role: true, disabled: true } },
    },
  },
  bot: {
    select: {
      id: true,
      status: true,
      config_version: true,
      cycles: {
        where: { closed_at: null },
        orderBy: { seq: 'desc' },
        take: 1,
        select: { average_entry: true, scratch: true },
      },
      snapshots: {
        orderBy: { taken_at: 'desc' },
        take: 1,
        select: { position_qty: true, average_entry: true },
      },
    },
  },
} as const;

type Operacion = NonNullable<Awaited<ReturnType<AiDeskSeguimientoService['leerOperacion']>>>;

/** Lo que la ronda de seguimiento guarda de lo que vio. */
interface Vista {
  estado: EstadoOperacionAgente;
  opciones: OpcionSeguimiento[];
}

/**
 * El seguimiento de las operaciones vivas de los agentes (spec 074, R-22 a
 * R-24).
 *
 * Todo lo que puede hacer REDUCE el riesgo, y solo toca dos campos del bot:
 * `stopPrice`, más ceñido, y `positionCap`, menor. Lo aplica por
 * `BotsService.updateConfig` con la versión que leyó y su propio firmante, como
 * cualquier cambio de configuración: no hay un segundo camino de escritura
 * (invariante 13). Y lo comprueba tres veces: el motor solo ofrece opciones que
 * ciñen o reducen, aquí `soloReduceRiesgo` lo vuelve a mirar contra la
 * configuración vigente, y la estrategia no ensancha su stop aunque se lo pidan.
 *
 * Cuándo mira: por su intervalo, solo si su expediente cambió (la huella), y
 * al cobrar el primer objetivo. Un bot pausado por una persona no se toca.
 * Pausar el agente no corta el seguimiento: reducir el riesgo nunca se corta.
 */
@Injectable()
export class AiDeskSeguimientoService {
  private readonly logger = new Logger(AiDeskSeguimientoService.name);
  private enCurso = 0;

  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly cfg: AiDeskConfig,
    private readonly lectura: AiDeskLecturaService,
    private readonly modelo: OpenRouterClient,
    private readonly consumo: AiDeskConsumoService,
    private readonly avisos: AiDeskAvisosService,
    private readonly bots: BotsService,
    private readonly audit: AuditService,
  ) {}

  get huecos(): number {
    return Math.max(0, this.cfg.concurrencia - this.enCurso);
  }

  async leerOperacion(propuestaId: string) {
    return this.db.aiDeskProposal.findUnique({
      where: { id: propuestaId },
      select: SELECT_OPERACION,
    });
  }

  // ── La ronda ─────────────────────────────────────────────────────────────

  /**
   * Una ronda de seguimiento. null si no le toca a esta réplica: no hay hueco,
   * la operación ya no está abierta o la de esta vela y disparador ya la hizo
   * otra (uq_ai_desk_round_seguimiento).
   */
  async rondaSeguimiento(
    propuestaId: string,
    disparador: DisparadorRonda,
    ahora = Date.now(),
  ): Promise<{ rondaId: string; estado: EstadoRondaAgente; motivo: MotivoRonda } | null> {
    if (this.enCurso >= this.cfg.concurrencia) return null;
    this.enCurso++;
    try {
      const op = await this.leerOperacion(propuestaId);
      if (!op || op.state !== EstadoPropuestaAgente.ABIERTA) return null;
      // Frontera Prisma: el intervalo se validó al guardar el agente.
      const intervalo = op.agent.interval as IntervaloAgente;
      let rondaId: string;
      try {
        rondaId = (
          await this.db.aiDeskRound.create({
            data: {
              agent_id: op.agent.id,
              kind: TipoRondaAgente.SEGUIMIENTO,
              bar_t: new Date(ultimaCerradaEsperada(ahora, intervalo)),
              trigger: disparador,
              proposal_id: op.id,
              decision_mode: modoDe(op.agent),
            },
            select: { id: true },
          })
        ).id;
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') return null;
        throw e;
      }
      try {
        return await this.ronda(rondaId, op, intervalo, disparador, ahora);
      } catch (e) {
        this.logger.error(`Seguimiento ${rondaId} de ${propuestaId}: ${(e as Error).message}`);
        return this.cerrar(rondaId, EstadoRondaAgente.FALLIDA, MotivoRonda.ERROR);
      }
    } finally {
      this.enCurso--;
    }
  }

  /** «Revisar ahora», desde la app: una por minuto y operación, y solo propia. */
  async revisarAhora(adminId: string, propuestaId: string): Promise<RondaVista> {
    const suya = await this.db.aiDeskProposal.findFirst({
      where: { id: propuestaId, agent: { user_id: adminId } },
      select: { id: true, state: true },
    });
    if (!suya) throw new NotFoundException('Operación no encontrada.');
    if (suya.state !== EstadoPropuestaAgente.ABIERTA) {
      throw new HttpException('La operación no está abierta.', HttpStatus.CONFLICT);
    }
    const libre = await this.cache
      .setnx(`ai-desk:revisar:${propuestaId}`, 1, 60)
      .catch(() => false);
    if (!libre) {
      throw new HttpException(
        'Espera un minuto entre dos revisiones de la misma operación.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const r = await this.rondaSeguimiento(propuestaId, 'MANUAL');
    if (!r) {
      throw new ServiceUnavailableException(
        'Ahora mismo hay demasiadas revisiones en curso. Vuelve a intentarlo en un momento.',
      );
    }
    const fila = await this.db.aiDeskRound.findUnique({
      where: { id: r.rondaId },
      select: SELECT_RONDA_VISTA,
    });
    if (!fila) throw new NotFoundException('Ronda no encontrada.');
    return rondaVista(fila);
  }

  private async ronda(
    rondaId: string,
    op: Operacion,
    intervalo: IntervaloAgente,
    disparador: DisparadorRonda,
    ahora: number,
  ) {
    const saltar = (motivo: MotivoRonda, extra: Record<string, unknown> = {}) =>
      this.cerrar(rondaId, EstadoRondaAgente.SALTADA, motivo, extra);
    const agente = op.agent;
    const ia = modoDe(agente) === ModoDecision.IA;

    // Las barreras. No mira el interruptor global de entradas: reducir el riesgo
    // nunca se corta. Ni si el agente está en pausa: eso corta entradas.
    if (!this.cfg.encendido) return saltar(MotivoRonda.IA_APAGADA);
    if (ia && !this.modelo.agentesDisponible) return saltar(MotivoRonda.IA_APAGADA);
    if (
      agente.user.role !== DUENO_DE_AGENTES.role ||
      agente.user.disabled !== DUENO_DE_AGENTES.disabled
    ) {
      return saltar(MotivoRonda.DUENO);
    }
    if (agente.state === EstadoAgente.ARCHIVADO) return saltar(MotivoRonda.AGENTE);
    if (ia && agente.sleeping_until && agente.sleeping_until.getTime() > ahora) {
      return saltar(MotivoRonda.DORMIDO);
    }
    // Un bot pausado por una persona no se toca (R-23); parado o en error, tampoco.
    if (!op.bot || op.bot.status !== 'RUNNING') return saltar(MotivoRonda.BOT);
    const pendiente = await this.db.aiDeskAction.count({
      where: {
        proposal_id: op.id,
        state: { in: [EstadoAccionAgente.PROPUESTA, EstadoAccionAgente.APLICANDO] },
      },
    });
    if (pendiente > 0) return saltar(MotivoRonda.PENDIENTE);

    const vista = await this.mirar(op, intervalo, ahora);
    if (!vista) return saltar(MotivoRonda.SIN_DATOS);
    const { estado, opciones } = vista;
    const huella = huellaSeguimiento(estado, opciones);
    const conVista = { huella, snapshot: vista as never };

    if (disparador === 'INTERVALO') {
      const previa = await this.db.aiDeskRound.findFirst({
        where: {
          proposal_id: op.id,
          kind: TipoRondaAgente.SEGUIMIENTO,
          state: EstadoRondaAgente.COMPLETADA,
          huella: { not: null },
          id: { not: rondaId },
        },
        orderBy: { created_at: 'desc' },
        select: { huella: true },
      });
      // El mismo expediente que la última vez: nada que preguntar (R-24).
      if (previa?.huella === huella) return saltar(MotivoRonda.HUELLA, conVista);
    }
    // Sin nada más que mantener ofrecido —la autonomía no permite nada—, no se pregunta.
    if (opciones.length <= 1) {
      return this.cerrar(rondaId, EstadoRondaAgente.COMPLETADA, MotivoRonda.MANTENER, conVista);
    }

    let accion: AccionSeguimiento = juezSeguimiento(estado, opciones);
    let respuesta: RespuestaModeloSeguimiento | null = null;
    let llamada: RespuestaDecision | null = null;
    const juez = accion;
    if (ia) {
      const cupo = await this.consumo.cupo(agente, leerLimitesAgente(agente.limits), ahora);
      if (cupo) return saltar(cupo, conVista);
      const acciones = opciones.map((o) => o.accion);
      const plan = planDe(op);
      llamada = await this.modelo.decidirAgente({
        esquema: esquemaSeguimiento(acciones),
        system: systemPromptSeguimiento(),
        usuario: plan ? renderSeguimiento(plan, estado, opciones) : '',
        limiteMs: this.cfg.plazoLlamadaMs,
      });
      const coste = llamada.uso?.coste ?? null;
      const columnas = this.columnasLlamada(llamada);
      if (llamada.contenido === null || llamada.fallo !== null) {
        const fallo = llamada.fallo ?? 'VACIA';
        await this.consumo.anotar(agente, coste, `MODELO:${fallo}`, ahora);
        return this.cerrar(rondaId, EstadoRondaAgente.FALLIDA, MotivoRonda.MODELO, {
          ...conVista,
          ...columnas,
          decision: { fallo, juez },
        });
      }
      respuesta = parseSeguimiento(llamada.contenido, acciones);
      if (!respuesta) {
        await this.consumo.anotar(agente, coste, 'CONTRATO', ahora);
        return this.cerrar(rondaId, EstadoRondaAgente.FALLIDA, MotivoRonda.CONTRATO, {
          ...conVista,
          ...columnas,
          decision: {
            fallo: 'CONTRATO',
            juez,
            bruto: recortarSinPartir(llamada.contenido, MAX_BRUTO),
          },
        });
      }
      await this.consumo.anotar(agente, coste, null, ahora);
      accion = accionEfectiva(respuesta);
    }

    const decision = { accion, juez, respuesta } as never;
    const columnas = { ...conVista, ...this.columnasLlamada(llamada), decision };
    const opcion = opciones.find((o) => o.accion === accion);
    if (accion === AccionSeguimiento.MANTENER || !opcion?.clase) {
      return this.cerrar(rondaId, EstadoRondaAgente.COMPLETADA, MotivoRonda.MANTENER, columnas);
    }
    const resultado = await this.cerrar(
      rondaId,
      EstadoRondaAgente.COMPLETADA,
      MotivoRonda.ACCION,
      columnas,
    );
    await this.actuar(rondaId, op, opcion, opcion.clase, respuesta, ahora);
    return resultado;
  }

  /** La operación viva, sus opciones y cómo va, o null si falta algo para verla. */
  private async mirar(
    op: Operacion,
    intervalo: IntervaloAgente,
    ahora: number,
  ): Promise<Vista | null> {
    const plan = planDe(op);
    const ciclo = op.bot?.cycles[0];
    const snapshot = op.bot?.snapshots[0];
    // Frontera Prisma-JSON: el scratch del ciclo lo escribe el motor; se lee con su lector.
    const scratch = (ciclo?.scratch ?? {}) as Record<string, unknown>;
    const estadoBot = leerOperacionAgente(scratch['op']);
    const posicion = snapshot ? D(snapshot.position_qty.toString()).abs() : D(0);
    const entrada = ciclo?.average_entry ?? snapshot?.average_entry ?? null;
    if (!plan || !estadoBot?.maximo || !posicion.gt(0) || !entrada) return null;
    const cuenta = op.agent.exchange_account;
    const lectura = await this.lectura.par(cuenta.venue, op.symbol, cuenta.testnet, intervalo);
    if (!lectura?.par.ticker) return null;
    const viva: OperacionViva = {
      plan,
      entrada: entrada.toString(),
      posicion: posicion.toFixed(),
      posicionInicial: estadoBot.maximo,
      stop: estadoBot.stop ?? estadoBot.stopInicial,
      tp1Hecho: estadoBot.tp1Hecho === true,
      abiertaEn: estadoBot.abiertaEn ?? op.opened_at?.getTime() ?? ahora,
    };
    const entradaSeguimiento = {
      op: viva,
      market: lectura.par.market,
      ticker: lectura.par.ticker,
      velas: lectura.par.velas,
      ahora,
    };
    const real = esCuentaReal(cuenta);
    const autonomia = autonomiaDe(op.agent);
    const frenos = this.cfg.frenos;
    return {
      estado: estadoOperacion(entradaSeguimiento),
      opciones: ofreciblesSegun(opcionesSeguimiento(entradaSeguimiento), (clase) =>
        efectoDe(clase, autonomia, frenos, real),
      ),
    };
  }

  // ── Las acciones ─────────────────────────────────────────────────────────

  /** Lo elegido, según la autonomía de su clase: se aplica, se propone o se mide. */
  private async actuar(
    rondaId: string,
    op: Operacion,
    opcion: OpcionSeguimiento,
    clase: ClaseAccion,
    respuesta: RespuestaModeloSeguimiento | null,
    ahora: number,
  ): Promise<void> {
    const cuenta = op.agent.exchange_account;
    const efecto = efectoDe(clase, autonomiaDe(op.agent), this.cfg.frenos, esCuentaReal(cuenta));
    if (efecto === EfectoAccion.NUNCA) return;
    const estado =
      efecto === EfectoAccion.APLICA
        ? EstadoAccionAgente.APLICANDO
        : efecto === EfectoAccion.PROPONE
          ? EstadoAccionAgente.PROPUESTA
          : EstadoAccionAgente.SOMBRA;
    const vidaMs = this.cfg.vidaAccionMin * 60_000;
    let accionId: string;
    try {
      accionId = (
        await this.db.aiDeskAction.create({
          data: {
            proposal_id: op.id,
            agent_id: op.agent.id,
            round_id: rondaId,
            action: opcion.accion,
            action_class: clase,
            state: estado,
            // Frontera Prisma-JSON: solo `stopPrice` y `positionCap`, en cadena decimal.
            change: opcion.cambio as never,
            decision: { respuesta, opcion } as never,
            expires_at: new Date(ahora + vidaMs),
            ...(efecto === EfectoAccion.APLICA
              ? { decided_by: OrigenDecision.AUTO, decided_at: new Date(ahora) }
              : {}),
          },
          select: { id: true },
        })
      ).id;
    } catch (e) {
      // Otra acción quedó pendiente entre medias (uq_ai_desk_action_pendiente).
      if ((e as { code?: string }).code === 'P2002') return;
      throw e;
    }
    const texto = respuesta?.texto ? respuesta.texto : null;
    if (efecto === EfectoAccion.APLICA) {
      await this.aplicar(accionId, OrigenDecision.AUTO, texto);
      return;
    }
    if (efecto !== EfectoAccion.PROPONE) return;
    const vale = await this.avisos.vale(
      { userId: op.agent.user_id, agentId: op.agent.id, propuestaId: op.id, accionId },
      vidaMs / 1000,
    );
    await this.avisos.agente(
      op.agent.user_id,
      EventoAgente.ACCION,
      EventSeverity.INFO,
      textoAccion(opcion, {
        simbolo: op.symbol,
        lado: ladoDe(op.side),
        texto,
        vidaMin: this.cfg.vidaAccionMin,
      }) + (vale ? '' : '\nDecídelo desde la app.'),
      {
        agentId: op.agent.id,
        propuestaId: op.id,
        accionId,
        accion: opcion.accion,
        ...(vale ? { vale } : {}),
      },
    );
  }

  /**
   * Aplica una acción en `APLICANDO`: el cambio sobre la configuración vigente,
   * si sigue reduciendo el riesgo, por `updateConfig` con la versión leída.
   * Cada salida deja la acción en un estado.
   */
  async aplicar(accionId: string, origen: OrigenDecision, texto: string | null = null) {
    const a = await this.db.aiDeskAction.findUnique({
      where: { id: accionId },
      select: {
        id: true,
        state: true,
        action: true,
        change: true,
        decision: true,
        proposal: {
          select: {
            id: true,
            state: true,
            symbol: true,
            side: true,
            agent: { select: { id: true, user_id: true } },
            bot: { select: { id: true, status: true, config_version: true } },
          },
        },
      },
    });
    if (!a || a.state !== EstadoAccionAgente.APLICANDO) return;
    const terminar = (state: EstadoAccionAgente, reason: string | null, extra = {}) =>
      this.db.aiDeskAction.updateMany({
        where: { id: accionId, state: EstadoAccionAgente.APLICANDO },
        data: { state, reason, ...extra },
      });
    const op = a.proposal;
    if (op.state !== EstadoPropuestaAgente.ABIERTA || !op.bot) {
      await terminar(EstadoAccionAgente.DESCARTADA, 'CERRADA');
      return;
    }
    const cambio = cambioSeguimientoDe(a.change);
    if (!cambio) {
      await terminar(EstadoAccionAgente.FALLIDA, 'CAMBIO');
      return;
    }
    const revision = await this.db.botConfigRevision.findUnique({
      where: { bot_id_version: { bot_id: op.bot.id, version: op.bot.config_version } },
      select: { config: true },
    });
    // Frontera Prisma-JSON: la configuración se guardó validada.
    const anterior = (revision?.config ?? null) as BotConfig | null;
    const nueva = anterior ? ({ ...anterior, ...cambio } as BotConfig) : null;
    // Contra la configuración de AHORA: si ya tiene un stop más ceñido o un tope
    // más bajo —otra acción, o su dueño—, esta ya no reduce nada.
    if (!anterior || !nueva || !soloReduceRiesgo(anterior, nueva)) {
      await terminar(EstadoAccionAgente.DESCARTADA, 'CUBIERTA');
      return;
    }
    let version: number | null = null;
    try {
      const r = await this.bots.updateConfig(
        op.agent.user_id,
        op.bot.id,
        { config: nueva },
        { appliedBy: `ai-desk:${op.agent.id}`, expectedVersion: op.bot.config_version },
      );
      version = 'version' in r && typeof r.version === 'number' ? r.version : null;
    } catch (e) {
      if (!(e instanceof HttpException)) throw e;
      const rancia = e.getStatus() === 409;
      this.logger.warn(`La acción ${accionId} no se aplicó: ${e.message}`);
      await terminar(EstadoAccionAgente.FALLIDA, rancia ? 'VERSION' : 'CONFIG');
      return;
    }
    if (version === null) {
      await terminar(EstadoAccionAgente.DESCARTADA, 'SIN_CAMBIOS');
      return;
    }
    await terminar(EstadoAccionAgente.APLICADA, null, { applied_version: version });
    // Frontera Prisma-JSON: la opción la escribió la ronda.
    const opcion = (a.decision as { opcion?: OpcionSeguimiento } | null)?.opcion;
    if (opcion) {
      await this.avisos.agente(
        op.agent.user_id,
        EventoAgente.ACCION,
        EventSeverity.INFO,
        textoAccion(opcion, { simbolo: op.symbol, lado: ladoDe(op.side), texto, vidaMin: null }),
        { agentId: op.agent.id, propuestaId: op.id, accionId, accion: opcion.accion },
      );
    }
    await this.audit.recordNow({
      actor: origen === OrigenDecision.AUTO ? ActorKind.SYSTEM : ActorKind.ADMIN,
      actorId: origen === OrigenDecision.AUTO ? null : op.agent.user_id,
      botId: op.bot.id,
      action: 'admin.ai_desk.action_apply',
      severity: EventSeverity.INFO,
      outcome: AuditOutcome.OK,
      message: `Seguimiento del agente: ${a.action} (${origen}).`,
      meta: { agentId: op.agent.id, propuestaId: op.id, accionId, origen, cambio },
    });
  }

  /** Aprueba una acción propuesta: la misma aplicación que la automática. */
  async aprobarAccion(
    userId: string,
    accionId: string,
    origen: OrigenDecision,
  ): Promise<ResultadoAccion> {
    await this.suya(userId, accionId);
    const reclamada = await this.db.aiDeskAction.updateMany({
      where: {
        id: accionId,
        state: EstadoAccionAgente.PROPUESTA,
        expires_at: { gt: new Date() },
      },
      data: { state: EstadoAccionAgente.APLICANDO, decided_by: origen, decided_at: new Date() },
    });
    if (reclamada.count !== 1) return this.enQueAcabo(accionId, 'La acción ya no está pendiente.');
    await this.aplicar(accionId, origen);
    return this.enQueAcabo(accionId, null);
  }

  async rechazarAccion(
    userId: string,
    accionId: string,
    origen: OrigenDecision,
  ): Promise<ResultadoAccion> {
    await this.suya(userId, accionId);
    const r = await this.db.aiDeskAction.updateMany({
      where: { id: accionId, state: EstadoAccionAgente.PROPUESTA },
      data: {
        state: EstadoAccionAgente.RECHAZADA,
        reason: 'PERSONA',
        decided_by: origen,
        decided_at: new Date(),
      },
    });
    return this.enQueAcabo(accionId, r.count === 1 ? null : 'La acción ya no está pendiente.');
  }

  /**
   * Cierra la operación a petición de su dueño, con el comando de siempre
   * (`STOP_AND_CLOSE`): la salida queda como suya, no del seguimiento. Lo
   * que esperaba respuesta deja de esperarla.
   */
  async cerrarOperacion(
    userId: string,
    propuestaId: string,
    origen: OrigenDecision,
  ): Promise<ResultadoAccion> {
    const op = await this.db.aiDeskProposal.findFirst({
      where: { id: propuestaId, agent: { user_id: userId } },
      select: { id: true, state: true, bot_id: true, agent: { select: { id: true } } },
    });
    if (!op) throw new NotFoundException('Operación no encontrada.');
    if (
      !op.bot_id ||
      (op.state !== EstadoPropuestaAgente.ABIERTA && op.state !== EstadoPropuestaAgente.EJECUTANDO)
    ) {
      return {
        accionId: null,
        estado: op.state,
        motivo: null,
        mensaje: 'La operación ya no está abierta.',
      };
    }
    await this.db.aiDeskAction.updateMany({
      where: { proposal_id: op.id, state: EstadoAccionAgente.PROPUESTA },
      data: { state: EstadoAccionAgente.DESCARTADA, reason: 'SUSTITUIDA' },
    });
    try {
      await this.bots.command(userId, op.bot_id, { command: 'STOP_AND_CLOSE', confirm: true });
    } catch (e) {
      if (!(e instanceof HttpException)) throw e;
      return { accionId: null, estado: op.state, motivo: 'COMANDO', mensaje: e.message };
    }
    await this.audit.recordNow({
      actor: ActorKind.ADMIN,
      actorId: userId,
      botId: op.bot_id,
      action: 'admin.ai_desk.trade_close',
      severity: EventSeverity.WARN,
      outcome: AuditOutcome.OK,
      message: `Operación del agente cerrada por su dueño (${origen}).`,
      meta: { agentId: op.agent.id, propuestaId: op.id, origen },
    });
    return {
      accionId: null,
      estado: op.state,
      motivo: null,
      mensaje: 'Cerrando la operación a mercado.',
    };
  }

  /**
   * Una pulsación de un botón de acción (el vale lleva `accionId`). Devuelve
   * false si el vale no es de una acción.
   */
  async pulsacion(
    userId: string,
    vale: { userId: string; propuestaId: string; accionId: string | null },
    verbo: VerboAgente,
  ): Promise<boolean> {
    if (vale.accionId === null) return false;
    if (vale.userId !== userId) return true;
    try {
      if (verbo === VerboAgente.SI) {
        await this.aprobarAccion(userId, vale.accionId, OrigenDecision.TELEGRAM);
      } else if (verbo === VerboAgente.NO) {
        await this.rechazarAccion(userId, vale.accionId, OrigenDecision.TELEGRAM);
      } else {
        await this.cerrarOperacion(userId, vale.propuestaId, OrigenDecision.TELEGRAM);
      }
    } catch (e) {
      if (!(e instanceof NotFoundException)) throw e;
    }
    return true;
  }

  /** Caduca las acciones que nadie respondió a tiempo. */
  async caducar(ahora: number): Promise<number> {
    const r = await this.db.aiDeskAction.updateMany({
      where: { state: EstadoAccionAgente.PROPUESTA, expires_at: { lt: new Date(ahora) } },
      data: { state: EstadoAccionAgente.CADUCADA, reason: 'CADUCIDAD' },
    });
    return r.count;
  }

  // ── Interno ──────────────────────────────────────────────────────────────

  private async suya(userId: string, accionId: string): Promise<void> {
    const a = await this.db.aiDeskAction.findFirst({
      where: { id: accionId, proposal: { agent: { user_id: userId } } },
      select: { id: true },
    });
    if (!a) throw new NotFoundException('Acción no encontrada.');
  }

  private async enQueAcabo(accionId: string, mensaje: string | null): Promise<ResultadoAccion> {
    const a = await this.db.aiDeskAction.findUnique({
      where: { id: accionId },
      select: { state: true, reason: true },
    });
    return {
      accionId,
      estado: a?.state ?? EstadoAccionAgente.FALLIDA,
      motivo: a?.reason ?? null,
      mensaje:
        mensaje ??
        (a?.state === EstadoAccionAgente.APLICADA
          ? 'Aplicado.'
          : a?.state === EstadoAccionAgente.RECHAZADA
            ? 'Acción descartada.'
            : 'No se ha aplicado.'),
    };
  }

  private async cerrar(
    rondaId: string,
    estado: EstadoRondaAgente,
    motivo: MotivoRonda,
    extra: Record<string, unknown> = {},
  ) {
    await this.db.aiDeskRound.update({
      where: { id: rondaId },
      // Frontera Prisma: el snapshot y la decisión son objetos planos.
      data: { state: estado, reason: motivo, finished_at: new Date(), ...extra } as never,
    });
    return { rondaId, estado, motivo };
  }

  private columnasLlamada(l: RespuestaDecision | null): Record<string, unknown> {
    if (!l) return {};
    return {
      model: l.modelo,
      prompt_version: versionPromptSeguimiento(),
      latency_ms: l.latenciaMs,
      cost: l.uso?.coste ?? null,
    };
  }
}

/** El lado de una propuesta: los candidatos solo son largos o cortos. */
const ladoDe = (d: string): 'LONG' | 'SHORT' => (d === 'SHORT' ? 'SHORT' : 'LONG');

const modoDe = (a: { decision_mode: string }): ModoDecision =>
  a.decision_mode === ModoDecision.REGLAS ? ModoDecision.REGLAS : ModoDecision.IA;

const planDe = (op: { final_plan: unknown; plan: unknown }) =>
  planAgenteDe(op.final_plan) ?? planAgenteDe(op.plan);
