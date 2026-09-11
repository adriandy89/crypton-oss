import { LevelKind, StrategyKind, type BotConfig, type DesiredState } from '@crypton/shared';
import { getStrategy } from './registry';
import { withStopLoss } from './stop-loss';
import { BASE_CONFIG, makeContext, makeCycle, makePosition } from './testing';
import { TTP_ARMED, TTP_PEAK } from './trailing-take-profit';

/**
 * El take profit que sigue al precio (spec 042).
 *
 * Casi todo lo que puede salir mal aquí vive ENTRE dos revisiones —el motor
 * planifica cada quince segundos y el precio se mueve varias veces por
 * segundo—, así que la mitad de estos casos son caminos de varios ticks y no
 * una sola llamada. Es la lección del spec 041.
 */

const MERCADO = { tickSize: '0.01', priceDecimals: 2, stepSize: '0.001', qtyDecimals: 3 };
const tdca = getStrategy(StrategyKind.TDCA);
const martingala = getStrategy(StrategyKind.MARTINGALE);

const CONFIG = {
  ...tdca.defaults(),
  ...BASE_CONFIG,
  amountPerBuy: '100',
  takeProfitPct: '20',
  trailingTakeProfit: true,
  trailingCallbackPct: '1',
} as unknown as BotConfig;

/** Un tick del DCA con posición abierta en 100. */
const plan = (
  extra: Record<string, unknown> = {},
  ctxExtra: Record<string, unknown> = {},
): DesiredState =>
  tdca.plan(
    makeContext({
      strategy: StrategyKind.TDCA,
      config: { ...CONFIG, ...extra },
      market: MERCADO,
      position: makePosition('1', '100'),
      ...ctxExtra,
    }),
  );

const salida = (r: DesiredState) => r.orders.find((o) => o.levelKind === LevelKind.TAKE_PROFIT);

describe('trailing take profit — antes de activarse', () => {
  it('por debajo del objetivo NO hay orden de beneficio, y la nota lo dice', () => {
    // Con el objetivo en +20 % sobre una entrada de 100, el disparador nace en
    // 120. A 110 no hay nada que asegurar: el stop loss del usuario es la única
    // protección, y eso es lo correcto (CA-3).
    const r = plan({}, { price: '110' });
    expect(salida(r)).toBeUndefined();
    expect(r.note).toContain('el seguimiento empieza');
    expect(r.scratchPatch).toBeUndefined();
  });

  it('el stop loss del usuario SIGUE estando', () => {
    // Es el test que impide cambiar una red de seguridad por una mejora de
    // beneficio. El trailing se emite como TAKE_PROFIT con `intent: SL`
    // justamente para que `withStopLoss` no se calle (CA-2).
    const r = plan({ stopLossPct: '5' }, { price: '125' });
    const conStop = withStopLoss(r, makePosition('1', '100'), {
      botId: '1a2b3c4d-0000-0000-0000-000000000000',
      cycleSeq: 1,
      market: { ...MERCADO } as never,
      stopLossPct: '5',
    });
    expect(conStop.orders.some((o) => o.levelKind === LevelKind.STOP_LOSS)).toBe(true);
    expect(salida(conStop)).toBeDefined();
  });
});

