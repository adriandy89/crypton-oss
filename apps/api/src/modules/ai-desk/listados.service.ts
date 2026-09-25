import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@crypton/db';
import {
  D,
  EstadoPropuestaAgente,
  EstadoRondaAgente,
  TipoRondaAgente,
  type DetallePropuesta,
  type ListaOperaciones,
  type ListaPropuestas,
  type ResultadosAgentes,
  type TarjetaAgente,
} from '@crypton/shared';
import { tarjetaAgente, type FilaCandidato, type FilaPropuesta } from '@crypton/strategy-core';
import { DbService } from 'src/libs';
import {
  SELECT_ACCION_VISTA,
  SELECT_REVISION,
  accionVista,
  filaCandidatoDe,
  filaPropuestaDe,
  propuestaVista,
  revisionVista,
} from './listados';
import { SELECT_RONDA_VISTA, esCuentaReal, rondaVista } from './vistas';

/** Lo que se enseña de lo ya decidido o terminado, como mucho. */
const RECIENTES = 50;
/** Las acciones y las rondas de seguimiento de una operación, como mucho. */
const ACCIONES_DETALLE = 50;
const REVISIONES_DETALLE = 20;

/** Las que esperan a una persona: la que se está aprobando sigue en la lista. */
const PENDIENTES = [EstadoPropuestaAgente.PROPUESTA, EstadoPropuestaAgente.APROBANDO];
const VIVAS = [EstadoPropuestaAgente.EJECUTANDO, EstadoPropuestaAgente.ABIERTA];
const TERMINADAS = [EstadoPropuestaAgente.CERRADA, EstadoPropuestaAgente.SIN_ENTRADA];

/** Lo que se selecciona de una propuesta: la forma de `FilaPropuestaVista`. */
const SELECT_PROPUESTA = {
  id: true,
  agent_id: true,
  symbol: true,
  family: true,
  side: true,
  state: true,
  reason: true,
  plan: true,
  final_plan: true,
  decision: true,
  dry_run: true,
  expires_at: true,
  decided_by: true,
  decided_at: true,
  bot_id: true,
  opened_at: true,
  closed_at: true,
  exit: true,
  realized_pnl: true,
  r_real: true,
  outcome: true,
  measured_at: true,
  created_at: true,
  agent: { select: { name: true } },
  bot: {
    select: {
      status: true,
      cycles: {
        orderBy: { seq: 'desc' },
        take: 1,
        select: { scratch: true, average_entry: true },
      },
      snapshots: {
        orderBy: { taken_at: 'desc' },
        take: 1,
        select: {
          position_qty: true,
          average_entry: true,
          mark_price: true,
          equity: true,
          taken_at: true,
        },
      },
    },
  },
  actions: { orderBy: { created_at: 'desc' }, take: 1, select: SELECT_ACCION_VISTA },
  // La última que llegó a mirar la operación: las paradas antes no guardan nada.
  followup_rounds: {
    where: { snapshot: { not: Prisma.DbNull } },
    orderBy: { created_at: 'desc' },
    take: 1,
    select: { created_at: true, snapshot: true },
  },
} as const;

/**
 * Lo que la app lee de los agentes de un administrador (spec 074): sus
 * propuestas, sus operaciones y sus resultados. Solo lee, y solo lo suyo: lo
 * de otro responde 404, como si no existiera.
 *
 * Aquí se lee lo MEDIDO —el resultado hipotético de cada candidato y de cada
 * propuesta, y la tarjeta—. Se enseña; nada de lo que decide lo importa
 * (`nadie-lee-la-medida.spec.ts`).
 */
@Injectable()
export class AiDeskListadosService {
  constructor(private readonly db: DbService) {}

  /** Las propuestas de sus agentes, o las de uno: las que esperan, y las últimas. */
  async propuestas(userId: string, agentId?: string): Promise<ListaPropuestas> {
    const suyas = { agent: { user_id: userId }, ...(agentId ? { agent_id: agentId } : {}) };
    const [pendientes, recientes] = await Promise.all([
      this.db.aiDeskProposal.findMany({
        where: { ...suyas, state: { in: PENDIENTES } },
        orderBy: { expires_at: 'asc' },
        select: SELECT_PROPUESTA,
      }),
      this.db.aiDeskProposal.findMany({
        where: { ...suyas, state: { notIn: PENDIENTES } },
        orderBy: { created_at: 'desc' },
        take: RECIENTES,
        select: SELECT_PROPUESTA,
      }),
    ]);
    return {
      pendientes: pendientes.map(propuestaVista),
      recientes: recientes.map(propuestaVista),
    };
  }

  /** Las operaciones de sus agentes, o las de uno: las vivas, y las últimas terminadas. */
  async operaciones(userId: string, agentId?: string): Promise<ListaOperaciones> {
    const suyas = { agent: { user_id: userId }, ...(agentId ? { agent_id: agentId } : {}) };
    const [vivas, terminadas] = await Promise.all([
      this.db.aiDeskProposal.findMany({
        where: { ...suyas, state: { in: VIVAS } },
        orderBy: { created_at: 'desc' },
        select: SELECT_PROPUESTA,
      }),
      this.db.aiDeskProposal.findMany({
        where: { ...suyas, state: { in: TERMINADAS } },
        orderBy: { updated_at: 'desc' },
        take: RECIENTES,
        select: SELECT_PROPUESTA,
      }),
    ]);
    return { vivas: vivas.map(propuestaVista), terminadas: terminadas.map(propuestaVista) };
  }

