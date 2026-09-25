import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@crypton/db';
import {
  ActorKind,
  AiMode,
  AuditOutcome,
  EstadoAgente,
  EstadoPropuestaAgente,
  EventSeverity,
  MotivoPausaAgente,
  MotivoPropuestaAgente,
  PROPUESTAS_VIVAS,
  TipoRondaAgente,
  proximaRondaAgente,
  type AgenteVista,
  type DetalleAgente,
  type ErrorAgente,
  type FamiliaAgente,
  type InterruptoresAgentes,
  type IntervaloAgente,
  type ResumenAgentes,
  type Venue,
} from '@crypton/shared';
import { VENUE_CAPABILITIES } from '@crypton/exchange-core';
import { leerLimitesAgente, peorDiaAgente, usoDelDia } from '@crypton/strategy-core';
import { AuditService, DbService } from 'src/libs';
import { MarketsService } from '../markets';
import { AiDeskConfig } from './ai-desk.config';
import type { CrearAgenteDto, EditarAgenteDto, ReanudarAgenteDto } from './dtos';
import { CERRADAS_MIRADAS, ESTADOS_ACTIVOS, historialDe } from './historial';
import { AiDeskInterruptoresService } from './interruptores.service';
import { limitesDeEntrada, validarDefinicion, type DefinicionAgente } from './validacion';
import {
  SELECT_AGENTE,
  SELECT_RONDA_VISTA,
  agenteVista,
  esCuentaReal,
  rondaVista,
  type FilaAgente,
} from './vistas';

/** El dueño de un agente: administrador y con la cuenta habilitada. Se lee de la base. */
export const DUENO_DE_AGENTES = { role: Role.ADMIN, disabled: false } as const;

/** Las rondas que acompañan al detalle de un agente. */
const ULTIMAS_RONDAS = 10;

/** Los estados de un bot vivo: los que ocupan su par en la cuenta (invariante 11). */
const BOT_VIVO = ['STARTING', 'RUNNING', 'PAUSED'] as const;

const SELECT_HISTORIAL = {
  id: true,
  symbol: true,
  state: true,
  plan: true,
  final_plan: true,
  expires_at: true,
  decided_at: true,
  opened_at: true,
  closed_at: true,
  exit: true,
  realized_pnl: true,
} as const;

/**
 * Los agentes de IA de un administrador (spec 074): crearlos, editarlos,
 * pausarlos, reanudarlos y archivarlos, y enseñarlos.
 *
 * Cada administrador ve y toca solo los suyos: uno ajeno responde 404, como si
 * no existiera. El rol se lee de la BASE en todo lo que da poder (R-28): la
 * sesión puede ser de antes de que se lo quitaran.
 *
 * Nada de aquí habla con el exchange ni con el modelo. No importa
 * `ExchangeAccountsModule`: es la puerta a descifrar la clave de firma.
 */
@Injectable()
export class AiDeskAgentesService {
  constructor(
    private readonly db: DbService,
    private readonly markets: MarketsService,
    private readonly cfg: AiDeskConfig,
    private readonly interruptores: AiDeskInterruptoresService,
    private readonly audit: AuditService,
  ) {}

  // ── Leer ─────────────────────────────────────────────────────────────────

  async resumen(adminId: string): Promise<ResumenAgentes> {
    const [filas, interruptores] = await Promise.all([
      this.db.aiDeskAgent.findMany({
        where: { user_id: adminId },
        // Los archivados al final: son historia.
        orderBy: [{ archived_at: { sort: 'asc', nulls: 'first' } }, { created_at: 'desc' }],
        select: SELECT_AGENTE,
      }),
      this.interruptores.interruptores(),
    ]);
    const cuentas = await this.cuentas(filas.map((f) => f.id));
    const ahora = Date.now();
    const agentes = filas.map((f) =>
      agenteVista(f, cuentas.get(f.id) ?? { vivas: 0, pendientes: 0 }, interruptores, ahora),
    );
    return {
      interruptores,
      agentes,
      pendientes: agentes.reduce((n, a) => n + a.pendientes, 0),
      vivas: agentes.reduce((n, a) => n + a.vivas, 0),
      maxPares: this.cfg.maxPares,
    };
  }

