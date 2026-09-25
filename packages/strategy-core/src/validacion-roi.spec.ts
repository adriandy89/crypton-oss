import { StrategyKind, type BotConfig, type ValidationResult } from '@crypton/shared';
import { camposEfectivos, validarStopFrenteALiquidacion } from './common';
import { getStrategy, listStrategies } from './registry';
import { BASE_CONFIG, CONFIG_MINIMA, makeMarket } from './testing';

/**
 * Lo que el spec 080 valida de los % sobre el margen, con el mercado de pruebas
 * (BTC, 40× de máximo: mantenimiento 1,25 %).
 */
const market = makeMarket();
const trailing = getStrategy(StrategyKind.TRAILING_PROFIT);
const martingala = getStrategy(StrategyKind.MARTINGALE);

const cfg = (s = trailing, extra: Record<string, unknown> = {}) =>
  ({ ...s.defaults(), ...BASE_CONFIG, totalInvestment: '120', ...extra }) as unknown as BotConfig;

const del = (r: ValidationResult, field: string) => r.issues.filter((i) => i.field === field);

describe('el stop frente a la liquidación (079/F-01)', () => {
  it('el caso del 079: corto a 15× en aislado, un stop del 90 % del margen no salta nunca', () => {
    const r = trailing.validate(
      cfg(trailing, { direction: 'SHORT', leverage: 15, stopLossPct: '90' }),
      market,
    );
    const [i] = del(r, 'stopLossPct');
    expect(i.severity).toBe('ERROR');
    expect(i.suggestedValue).toBe('53.4');
    expect(i.message).toContain('80.2 % del margen');
    expect(r.ok).toBe(false);
  });

  it('con el 75 % —el 5 % del precio de antes— la liquidación queda a menos de medio stop: aviso', () => {
    const r = trailing.validate(
      cfg(trailing, { direction: 'SHORT', leverage: 15, stopLossPct: '75' }),
      market,
    );
    const [i] = del(r, 'stopLossPct');
    expect(i.severity).toBe('WARNING');
    expect(i.suggestedValue).toBe('53.4');
    expect(r.ok).toBe(true);
  });

  it('con el stop propuesto no hay nada que decir', () => {
    const r = trailing.validate(
      cfg(trailing, { direction: 'SHORT', leverage: 15, stopLossPct: '53.4' }),
      market,
    );
    expect(del(r, 'stopLossPct')).toEqual([]);
  });

  it('en cruzado solo avisa: la liquidación real queda más lejos', () => {
    const r = trailing.validate(
      cfg(trailing, {
        direction: 'SHORT',
        leverage: 15,
        stopLossPct: '90',
        marginMode: 'CROSS',
      }),
      market,
    );
    const [i] = del(r, 'stopLossPct');
    expect(i.severity).toBe('WARNING');
    expect(i.suggestedValue).toBe('53.4');
  });

  it('NEUTRAL se mide contra el corto, que liquida antes', () => {
    // A 15× un 81 % del margen es un 5,4 % del precio: dentro del largo
    // (5,49 %) y detrás del corto (5,35 %).
    const largo = validarStopFrenteALiquidacion('81', 15, market, 'LONG', 'ISOLATED');
    const neutral = validarStopFrenteALiquidacion('81', 15, market, 'NEUTRAL', 'ISOLATED');
    expect(largo[0].severity).toBe('WARNING');
    expect(neutral[0].severity).toBe('ERROR');
    expect(neutral[0].message).toContain('en corto');
  });

  it('en largo, un stop que lleva el disparo a cero es un error aunque sea cruzado', () => {
    const [i] = validarStopFrenteALiquidacion('100', 1, market, 'LONG', 'CROSS');
    expect(i.severity).toBe('ERROR');
    expect(i.message).toContain('cero');
    // Y también propone el más ancho válido: a 1× la liquidación está en cero,
    // y medio stop de holgura deja un 66,6 % (D-4).
    expect(i.suggestedValue).toBe('66.6');
  });

  it('la tendencia pone su propio stop: la regla no la mide', () => {
    const tendencia = getStrategy(StrategyKind.TREND_FOLLOW);
    const r = tendencia.validate(cfg(tendencia, { leverage: 15, stopLossPct: '90' }), market);
    expect(del(r, 'stopLossPct').some((i) => i.suggestedValue !== undefined)).toBe(false);
  });
});

