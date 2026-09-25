import {
  D,
  EventoOperacionAgente,
  LevelKind,
  StrategyKind,
  Venue,
  type BotConfig,
  type BotContext,
  type DesiredState,
  type NivelApalancamiento,
} from '@crypton/shared';
import { mulberry32 } from '../canal/testing-canal';
import { makeCoid } from '../client-order-id';
import {
  ESPERA_ENTRE_CIERRES_MS,
  ESPERA_LLENADO_MS,
  INDICE_CIERRE,
  MAX_INTENTOS_CIERRE,
} from '../operacion/gestion';
import { getStrategy } from '../registry';
import { BASE_CONFIG, makeContext, makePosition, makeVenueOrder } from '../testing';
import {
  ESPERA_OPERACION_PERDIDA_MS,
  INDICE_REDUCCION,
  MAX_REDUCCIONES,
  soloReduceRiesgo,
  type OperacionAgente,
} from './agent-trade';

/**
 * La operación de un agente (spec 074, CA-3). Lo que se fija aquí es lo que
 * hace segura una operación con dinero real aunque la mande una IA: entra una
 * vez, su stop solo se ciñe, reducir dos veces no reduce dos veces y una
 * posición ajena no se toca.
 */

const s = getStrategy(StrategyKind.AGENT_TRADE);
const AHORA = 50_000_000;

const CFG = {
  ...BASE_CONFIG,
  leverage: 5,
  totalInvestment: '20',
  liquidationAction: 'CLOSE_ALL',
  entryLimitPrice: '100.1',
  entryDeadline: AHORA + 5 * 60_000,
  quantity: '1',
  riskAmount: '2.2',
  agentProposalId: 'p-1',
  stopPrice: '98',
  tp1Price: '104',
  tp2Price: '108',
  tp1Fraction: '50',
  breakevenAfterTp1: true,
  trailAfterTp1: false,
  trailCallbackPct: '1',
  maxHoldMinutes: 1440,
  positionCap: null,
};

const OP: OperacionAgente = { intento: 0, enviadaEn: AHORA - 60_000, stopInicial: '98' };

interface Caso {
  cfg?: Record<string, unknown>;
  precio?: string;
  qty?: string;
  entrada?: string;
  scratch?: Record<string, unknown>;
  now?: number;
  extra?: Partial<BotContext>;
  leverage?: number;
}

function ctx(o: Caso = {}): BotContext {
  const base = makeContext({
    strategy: StrategyKind.AGENT_TRADE,
    config: { ...CFG, ...(o.cfg ?? {}) } as unknown as BotConfig,
    price: o.precio ?? '100',
    position: o.qty
      ? { ...makePosition(o.qty, o.entrada ?? '100', o.precio ?? '100'), leverage: o.leverage ?? 5 }
      : null,
    cycle: { scratch: { cycleSeq: 1, ...(o.scratch ?? {}) } },
    now: o.now ?? AHORA,
  });
  return { ...base, ...(o.extra ?? {}) };
}

const plan = (o: Caso = {}): DesiredState => s.plan(ctx(o));
const de = (d: DesiredState, kind: LevelKind) => d.orders.filter((x) => x.levelKind === kind);
const stopDe = (d: DesiredState) => de(d, LevelKind.STOP_LOSS)[0];

