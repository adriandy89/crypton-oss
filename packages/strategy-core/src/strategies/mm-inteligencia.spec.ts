import { D, LevelKind, StrategyKind, type BotConfig, type Ticker } from '@crypton/shared';
import { getStrategy } from '../registry';
import { BASE_CONFIG, makeContext, makePosition } from '../testing';
import {
  centroSesgado,
  deriva,
  desequilibrio,
  factorDeTamano,
  fundingBps,
  microprecio,
  penalizacionMarkout,
  anotarFill,
  resolverMarkout,
  sampleVolatility,
  type VolSample,
} from './mm-shared';

/**
 * Las piezas que el spec 039 le da a los market makers, en aislamiento.
 *
 * Van aparte de `strategies.spec.ts` porque son funciones PURAS y se prueban
 * con numeros, no con planes: aqui se fija la aritmetica, y en el fichero de
 * estrategias se comprueba que el cableado la usa donde debe.
 */

const ticker = (extra: Partial<Ticker> = {}): Ticker => ({
  venue: 'HYPERLIQUID',
  symbol: 'BTC',
  last: '100',
  bid: '99.9',
  ask: '100.1',
  mark: '100',
  ts: 0,
  ...extra,
});

describe('microprecio', () => {
  it('con mas cantidad en el bid queda POR ENCIMA del punto medio', () => {
    // Mas gente esperando para comprar empuja el precio justo hacia el ask.
    const t = ticker({ bidSize: '30', askSize: '10' });
    expect(Number(microprecio(t))).toBeGreaterThan(100);
    // (100,1 x 30 + 99,9 x 10) / 40 = 100,05
    expect(microprecio(t).toFixed(4)).toBe('100.0500');
  });

  it('con mas cantidad en el ask queda por debajo', () => {
    expect(Number(microprecio(ticker({ bidSize: '10', askSize: '30' })))).toBeLessThan(100);
  });

  it('con tamanos iguales es exactamente el punto medio', () => {
    expect(microprecio(ticker({ bidSize: '5', askSize: '5' })).toFixed(4)).toBe('100.0000');
  });

  it('SIN tamanos cae al punto medio, no inventa nada', () => {
    // Es el caso de Lighter, y el de cualquier venue que deje de mandarlos.
    expect(microprecio(ticker()).toFixed(4)).toBe('100.0000');
    expect(microprecio(ticker({ bidSize: '10' })).toFixed(4)).toBe('100.0000');
  });

  it('con tamanos a cero por los dos lados cae al punto medio', () => {
    // Dividir por cero daria NaN y NaN entra en un precio sin quejarse.
    expect(microprecio(ticker({ bidSize: '0', askSize: '0' })).toFixed(4)).toBe('100.0000');
  });

  it('sin libro cae al precio de marca, como bookMid', () => {
    const t = ticker({ bid: '0', ask: '0', mark: '77', bidSize: '1', askSize: '1' });
    expect(microprecio(t).toFixed()).toBe('77');
  });
});

describe('desequilibrio', () => {
  it('vale +1 con el ask vacio y -1 con el bid vacio', () => {
    expect(desequilibrio(ticker({ bidSize: '10', askSize: '0' }))!.toFixed()).toBe('1');
    expect(desequilibrio(ticker({ bidSize: '0', askSize: '10' }))!.toFixed()).toBe('-1');
  });

  it('vale 0 con tamanos iguales', () => {
    expect(desequilibrio(ticker({ bidSize: '7', askSize: '7' }))!.toFixed()).toBe('0');
  });

  it('es null sin tamanos, que NO es lo mismo que cero', () => {
    // Cero se leeria como «equilibrado» y aplicaria un sesgo de cero; null deja
    // que quien lo use decida no aplicar nada.
    expect(desequilibrio(ticker())).toBeNull();
  });
});