describe('los objetivos en % del margen', () => {
  it('en corto, un objetivo que llevaría el precio a cero es un error (079/F-06)', () => {
    // A 2× un 200 % del margen es un 100 % del precio.
    const imposible = trailing.validate(
      cfg(trailing, { direction: 'SHORT', leverage: 2, takeProfitPct: '200' }),
      market,
    );
    expect(del(imposible, 'takeProfitPct')[0]?.severity).toBe('ERROR');
    const posible = trailing.validate(
      cfg(trailing, { direction: 'SHORT', leverage: 2, takeProfitPct: '199' }),
      market,
    );
    expect(del(posible, 'takeProfitPct')).toEqual([]);
  });

  it('el mínimo rentable se mide en precio', () => {
    // A 5× un 1 % del margen es un 0,2 % del precio: por debajo del 0,3 %.
    const corto = martingala.validate(cfg(martingala, { leverage: 5, takeProfitPct: '1' }), market);
    expect(del(corto, 'takeProfitPct')[0]?.severity).toBe('WARNING');
    const bien = martingala.validate(cfg(martingala, { leverage: 1, takeProfitPct: '1' }), market);
    expect(del(bien, 'takeProfitPct')).toEqual([]);
  });

  it('el máximo de cada uno escala con el apalancamiento, y el tope en precio no cambia', () => {
    const campos = camposEfectivos(martingala.meta.fields, { leverage: 5 }, market);
    const max = (k: string) => campos.find((f) => f.key === k)?.max;
    expect(max('takeProfitPct')).toBe(250);
    expect(max('stopLossPct')).toBe(450);
  });

  it('llevan la marca `roi` justo los campos que convierte la migración del 080', () => {
    // El mismo listado que `_claves()` en la migración: si una estrategia gana
    // un % de resultado, la migración tiene que saberlo.
    const esperado: Record<string, string[]> = {
      GRID_CLASSIC: ['stopLossPct'],
      NEUTRAL_GRID: ['stopLossPct'],
      TDCA: ['stopLossPct', 'takeProfitPct'],
      MARTINGALE: ['stopLossPct', 'takeProfitPct'],
      GRIDMART: ['satelliteTpPct', 'stopLossPct'],
      MARKET_MAKER: ['stopLossPct'],
      MARKET_MAKER_V2: ['stopLossPct'],
      TREND_FOLLOW: ['stopLossPct'],
      TRAILING_PROFIT: ['stopLossPct', 'takeProfitPct'],
      AI_CHANNEL: ['stopLossPct'],
      AGENT_TRADE: ['stopLossPct'],
    };
    for (const s of listStrategies()) {
      const roi = s.meta.fields
        .filter((f) => f.roi)
        .map((f) => f.key)
        .sort();
      expect({ [s.kind]: roi }).toEqual({ [s.kind]: esperado[s.kind] });
    }
  });
});

describe('el retroceso del seguimiento, con la fórmula exacta (079/F-16)', () => {
  const avisa = (extra: Record<string, unknown>) =>
    del(trailing.validate(cfg(trailing, { leverage: 1, ...extra }), market), 'trailingCallbackPct');

  it('en largo avisa aunque el retroceso sea menor que el objetivo', () => {
    // Activa en 103; con 2,95 % sale en 99,96, por debajo de la entrada.
    expect(avisa({ takeProfitPct: '3', trailingCallbackPct: '2.95' })).toHaveLength(1);
  });

  it('en corto no avisa si sigue en beneficio', () => {
    // Activa en 90; con un 10 % sale en 99: sigue por debajo de la entrada.
    expect(
      avisa({ direction: 'SHORT', takeProfitPct: '10', trailingCallbackPct: '10' }),
    ).toHaveLength(0);
  });

  it('en corto dice «por encima» cuando sí sale en pérdida', () => {
    const [i] = avisa({ direction: 'SHORT', takeProfitPct: '5', trailingCallbackPct: '6' });
    expect(i.message).toContain('por encima');
  });
});