  async detalle(adminId: string, id: string): Promise<DetalleAgente> {
    const fila = await this.suyo(adminId, id);
    const ahora = Date.now();
    const [interruptores, historial, cuentas, rondas] = await Promise.all([
      this.interruptores.interruptores(),
      this.historial(fila, ahora),
      this.cuentas([id]),
      // Solo las de entrada: son las que responden a «¿por qué no propone
      // nada?», y las de seguimiento —una por vela y operación— las taparían.
      // Esas se ven en el detalle de su operación.
      this.db.aiDeskRound.findMany({
        where: { agent_id: id, kind: TipoRondaAgente.ENTRADA },
        orderBy: { created_at: 'desc' },
        take: ULTIMAS_RONDAS,
        select: SELECT_RONDA_VISTA,
      }),
    ]);
    const limites = leerLimitesAgente(fila.limits);
    return {
      agente: agenteVista(
        fila,
        cuentas.get(id) ?? { vivas: 0, pendientes: 0 },
        interruptores,
        ahora,
      ),
      uso: usoDelDia(historial, limites),
      peorDia: peorDiaAgente(limites),
      rondas: rondas.map(rondaVista),
    };
  }

  /**
   * Lo operado por un agente, para sus límites del día. Lo usan el detalle, la
   * ronda y el recálculo al aprobar; `excluir` es la propuesta que se aprueba.
   */
  async historial(
    agente: { id: string; exchange_account: { id: string } },
    ahora: number,
    excluir: string | null = null,
  ) {
    const [activas, cerradas, bots] = await Promise.all([
      this.db.aiDeskProposal.findMany({
        where: { agent_id: agente.id, state: { in: [...ESTADOS_ACTIVOS] } },
        select: SELECT_HISTORIAL,
      }),
      this.db.aiDeskProposal.findMany({
        where: { agent_id: agente.id, state: EstadoPropuestaAgente.CERRADA },
        orderBy: { closed_at: 'desc' },
        take: CERRADAS_MIRADAS,
        select: SELECT_HISTORIAL,
      }),
      // Los bots reales vivos del usuario en la misma cuenta: su par está
      // ocupado para siempre mientras vivan (invariante 11). Los de las propias
      // operaciones del agente ya cuentan como vivas.
      this.db.bot.findMany({
        where: {
          exchange_account_id: agente.exchange_account.id,
          status: { in: [...BOT_VIVO] },
          dry_run: false,
        },
        select: { symbol: true },
      }),
    ]);
    return historialDe(
      activas,
      cerradas,
      bots.map((b) => b.symbol),
      ahora,
      excluir,
    );
  }

  // ── Escribir ─────────────────────────────────────────────────────────────

  async crear(adminId: string, dto: CrearAgenteDto): Promise<AgenteVista> {
    await this.exigirAdmin(adminId);
    const cuenta = await this.db.exchangeAccount.findFirst({
      where: { id: dto.exchangeAccountId, user_id: adminId },
      select: { id: true, venue: true, paper: true, testnet: true, status: true },
    });
    if (!cuenta) throw new NotFoundException('Conexión de exchange no encontrada.');
    if (cuenta.status === 'REVOKED') throw new BadRequestException('Esa conexión está revocada.');

    const def = await this.definicion(dto, cuenta.venue, cuenta.testnet);
    const real = esCuentaReal(cuenta);
    if (real && dto.consentimiento !== true) throw this.sinConsentimiento();

    const ahora = Date.now();
    const fila = await this.db.aiDeskAgent.create({
      data: {
        user_id: adminId,
        exchange_account_id: cuenta.id,
        venue: cuenta.venue,
        name: def.nombre,
        symbols: def.pares,
        interval: def.intervalo,
        families: def.familias,
        sides: def.lados,
        decision_mode: def.modo,
        // Frontera Prisma-JSON: los límites se acaban de validar enteros.
        limits: def.limites as never,
        auto_entry: def.autonomia.entrar,
        auto_reduce: def.autonomia.reducir,
        auto_close: def.autonomia.cerrar,
        next_round_at: new Date(proximaRondaAgente(ahora, def.intervalo)),
      },
      select: SELECT_AGENTE,
    });
    await this.auditar(adminId, 'admin.ai_desk.agent_create', real, dto.reason, {
      agentId: fila.id,
      real,
      pares: def.pares,
      autonomia: def.autonomia,
      modo: def.modo,
    });
    return this.vista(fila);
  }

