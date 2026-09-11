import {
  LevelKind,
  StrategyKind,
  type BotConfig,
  type Candle,
  type DesiredState,
} from '@crypton/shared';
import { getStrategy } from '../registry';
import { BASE_CONFIG, makeContext, makeMarket, makePosition } from '../testing';

/**
 * La estrategia de tendencia (spec 040).
 *
 * Es la unica que decide mirando un grafico, asi que casi todos estos casos son
 * sobre la SERIE: que entre cuando hay ruptura, que NO entre cuando el mercado
 * va y viene, y que el stop siga al precio sin retroceder nunca.
 */

const MERCADO = { tickSize: '0.01', priceDecimals: 2, stepSize: '0.001', qtyDecimals: 3 };
const estrategia = getStrategy(StrategyKind.TREND_FOLLOW);

/** Velas con rango fijo alrededor de cada cierre. */
const serie = (cierres: number[], rango = 2): Candle[] =>
  cierres.map((c, i) => ({
    t: i * 3_600_000,
    o: String(c),
    h: String(c + rango / 2),
    l: String(c - rango / 2),
    c: String(c),
    v: '1',
  }));

/** 30 velas laterales y luego el cierre que se le pase. */
const conRuptura = (ultimo: number): Candle[] => {
  const laterales = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 ? 1 : -1));
  return serie([...laterales, ultimo]);
};

/** Rampa monotona: eficiencia 1, que es lo que el filtro quiere ver. */
const rampa = (n: number, desde = 100, paso = 2): Candle[] =>
  serie(Array.from({ length: n }, (_, i) => desde + i * paso));

const plan = (extra: Record<string, unknown> = {}, ctxExtra: Record<string, unknown> = {}) =>
  estrategia.plan(
    makeContext({
      strategy: StrategyKind.TREND_FOLLOW,
      config: {
        ...estrategia.defaults(),
        ...BASE_CONFIG,
        totalInvestment: '1000',
        direction: 'NEUTRAL',
        ...extra,
      } as unknown as BotConfig,
      price: '120',
      market: MERCADO,
      ...ctxExtra,
    }),
  );

const entrada = (r: DesiredState) => r.orders.find((o) => o.levelKind === LevelKind.BASE);
const stop = (r: DesiredState) => r.orders.find((o) => o.levelKind === LevelKind.STOP_LOSS);

describe('trendFollow.plan — sin velas no se opera', () => {
  it('sin velas no coloca nada, y lo dice', () => {
    const r = plan();
    expect(r.orders).toHaveLength(0);
    expect(r.note).toContain('Esperando velas');
  });

  it('con menos velas de las que necesita tampoco', () => {
    // Un ATR de catorce calculado sobre cinco es un numero con toda la pinta de
    // ser valido, y de ahi saldria el TAMANO de la posicion.
    const r = plan({}, { candles: serie([100, 101, 102, 103, 104]) });
    expect(r.orders).toHaveLength(0);
    expect(r.note).toContain('Esperando velas');
  });
});