describe('la entrada', () => {
  it('una IOC al tope, con el apalancamiento de la operación', () => {
    const d = plan();
    expect(d.orders).toHaveLength(1);
    const o = d.orders[0];
    expect(o).toMatchObject({
      clientOrderId: makeCoid(ctx().botId, 1, LevelKind.BASE, 0),
      side: 'BUY',
      type: 'LIMIT',
      timeInForce: 'IOC',
      price: '100.1',
      reduceOnly: false,
    });
    expect(D(o.qty).eq(1)).toBe(true);
    expect(d.apalancamiento).toBe(5);
    expect(d.scratchPatch).toMatchObject({
      op: { intento: 0, enviadaEn: AHORA, stopInicial: '98' },
      intentos: 1,
    });
    expect(d.detener).toBeUndefined();
  });

  it('el corto vende, y su tope redondea hacia arriba', () => {
    const d = plan({
      cfg: {
        direction: 'SHORT',
        entryLimitPrice: '99.93',
        stopPrice: '102',
        tp1Price: '96',
        tp2Price: '92',
      },
    });
    expect(d.orders[0]).toMatchObject({ side: 'SELL', price: '100.0' });
  });

  it('con el libro más allá del tope, espera', () => {
    const d = plan({ precio: '100.2' });
    expect(d.orders).toEqual([]);
    expect(d.detener).toBeUndefined();
  });

  it('a menos de medio stop del stop, no entra', () => {
    // Distancia 2,1: medio stop son 1,05, y 98,95 − 98 = 0,95 lo pasa.
    const d = plan({ precio: '98.9' });
    expect(d.orders).toEqual([]);
    expect(d.detener).toBeUndefined();
  });

  it('si el precio llega al stop antes de entrar, la operación ya no vale', () => {
    const d = plan({ precio: '97.9' });
    expect(d.detener).toBe('INVALIDADA');
    expect(d.orders).toEqual([]);
    expect(d.avisos?.[0].tipo).toBe(EventoOperacionAgente.ENTRADA_DESCARTADA);
  });

  it('pasado el plazo sin entrar, se detiene', () => {
    const d = plan({ now: CFG.entryDeadline });
    expect(d.detener).toBe('SIN_ENTRADA');
    expect(d.orders).toEqual([]);
  });

  it('el apalancamiento se rebaja con el tramo del venue o el tope de la cuenta, nunca se sube', () => {
    const tramos: NivelApalancamiento[] = [
      { desdeNocional: '0', maxApalancamiento: 40, mantenimiento: 0.01 },
      { desdeNocional: '50', maxApalancamiento: 3, mantenimiento: 0.02 },
    ];
    expect(plan({ extra: { nivelesApalancamiento: tramos } }).apalancamiento).toBe(3);
    const limites = {
      entradasPermitidas: true,
      maxApalancamientoUsuario: 2,
      venueListo: true,
      motivo: null,
    };
    expect(plan({ extra: { limites } }).apalancamiento).toBe(2);
    const holgado = { ...limites, maxApalancamientoUsuario: 20 };
    expect(plan({ extra: { limites: holgado } }).apalancamiento).toBe(5);
  });

  it('la IOC que no se llenó se reintenta con otro id, mientras valga', () => {
    // Enviada hace un minuto, sin rastro en el libro ni ejecución.
    const d = plan({ scratch: { op: OP, intentos: 1 } });
    expect(d.orders).toEqual([]);
    expect(d.scratchPatch).toEqual({ op: null });
    const otra = plan({ scratch: { intentos: 1 } });
    expect(otra.orders[0].clientOrderId).toBe(makeCoid(ctx().botId, 1, LevelKind.BASE, 1));
  });

  it('mientras la IOC está en camino, espera', () => {
    const recien = { ...OP, enviadaEn: AHORA - ESPERA_LLENADO_MS + 1 };
    expect(plan({ scratch: { op: recien } }).orders).toEqual([]);
    const coid = makeCoid(ctx().botId, 1, LevelKind.BASE, 0);
    const enLibro = ctx({ scratch: { op: OP } });
    const d = s.plan({ ...enLibro, openOrders: [makeVenueOrder(coid, '100.1')] });
    expect(d.orders).toEqual([]);
    expect(d.scratchPatch).toBeUndefined();
  });
});

describe('una sola vez (R-1)', () => {
  it('con un ciclo cerrado, se detiene y no vuelve a entrar', () => {
    const d = plan({ scratch: { cycleSeq: 2 } });
    expect(d.detener).toBe('CERRADA');
    expect(d.orders).toEqual([]);
  });

  it('rearrancada a mano con el plazo vencido, tampoco', () => {
    expect(plan({ now: AHORA + 3_600_000 }).detener).toBe('SIN_ENTRADA');
  });

  it('plana tras haber tenido posición, espera su ejecución; si no llega, se detiene sin resultado', () => {
    const cerrada = { ...OP, maximo: '1', vistaEn: AHORA - 60_000 };
    const espera = plan({ scratch: { op: cerrada } });
    expect(espera.orders).toEqual([]);
    expect(espera.detener).toBeUndefined();
    const perdida = plan({
      scratch: { op: { ...cerrada, vistaEn: AHORA - ESPERA_OPERACION_PERDIDA_MS } },
    });
    expect(perdida.detener).toBe('FUERA');
    expect(perdida.avisos?.[0].tipo).toBe(EventoOperacionAgente.OPERACION_PERDIDA);
  });
});