describe('la escalera, nivel a nivel (079/F-01, F-07)', () => {
  // Volumen constante y separaciones 2, 3 y 4,5 %: a 15× la media de los tres
  // primeros niveles (≈ 0,977 del ancla) liquida en ≈ 0,923, antes de la
  // tercera seguridad (0,905).
  const cortada = {
    leverage: 15,
    totalInvestment: '1000',
    volumeScale: '1',
    initialSeparationPct: '2',
    stepScale: '1.5',
  };

  it('en aislado, la liquidación que llega antes que una seguridad es un error', () => {
    const r = martingala.validate(cfg(martingala, cortada), market);
    const i = del(r, 'numLimitBuys').find((x) => x.message.includes('liquidación'));
    expect(i?.severity).toBe('ERROR');
    expect(i?.message).toContain('seguridad 3');
  });

  it('en cruzado, un aviso', () => {
    const r = martingala.validate(cfg(martingala, { ...cortada, marginMode: 'CROSS' }), market);
    const i = del(r, 'numLimitBuys').find((x) => x.message.includes('liquidación'));
    expect(i?.severity).toBe('WARNING');
  });

  it('si el tope de exposición no deja tender esa seguridad, no hay error: no existe', () => {
    // Cada nivel mueve 1000 × 15 / 7 ≈ 2142,9. Al llegar a la tercera seguridad
    // (0,905) lo comprado valdría ≈ 8102: con un tope de 7000 el plan no la
    // tiende, y la liquidación que llegaba antes que ella no corta nada que el
    // bot vaya a colocar.
    const r = martingala.validate(cfg(martingala, { ...cortada, maxNotionalCap: '7000' }), market);
    expect(r.issues.filter((x) => x.severity === 'ERROR')).toEqual([]);
  });

  it('y si no cabe ninguna seguridad, lo dice', () => {
    const r = martingala.validate(cfg(martingala, { ...cortada, maxNotionalCap: '2500' }), market);
    expect(del(r, 'maxNotionalCap').map((x) => x.message)).toContain(
      'Con este tope de exposición no cabe ninguna seguridad: el bot abre la base y no promedia.',
    );
  });

  it('un tope que no deja tender ninguna línea es un error: el bot no haría nada', () => {
    // 1000 a 1× en cinco líneas: 200 cada una.
    const neutral = getStrategy(StrategyKind.NEUTRAL_GRID);
    const rn = neutral.validate(
      {
        ...cfg(neutral, CONFIG_MINIMA.NEUTRAL_GRID),
        totalInvestment: '1000',
        maxExposure: '150',
      },
      market,
    );
    expect(del(rn, 'maxExposure').find((x) => x.severity === 'ERROR')?.message).toContain(
      'no deja tender ni la línea más cercana al ancla',
    );
    const clasica = getStrategy(StrategyKind.GRID_CLASSIC);
    const rc = clasica.validate(
      {
        ...cfg(clasica, CONFIG_MINIMA.GRID_CLASSIC),
        totalInvestment: '1000',
        maxNotionalCap: '150',
      },
      market,
    );
    expect(del(rc, 'maxNotionalCap').find((x) => x.severity === 'ERROR')?.message).toBe(
      'El tope de exposición (150.00) es menor que una sola línea (200.00): la rejilla no pondría ninguna orden de entrada.',
    );
    // Con una línea que quepa, solo el aviso de que el lado no se tiende entero.
    const ok = neutral.validate(
      {
        ...cfg(neutral, CONFIG_MINIMA.NEUTRAL_GRID),
        totalInvestment: '1000',
        maxExposure: '300',
      },
      market,
    );
    expect(ok.ok).toBe(true);
    expect(del(ok, 'maxExposure').map((x) => x.severity)).toEqual(['WARNING']);
    // Y la cifra del aviso es la de la Revisión: el lado más cargado, con sus
    // líneas ya en la retícula del venue.
    const sinTope = neutral.preview(
      {
        ...cfg(neutral, CONFIG_MINIMA.NEUTRAL_GRID),
        totalInvestment: '1000',
        maxExposure: '1000000',
      },
      market,
      '100',
    );
    const mayor = sinTope.sides.map((s) => Number(s.notional)).sort((a, b) => b - a)[0];
    expect(del(ok, 'maxExposure')[0].message).toContain(`un lado (${mayor.toFixed(2)})`);
  });

  it('la rejilla neutral mide el corto también en Largo: la dirección no cambia la retícula', () => {
    // A 2× el corto admite un stop del 64,1 % sin aviso y el largo, del 65,8 %.
    // Con 65 %, en Neutral avisa; en Largo callaba, y la rejilla puede acabar
    // corta igual.
    const neutral = getStrategy(StrategyKind.NEUTRAL_GRID);
    const conStop = (direction: string) =>
      neutral.validate(
        {
          ...cfg(neutral, CONFIG_MINIMA.NEUTRAL_GRID),
          direction,
          leverage: 2,
          marginMode: 'ISOLATED',
          stopLossPct: '65',
        } as never,
        market,
      );
    expect(del(conStop('NEUTRAL'), 'stopLossPct')).toHaveLength(1);
    expect(del(conStop('LONG'), 'stopLossPct')).toEqual(del(conStop('NEUTRAL'), 'stopLossPct'));
  });

  it('con el volumen de fábrica la media baja deprisa y la misma escalera cabe a 15×', () => {
    // Es lo que el `100/L` de antes no veía: la liquidación se mueve con la
    // media, y con 1,6× por nivel la media se va detrás del precio.
    const r = martingala.validate(
      cfg(martingala, { leverage: 15, totalInvestment: '1000' }),
      market,
    );
    expect(del(r, 'numLimitBuys').filter((x) => x.severity === 'ERROR')).toEqual([]);
  });

  it('un stop que salta antes que una seguridad lo avisa', () => {
    // A 2× un 4 % del margen es un 2 % del precio desde la media: con la de las
    // tres primeras entradas (≈ 98,6) salta en ≈ 96,6, antes que la tercera
    // seguridad, a un 3,6 % de la entrada.
    const r = martingala.validate(
      cfg(martingala, { leverage: 2, totalInvestment: '1000', stopLossPct: '4' }),
      market,
    );
    const i = del(r, 'stopLossPct').find((x) => x.message.includes('salta antes'));
    expect(i?.severity).toBe('WARNING');
    expect(i?.message).toContain('seguridad 3');
  });
});