describe('centroSesgado', () => {
  it('con inventario largo baja el centro', () => {
    // ratio 0,5 · factor 1 · 20 bps -> 10 bps por debajo de 100.
    expect(centroSesgado(D(100), D(0.5), 1, D(20)).toFixed(4)).toBe('99.9000');
  });

  it('con inventario corto lo sube', () => {
    expect(centroSesgado(D(100), D(-0.5), 1, D(20)).toFixed(4)).toBe('100.1000');
  });

  it('con factor 0 no lo mueve', () => {
    expect(centroSesgado(D(100), D(1), 0, D(20)).toFixed(4)).toBe('100.0000');
  });
});

describe('fundingBps', () => {
  it('pasa la fraccion a bps conservando el signo', () => {
    expect(fundingBps(ticker({ fundingRate: '0.0001' }))!.toFixed()).toBe('1');
    expect(fundingBps(ticker({ fundingRate: '-0.00025' }))!.toFixed()).toBe('-2.5');
  });

  it('es null cuando el venue no lo publica', () => {
    expect(fundingBps(ticker())).toBeNull();
  });
});

describe('factorDeTamano', () => {
  it('achica el lado que anade y agranda el que reduce', () => {
    expect(factorDeTamano('adding', D(0.5), 0.5).toFixed(4)).toBe('0.7500');
    expect(factorDeTamano('reducing', D(0.5), 0.5).toFixed(4)).toBe('1.2500');
  });

  it('usa el VALOR ABSOLUTO del ratio: es simetrico en corto', () => {
    expect(factorDeTamano('adding', D(-0.5), 0.5).toFixed(4)).toBe('0.7500');
  });

  it('nunca baja de cero', () => {
    // Con el tope lleno y el factor al maximo, el lado que anade desaparece,
    // que es lo mismo que ya hace el modo de alto riesgo.
    expect(factorDeTamano('adding', D(1), 1).toFixed()).toBe('0');
    expect(factorDeTamano('adding', D(1), 3).toFixed()).toBe('0');
  });

  it('con factor 0 no cambia nada', () => {
    expect(factorDeTamano('adding', D(1), 0).toFixed()).toBe('1');
    expect(factorDeTamano('reducing', D(1), 0).toFixed()).toBe('1');
  });
});