  async editar(adminId: string, id: string, dto: EditarAgenteDto): Promise<AgenteVista> {
    await this.exigirAdmin(adminId);
    const actual = await this.suyo(adminId, id);
    if (actual.state === EstadoAgente.ARCHIVADO) {
      throw new ConflictException('El agente está archivado y ya no se puede editar.');
    }
    if (dto.version !== actual.version) throw this.rancio(dto.version, actual.version);

    const cuenta = actual.exchange_account;
    const def = await this.definicion(dto, cuenta.venue as Venue, cuenta.testnet);
    const real = esCuentaReal(cuenta);
    // Pasar «entrar» a automático sobre dinero real pide el mismo consentimiento
    // que crear el agente (R-11): desde ahí, abre operaciones sin preguntar.
    const aAutomatico = def.autonomia.entrar === AiMode.AUTO && actual.auto_entry !== AiMode.AUTO;
    if (real && aAutomatico && dto.consentimiento !== true) throw this.sinConsentimiento();

    const ahora = new Date();
    const cambiaIntervalo = def.intervalo !== actual.interval;
    const escritas = await this.db.aiDeskAgent.updateMany({
      where: { id, version: actual.version, state: { not: EstadoAgente.ARCHIVADO } },
      data: {
        name: def.nombre,
        symbols: def.pares,
        interval: def.intervalo,
        families: def.familias,
        sides: def.lados,
        decision_mode: def.modo,
        limits: def.limites as never,
        auto_entry: def.autonomia.entrar,
        auto_reduce: def.autonomia.reducir,
        auto_close: def.autonomia.cerrar,
        version: { increment: 1 },
        ...(cambiaIntervalo
          ? { next_round_at: new Date(proximaRondaAgente(ahora.getTime(), def.intervalo)) }
          : {}),
      },
    });
    if (escritas.count !== 1) throw this.rancio(dto.version, null);
    // Lo que esperaba respuesta se calculó con la definición de antes: con
    // otros límites, otros pares u otra autonomía, ya no es lo que el agente
    // propondría (R-9).
    await this.descartarPendientes(id, MotivoPropuestaAgente.AGENTE_CAMBIADO, ahora);
    await this.auditar(adminId, 'admin.ai_desk.agent_update', real, dto.reason, {
      agentId: id,
      version: actual.version + 1,
      autonomia: def.autonomia,
      modo: def.modo,
      pares: def.pares,
    });
    return this.vista(await this.suyo(adminId, id));
  }

  /** Pausa las entradas. Lo abierto sigue su seguimiento: solo reduce riesgo. */
  async pausar(adminId: string, id: string, motivo: string): Promise<AgenteVista> {
    const actual = await this.suyo(adminId, id);
    if (actual.state === EstadoAgente.ARCHIVADO) {
      throw new ConflictException('El agente está archivado.');
    }
    const ahora = new Date();
    if (actual.state === EstadoAgente.ACTIVO) {
      await this.db.aiDeskAgent.updateMany({
        where: { id, state: EstadoAgente.ACTIVO },
        data: { state: EstadoAgente.PAUSADO, pause_reason: MotivoPausaAgente.MANUAL },
      });
      await this.descartarPendientes(id, MotivoPropuestaAgente.AGENTE_PAUSADO, ahora);
      await this.auditar(adminId, 'admin.ai_desk.agent_pause', false, motivo, { agentId: id });
    }
    return this.vista(await this.suyo(adminId, id));
  }