  /** Una propuesta propia con todo lo suyo. */
  async propuesta(userId: string, id: string): Promise<DetallePropuesta> {
    return this.detalle({ id, agent: { user_id: userId } });
  }

  /** La operación de un bot propio: el panel del detalle del bot. */
  async operacionDeBot(userId: string, botId: string): Promise<DetallePropuesta> {
    return this.detalle({ bot_id: botId, agent: { user_id: userId } });
  }

  /**
   * Las tarjetas de sus agentes, y las de todos juntos. Lo real y lo simulado
   * se juntan cada uno por su lado: un agente es de una sola cuenta, y su
   * cuenta no cambia.
   */
  async resultados(userId: string): Promise<ResultadosAgentes> {
    const agentes = await this.db.aiDeskAgent.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'asc' },
      select: {
        id: true,
        name: true,
        archived_at: true,
        exchange_account: { select: { paper: true, testnet: true } },
      },
    });
    if (agentes.length === 0) return { real: null, simulado: null, agentes: [] };
    const ids = agentes.map((a) => a.id);
    const [candidatos, propuestas, consumo] = await Promise.all([
      // Solo los que se pudieron medir: los demás no dicen nada. Y no los de una
      // ronda FALLIDA: se guardan para medir la población, pero ahí no se eligió
      // ninguno porque el modelo no llegó a decidir, y contarlos como «no
      // elegidos» ensuciaría si la IA discrimina (spec 078).
      this.db.aiDeskCandidate.findMany({
        where: {
          agent_id: { in: ids },
          outcome: { not: Prisma.DbNull },
          round: { state: { not: EstadoRondaAgente.FALLIDA } },
        },
        select: { agent_id: true, eligible: true, chosen: true, outcome: true },
      }),
      this.db.aiDeskProposal.findMany({
        where: { agent_id: { in: ids } },
        select: {
          agent_id: true,
          family: true,
          side: true,
          state: true,
          reason: true,
          outcome: true,
          r_real: true,
          realized_pnl: true,
          exit: true,
        },
      }),
      this.db.aiDeskRound.groupBy({
        by: ['agent_id'],
        where: { agent_id: { in: ids }, model: { not: null } },
        // `cost` cuenta las que trajeron coste: el resto se cortó y no dijo cuánto.
        _count: { _all: true, cost: true },
        _sum: { cost: true },
      }),
    ]);

    const candidatosDe = agruparPorAgente(
      candidatos.map((c) => [c.agent_id, filaCandidatoDe(c)] as const),
    );
    const propuestasDe = agruparPorAgente(
      propuestas.map((p) => [p.agent_id, filaPropuestaDe(p)] as const),
    );
    const consumoDe = new Map(consumo.map((c) => [c.agent_id, c]));
    const juntas = {
      real: { candidatos: [] as FilaCandidato[], propuestas: [] as FilaPropuesta[], hay: false },
      simulado: {
        candidatos: [] as FilaCandidato[],
        propuestas: [] as FilaPropuesta[],
        hay: false,
      },
    };

    const porAgente = agentes.map((a) => {
      const real = esCuentaReal(a.exchange_account);
      const c = candidatosDe.get(a.id) ?? [];
      const p = propuestasDe.get(a.id) ?? [];
      const grupo = real ? juntas.real : juntas.simulado;
      grupo.candidatos.push(...c);
      grupo.propuestas.push(...p);
      grupo.hay = true;
      const uso = consumoDe.get(a.id);
      return {
        agenteId: a.id,
        nombre: a.name,
        real,
        archivado: a.archived_at !== null,
        tarjeta: tarjetaAgente(c, p),
        consultas: uso?._count._all ?? 0,
        coste: D(uso?._sum.cost?.toString() ?? '0').toFixed(),
        consultasSinCoste: uso ? uso._count._all - uso._count.cost : 0,
      };
    });
    const tarjeta = (g: typeof juntas.real): TarjetaAgente | null =>
      g.hay ? tarjetaAgente(g.candidatos, g.propuestas) : null;
    return { real: tarjeta(juntas.real), simulado: tarjeta(juntas.simulado), agentes: porAgente };
  }

  private async detalle(where: Prisma.AiDeskProposalWhereInput): Promise<DetallePropuesta> {
    const f = await this.db.aiDeskProposal.findFirst({
      where,
      select: { ...SELECT_PROPUESTA, round: { select: SELECT_RONDA_VISTA } },
    });
    if (!f) throw new NotFoundException('Propuesta no encontrada.');
    const [acciones, revisiones] = await Promise.all([
      this.db.aiDeskAction.findMany({
        where: { proposal_id: f.id },
        orderBy: { created_at: 'desc' },
        take: ACCIONES_DETALLE,
        select: SELECT_ACCION_VISTA,
      }),
      this.db.aiDeskRound.findMany({
        where: { proposal_id: f.id, kind: TipoRondaAgente.SEGUIMIENTO },
        orderBy: { created_at: 'desc' },
        take: REVISIONES_DETALLE,
        select: SELECT_REVISION,
      }),
    ]);
    return {
      propuesta: propuestaVista(f),
      ronda: f.round ? rondaVista(f.round) : null,
      acciones: acciones.map(accionVista),
      seguimiento: revisiones.map(revisionVista),
    };
  }
}

/** Las filas de cada agente, ya traducidas. */
function agruparPorAgente<T>(filas: readonly (readonly [string, T])[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const [agentId, fila] of filas) {
    const lista = m.get(agentId);
    if (lista) lista.push(fila);
    else m.set(agentId, [fila]);
  }
  return m;
}
