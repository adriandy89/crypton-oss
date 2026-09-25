import { Injectable, Logger } from '@nestjs/common';
import {
  candleSpanMs,
  esIntervaloAgente,
  planAgenteDe,
  type Candle,
  type IntervaloAgente,
  type ResultadoHipotetico,
  type Venue,
} from '@crypton/shared';
import {
  VELAS_AGENTE,
  costesDe,
  leerLimitesAgente,
  planMedibleDePlan,
  resultadoHipotetico,
  ultimaCerradaEsperada,
  type Costes,
  type PlanMedible,
} from '@crypton/strategy-core';
import { DbService } from 'src/libs';
import { MarketDataService } from '../market-data';

/** Filas por lectura, y lecturas por vuelta de cada tabla. */
const LOTE = 200;
const LOTES_POR_VUELTA = 10;

/**
 * Pasado su horizonte más este margen sin haberse podido medir —el par dejó de
 * existir, el venue no da sus velas—, ya no se medirá: se cierra sin resultado
 * para que no tape la cola.
 */
export const MARGEN_MEDICION_MS = 24 * 3_600_000;

/**
 * Un plan medible con lo que se decidió con él: su intervalo, su duración
 * máxima y sus costes. Si su dueño edita el agente después, lo ya decidido se
 * sigue midiendo con lo suyo.
 */
export interface PlanMedido extends PlanMedible {
  intervalo: IntervaloAgente;
  maxVelas: number;
  costes: Costes;
}

/** Un agente, con lo que la medición necesita de él. */
export interface AgenteMedido {
  venue: Venue;
  testnet: boolean;
  /** El intervalo y la duración de ahora: solo para candidatos que no guardaron los suyos. */
  intervalo: IntervaloAgente;
  maxVelas: number;
}

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const esPrecio = (v: unknown): v is string =>
  typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));

/**
 * El plan medible que guardó la ronda con un candidato, con el intervalo y la
 * duración máxima de entonces; null si no tiene (ninguna opción era viable).
 */
export function planDeCandidato(v: unknown, agente: AgenteMedido): PlanMedido | null {
  if (!esObjeto(v)) return null;
  const { lado, barT, entrada, stop, objetivo, intervalo, maxVelas } = v;
  if (lado !== 'LONG' && lado !== 'SHORT') return null;
  if (typeof barT !== 'number' || !Number.isFinite(barT)) return null;
  if (!esPrecio(entrada) || !esPrecio(stop) || !esPrecio(objetivo)) return null;
  return {
    lado,
    barT,
    entrada,
    stop,
    objetivo,
    intervalo: esIntervaloAgente(intervalo) ? intervalo : agente.intervalo,
    maxVelas:
      typeof maxVelas === 'number' && Number.isInteger(maxVelas) && maxVelas >= 1
        ? maxVelas
        : agente.maxVelas,
    costes: costesDe(agente.venue),
  };
}

/** El de una propuesta: su propio plan, con su intervalo, su duración y sus costes. */
export function planDePropuesta(v: unknown): PlanMedido | null {
  const plan = planAgenteDe(v);
  if (!plan || plan.objetivos.length === 0) return null;
  const minutosVela = candleSpanMs(plan.intervalo) / 60_000;
  return {
    ...planMedibleDePlan(plan),
    intervalo: plan.intervalo,
    maxVelas: Math.max(1, Math.round(plan.maxMinutos / minutosVela)),
    costes: plan.costes,
  };
}

/** Qué hacer con algo pendiente de medir. */
export type Medida =
  { tipo: 'RESUELTO'; outcome: ResultadoHipotetico } | { tipo: 'SIN_DATOS' } | { tipo: 'ESPERAR' };

const SIN_DATOS: Medida = { tipo: 'SIN_DATOS' };
const ESPERAR: Medida = { tipo: 'ESPERAR' };

/**
 * Qué se sabe ya de un plan con las velas CERRADAS que hay (puro).
 *
 * - RESUELTO: las velas llegan a una de sus tres barreras.
 * - SIN_DATOS: no se medirá nunca. No tiene plan; la serie ya dejó atrás su
 *   vela, o la salta; con su vela y todas las de su horizonte sigue sin
 *   resolverse (un plan que no se puede etiquetar); o pasó su horizonte, con
 *   margen, sin haber podido medirse.
 * - ESPERAR: aún no ha llegado a ninguna.
 */