describe('trendFollow.plan — la entrada', () => {
  it('entra largo cuando el cierre rompe el maximo del canal', () => {
    const r = plan({ entryEfficiency: '0' }, { candles: conRuptura(130) });
    const e = entrada(r)!;
    expect(e.side).toBe('BUY');
    expect(e.reduceOnly).toBe(false);
    expect(r.note).toContain('Ruptura al alza');
  });

  it('entra corto cuando pierde el minimo', () => {
    const r = plan({ entryEfficiency: '0' }, { candles: conRuptura(70) });
    expect(entrada(r)!.side).toBe('SELL');
  });

  it('sin ruptura no hace nada', () => {
    const r = plan({ entryEfficiency: '0' }, { candles: conRuptura(100) });
    expect(r.orders).toHaveLength(0);
    expect(r.note).toContain('Sin ruptura');
  });

  it('NO entra si el mercado va y viene, aunque haya ruptura', () => {
    // El caso que mas dinero ahorra: en un lateral casi todas las rupturas son
    // falsas, y el filtro las descarta sin mirar nada mas.
    const r = plan({ entryEfficiency: '0.5' }, { candles: conRuptura(130) });
    expect(r.orders).toHaveLength(0);
    expect(r.note).toContain('eficiencia');
  });

  it('con una rampa la eficiencia es alta y el filtro deja pasar', () => {
    const r = plan({ entryEfficiency: '0.5' }, { candles: rampa(30) });
    expect(entrada(r)).toBeDefined();
  });

  it('un bot solo largo no abre cortos', () => {
    const r = plan({ entryEfficiency: '0', direction: 'LONG' }, { candles: conRuptura(70) });
    expect(r.orders).toHaveLength(0);
    expect(r.note).toContain('solo largo');
  });

  it('un bot solo corto no abre largos', () => {
    const r = plan({ entryEfficiency: '0', direction: 'SHORT' }, { candles: conRuptura(130) });
    expect(r.orders).toHaveLength(0);
    expect(r.note).toContain('solo corto');
  });

  it('un funding extremo en contra descarta la entrada', () => {
    const r = plan(
      { entryEfficiency: '0', maxAdverseFundingBps: '5' },
      { candles: conRuptura(130), ticker: { fundingRate: '0.001' } },
    );
    expect(r.orders).toHaveLength(0);
    expect(r.note).toContain('funding');
  });
});

describe('trendFollow.plan — el tamano sale del riesgo', () => {
  const qtyCon = (extra: Record<string, unknown>, velas = conRuptura(130)) =>
    Number(entrada(plan({ entryEfficiency: '0', ...extra }, { candles: velas }))!.qty);

  it('al DOBLE de distancia de stop, la mitad de posicion', () => {
    // La invariante que define la estrategia: el riesgo en dinero es constante
    // y lo que varia es el tamano. Es lo que hace comparables dos operaciones
    // separadas por meses.
    const cerca = qtyCon({ atrStopMultiplier: '2' });
    const lejos = qtyCon({ atrStopMultiplier: '4' });
    expect(lejos / cerca).toBeCloseTo(0.5, 2);
  });

  it('un mercado mas nervioso da una posicion mas pequena', () => {
    // Mismo riesgo en dinero, mas ATR: menos moneda.
    const tranquilo = serie([...Array.from({ length: 30 }, () => 100), 130], 2);
    const nervioso = serie([...Array.from({ length: 30 }, () => 100), 130], 8);
    expect(qtyCon({}, nervioso)).toBeLessThan(qtyCon({}, tranquilo));
  });

  it('mas riesgo por operacion es mas posicion, en proporcion', () => {
    const velas = conRuptura(130);
    const uno = Number(
      entrada(plan({ entryEfficiency: '0', riskPerTradePct: '1' }, { candles: velas }))!.qty,
    );
    const dos = Number(
      entrada(plan({ entryEfficiency: '0', riskPerTradePct: '2' }, { candles: velas }))!.qty,
    );
    expect(dos / uno).toBeCloseTo(2, 1);
  });
});