describe('el suelo del seguimiento, también en la martingala y el DCA (079/F-16)', () => {
  const tdca = getStrategy(StrategyKind.TDCA);
  const aviso = (s: typeof martingala, extra: Record<string, unknown>) =>
    del(
      s.validate(cfg(s, { trailingTakeProfit: true, ...extra }), market),
      'trailingCallbackPct',
    ).filter((i) => i.message.includes('lo mínimo que cobra'));

  it('con los valores de fábrica de la martingala el suelo cae en pérdida, y se avisa', () => {
    // 2 % del margen a 2× es un 1 % del precio: activa en 1,01 y, con un 1 % de
    // retroceso, sale en 0,9999, por debajo de la entrada.
    expect(aviso(martingala, { leverage: 2, takeProfitPct: '2' })).toHaveLength(1);
    expect(
      aviso(martingala, { leverage: 2, takeProfitPct: '2', trailingCallbackPct: '0.9' }),
    ).toEqual([]);
  });

  it('en el DCA, lo mismo, y en corto dice «por encima»', () => {
    const [i] = aviso(tdca, {
      amountPerBuy: '25',
      direction: 'SHORT',
      leverage: 1,
      takeProfitPct: '1',
      trailingCallbackPct: '1.5',
    });
    expect(i.message).toContain('por encima');
  });

  it('apagado, no se mide', () => {
    expect(
      aviso(martingala, { trailingTakeProfit: false, leverage: 2, takeProfitPct: '2' }),
    ).toEqual([]);
  });
});

describe('los casos sin liquidación (encontrados al rehacer las guías del 080)', () => {
  it('una escalera en largo que llega a precio cero es un error, también a 1×', () => {
    // 1 %, 10 % de separación y escala 1,3: la sexta seguridad cae más de un 100 %.
    const r = martingala.validate(
      cfg(martingala, {
        leverage: 1,
        numLimitBuys: 6,
        initialSeparationPct: '10',
        stepScale: '1.3',
        volumeScale: '1.6',
      }),
      market,
    );
    const i = del(r, 'numLimitBuys').find((x) => x.message.includes('precio cero'));
    expect(i?.severity).toBe('ERROR');
    expect(r.ok).toBe(false);
  });

  it('a 1× en largo no hay liquidación de la que avisar: un stop del 70 % es un stop del 70 %', () => {
    expect(validarStopFrenteALiquidacion('70', 1, market, 'LONG', 'ISOLATED')).toEqual([]);
    // En corto sí la hay: el precio casi se duplica.
    expect(validarStopFrenteALiquidacion('70', 1, market, 'SHORT', 'ISOLATED')).toHaveLength(1);
  });
});
