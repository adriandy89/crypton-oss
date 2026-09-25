import type { Candle } from '@crypton/shared';
import { COSTES_VENUE } from '@crypton/strategy-core';
import { BAR_T, planDePrueba } from './agentes.fixture-spec';
import {
  AiDeskMedicionService,
  MARGEN_MEDICION_MS,
  medida,
  planDeCandidato,
  planDePropuesta,
  type AgenteMedido,
  type PlanMedido,
} from './medicion.service';

/**
 * La medición de los agentes (spec 074, R-25): el resultado hipotético de cada
 * candidato y de cada propuesta, con lo que se decidió con ellos, y una cola
 * que no se atasca ni gasta el cupo del venue en series sin nada nuevo.
 */

const HORA = 3_600_000;

/** Una vela de 1 h desde la de la decisión; sin mechas salvo que se digan. */
const vela = (i: number, c: number, mecha: { h?: number; l?: number } = {}): Candle => ({
  t: BAR_T + i * HORA,
  o: String(c),
  h: String(mecha.h ?? c),
  l: String(mecha.l ?? c),
  c: String(c),
  v: '1',
});

const planas = (desde: number, hasta: number, c = 100.5): Candle[] =>
  Array.from({ length: hasta - desde + 1 }, (_, k) => vela(desde + k, c));

const AGENTE: AgenteMedido = {
  venue: 'HYPERLIQUID',
  testnet: false,
  intervalo: '1h',
  maxVelas: 24,
};

const PLAN: PlanMedido = {
  lado: 'LONG',
  barT: BAR_T,
  entrada: '100',
  stop: '97',
  objetivo: '105',
  intervalo: '1h',
  maxVelas: 3,
  costes: COSTES_VENUE.HYPERLIQUID,
};

/** Cuando ya han cerrado las velas 0 a n. */
const tras = (n: number) => BAR_T + (n + 1) * HORA + 60_000;

describe('medida', () => {
  it('resuelve por objetivo, por stop o por tiempo, con costes', () => {
    const objetivo = medida([vela(0, 100), vela(1, 101, { h: 106 })], PLAN, tras(1));
    expect(objetivo).toMatchObject({
      tipo: 'RESUELTO',
      outcome: { resultado: 'OBJETIVO', en: BAR_T + HORA },
    });
    const stop = medida([vela(0, 100), vela(1, 98, { l: 96 })], PLAN, tras(1));
    expect(stop).toMatchObject({ tipo: 'RESUELTO', outcome: { resultado: 'STOP' } });
    // 1R es la pérdida al stop CON costes: saltar el stop es −1R justo…
    expect(stop.tipo === 'RESUELTO' && stop.outcome.r).toBeCloseTo(-1, 10);
    // …y una vela que abre al otro lado sale a su apertura, que es peor.
    const hueco = medida([vela(0, 100), vela(1, 95)], PLAN, tras(1));
    expect(hueco.tipo === 'RESUELTO' && hueco.outcome.r).toBeLessThan(-1.5);
    const tiempo = medida(planas(0, 3), PLAN, tras(3));
    expect(tiempo).toMatchObject({
      tipo: 'RESUELTO',
      outcome: { resultado: 'TIEMPO', en: BAR_T + 3 * HORA },
    });
  });

  it('espera mientras no llega a ninguna barrera', () => {
    expect(medida(planas(0, 2), PLAN, tras(2))).toEqual({ tipo: 'ESPERAR' });
    // La serie aún no trae ni su vela: tampoco se da por perdida.
    expect(medida(planas(-5, -1), PLAN, tras(0))).toEqual({ tipo: 'ESPERAR' });
  });

  it('sin datos cuando no se medirá nunca', () => {
    expect(medida(planas(0, 5), null, tras(5))).toEqual({ tipo: 'SIN_DATOS' });
    // La serie ya dejó atrás su vela…
    expect(medida(planas(1, 2), PLAN, tras(2))).toEqual({ tipo: 'SIN_DATOS' });
    // …o la salta.
    expect(medida([vela(-1, 100), vela(1, 100), vela(2, 100)], PLAN, tras(2))).toEqual({
      tipo: 'SIN_DATOS',
    });
    // Un plan que no se puede etiquetar —stop del lado equivocado— con todo su horizonte.
    const torcido = { ...PLAN, stop: '103' };
    expect(medida(planas(0, 2), torcido, tras(2))).toEqual({ tipo: 'ESPERAR' });
    expect(medida(planas(0, 3), torcido, tras(3))).toEqual({ tipo: 'SIN_DATOS' });
  });

  it('sin velas —no se pudieron leer—, espera hasta pasado su horizonte con margen', () => {
    const limite = BAR_T + (PLAN.maxVelas + 1) * HORA + MARGEN_MEDICION_MS;
    expect(medida([], PLAN, limite)).toEqual({ tipo: 'ESPERAR' });
    expect(medida([], PLAN, limite + 1)).toEqual({ tipo: 'SIN_DATOS' });
  });
});