describe('con posición', () => {
  const abierta = (o: Caso = {}) =>
    plan({ qty: '1', precio: '101', ...o, scratch: { op: OP, ...(o.scratch ?? {}) } });

  it('el stop nativo y los dos objetivos, reduce-only y con su parte', () => {
    const d = abierta();
    expect(stopDe(d)).toMatchObject({ side: 'SELL', triggerPrice: '98.0', reduceOnly: true });
    expect(D(stopDe(d).qty).eq(1)).toBe(true);
    const tps = de(d, LevelKind.TAKE_PROFIT);
    expect(tps.map((o) => [o.levelIndex, o.price, D(o.qty).toNumber()])).toEqual([
      [0, '104.0', 0.5],
      [1, '108.0', 0.5],
    ]);
    expect(tps.every((o) => o.reduceOnly && o.type === 'LIMIT')).toBe(true);
    expect(d.detener).toBeUndefined();
  });

  it('la entrada se avisa una vez, el primer tick con posición, con sus números', () => {
    const primera = abierta();
    const aviso = primera.avisos?.find((a) => a.tipo === EventoOperacionAgente.ENTRADA);
    expect(aviso?.mensaje).toBe(
      'Entrada larga: 1 a 100 con 5x. Stop 98.0 · objetivos 104.0 / 108.0 · pérdida al stop 2.20 USDC.',
    );
    const siguiente = abierta({ scratch: { op: { ...OP, abiertaEn: AHORA, maximo: '1' } } });
    expect(siguiente.avisos?.some((a) => a.tipo === EventoOperacionAgente.ENTRADA)).toBeFalsy();
  });

  it('cobrado el primer objetivo, el stop pasa a la entrada más costes', () => {
    const d = abierta({ qty: '0.5', precio: '105', scratch: { op: { ...OP, maximo: '1' } } });
    // 100 × (1 + 0,0011) = 100,11 → la venta redondea hacia arriba: 100,2.
    expect(stopDe(d).triggerPrice).toBe('100.2');
    expect(de(d, LevelKind.TAKE_PROFIT).map((o) => o.levelIndex)).toEqual([1]);
    expect(d.avisos?.map((a) => a.tipo)).toContain(EventoOperacionAgente.BREAKEVEN);
    expect(d.scratchPatch?.['op']).toMatchObject({ tp1Hecho: true, stop: '100.2' });
  });

  it('sin breakeven pedido, el stop se queda', () => {
    const d = abierta({
      qty: '0.5',
      precio: '105',
      cfg: { breakevenAfterTp1: false },
      scratch: { op: { ...OP, maximo: '1' } },
    });
    expect(stopDe(d).triggerPrice).toBe('98.0');
  });

  it('un stop pedido que el precio ya pasó cierra a mercado', () => {
    const d = abierta({ cfg: { stopPrice: '101.5' } });
    expect(d.immediate[0]).toMatchObject({
      levelIndex: INDICE_CIERRE,
      type: 'MARKET',
      reduceOnly: true,
    });
    expect(d.scratchPatch?.['cierre']).toMatchObject({ motivo: 'STOP' });
  });

  it('pasado el tiempo, cierra a mercado', () => {
    const d = abierta({ scratch: { op: { ...OP, abiertaEn: AHORA - 1440 * 60_000 } } });
    expect(d.immediate[0].levelIndex).toBe(INDICE_CIERRE);
    expect(d.scratchPatch?.['cierre']).toMatchObject({ motivo: 'TIEMPO' });
  });

  it('con más apalancamiento del pedido en el venue, sale por seguridad', () => {
    const d = abierta({ leverage: 12 });
    expect(d.scratchPatch?.['cierre']).toMatchObject({ motivo: 'APALANCAMIENTO' });
  });

  it('el stop que sigue al precio tras el primer objetivo', () => {
    const op = { ...OP, maximo: '1', tp1Hecho: true, stop: '100.2' };
    const d = abierta({
      qty: '0.5',
      precio: '110',
      cfg: { trailAfterTp1: true, trailCallbackPct: '2' },
      scratch: { op },
    });
    // 110 × 0,98 = 107,8.
    expect(stopDe(d).triggerPrice).toBe('107.8');
    // Si entre dos ticks subió a 115 y volvió a 110, el que seguía ya saltó.
    const vuelta = s.plan({
      ...ctx({
        qty: '0.5',
        precio: '110',
        cfg: { trailAfterTp1: true, trailCallbackPct: '2' },
        scratch: { op },
      }),
      extremos: { alto: '115', bajo: '109' },
    });
    expect(vuelta.scratchPatch?.['cierre']).toMatchObject({ motivo: 'TRAILING' });
  });
});