export function medida(velas: readonly Candle[], plan: PlanMedido | null, ahora: number): Medida {
  if (!plan) return SIN_DATOS;
  const r = resultadoHipotetico(velas, plan, plan.maxVelas, plan.costes);
  if (r) return { tipo: 'RESUELTO', outcome: r };
  const i = velas.findIndex((v) => v.t === plan.barT);
  const ultima = velas[velas.length - 1]?.t;
  if (i < 0 && ultima !== undefined && ultima >= plan.barT) return SIN_DATOS;
  if (i >= 0 && velas.length - 1 - i >= plan.maxVelas) return SIN_DATOS;
  const horizonte = plan.barT + (plan.maxVelas + 1) * candleSpanMs(plan.intervalo);
  return ahora > horizonte + MARGEN_MEDICION_MS ? SIN_DATOS : ESPERAR;
}

/** Algo pendiente de medir, de cualquiera de las dos tablas. */
interface Pendiente {
  id: string;
  agentId: string;
  simbolo: string;
  creadaEn: Date;
  plan: (agente: AgenteMedido) => PlanMedido | null;
}

type Tabla = 'candidato' | 'propuesta';

/**
 * Una serie en una vuelta: sus velas cerradas; `SIN_NOVEDAD` si no ha podido
 * cerrar ninguna desde la última vez que se leyó —lo pendiente de ella ya se
 * miró con esas mismas velas—; o null si no se ha podido leer.
 */
type Serie = Candle[] | 'SIN_NOVEDAD' | null;

/** Lo que se comparte dentro de una vuelta: los agentes y las series ya leídas. */
interface Vuelta {
  ahora: number;
  agentes: Map<string, AgenteMedido | null>;
  series: Map<string, Serie>;
}

/**
 * La medición de los agentes (spec 074, R-25): el resultado hipotético de cada
 * candidato y de cada propuesta, se tomara o no, por triple barrera pesimista
 * (`resultadoHipotetico`). Es lo que deja enseñar si quien elige distingue lo
 * bueno de lo malo (spec 070) y qué habría pasado con lo que su dueño
 * descartó.
 *
 * NADA de lo que escribe esto lo lee quien decide —ni la ronda, ni la
 * aprobación, ni el seguimiento—: se enseña. `nadie-lee-la-medida.spec.ts` lo
 * afirma.
 *
 * Las velas se piden una vez por serie y vuelta, y solo si ha podido cerrar
 * una vela nueva desde la última vez: el cupo por IP del venue lo comparten
 * los bots, y en Lighter son 60 peticiones por minuto.
 */
@Injectable()
export class AiDeskMedicionService {
  private readonly logger = new Logger(AiDeskMedicionService.name);
  /** La última vela cerrada que trajo cada serie en una vuelta anterior. */
  private readonly vistas = new Map<string, number>();

  constructor(
    private readonly db: DbService,
    private readonly marketData: MarketDataService,
  ) {}

  /** Mide lo que se pueda de las dos tablas. Devuelve cuántas filas cerró. */
  async medir(ahora = Date.now()): Promise<number> {
    const vuelta: Vuelta = { ahora, agentes: new Map(), series: new Map() };
    const candidatos = await this.recorrer(vuelta, 'candidato');
    const propuestas = await this.recorrer(vuelta, 'propuesta');
    return candidatos + propuestas;
  }

  private async recorrer(vuelta: Vuelta, tabla: Tabla): Promise<number> {
    let cerradas = 0;
    let tras: Pendiente | null = null;
    for (let lote = 0; lote < LOTES_POR_VUELTA; lote++) {
      const filas = await this.leer(tabla, tras);
      await this.cargarAgentes(vuelta, filas);
      for (const x of filas) {
        const agente = vuelta.agentes.get(x.agentId);
        if (!agente) continue;
        const plan = x.plan(agente);
        const serie = plan ? await this.serie(vuelta, agente, x.simbolo, plan.intervalo) : null;
        // Nada nuevo que mirar: ni siquiera su plazo, que se juzga con velas o con un fallo.
        if (serie === 'SIN_NOVEDAD') continue;
        const m = medida(serie ?? [], plan, vuelta.ahora);
        if (m.tipo === 'ESPERAR') continue;
        try {
          if (await this.guardar(tabla, x.id, m, vuelta.ahora)) cerradas++;
        } catch (e) {
          this.logger.warn(`No se ha podido guardar la medida de ${tabla} ${x.id}: ${String(e)}`);
        }
      }
      if (filas.length < LOTE) break;
      tras = filas[filas.length - 1];
    }
    return cerradas;
  }