describe('trendFollow.plan — el stop', () => {
  const largo = { position: makePosition('1', '100') };

  it('con posicion abierta solo hay stop, y es condicional nativo', () => {
    const r = plan({}, { ...largo, candles: rampa(30) });
    expect(entrada(r)).toBeUndefined();
    const s = stop(r)!;
    expect(s.side).toBe('SELL');
    expect(s.reduceOnly).toBe(true);
    // `triggerPrice` es lo que hace que el venue lo ejecute aunque el worker
    // este caido (invariante 6).
    expect(s.triggerPrice).toBe(s.price);
  });

  it('el stop de un corto esta POR ENCIMA del precio y compra', () => {
    // Corto entrado en 100 con el mercado en 98. El stop va por ENCIMA -a 7,5
    // de la entrada-, que es lo que cierra un corto que sale mal.
    const r = plan({}, { position: makePosition('-1', '100'), price: '98', candles: rampa(30) });
    const s = stop(r)!;
    expect(s.side).toBe('BUY');
    expect(Number(s.price)).toBeGreaterThan(98);
    expect(s.price).toBe('105.50');
  });

  it('sube con el precio', () => {
    const primero = plan({}, { ...largo, price: '120', candles: rampa(30) });
    const guardado = primero.scratchPatch!['stopPrice'] as string;
    const segundo = plan(
      {},
      {
        ...largo,
        price: '140',
        candles: rampa(30),
        cycle: { scratch: { cycleSeq: 1, stopPrice: guardado } },
      },
    );
    expect(Number(stop(segundo)!.price)).toBeGreaterThan(Number(guardado));
  });

  it('NUNCA baja, aunque el precio se desplome', () => {
    // La unica regla que hace que un stop de seguimiento sea eso y no un stop
    // que persigue al precio hacia abajo.
    const r = plan(
      {},
      {
        ...largo,
        price: '90',
        candles: rampa(30),
        cycle: { scratch: { cycleSeq: 1, stopPrice: '115.00' } },
      },
    );
    expect(stop(r)!.price).toBe('115.00');
  });

  it('no se recoloca por un movimiento pequeno', () => {
    // Un trailing que se reescribe en cada tick son dos peticiones cada quince
    // segundos contra el cupo del venue, para nada.
    const r = plan(
      { stopRepriceBps: '100' },
      {
        ...largo,
        price: '120.10',
        candles: rampa(30),
        cycle: { scratch: { cycleSeq: 1, stopPrice: '114.00' } },
      },
    );
    expect(r.scratchPatch?.['stopPrice']).toBeUndefined();
    expect(stop(r)!.price).toBe('114.00');
  });
});

describe('trendFollow.validate y preview', () => {
  const cfg = (extra: Record<string, unknown> = {}) =>
    ({ ...estrategia.defaults(), ...BASE_CONFIG, ...extra }) as unknown as BotConfig;

  it('acepta la configuracion de fabrica', () => {
    expect(estrategia.validate(cfg(), makeMarket()).ok).toBe(true);
  });

  it('avisa de un stop demasiado pegado', () => {
    const r = estrategia.validate(cfg({ atrStopMultiplier: '1.1' }), makeMarket());
    expect(r.issues.some((i) => i.field === 'atrStopMultiplier')).toBe(true);
  });

  it('avisa de que el stop loss por porcentaje no se usa aqui', () => {
    // Dejar al usuario creer que tiene dos stops es peor que decirselo.
    const r = estrategia.validate(cfg({ stopLossPct: '5' }), makeMarket());
    expect(r.issues.some((i) => i.field === 'stopLossPct')).toBe(true);
  });

  it('avisa de un riesgo por operacion alto', () => {
    const r = estrategia.validate(cfg({ riskPerTradePct: '4' }), makeMarket());
    expect(r.issues.some((i) => i.field === 'riskPerTradePct')).toBe(true);
  });

  it('la vista previa ensena la entrada y dice que el tamano es estimado', () => {
    const p = estrategia.preview(cfg(), makeMarket(), '100');
    expect(p.levels).toHaveLength(1);
    expect(p.issues.some((i) => /estimaci/i.test(i.message))).toBe(true);
  });
});

describe('trendFollow — el contrato con el motor', () => {
  it('declara las velas que necesita, y dependen de la configuracion', () => {
    const cuatroH = estrategia.candles!({ ...estrategia.defaults() } as never);
    expect(cuatroH.interval).toBe('4h');
    // Con un canal mas largo pide mas velas: el motor sirve la ventana entera.
    const largo = estrategia.candles!({
      ...estrategia.defaults(),
      breakoutPeriod: 50,
      candleInterval: '1d',
    } as never);
    expect(largo.interval).toBe('1d');
    expect(largo.bars).toBeGreaterThan(cuatroH.bars);
  });

  it('NO declara keepCycleOnFlat: cada operacion es un ciclo', () => {
    expect(estrategia.keepCycleOnFlat).toBeUndefined();
  });
});