describe('trailing take profit — el disparador', () => {
  it('al cruzar el objetivo nace en máximo × (1 − retroceso)', () => {
    // 125 × 0,99 = 123,75 (CA-4).
    const r = plan({}, { price: '125' });
    const o = salida(r)!;
    expect(o.price).toBe('123.75');
    expect(o.triggerPrice).toBe('123.75');
    expect(o.type).toBe('MARKET');
    expect(o.reduceOnly).toBe(true);
  });

  it('se emite como TAKE_PROFIT pero con intención de STOP', () => {
    // Contablemente es un objetivo de beneficio; mecánicamente es un stop, y
    // sin decirlo el venue lo armaría al revés y cerraría la posición al
    // colocarlo — el fallo 001/F-80 (CA-1, la mitad pura).
    const o = salida(plan({}, { price: '125' }))!;
    expect(o.levelKind).toBe(LevelKind.TAKE_PROFIT);
    expect(o.intent).toBe('SL');
    expect(o.side).toBe('SELL');
  });

  it('anota el armado y el máximo en el scratch', () => {
    const r = plan({}, { price: '125' });
    expect(r.scratchPatch?.[TTP_ARMED]).toBeDefined();
    expect(r.scratchPatch?.[TTP_PEAK]).toBe('125');
  });

  it('SUBE con el precio', () => {
    const r = plan(
      {},
      { price: '140', cycle: { scratch: { cycleSeq: 1, [TTP_ARMED]: 1, [TTP_PEAK]: '125' } } },
    );
    expect(salida(r)!.price).toBe('138.60');
  });

  it('y NUNCA baja, ni con el precio desplomándose', () => {
    // El precio se va a 121 desde un máximo de 140: el disparador se queda en
    // 138,60. Que quede POR ENCIMA del mercado no es un error, es la condición
    // de salida cumplida — el venue lo ejecuta y eso es lo que se quiere (CA-5).
    const r = plan(
      {},
      { price: '121', cycle: { scratch: { cycleSeq: 1, [TTP_ARMED]: 1, [TTP_PEAK]: '140' } } },
    );
    expect(salida(r)!.price).toBe('138.60');
    expect(r.scratchPatch).toBeUndefined();
  });

  it('un avance pequeño NO recoloca ni escribe en el scratch', () => {
    // De 140 a 140,1 el disparador avanza ~7 bps, por debajo de los 20 de
    // fábrica. Ni orden nueva ni UPDATE en la base (CA-6).
    const r = plan(
      {},
      { price: '140.1', cycle: { scratch: { cycleSeq: 1, [TTP_ARMED]: 1, [TTP_PEAK]: '140' } } },
    );
    expect(salida(r)!.price).toBe('138.60');
    expect(r.scratchPatch).toBeUndefined();
  });

  it('y uno que pasa del umbral sí', () => {
    const r = plan(
      {},
      { price: '141', cycle: { scratch: { cycleSeq: 1, [TTP_ARMED]: 1, [TTP_PEAK]: '140' } } },
    );
    expect(salida(r)!.price).toBe('139.59');
    expect(r.scratchPatch?.[TTP_PEAK]).toBe('141');
  });
});

describe('trailing take profit — el armado es irreversible', () => {
  it('una vez cruzado el objetivo, volver por debajo NO desarma', () => {
    // Un precio que vuelve a bajar no desarma un bot que ya tiene inventario
    // que proteger. Es la misma regla que el `activationGate` del MM V2 (CA-7).
    const r = plan(
      {},
      { price: '105', cycle: { scratch: { cycleSeq: 1, [TTP_ARMED]: 1, [TTP_PEAK]: '125' } } },
    );
    expect(salida(r)).toBeDefined();
    expect(salida(r)!.price).toBe('123.75');
  });
});

describe('trailing take profit — en corto es el espejo exacto', () => {
  const corto = (precio: string, scratch: Record<string, unknown> = { cycleSeq: 1 }) =>
    tdca.plan(
      makeContext({
        strategy: StrategyKind.TDCA,
        config: { ...CONFIG, direction: 'SHORT' } as unknown as BotConfig,
        market: MERCADO,
        position: makePosition('-1', '100'),
        price: precio,
        cycle: { scratch },
      }),
    );

  it('el objetivo está por DEBAJO y el disparador por ENCIMA del mínimo', () => {
    // Objetivo −20 % = 80; mínimo 75 ⇒ disparador 75 × 1,01 = 75,75 (CA-8).
    const o = salida(corto('75'))!;
    expect(o.side).toBe('BUY');
    expect(o.intent).toBe('SL');
    expect(o.price).toBe('75.75');
  });

  it('el mínimo nunca sube', () => {
    const o = salida(corto('79', { cycleSeq: 1, [TTP_ARMED]: 1, [TTP_PEAK]: '70' }))!;
    expect(o.price).toBe('70.70');
  });

  it('por encima del objetivo no hay salida', () => {
    expect(salida(corto('95'))).toBeUndefined();
  });
});