describe('el stop es monótono (R-2)', () => {
  it('una configuración que lo ensancha se ignora, y lo dice', () => {
    const op = { ...OP, stop: '99' };
    const d = plan({ qty: '1', precio: '101', cfg: { stopPrice: '97' }, scratch: { op } });
    expect(stopDe(d).triggerPrice).toBe('99.0');
    expect(d.avisos?.map((a) => a.tipo)).toContain(EventoOperacionAgente.STOP_IGNORADO);
  });

  it('una que lo ciñe se aplica, y lo dice', () => {
    const d = plan({ qty: '1', precio: '101', cfg: { stopPrice: '99.5' }, scratch: { op: OP } });
    expect(stopDe(d).triggerPrice).toBe('99.5');
    expect(d.avisos?.map((a) => a.tipo)).toContain(EventoOperacionAgente.STOP_CENIDO);
  });

  it('ante cualquier secuencia de configuraciones, el stop nunca se aleja', () => {
    for (const lado of ['LONG', 'SHORT'] as const) {
      const largo = lado === 'LONG';
      const azar = mulberry32(largo ? 2 : 3);
      const base = largo
        ? { direction: 'LONG', stopPrice: '98', tp1Price: '104', tp2Price: '108' }
        : {
            direction: 'SHORT',
            entryLimitPrice: '99.9',
            stopPrice: '102',
            tp1Price: '96',
            tp2Price: '92',
          };
      let scratch: Record<string, unknown> = { op: { ...OP, stopInicial: base.stopPrice } };
      let previo = D(base.stopPrice);
      for (let i = 0; i < 200; i++) {
        // Stops pedidos a los dos lados del vigente, sin cruzar el precio (100 ± 3).
        const pedido = largo ? 94 + azar() * 8.9 : 97.1 + azar() * 8.9;
        const d = plan({
          qty: largo ? '1' : '-1',
          precio: largo ? '103' : '97',
          cfg: { ...base, stopPrice: pedido.toFixed(1) },
          scratch,
          now: AHORA + i * 1000,
        });
        const actual = D(stopDe(d).triggerPrice ?? '0');
        expect(largo ? actual.gte(previo) : actual.lte(previo)).toBe(true);
        previo = actual;
        scratch = { ...scratch, ...(d.scratchPatch ?? {}) };
      }
    }
  });
});