describe('markout', () => {
  const fill = (price: string, side: 'BUY' | 'SELL') => ({ price, side });

  it('apagado no escribe NADA', () => {
    expect(anotarFill({}, fill('100', 'BUY'), 1000, 0)).toBeNull();
    expect(anotarFill({}, fill('100', 'BUY'), 1000, null)).toBeNull();
    expect(resolverMarkout({}, D(100), 1000, 0).patch).toBeNull();
  });

  it('una compra que el mercado deja atras da markout NEGATIVO', () => {
    // Te compraron a 100 y el mercado se fue a 99: te eligieron.
    const scratch: Record<string, unknown> = { mkPend: anotarFill({}, fill('100', 'BUY'), 0, 30) };
    const r = resolverMarkout(scratch, D(99), 30_000, 30);

    expect(Number(r.bidBps)).toBeLessThan(0);
    expect(r.askBps.toFixed()).toBe('0');
    expect(r.muestras).toBe(1);
  });

  it('una compra que el mercado sube da markout POSITIVO', () => {
    const scratch: Record<string, unknown> = { mkPend: anotarFill({}, fill('100', 'BUY'), 0, 30) };
    expect(Number(resolverMarkout(scratch, D(101), 30_000, 30).bidBps)).toBeGreaterThan(0);
  });

  it('una venta es el espejo', () => {
    const scratch: Record<string, unknown> = { mkPend: anotarFill({}, fill('100', 'SELL'), 0, 30) };
    // Te vendieron a 100 y el mercado se fue a 101: te eligieron.
    expect(Number(resolverMarkout(scratch, D(101), 30_000, 30).askBps)).toBeLessThan(0);
  });

  it('un fill cuyo horizonte NO ha vencido no se toca', () => {
    const scratch: Record<string, unknown> = { mkPend: anotarFill({}, fill('100', 'BUY'), 0, 30) };
    const r = resolverMarkout(scratch, D(99), 10_000, 30);
    expect(r.patch).toBeNull();
    expect(r.muestras).toBe(0);
  });

  it('un fill resuelto sale de la lista de pendientes', () => {
    const scratch: Record<string, unknown> = { mkPend: anotarFill({}, fill('100', 'BUY'), 0, 30) };
    const r = resolverMarkout(scratch, D(99), 30_000, 30);
    expect(r.patch!['mkPend']).toEqual([]);
  });

  it('un fill DEMASIADO viejo no entra en la media, y desaparece', () => {
    // Si el bot ha estado sin planificar -fuente externa caida, pausado, worker
    // relevado-, un fill de hace diez minutos resuelto contra el mid de ahora
    // entraria en la media como si fuera un markout de treinta segundos.
    const scratch: Record<string, unknown> = { mkPend: anotarFill({}, fill('100', 'BUY'), 0, 30) };
    const r = resolverMarkout(scratch, D(50), 10 * 60_000, 30);

    expect(r.bidBps.toFixed()).toBe('0'); // la media no se mueve
    expect(r.muestras).toBe(0);
    expect(r.patch!['mkPend']).toEqual([]); // pero el pendiente se limpia
  });

  it('justo en el limite de tres horizontes todavia cuenta', () => {
    const scratch: Record<string, unknown> = { mkPend: anotarFill({}, fill('100', 'BUY'), 0, 30) };
    const r = resolverMarkout(scratch, D(99), 90_000, 30);
    expect(Number(r.bidBps)).toBeLessThan(0);
    expect(r.muestras).toBe(1);
  });

  it('el anillo de pendientes tiene tope', () => {
    let pend: unknown = [];
    for (let i = 0; i < 100; i++) {
      pend = anotarFill({ mkPend: pend }, fill('100', 'BUY'), i, 30);
    }
    expect((pend as unknown[]).length).toBe(60);
  });

  it('la penalizacion tiene suelo en cero: un markout bueno no acerca', () => {
    expect(penalizacionMarkout(D(-4), 1).toFixed()).toBe('4');
    expect(penalizacionMarkout(D(-4), 0.5).toFixed()).toBe('2');
    // Perseguir al mercado cuando te va bien es el otro modo de perder dinero.
    expect(penalizacionMarkout(D(10), 1).toFixed()).toBe('0');
  });
});

describe('deriva y eficiencia de Kaufman', () => {
  const serie = (precios: number[]): VolSample[] =>
    precios.map((p, i) => [i * 1000, String(p)] as VolSample);

  it('una rampa monotona tiene eficiencia 1', () => {
    const r = deriva(serie([100, 101, 102, 103]))!;
    expect(r.eficiencia.toFixed(2)).toBe('1.00');
    expect(r.bps.toFixed(0)).toBe('300');
  });

  it('una rampa a la BAJA tiene eficiencia 1 y deriva negativa', () => {
    const r = deriva(serie([100, 99, 98]))!;
    expect(r.eficiencia.toFixed(2)).toBe('1.00');
    expect(Number(r.bps)).toBeLessThan(0);
  });

  it('ir y venir sin avanzar tiene eficiencia 0', () => {
    // El terreno del market maker: mucho recorrido y ningun avance.
    const r = deriva(serie([100, 102, 100, 102, 100]))!;
    expect(r.eficiencia.toFixed(2)).toBe('0.00');
    expect(r.bps.toFixed(0)).toBe('0');
  });

  it('un zigzag con tendencia queda en medio', () => {
    const r = deriva(serie([100, 102, 101, 103, 102, 104]))!;
    expect(Number(r.eficiencia)).toBeGreaterThan(0.2);
    expect(Number(r.eficiencia)).toBeLessThan(0.8);
  });

  it('con menos de tres muestras no se pronuncia', () => {
    expect(deriva(serie([100, 101]))).toBeNull();
    expect(deriva(undefined)).toBeNull();
  });
});