describe('los planes que se miden', () => {
  const guardado = {
    lado: 'SHORT',
    barT: BAR_T,
    entrada: '100',
    stop: '103',
    objetivo: '95',
    intervalo: '4h',
    maxVelas: 6,
  };

  it('un candidato, con el intervalo y la duración de su ronda', () => {
    expect(planDeCandidato(guardado, AGENTE)).toEqual({
      ...guardado,
      costes: COSTES_VENUE.HYPERLIQUID,
    });
  });

  it('sin ellos guardados, los del agente de ahora', () => {
    const { intervalo: _i, maxVelas: _m, ...viejo } = guardado;
    expect(planDeCandidato(viejo, AGENTE)).toMatchObject({ intervalo: '1h', maxVelas: 24 });
    expect(planDeCandidato({ ...guardado, maxVelas: 0.5 }, AGENTE)?.maxVelas).toBe(24);
  });

  it('un candidato sin plan, o con otra forma, no se mide', () => {
    expect(planDeCandidato(null, AGENTE)).toBeNull();
    expect(planDeCandidato({ ...guardado, lado: 'NEUTRAL' }, AGENTE)).toBeNull();
    expect(planDeCandidato({ ...guardado, stop: 'mucho' }, AGENTE)).toBeNull();
    expect(planDeCandidato({ ...guardado, barT: '1' }, AGENTE)).toBeNull();
  });

  it('una propuesta, con su propio plan: su tope de entrada, su primer objetivo y sus costes', () => {
    const plan = planDePrueba({
      barT: BAR_T,
      costes: { makerBps: 0, takerBps: 1, deslizamientoBps: 3 },
    });
    expect(planDePropuesta(plan)).toEqual({
      lado: 'LONG',
      barT: BAR_T,
      entrada: '100.1',
      stop: '97',
      objetivo: '105',
      intervalo: '1h',
      // 1440 minutos en velas de 1 h.
      maxVelas: 24,
      costes: { makerBps: 0, takerBps: 1, deslizamientoBps: 3 },
    });
    expect(planDePropuesta(planDePrueba({ intervalo: '15m', maxMinutos: 360 }))?.maxVelas).toBe(24);
    expect(planDePropuesta({ version: 2 })).toBeNull();
  });
});

// ── El servicio ────────────────────────────────────────────────────────────

interface Fila {
  id: string;
  agent_id: string;
  symbol: string;
  created_at: Date;
  measured_at: Date | null;
  outcome?: unknown;
  measurable?: unknown;
  plan?: unknown;
}

const medible = (extra: Record<string, unknown> = {}) => ({
  lado: 'LONG',
  barT: BAR_T,
  entrada: '100',
  stop: '97',
  objetivo: '105',
  intervalo: '1h',
  maxVelas: 3,
  ...extra,
});

const candidato = (id: string, extra: Partial<Fila> = {}): Fila => ({
  id,
  agent_id: 'ag-1',
  symbol: 'BTC',
  created_at: new Date(BAR_T + HORA + 15_000),
  measured_at: null,
  measurable: medible(),
  ...extra,
});

/** El `where` de una lectura: lo no medido, tras el último leído si lo hay. */
interface Lectura {
  where: {
    OR?: [{ created_at: { gt: Date } }, { created_at: Date; id: { gt: string } }];
  };
  take: number;
}

function tabla(filas: Fila[]) {
  return {
    findMany: jest.fn(async ({ where, take }: Lectura) => {
      const tras = where.OR;
      return filas
        .filter((f) => f.measured_at === null)
        .filter(
          (f) =>
            !tras ||
            f.created_at > tras[0].created_at.gt ||
            (f.created_at.getTime() === tras[1].created_at.getTime() && f.id > tras[1].id.gt),
        )
        .slice(0, take);
    }),
    updateMany: jest.fn(
      async (args: { where: { id: string; measured_at: null }; data: Partial<Fila> }) => {
        const f = filas.find((x) => x.id === args.where.id && x.measured_at === null);
        if (!f) return { count: 0 };
        Object.assign(f, args.data);
        return { count: 1 };
      },
    ),
  };
}

function montar(
  candidatos: Fila[],
  propuestas: Fila[] = [],
  series: Record<string, Candle[] | Error> = {},
) {
  const db = {
    aiDeskCandidate: tabla(candidatos),
    aiDeskProposal: tabla(propuestas),
    aiDeskAgent: {
      findMany: jest.fn(async () => [
        {
          id: 'ag-1',
          venue: 'HYPERLIQUID',
          // El intervalo de AHORA: lo decidido antes se mide con el suyo.
          interval: '15m',
          limits: {},
          exchange_account: { testnet: false },
        },
      ]),
    },
  };
  const marketData = {
    candles: jest.fn(async (_venue: string, simbolo: string, intervalo: string) => {
      const s = series[`${simbolo}|${intervalo}`] ?? [];
      if (s instanceof Error) throw s;
      return s;
    }),
  };
  const servicio = new AiDeskMedicionService(db as never, marketData as never);
  return { servicio, db, marketData };
}