describe('trailing take profit — lo que se ve entre dos revisiones', () => {
  it('un pico visto SOLO por el stream cuenta igual', () => {
    // El motor planifica cada quince segundos. Si el precio sube a 130 y vuelve
    // a 121 entre dos planes, sin la marca de agua ese máximo no habría
    // existido y el bot habría salido casi diez puntos más abajo (CA-9).
    const r = plan({}, { price: '121', extremos: { alto: '130', bajo: '120' } });
    expect(salida(r)!.price).toBe('128.70');
    expect(r.scratchPatch?.[TTP_PEAK]).toBe('130');
  });

  it('el stream no puede BAJAR un máximo ya persistido', () => {
    const r = plan(
      {},
      {
        price: '121',
        extremos: { alto: '130', bajo: '120' },
        cycle: { scratch: { cycleSeq: 1, [TTP_ARMED]: 1, [TTP_PEAK]: '140' } },
      },
    );
    expect(salida(r)!.price).toBe('138.60');
  });

  it('sin marca de agua el bot sale más abajo, nunca más arriba', () => {
    // Es el peor caso de un reinicio del worker, y está aceptado a propósito:
    // lo que se persiste es el máximo del ciclo, no el de los últimos quince
    // segundos.
    const conStream = salida(plan({}, { price: '121', extremos: { alto: '130', bajo: '120' } }))!;
    const sinStream = salida(plan({}, { price: '121' }))!;
    expect(Number(sinStream.price)).toBeLessThan(Number(conStream.price));
  });
});

describe('trailing take profit — camino de varios ticks', () => {
  it('sube al +20 %, retrocede al +19 %: sale ahí y no antes ni después', () => {
    // El camino que pidió el usuario, tick a tick y determinista (CA-10).
    let scratch: Record<string, unknown> = { cycleSeq: 1 };
    const tick = (precio: string) => {
      const r = plan({}, { price: precio, cycle: { scratch } });
      if (r.scratchPatch) scratch = { ...scratch, ...r.scratchPatch };
      return r;
    };

    // 1. +10 %: ni armado ni orden.
    expect(salida(tick('110'))).toBeUndefined();

    // 2. +20 %: se arma justo en el objetivo y el disparador nace en 118,80.
    expect(salida(tick('120'))!.price).toBe('118.80');
    expect(scratch[TTP_ARMED]).toBeDefined();

    // 3. Sigue subiendo al +25 %: el disparador sube con él.
    expect(salida(tick('125'))!.price).toBe('123.75');

    // 4. Retrocede al +19 %: el disparador NO se mueve, y está por encima del
    //    mercado — o sea, la condición de salida está cumplida y el venue
    //    cierra. Sale en 123,75, que es el +23,75 % y no el +19 %.
    const ultimo = tick('119');
    expect(ultimo.scratchPatch).toBeUndefined();
    expect(salida(ultimo)!.price).toBe('123.75');
    expect(Number(salida(ultimo)!.price)).toBeGreaterThan(119);
  });

  it('el suelo de lo que se cobra es activación × (1 − retroceso)', () => {
    // Con 15 % y 1 %: 115 × 0,99 = 113,85. Es el peor caso, y va en la guía.
    const r = plan({ takeProfitPct: '15' }, { price: '115' });
    expect(salida(r)!.price).toBe('113.85');
  });
});

describe('trailing take profit — martingala', () => {
  const planMart = (extra: Record<string, unknown>, ctxExtra: Record<string, unknown> = {}) =>
    martingala.plan(
      makeContext({
        strategy: StrategyKind.MARTINGALE,
        config: {
          ...martingala.defaults(),
          ...BASE_CONFIG,
          takeProfitPct: '20',
          trailingTakeProfit: true,
          trailingCallbackPct: '1',
          ...extra,
        },
        market: MERCADO,
        position: makePosition('1', '100'),
        ...ctxExtra,
      }),
    );

  it('hace exactamente lo mismo que el DCA', () => {
    const o = salida(planMart({}, { price: '125' }))!;
    expect(o.price).toBe('123.75');
    expect(o.intent).toBe('SL');
    expect(o.type).toBe('MARKET');
  });

  it('sin activar no emite salida, y las seguridades siguen tendidas', () => {
    const r = planMart({}, { price: '105' });
    expect(salida(r)).toBeUndefined();
    expect(r.orders.some((o) => o.levelKind === LevelKind.SAFETY)).toBe(true);
  });

  it('la activación baja cuando baja el precio medio, pero el máximo no', () => {
    // Al llenarse una seguridad el medio cae y el objetivo cae con él. El
    // máximo ya alcanzado NO se toca: es lo que separa «dónde empiezo a seguir»
    // de «hasta dónde he llegado».
    const r = planMart(
      {},
      {
        position: makePosition('2', '90'),
        price: '109',
        cycle: { scratch: { cycleSeq: 1, [TTP_ARMED]: 1, [TTP_PEAK]: '125' } },
      },
    );
    expect(salida(r)!.price).toBe('123.75');
  });
});