describe('estimador de volatilidad', () => {
  /** Mismo recorrido, distinto numero de muestras dentro de la ventana. */
  const anillo = (n: number): VolSample[] =>
    Array.from({ length: n }, (_, i) => [i * 100, String(100 + (i % 2 ? 2 : 0))] as VolSample);

  it('PARKINSON normaliza el recorrido por el numero de muestras', () => {
    // Lo que este test ensena y lo que NO. La serie es sintetica y tiene el
    // MISMO recorrido con 10 y con 100 muestras, asi que `RANGE` da lo mismo en
    // las dos: aqui no hay sesgo de muestreo que quitar.
    const pocas = sampleVolatility({ volSamples: anillo(10) }, 1000, D(100), 300, false);
    const muchas = sampleVolatility({ volSamples: anillo(100) }, 1000, D(100), 300, false);
    expect(pocas.volBps.toFixed(0)).toBe(muchas.volBps.toFixed(0));

    // Lo que se comprueba es la division por `sqrt(2 ln n)`. El sesgo que eso
    // corrige -el recorrido de un paseo aleatorio crece justo asi con n- no se
    // puede demostrar con una serie determinista sin convertir el test en un
    // argumento probabilistico, que es lo que este fichero evita a proposito.
    const pP = sampleVolatility({ volSamples: anillo(10) }, 1000, D(100), 300, false, 'PARKINSON');
    const mP = sampleVolatility({ volSamples: anillo(100) }, 1000, D(100), 300, false, 'PARKINSON');
    expect(Number(pP.volBps)).toBeCloseTo(Number(pocas.volBps) / Math.sqrt(2 * Math.log(10)), 6);
    expect(Number(mP.volBps)).toBeCloseTo(Number(muchas.volBps) / Math.sqrt(2 * Math.log(100)), 6);
    expect(Number(mP.volBps)).toBeLessThan(Number(pP.volBps));
  });

  it('con menos de tres muestras no normaliza: no habria n del que fiarse', () => {
    const dos = { volSamples: anillo(2) };
    const r = sampleVolatility(dos, 1000, D(100), 300, false);
    const p = sampleVolatility(dos, 1000, D(100), 300, false, 'PARKINSON');
    expect(p.volBps.toFixed(6)).toBe(r.volBps.toFixed(6));
  });

  it('de fabrica el estimador es RANGE: nada cambia sin pedirlo', () => {
    const porDefecto = sampleVolatility({ volSamples: anillo(20) }, 1000, D(100), 300, false);
    const explicito = sampleVolatility(
      { volSamples: anillo(20) },
      1000,
      D(100),
      300,
      false,
      'RANGE',
    );
    expect(porDefecto.volBps.toFixed(6)).toBe(explicito.volBps.toFixed(6));
  });
});

/**
 * Los mandos, ya cableados: que ENCENDIDOS hagan lo que prometen, y que
 * apagados -que es de fabrica- no muevan una sola orden.
 */