describe('AiDeskMedicionService', () => {
  it('cierra lo resuelto con su resultado, lo imposible sin él, y deja lo que aún espera', async () => {
    const filas = [
      candidato('c-objetivo'),
      candidato('c-espera', { symbol: 'ETH' }),
      candidato('c-sin-plan', { measurable: null }),
    ];
    const propuesta: Fila = {
      ...candidato('p-1'),
      measurable: undefined,
      plan: planDePrueba({ barT: BAR_T }),
    };
    const m = montar(filas, [propuesta], {
      'BTC|1h': [vela(0, 100), vela(1, 101, { h: 106 })],
      'ETH|1h': [vela(0, 100), vela(1, 100.5)],
    });
    const n = await m.servicio.medir(tras(1));
    expect(n).toBe(3);
    expect(filas[0]).toMatchObject({ outcome: { resultado: 'OBJETIVO' } });
    expect(filas[0].measured_at).toEqual(new Date(tras(1)));
    expect(filas[1].measured_at).toBeNull();
    // Sin plan: se cierra, pero sin resultado.
    expect(filas[2].measured_at).not.toBeNull();
    expect(filas[2].outcome).toBeUndefined();
    // La propuesta se mide con SU plan: su tope de entrada y su primer objetivo.
    expect(propuesta).toMatchObject({ outcome: { resultado: 'OBJETIVO' } });
    // La escritura es condicional: lo que otra vuelta ya midió no se pisa.
    expect(m.db.aiDeskCandidate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c-objetivo', measured_at: null } }),
    );
  });

  it('mide con el intervalo que se decidió, no con el que tiene ahora el agente', async () => {
    const m = montar([candidato('c-1')], [], {
      'BTC|1h': [vela(0, 100), vela(1, 101, { h: 106 })],
    });
    await m.servicio.medir(tras(1));
    expect(m.marketData.candles).toHaveBeenCalledWith('HYPERLIQUID', 'BTC', '1h', {
      limit: 500,
      testnet: false,
    });
  });

  it('la vela en formación no resuelve nada', async () => {
    const filas = [candidato('c-1')];
    // La vela 1 aún no ha cerrado a esta hora, y toca el objetivo.
    const m = montar(filas, [], { 'BTC|1h': [vela(0, 100), vela(1, 101, { h: 106 })] });
    await m.servicio.medir(BAR_T + HORA + 30 * 60_000);
    expect(filas[0].measured_at).toBeNull();
  });

  it('una serie se lee una vez por vuelta, y otra vez solo cuando ha podido cerrar una vela', async () => {
    const filas = [candidato('c-1'), candidato('c-2')];
    const m = montar(filas, [], { 'BTC|1h': planas(0, 1) });
    await m.servicio.medir(tras(1));
    expect(m.marketData.candles).toHaveBeenCalledTimes(1);
    // Diez minutos después no ha cerrado ninguna: no se pregunta al venue.
    await m.servicio.medir(tras(1) + 10 * 60_000);
    expect(m.marketData.candles).toHaveBeenCalledTimes(1);
    // Una hora después, sí.
    await m.servicio.medir(tras(2));
    expect(m.marketData.candles).toHaveBeenCalledTimes(2);
  });

  it('sin velas —el venue falla—, espera; pasado su horizonte con margen, se deja', async () => {
    const filas = [candidato('c-1')];
    const m = montar(filas, [], { 'BTC|1h': new Error('503') });
    await m.servicio.medir(tras(1));
    expect(filas[0].measured_at).toBeNull();
    // Un fallo no deja memoria: la vuelta siguiente vuelve a intentarlo.
    await m.servicio.medir(tras(1) + 60_000);
    expect(m.marketData.candles).toHaveBeenCalledTimes(2);
    await m.servicio.medir(BAR_T + 4 * HORA + MARGEN_MEDICION_MS + 1);
    expect(filas[0].measured_at).not.toBeNull();
    expect(filas[0].outcome).toBeUndefined();
  });

  it('lo de un agente que ya no existe no se toca', async () => {
    const filas = [candidato('c-1', { agent_id: 'ag-borrado' })];
    const m = montar(filas, [], { 'BTC|1h': [vela(0, 100), vela(1, 101, { h: 106 })] });
    expect(await m.servicio.medir(tras(1))).toBe(0);
    expect(m.marketData.candles).not.toHaveBeenCalled();
  });

  it('recorre la cola por lotes, del más viejo al más nuevo, tras el último leído', async () => {
    const filas = Array.from({ length: 250 }, (_, k) =>
      candidato(`c-${String(k).padStart(3, '0')}`),
    );
    const m = montar(filas, [], { 'BTC|1h': planas(0, 1) });
    await m.servicio.medir(tras(1));
    const llamadas = m.db.aiDeskCandidate.findMany.mock.calls as unknown as {
      where: Record<string, unknown>;
      orderBy: unknown;
    }[][];
    expect(llamadas).toHaveLength(2);
    expect(llamadas[0][0].where).toEqual({ measured_at: null });
    expect(llamadas[0][0].orderBy).toEqual([{ created_at: 'asc' }, { id: 'asc' }]);
    expect(llamadas[1][0].where).toEqual({
      measured_at: null,
      OR: [
        { created_at: { gt: filas[199].created_at } },
        { created_at: filas[199].created_at, id: { gt: 'c-199' } },
      ],
    });
  });
});