/**
 * Lo que la revision del spec 041 encontro. Los tres son de VENTANA: ocurren
 * entre la ejecucion y el tick siguiente, que es justo lo que un test de una
 * sola llamada no produce.
 */
describe('trendFollow — lo que la revision encontro (spec 041)', () => {
  it('NO reutiliza ids de orden, y eso es deliberado', () => {
    // Con `reusesOrderSlots` el motor permite recolocar un id que YA se
    // ejecuto. Para un market maker es necesario -«ejecutada» significa que el
    // hueco quedo libre-; aqui seria una SEGUNDA entrada a mercado mientras la
    // posicion tarda en aparecer en `getPositions()`, y la senal de ruptura
    // sigue siendo cierta durante toda la vela.
    expect(estrategia.reusesOrderSlots).toBeUndefined();
  });

  it('el primer stop se ancla en la ENTRADA, no en la marca', () => {
    // La rampa tiene ATR 3 -manda el hueco al cierre anterior, no el rango de
    // la vela-, asi que con k = 1,5 la distancia es 4,5.
    //
    // Entrada en 100: el stop tiene que ir a 95,5. Si el precio cae a 94 antes
    // del primer tick y el stop se anclara en la marca, saldria en 89,5: la
    // operacion arriesgaria el DOBLE de lo declarado.
    const r = plan(
      { atrStopMultiplier: '1.5' },
      { position: makePosition('1', '100'), price: '94', candles: rampa(30) },
    );
    expect(stop(r)!.price).toBe('95.50');
  });

  it('pero si el precio se ha ido A FAVOR, el stop ya nace mas arriba', () => {
    // El seguimiento no se pierde: manda el mayor de los dos.
    const r = plan(
      { atrStopMultiplier: '1.5' },
      { position: makePosition('1', '100'), price: '106', candles: rampa(30) },
    );
    expect(stop(r)!.price).toBe('101.50');
  });

  it('en corto es el espejo: manda el menor', () => {
    const r = plan(
      { atrStopMultiplier: '1.5' },
      { position: makePosition('-1', '100'), price: '106', candles: rampa(30) },
    );
    // Corto: manda el MENOR. 100 + 4,5 = 104,5, no 106 + 4,5.
    expect(stop(r)!.price).toBe('104.50');
  });

  // Tranquila DE VERDAD: la vela que rompe entra tambien en el ATR, asi que un
  // salto de 30 lo domina entero y el mercado deja de ser tranquilo. Aqui la
  // ruptura es de medio punto, y el ATR sale ~0,055.
  const muyTranquila = () => serie([...Array.from({ length: 30 }, () => 100), 100.5], 0.02);

  it('el tamano no supera el capital por el apalancamiento', () => {
    // El tamano sale de dividir el riesgo por la distancia al stop. Con un ATR
    // minusculo esa division se dispara, y sin tope el nocional pide mas margen
    // del que hay.
    const r = plan(
      { entryEfficiency: '0', leverage: 2, atrStopMultiplier: '1' },
      { candles: muyTranquila(), price: '100.5' },
    );
    // Capital 1000 x 2 = 2000 de nocional maximo.
    expect(Number(entrada(r)!.qty) * 100.5).toBeLessThanOrEqual(2000.001);
    expect(r.note).toContain('recortado');
  });

  it('con tope de exposicion manda el tope', () => {
    const r = plan(
      { entryEfficiency: '0', leverage: 2, atrStopMultiplier: '1', maxNotionalCap: '300' },
      { candles: muyTranquila(), price: '100.5' },
    );
    expect(Number(entrada(r)!.qty) * 100.5).toBeLessThanOrEqual(300.001);
  });

  it('en un mercado normal el tope no muerde y no se dice nada', () => {
    const r = plan({ entryEfficiency: '0' }, { candles: conRuptura(130) });
    expect(r.note).not.toContain('recortado');
  });
});