  /** Lo pendiente de una tabla, del más viejo al más nuevo, tras el último leído. */
  private async leer(tabla: Tabla, tras: Pendiente | null): Promise<Pendiente[]> {
    const where = {
      measured_at: null,
      ...(tras
        ? {
            OR: [
              { created_at: { gt: tras.creadaEn } },
              { created_at: tras.creadaEn, id: { gt: tras.id } },
            ],
          }
        : {}),
    };
    const orderBy = [{ created_at: 'asc' as const }, { id: 'asc' as const }];
    if (tabla === 'candidato') {
      const filas = await this.db.aiDeskCandidate.findMany({
        where,
        orderBy,
        take: LOTE,
        select: { id: true, agent_id: true, symbol: true, measurable: true, created_at: true },
      });
      return filas.map((f) => ({
        id: f.id,
        agentId: f.agent_id,
        simbolo: f.symbol,
        creadaEn: f.created_at,
        plan: (a: AgenteMedido) => planDeCandidato(f.measurable, a),
      }));
    }
    const filas = await this.db.aiDeskProposal.findMany({
      where,
      orderBy,
      take: LOTE,
      select: { id: true, agent_id: true, symbol: true, plan: true, created_at: true },
    });
    return filas.map((f) => ({
      id: f.id,
      agentId: f.agent_id,
      simbolo: f.symbol,
      creadaEn: f.created_at,
      plan: () => planDePropuesta(f.plan),
    }));
  }

  private async cargarAgentes(vuelta: Vuelta, filas: readonly Pendiente[]): Promise<void> {
    const faltan = [...new Set(filas.map((f) => f.agentId))].filter(
      (id) => !vuelta.agentes.has(id),
    );
    if (faltan.length === 0) return;
    const agentes = await this.db.aiDeskAgent.findMany({
      where: { id: { in: faltan } },
      select: {
        id: true,
        venue: true,
        interval: true,
        limits: true,
        exchange_account: { select: { testnet: true } },
      },
    });
    for (const id of faltan) vuelta.agentes.set(id, null);
    for (const a of agentes) {
      if (!esIntervaloAgente(a.interval)) continue;
      vuelta.agentes.set(a.id, {
        venue: a.venue,
        testnet: a.exchange_account.testnet,
        intervalo: a.interval,
        maxVelas: leerLimitesAgente(a.limits).maxVelasOperacion,
      });
    }
  }

  /** Una serie, leída como mucho una vez por vuelta (ver `Serie`). */
  private async serie(
    vuelta: Vuelta,
    agente: AgenteMedido,
    simbolo: string,
    intervalo: IntervaloAgente,
  ): Promise<Serie> {
    const clave = `${agente.venue}|${agente.testnet ? 't' : 'm'}|${simbolo}|${intervalo}`;
    const leida = vuelta.series.get(clave);
    if (leida !== undefined) return leida;
    const vista = this.vistas.get(clave);
    if (vista !== undefined && vista >= ultimaCerradaEsperada(vuelta.ahora, intervalo)) {
      vuelta.series.set(clave, 'SIN_NOVEDAD');
      return 'SIN_NOVEDAD';
    }
    let cerradas: Candle[] | null = null;
    try {
      const span = candleSpanMs(intervalo);
      const todas = await this.marketData.candles(agente.venue, simbolo, intervalo, {
        limit: VELAS_AGENTE,
        testnet: agente.testnet,
      });
      // La vela en formación no resuelve nada: aún puede cambiar.
      cerradas = todas.filter((v) => v.t + span <= vuelta.ahora);
      const ultima = cerradas[cerradas.length - 1]?.t;
      if (ultima !== undefined) this.vistas.set(clave, ultima);
    } catch (e) {
      this.logger.debug(`Sin velas de ${simbolo} (${intervalo}) para medir: ${String(e)}`);
    }
    vuelta.series.set(clave, cerradas);
    return cerradas;
  }

  /**
   * Guarda una medida. Condicional: si otra vuelta ya la midió, no pisa nada.
   * Devuelve si la escribió.
   */
  private async guardar(tabla: Tabla, id: string, m: Medida, ahora: number): Promise<boolean> {
    const data = {
      measured_at: new Date(ahora),
      // Frontera Prisma-JSON: el resultado es un objeto plano.
      ...(m.tipo === 'RESUELTO' ? { outcome: m.outcome as never } : {}),
    };
    const where = { id, measured_at: null };
    const { count } =
      tabla === 'candidato'
        ? await this.db.aiDeskCandidate.updateMany({ where, data })
        : await this.db.aiDeskProposal.updateMany({ where, data });
    return count > 0;
  }
}