describe('trailing take profit — apagado, nada cambia', () => {
  it('con los valores de fábrica el DCA emite el mismo LIMIT de siempre', () => {
    // R-8: la garantía para los bots en marcha.
    const r = tdca.plan(
      makeContext({
        strategy: StrategyKind.TDCA,
        config: {
          ...tdca.defaults(),
          ...BASE_CONFIG,
          amountPerBuy: '100',
        },
        market: MERCADO,
        position: makePosition('1', '100'),
        price: '125',
        cycle: makeCycle(),
      }),
    );
    const o = salida(r)!;
    expect(o.type).toBe('LIMIT');
    expect(o.price).toBe('101.50');
    expect(o.intent).toBeUndefined();
    expect(o.triggerPrice).toBeUndefined();
    expect(r.scratchPatch).toBeUndefined();
  });

  it('y la martingala también', () => {
    const r = martingala.plan(
      makeContext({
        strategy: StrategyKind.MARTINGALE,
        config: {
          ...martingala.defaults(),
          ...BASE_CONFIG,
        },
        market: MERCADO,
        position: makePosition('1', '100'),
        price: '125',
      }),
    );
    const o = salida(r)!;
    expect(o.type).toBe('LIMIT');
    expect(o.intent).toBeUndefined();
    expect(r.scratchPatch).toBeUndefined();
  });
});

describe('trailing take profit — validación', () => {
  const market = { ...makeContext({ strategy: StrategyKind.TDCA, config: CONFIG }).market };

  it('avisa de un retroceso demasiado fino', () => {
    const r = tdca.validate({ ...CONFIG, trailingCallbackPct: '0.2' }, market);
    expect(
      r.issues.some((i) => i.field === 'trailingCallbackPct' && i.severity === 'WARNING'),
    ).toBe(true);
  });

  it('rechaza encenderlo sin retroceso', () => {
    // El rango 0,1-10 lo cubre el validador genérico a partir del `FieldMeta`.
    // Lo que ESTE comprueba es el caso que aquel no ve: el campo ausente en una
    // configuración guardada antes del spec a la que se le enciende el
    // interruptor en caliente.
    const r = tdca.validate({ ...CONFIG, trailingCallbackPct: undefined }, market);
    expect(r.issues.some((i) => i.field === 'trailingCallbackPct' && i.severity === 'ERROR')).toBe(
      true,
    );
  });

  it('apagado no avisa de un retroceso fino', () => {
    const r = tdca.validate(
      { ...CONFIG, trailingTakeProfit: false, trailingCallbackPct: '0.2' },
      market,
    );
    expect(r.issues.some((i) => i.field === 'trailingCallbackPct')).toBe(false);
  });
});

/**
 * Lo que la revisión del spec 044 encontró.
 *
 * Los dos son de VENTANA: no ocurren en una llamada, ocurren entre dos
 * configuraciones. Es la misma lección del spec 041 aplicada a un interruptor
 * que se puede tocar con el bot en marcha.
 */
describe('trailing take profit — lo que la revision encontro (spec 044)', () => {
  it('apagarlo borra el maximo, y volver a encenderlo empieza de cero', () => {
    // Con el pico en 140 y la marca ya en 100, el estado viejo daba un
    // disparador en 126: una venta con disparo a la baja POR ENCIMA del
    // mercado, o sea un cierre a mercado inmediato de la posicion entera.
    const sucio = { cycleSeq: 1, [TTP_ARMED]: 1, [TTP_PEAK]: '140' };
    const apagado = plan(
      { trailingTakeProfit: false, trailingCallbackPct: '10' },
      { price: '100', cycle: { scratch: sucio } },
    );
    expect(apagado.scratchPatch?.[TTP_ARMED]).toBeNull();
    expect(apagado.scratchPatch?.[TTP_PEAK]).toBeNull();

    // Y con el scratch ya limpio, volver a encenderlo no resucita nada: el
    // objetivo es 120 y la marca 100, asi que ni siquiera se arma.
    const limpio = { cycleSeq: 1, [TTP_ARMED]: null, [TTP_PEAK]: null };
    const reencendido = plan(
      { trailingCallbackPct: '10' },
      { price: '100', cycle: { scratch: limpio } },
    );
    expect(salida(reencendido)).toBeUndefined();
  });

  it('apagado y ya limpio, no escribe en el scratch en cada revision', () => {
    // Cada patch es un UPDATE en la base sin amortiguar.
    const r = plan({ trailingTakeProfit: false }, { price: '125' });
    expect(r.scratchPatch).toBeUndefined();
  });
});