  async reanudar(adminId: string, id: string, dto: ReanudarAgenteDto): Promise<AgenteVista> {
    await this.exigirAdmin(adminId);
    const actual = await this.suyo(adminId, id);
    if (actual.state === EstadoAgente.ARCHIVADO) {
      throw new ConflictException('El agente está archivado y no se puede reanudar.');
    }
    const real = esCuentaReal(actual.exchange_account);
    if (actual.state === EstadoAgente.PAUSADO) {
      if (real && dto.consentimiento !== true) throw this.sinConsentimiento();
      await this.db.aiDeskAgent.updateMany({
        where: { id, state: EstadoAgente.PAUSADO },
        data: {
          state: EstadoAgente.ACTIVO,
          pause_reason: null,
          // Frontera Prisma: el intervalo se validó al guardarlo.
          next_round_at: new Date(
            proximaRondaAgente(Date.now(), actual.interval as IntervaloAgente),
          ),
        },
      });
      await this.auditar(adminId, 'admin.ai_desk.agent_resume', real, dto.reason, {
        agentId: id,
        motivoPausa: actual.pause_reason,
      });
    }
    return this.vista(await this.suyo(adminId, id));
  }

  /** Retira un agente. Solo sin operaciones vivas, y no vuelve. */
  async archivar(adminId: string, id: string, motivo: string): Promise<AgenteVista> {
    const actual = await this.suyo(adminId, id);
    if (actual.state === EstadoAgente.ARCHIVADO) return this.vista(actual);
    const vivas = await this.db.aiDeskProposal.count({
      where: { agent_id: id, state: { in: [...PROPUESTAS_VIVAS] } },
    });
    if (vivas > 0) {
      throw new ConflictException(
        `El agente tiene ${vivas} operación(es) viva(s): archívalo cuando terminen. ` +
          'Mientras, puedes pausarlo para que no abra más.',
      );
    }
    const ahora = new Date();
    await this.db.aiDeskAgent.updateMany({
      where: { id, state: { not: EstadoAgente.ARCHIVADO } },
      data: { state: EstadoAgente.ARCHIVADO, archived_at: ahora, next_round_at: null },
    });
    await this.descartarPendientes(id, MotivoPropuestaAgente.AGENTE_PAUSADO, ahora);
    await this.auditar(adminId, 'admin.ai_desk.agent_archive', false, motivo, { agentId: id });
    return this.vista(await this.suyo(adminId, id));
  }

  // ── Interno ──────────────────────────────────────────────────────────────

  /** El agente, si es de quien pregunta. Uno ajeno no existe. */
  private async suyo(adminId: string, id: string): Promise<FilaAgente> {
    const fila = await this.db.aiDeskAgent.findFirst({
      where: { id, user_id: adminId },
      select: SELECT_AGENTE,
    });
    if (!fila) throw new NotFoundException('Agente no encontrado.');
    return fila;
  }

  private async vista(fila: FilaAgente): Promise<AgenteVista> {
    const [interruptores, cuentas]: [InterruptoresAgentes, Map<string, Cuentas>] =
      await Promise.all([this.interruptores.interruptores(), this.cuentas([fila.id])]);
    return agenteVista(
      fila,
      cuentas.get(fila.id) ?? { vivas: 0, pendientes: 0 },
      interruptores,
      Date.now(),
    );
  }

  /** Operaciones vivas y propuestas pendientes de cada agente. */
  private async cuentas(ids: readonly string[]): Promise<Map<string, Cuentas>> {
    const out = new Map<string, Cuentas>();
    if (ids.length === 0) return out;
    const [vivas, pendientes] = await Promise.all([
      this.db.aiDeskProposal.groupBy({
        by: ['agent_id'],
        where: { agent_id: { in: [...ids] }, state: { in: [...PROPUESTAS_VIVAS] } },
        _count: { _all: true },
      }),
      this.db.aiDeskProposal.groupBy({
        by: ['agent_id'],
        where: {
          agent_id: { in: [...ids] },
          state: EstadoPropuestaAgente.PROPUESTA,
          expires_at: { gt: new Date() },
        },
        _count: { _all: true },
      }),
    ]);
    const de = (id: string): Cuentas => out.get(id) ?? { vivas: 0, pendientes: 0 };
    for (const id of ids) out.set(id, de(id));
    for (const g of vivas) out.set(g.agent_id, { ...de(g.agent_id), vivas: g._count._all });
    for (const g of pendientes) {
      out.set(g.agent_id, { ...de(g.agent_id), pendientes: g._count._all });
    }
    return out;
  }