describe('reducir por configuración (R-4)', () => {
  const op = { ...OP, maximo: '1' };

  it('reduce hasta el tope con una orden a mercado reduce-only, y los objetivos ya son los del tope', () => {
    const d = plan({ qty: '1', precio: '101', cfg: { positionCap: '0.6' }, scratch: { op } });
    expect(d.immediate).toHaveLength(1);
    expect(d.immediate[0]).toMatchObject({
      levelIndex: INDICE_REDUCCION,
      type: 'MARKET',
      side: 'SELL',
      reduceOnly: true,
    });
    expect(D(d.immediate[0].qty).eq('0.4')).toBe(true);
    const tps = de(d, LevelKind.TAKE_PROFIT);
    expect(tps.reduce((a, o) => a.plus(o.qty), D(0)).lte('0.6')).toBe(true);
    expect(stopDe(d).triggerPrice).toBe('98.0');
    expect(d.scratchPatch?.['op']).toMatchObject({ tope: '0.6', reducciones: 1 });
  });

  it('aplicarlo dos veces no reduce dos veces', () => {
    const tras = { ...op, tope: '0.6', reducciones: 1, reduccionEn: AHORA };
    // Aún sin la ejecución, dentro de su medio minuto: nada nuevo.
    const pronto = plan({
      qty: '1',
      precio: '101',
      cfg: { positionCap: '0.6' },
      scratch: { op: tras },
      now: AHORA + ESPERA_ENTRE_CIERRES_MS - 1,
    });
    expect(pronto.immediate).toEqual([]);
    // Ya reducida: nada que hacer, y la reducción no se toma por un objetivo cobrado.
    const hecha = plan({
      qty: '0.6',
      precio: '101',
      cfg: { positionCap: '0.6' },
      scratch: { op: tras },
    });
    expect(hecha.immediate).toEqual([]);
    expect(hecha.scratchPatch?.['op']).not.toMatchObject({ tp1Hecho: true });
    expect(stopDe(hecha).triggerPrice).toBe('98.0');
  });

  it('subir el tope después no añade nada', () => {
    const tras = { ...op, tope: '0.6' };
    const d = plan({
      qty: '0.6',
      precio: '101',
      cfg: { positionCap: '0.9' },
      scratch: { op: tras },
    });
    expect(d.immediate).toEqual([]);
    expect(d.orders.filter((o) => !o.reduceOnly)).toEqual([]);
  });

  it('tope cero es cerrar', () => {
    const d = plan({ qty: '1', precio: '101', cfg: { positionCap: '0' }, scratch: { op } });
    expect(d.immediate[0]).toMatchObject({ levelIndex: INDICE_CIERRE, type: 'MARKET' });
    expect(d.scratchPatch?.['cierre']).toMatchObject({ motivo: 'SEGUIMIENTO' });
  });

  it('una reducción por debajo del mínimo del venue no se manda, y se avisa', () => {
    // 0,05 × 101 = 5 USDC, por debajo de los 10 de mínimo.
    const d = plan({ qty: '1', precio: '101', cfg: { positionCap: '0.95' }, scratch: { op } });
    expect(d.immediate).toEqual([]);
    expect(d.avisos?.map((a) => a.tipo)).toContain(EventoOperacionAgente.REDUCIDA);
  });
});

it('los tramos de índices de salida no se pisan, ni con los del motor', () => {
  // Objetivos 0 y 1, reducciones 100-129, cierres 500-511; el motor usa del 512
  // al 999 para los suyos (`CIERRE_INDICE_BAJO` en `bot-runner.ts`).
  expect(INDICE_REDUCCION).toBeGreaterThan(1);
  expect(INDICE_REDUCCION + MAX_REDUCCIONES).toBeLessThanOrEqual(INDICE_CIERRE);
  expect(INDICE_CIERRE + MAX_INTENTOS_CIERRE).toBeLessThanOrEqual(512);
});

describe('una posición ajena no se toca (R-5)', () => {
  it('sin entrada de esta operación: aviso CRITICAL, nada en el libro y se detiene', () => {
    const d = plan({ qty: '1', precio: '101' });
    expect(d.orders).toEqual([]);
    expect(d.immediate).toEqual([]);
    expect(d.detener).toBe('POSICION_AJENA');
    expect(d.avisos?.[0]).toMatchObject({
      tipo: EventoOperacionAgente.POSICION_AJENA,
      severidad: 'CRITICAL',
    });
  });

  it('del otro lado, tampoco', () => {
    const d = plan({ qty: '-1', precio: '101', scratch: { op: OP } });
    expect(d.detener).toBe('POSICION_AJENA');
    expect(d.orders).toEqual([]);
  });

  it('si el par tiene más de lo que entró, el stop lo cubre todo y los objetivos solo lo suyo', () => {
    const d = plan({ qty: '1.5', precio: '101', scratch: { op: OP } });
    // Nada del lado de la operación se queda sin stop (spec 075, F-01)…
    expect(D(stopDe(d).qty).eq(1.5)).toBe(true);
    // …pero lo que no entró por ella no se cobra en sus objetivos.
    const objetivos = de(d, LevelKind.TAKE_PROFIT).reduce((a, o) => a.plus(o.qty), D(0));
    expect(objetivos.lte(1)).toBe(true);
    expect(d.avisos?.[0]).toMatchObject({ severidad: 'WARN' });
  });
});