describe('los mandos de microestructura en plan()', () => {
  const MERCADO = { tickSize: '0.01', priceDecimals: 2, stepSize: '0.001', qtyDecimals: 3 };

  const planV2 = (extra: Record<string, unknown>, ctxExtra: Record<string, unknown> = {}) =>
    getStrategy(StrategyKind.MARKET_MAKER_V2).plan(
      makeContext({
        strategy: StrategyKind.MARKET_MAKER_V2,
        config: {
          ...getStrategy(StrategyKind.MARKET_MAKER_V2).defaults(),
          ...BASE_CONFIG,
          direction: 'NEUTRAL',
          orderSizePerSide: '100',
          maxBotPositionValue: '1000',
          buyDistanceBps: '20',
          sellDistanceBps: '20',
          layers: 1,
          dynamicSpread: false,
          feeEstimateBps: '0',
          minProfitMarginBps: '0',
          leverage: 1,
          ...extra,
        } as unknown as BotConfig,
        price: '100',
        market: MERCADO,
        ...ctxExtra,
      }),
    );

  const bid = (r: { orders: { levelKind: string; price: string; qty: string }[] }) =>
    r.orders.find((o) => o.levelKind === LevelKind.QUOTE_BID);
  const ask = (r: { orders: { levelKind: string; price: string; qty: string }[] }) =>
    r.orders.find((o) => o.levelKind === LevelKind.QUOTE_ASK);

  /** Libro con mas cantidad esperando para comprar. */
  const cargadoAlBid = { ticker: { bidSize: '30', askSize: '10' } };

  it('de fabrica no mira nada de esto: los tamanos del libro no mueven la cotizacion', () => {
    const sinDatos = planV2({});
    const conDatos = planV2({}, cargadoAlBid);
    expect(bid(conDatos)!.price).toBe(bid(sinDatos)!.price);
    expect(ask(conDatos)!.price).toBe(ask(sinDatos)!.price);
  });

  it('con fairPriceMode MICRO el centro sube cuando el bid esta cargado', () => {
    const mid = planV2({});
    const micro = planV2({ fairPriceMode: 'MICRO' }, cargadoAlBid);
    expect(Number(bid(micro)!.price)).toBeGreaterThan(Number(bid(mid)!.price));
    expect(Number(ask(micro)!.price)).toBeGreaterThan(Number(ask(mid)!.price));
  });

  it('MICRO sin tamanos -Lighter- cotiza exactamente igual que MID', () => {
    expect(bid(planV2({ fairPriceMode: 'MICRO' }))!.price).toBe(bid(planV2({}))!.price);
  });

  it('el sesgo por desequilibrio sube las dos cotizaciones con el bid cargado', () => {
    const sin = planV2({}, cargadoAlBid);
    const con = planV2({ obiSkewFactor: '1' }, cargadoAlBid);
    expect(Number(bid(con)!.price)).toBeGreaterThan(Number(bid(sin)!.price));
    expect(Number(ask(con)!.price)).toBeGreaterThan(Number(ask(sin)!.price));
  });

  it('con el libro equilibrado el sesgo por desequilibrio no mueve nada', () => {
    const equilibrado = { ticker: { bidSize: '10', askSize: '10' } };
    expect(bid(planV2({ obiSkewFactor: '2' }, equilibrado))!.price).toBe(
      bid(planV2({}, equilibrado))!.price,
    );
  });

  it('la V2 ya tiene sesgo de inventario: con posicion larga la venta se acerca', () => {
    const largo = { position: makePosition('5', '100') }; // 500 = 50 % del tope
    const sin = planV2({}, largo);
    const con = planV2({ inventoryPriceAdjustment: true, inventorySkewFactor: '1' }, largo);
    expect(Number(ask(con)!.price)).toBeLessThan(Number(ask(sin)!.price));
    expect(Number(bid(con)!.price)).toBeLessThan(Number(bid(sin)!.price));
  });

  it('el sesgo de TAMANO achica el lado que anade y agranda el que reduce', () => {
    const largo = { position: makePosition('5', '100') }; // ratio 0,5
    const sin = planV2({}, largo);
    const con = planV2({ sizeSkewFactor: '0.5' }, largo);
    // Largo: la compra anade (x0,75) y la venta reduce (x1,25).
    expect(Number(bid(con)!.qty)).toBeLessThan(Number(bid(sin)!.qty));
    expect(Number(ask(con)!.qty)).toBeGreaterThan(Number(ask(sin)!.qty));
  });

  it('con funding positivo las dos cotizaciones BAJAN', () => {
    // f > 0 son los largos pagando: el bot se inclina hacia el lado que cobra.
    const conFunding = { ticker: { fundingRate: '0.001' } };
    const sin = planV2({}, conFunding);
    const con = planV2({ fundingSkewFactor: '1' }, conFunding);
    expect(Number(bid(con)!.price)).toBeLessThan(Number(bid(sin)!.price));
    expect(Number(ask(con)!.price)).toBeLessThan(Number(ask(sin)!.price));
  });

  it('con funding negativo suben, y sin funding no se mueve nada', () => {
    const negativo = { ticker: { fundingRate: '-0.001' } };
    expect(Number(ask(planV2({ fundingSkewFactor: '1' }, negativo))!.price)).toBeGreaterThan(
      Number(ask(planV2({}, negativo))!.price),
    );
    // Lighter no publica funding: el mando no hace nada, no revienta.
    expect(bid(planV2({ fundingSkewFactor: '3' }))!.price).toBe(bid(planV2({}))!.price);
  });

  it('un funding extremo corta el lado que se pondria del lado que paga', () => {
    // 0,001 = 10 bps. Con el tope en 5, comprar seria ponerse a pagar.
    const r = planV2({ maxAdverseFundingBps: '5' }, { ticker: { fundingRate: '0.001' } });
    expect(bid(r)).toBeUndefined();
    expect(ask(r)).toBeDefined();
  });

  it('pero el lado que REDUCE sigue vivo aunque el funding sea extremo', () => {
    // Corto: la compra reduce, asi que no se corta nunca.
    const r = planV2(
      { maxAdverseFundingBps: '5' },
      { ticker: { fundingRate: '0.001' }, position: makePosition('-5', '100') },
    );
    expect(bid(r)).toBeDefined();
  });

  it('el markout aleja el lado por el que le estan eligiendo', () => {
    const t0 = 1_000_000;
    const cfgMk = { markoutHorizonSeconds: 30, markoutSensitivity: '2' };
    // Una compra ejecutada a 100 y el mercado, 40 s despues, en 99.
    const scratch = {
      cycleSeq: 1,
      mkPend: [[t0, '100', 'BUY']],
      quotedMid: '99',
      quotedAt: t0,
    };
    const con = planV2(cfgMk, { now: t0 + 40_000, price: '99', cycle: { scratch } });
    const sin = planV2({}, { now: t0 + 40_000, price: '99', cycle: { scratch } });

    // La compra se aleja; la venta no se toca.
    expect(Number(bid(con)!.price)).toBeLessThan(Number(bid(sin)!.price));
    expect(ask(con)!.price).toBe(ask(sin)!.price);
    expect(con.note).toContain('markout');
  });

  it('el filtro de tendencia deja de anadir contra una rampa', () => {
    // Rampa monotona a la BAJA, eficiencia 1. Quien pelea contra la tendencia
    // es la COMPRA -coger un cuchillo que cae-, asi que es la que se corta; la
    // venta va con la tendencia y sigue viva.
    const bajando = Array.from({ length: 10 }, (_, i) => [i * 1000, String(100 - i)]);
    const r = planV2(
      { trendGuardEfficiency: '0.8' },
      { cycle: { scratch: { cycleSeq: 1, volSamples: bajando } } },
    );
    expect(bid(r)).toBeUndefined();
    expect(ask(r)).toBeDefined();
    expect(r.note).toContain('tendencia');
  });

  it('con una onda -ir y venir- el filtro de tendencia no corta nada', () => {
    // Es el terreno del market maker: eficiencia ~0.
    const onda = Array.from({ length: 10 }, (_, i) => [i * 1000, String(100 + (i % 2 ? 2 : 0))]);
    const r = planV2(
      { trendGuardEfficiency: '0.8' },
      { cycle: { scratch: { cycleSeq: 1, volSamples: onda } } },
    );
    expect(bid(r)).toBeDefined();
    expect(ask(r)).toBeDefined();
  });

  it('onFill no escribe nada con el markout apagado', () => {
    const estrategia = getStrategy(StrategyKind.MARKET_MAKER_V2);
    const ctx = makeContext({
      strategy: StrategyKind.MARKET_MAKER_V2,
      config: { ...estrategia.defaults(), ...BASE_CONFIG },
    });
    const ciclo = ctx.cycle;
    const fill = { price: '100', side: 'BUY' as const, qty: '1' };
    expect(estrategia.onFill!(ctx, fill as never, ciclo)).toBe(ciclo);
  });

  it('onFill anota la ejecucion con el markout encendido', () => {
    const estrategia = getStrategy(StrategyKind.MARKET_MAKER_V2);
    const ctx = makeContext({
      strategy: StrategyKind.MARKET_MAKER_V2,
      config: {
        ...estrategia.defaults(),
        ...BASE_CONFIG,
        markoutHorizonSeconds: 30,
      },
    });
    const fill = { price: '100', side: 'BUY' as const, qty: '1' };
    const nuevo = estrategia.onFill!(ctx, fill as never, ctx.cycle);
    expect(nuevo.scratch['mkPend']).toHaveLength(1);
  });
});