  /** La definición del DTO, validada entera, o un 400 con todos sus errores. */
  private async definicion(
    dto: CrearAgenteDto | EditarAgenteDto,
    venue: Venue,
    testnet: boolean,
  ): Promise<DefinicionAgente> {
    const pares = dto.pares.map((p) => p.trim());
    const errores: ErrorAgente[] = validarDefinicion(
      { nombre: dto.nombre, pares, familias: dto.familias as FamiliaAgente[], lados: dto.lados },
      this.cfg.maxPares,
    );
    const lectura = limitesDeEntrada(dto.limites);
    errores.push(...lectura.errores);
    if (!VENUE_CAPABILITIES[venue].candles.intervals.includes(dto.intervalo)) {
      errores.push({ campo: 'intervalo', mensaje: `${venue} no da velas de ${dto.intervalo}.` });
    }
    // Que cada par exista en el catálogo del venue y de la red de la cuenta.
    for (const par of new Set(pares)) {
      try {
        await this.markets.getSpec(venue, par, testnet);
      } catch (e) {
        if (!(e instanceof NotFoundException)) throw e;
        errores.push({ campo: 'pares', mensaje: `«${par}» no está en ${venue}.` });
      }
    }
    if (errores.length > 0 || !lectura.limites) {
      throw new BadRequestException({ message: 'La definición del agente no es válida.', errores });
    }
    return {
      nombre: dto.nombre.trim(),
      pares,
      intervalo: dto.intervalo,
      familias: dto.familias as FamiliaAgente[],
      lados: dto.lados,
      modo: dto.modo,
      limites: lectura.limites,
      autonomia: {
        entrar: dto.autonomia.entrar,
        reducir: dto.autonomia.reducir,
        cerrar: dto.autonomia.cerrar,
      },
    };
  }

  /** Lo pendiente de un agente deja de estarlo, con su motivo. */
  private async descartarPendientes(
    agentId: string,
    motivo: MotivoPropuestaAgente,
    ahora: Date,
  ): Promise<void> {
    await this.db.aiDeskProposal.updateMany({
      where: { agent_id: agentId, state: EstadoPropuestaAgente.PROPUESTA },
      data: { state: EstadoPropuestaAgente.DESCARTADA, reason: motivo, decided_at: ahora },
    });
  }

  /** El rol, de la base: la sesión puede ser de antes de que se lo quitaran. */
  private async exigirAdmin(userId: string): Promise<void> {
    const u = await this.db.user.findUnique({
      where: { id: userId },
      select: { role: true, disabled: true },
    });
    if (!u || u.role !== DUENO_DE_AGENTES.role || u.disabled !== DUENO_DE_AGENTES.disabled) {
      throw new ForbiddenException('Los agentes de IA son solo para administradores.');
    }
  }

  private sinConsentimiento(): BadRequestException {
    return new BadRequestException({
      message:
        'Este agente opera con dinero real: marca la casilla de consentimiento para continuar.',
      errores: [
        {
          campo: 'consentimiento',
          mensaje: 'Falta el consentimiento para operar con dinero real.',
        },
      ],
    });
  }

  private rancio(pedida: number, actual: number | null): ConflictException {
    return new ConflictException({
      message: 'El agente ha cambiado desde que lo abriste. Vuelve a cargarlo y repite el cambio.',
      code: 'STALE_VERSION',
      expectedVersion: pedida,
      currentVersion: actual,
    });
  }

  private async auditar(
    adminId: string,
    accion: string,
    real: boolean,
    motivo: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.recordNow({
      actor: ActorKind.ADMIN,
      actorId: adminId,
      botId: null,
      action: accion,
      // Lo que puede acabar abriendo operaciones con dinero de verdad, en WARN.
      severity: real ? EventSeverity.WARN : EventSeverity.INFO,
      outcome: AuditOutcome.OK,
      message: `${accion}: ${motivo}`,
      meta: { ...meta, reason: motivo },
    });
  }
}

interface Cuentas {
  vivas: number;
  pendientes: number;
}