describe('validate y preview', () => {
  const market = ctx().market;
  const v = (extra: Record<string, unknown>) =>
    s.validate({ ...CFG, ...extra } as unknown as BotConfig, market);
  const errores = (extra: Record<string, unknown>) =>
    v(extra)
      .issues.filter((i) => i.severity === 'ERROR')
      .map((i) => i.field);

  it('una operación bien formada valida y se previsualiza', () => {
    expect(v({}).ok).toBe(true);
    const p = s.preview(CFG as unknown as BotConfig, market, '100');
    expect(p.valid).toBe(true);
    expect(p.levels).toHaveLength(1);
  });

  it('cada número en su sitio', () => {
    expect(errores({ stopPrice: '101' })).toContain('stopPrice');
    expect(errores({ tp1Price: '99' })).toContain('tp1Price');
    expect(errores({ tp2Price: '103' })).toContain('tp2Price');
    expect(errores({ quantity: '0.000001' })).toContain('quantity');
    expect(errores({ quantity: '0.05' })).toContain('quantity');
    expect(errores({ marginMode: 'CROSS' })).toContain('marginMode');
  });

  it('la liquidación tiene que quedar detrás del stop, con holgura', () => {
    // A 25x la liquidación de un largo en 100,1 queda hacia 96,5: el stop de 98 no aguanta.
    expect(errores({ leverage: 25 })).toContain('leverage');
  });
});

describe('soloReduceRiesgo', () => {
  const a = CFG as unknown as BotConfig;
  const con = (extra: Record<string, unknown>) => ({ ...CFG, ...extra }) as unknown as BotConfig;

  it('ceñir el stop o bajar el tope, sí', () => {
    expect(soloReduceRiesgo(a, con({ stopPrice: '99' }))).toBe(true);
    expect(soloReduceRiesgo(a, con({ positionCap: '0.5' }))).toBe(true);
    expect(soloReduceRiesgo(a, con({ stopPrice: '99', positionCap: '0' }))).toBe(true);
    expect(soloReduceRiesgo(a, a)).toBe(true);
  });

  it('ensanchar el stop, subir el tope o tocar cualquier otra cosa, no', () => {
    expect(soloReduceRiesgo(a, con({ stopPrice: '97' }))).toBe(false);
    expect(soloReduceRiesgo(con({ positionCap: '0.5' }), con({ positionCap: '0.8' }))).toBe(false);
    expect(soloReduceRiesgo(a, con({ tp1Price: '103' }))).toBe(false);
    expect(soloReduceRiesgo(a, con({ leverage: 10 }))).toBe(false);
    expect(soloReduceRiesgo(a, con({ positionCap: '-1' }))).toBe(false);
  });

  it('en el corto, ceñir es bajar', () => {
    const corto = con({ direction: 'SHORT', stopPrice: '102' });
    expect(soloReduceRiesgo(corto, { ...corto, stopPrice: '101' })).toBe(true);
    expect(soloReduceRiesgo(corto, { ...corto, stopPrice: '103' })).toBe(false);
  });

  it('la estrategia registrada lo declara para `updateConfig`, y ninguna otra', () => {
    // Por él, ceñir el stop no depende de que un tope del usuario siga como estaba.
    const declarada = getStrategy(StrategyKind.AGENT_TRADE).soloReduceRiesgo;
    expect(declarada?.(a, con({ stopPrice: '99' }))).toBe(true);
    expect(declarada?.(a, con({ stopPrice: '97' }))).toBe(false);
    for (const k of Object.values(StrategyKind)) {
      if (k !== StrategyKind.AGENT_TRADE) expect(getStrategy(k).soloReduceRiesgo).toBeUndefined();
    }
  });
});

it('plan() es pura', () => {
  const c = ctx({ qty: '1', precio: '101', scratch: { op: OP } });
  expect(s.plan(c)).toEqual(s.plan(c));
  expect(Venue.HYPERLIQUID).toBe(c.venue);
});
