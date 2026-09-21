import { StrategyKind } from '@crypton/shared';
import { getStrategy } from '../registry';
import { BASE_CONFIG, makeContext, makeMarket, makePosition } from '../testing';

/**
 * El aviso del sesgo por inventario del Market Maker V2 (spec 071).
 *
 * ── El defecto que lo motiva ──
 *
 * Ninguno de los dos market makers lee `entryPrice` de la posición. Las dos
 * cotizaciones —la que añade y la que reduce— salen del precio de mercado, así
 * que en cuanto el precio se va, la salida se planta POR DEBAJO del coste medio
 * y realiza una pérdida que la estrategia nunca quiso hacer. El beneficio está
 * acotado por el diferencial; la pérdida, no.
 *
 * Medido con el motor real sobre ocho pares y veinte días de velas de 5 min,
 * con los valores de fábrica:
 *
 *   cierres por ENCIMA del coste medio  52 %   media +0,455
 *   cierres por DEBAJO del coste medio  48 %   media −0,777   ← 1,71 veces más
 *   comisiones pagadas                  63 de una pérdida de 520
 *
 * O sea que no se pierde por lo que se paga, sino por dónde se pone la salida.
 * El sesgo por inventario es el único mando que pelea eso: desplaza el centro
 * en contra del inventario, así que la salida se acerca y la entrada se aleja.
 * Encendiéndolo en 1, la pérdida realizada baja un 44 %; con el de tamaño
 * también, un 54 %.
 *
 * ── Por qué un aviso y no un valor de fábrica distinto ──
 *
 * La V1 lo trae encendido desde siempre y la V2 no. Cambiar el de la V2 movería
 * dónde cotiza cada bot V2 que ya está en marcha, y eso no se hace sin decisión
 * de su dueño. Lo que sí se puede es dejar de callarlo.
 */

const mmv2 = getStrategy(StrategyKind.MARKET_MAKER_V2);

const MERCADO = makeMarket({
  tickSize: '0.01',
  priceDecimals: 2,
  stepSize: '0.001',
  qtyDecimals: 3,
});

const configCon = (extra: Record<string, unknown>) =>
  ({
    ...mmv2.defaults(),
    ...BASE_CONFIG,
    direction: 'NEUTRAL',
    orderSizePerSide: '100',
    maxBotPositionValue: '1000',
    ...extra,
  }) as never;

const avisoDeSesgo = (extra: Record<string, unknown>) =>
  mmv2
    .validate(configCon(extra), MERCADO)
    .issues.find((i) => i.field === 'inventoryPriceAdjustment');

describe('MM V2: el aviso de la salida sin sesgo (spec 071)', () => {
  it('de fábrica NO avisa, porque el sesgo ya viene encendido', () => {
    const d = mmv2.defaults();
    expect(d['inventoryPriceAdjustment']).toBe(true);
    expect(String(d['inventorySkewFactor'])).toBe('1');
    expect(avisoDeSesgo({})).toBeUndefined();
  });

  /** Y la ayuda tiene que decir lo mismo que siembra el formulario. */
  it.each([
    ['inventoryPriceAdjustment', true],
    ['inventorySkewFactor', 1],
  ])('`meta.default` de %s dice %s', (key, esperado) => {
    expect(mmv2.meta.fields.find((f) => f.key === key)?.default).toBe(esperado);
  });

  it('apagándolo a mano, avisa', () => {
    const aviso = avisoDeSesgo({ inventoryPriceAdjustment: false });
    expect(aviso).toBeDefined();
    expect(aviso?.severity).toBe('WARNING');
    expect(aviso?.message).toContain('POR DEBAJO');
  });

  /**
   * Avisar no puede impedir crear el bot: es una recomendación sobre un mando
   * opcional, no un error de configuración.
   */
  it('avisar no invalida la configuración', () => {
    const v = mmv2.validate(configCon({ inventoryPriceAdjustment: false }), MERCADO);
    expect(v.issues.some((i) => i.severity === 'ERROR')).toBe(false);
    expect(v.ok).toBe(true);
  });

  /**
   * Las dos formas de tenerlo apagado. El interruptor en true con el factor en
   * cero no hace absolutamente nada —`centroSesgado` multiplica por él—, así
   * que un aviso que solo mirara el interruptor se callaría justo cuando más
   * falta hace.
   */
  it.each([
    ['el interruptor apagado', { inventoryPriceAdjustment: false, inventorySkewFactor: '2' }],
    ['el factor en cero', { inventoryPriceAdjustment: true, inventorySkewFactor: '0' }],
  ])('avisa con %s', (_, extra) => {
    expect(avisoDeSesgo(extra)).toBeDefined();
  });
});

/**
 * Y la conducta que el aviso describe, comprobada: con inventario largo el
 * sesgo BAJA las dos cotizaciones, así que la venta queda más cerca y la compra
 * más lejos. Sin él, las dos se quedan donde estaban mire donde mire el
 * inventario, que es exactamente el defecto.
 */
describe('MM V2: qué cambia el sesgo cuando está encendido', () => {
  const planCon = (extra: Record<string, unknown>) =>
    mmv2.plan(
      makeContext({
        strategy: StrategyKind.MARKET_MAKER_V2,
        config: configCon({
          layers: 1,
          dynamicSpread: false,
          feeEstimateBps: '0',
          minProfitMarginBps: '0',
          leverage: 1,
          ...extra,
        }),
        market: { tickSize: '0.01', priceDecimals: 2, stepSize: '0.001', qtyDecimals: 3 },
        // Largo a la mitad del tope: el inventario que el sesgo tiene que ver.
        position: makePosition('5', '100'),
        price: '100',
      }),
    );

  const precio = (plan: ReturnType<typeof planCon>, side: 'BUY' | 'SELL') =>
    Number(plan.orders.find((o) => o.side === side)?.price ?? 0);

  it('con inventario largo acerca la venta y aleja la compra', () => {
    const sin = planCon({ inventoryPriceAdjustment: false });
    const con = planCon({ inventoryPriceAdjustment: true, inventorySkewFactor: '1' });

    expect(precio(sin, 'SELL')).toBeGreaterThan(0);
    expect(precio(con, 'SELL')).toBeGreaterThan(0);
    // La salida (la venta, estando largo) se acerca...
    expect(precio(con, 'SELL')).toBeLessThan(precio(sin, 'SELL'));
    // ...y la que añadiría más inventario se aleja.
    expect(precio(con, 'BUY')).toBeLessThan(precio(sin, 'BUY'));
  });

  it('sin sesgo, el inventario no mueve ni una de las dos', () => {
    const plano = mmv2.plan(
      makeContext({
        strategy: StrategyKind.MARKET_MAKER_V2,
        config: configCon({
          layers: 1,
          dynamicSpread: false,
          feeEstimateBps: '0',
          minProfitMarginBps: '0',
          leverage: 1,
          inventoryPriceAdjustment: false,
        }),
        market: { tickSize: '0.01', priceDecimals: 2, stepSize: '0.001', qtyDecimals: 3 },
        price: '100',
      }),
    );
    const largo = planCon({ inventoryPriceAdjustment: false });
    expect(precio(largo, 'SELL')).toBe(precio(plano, 'SELL'));
    expect(precio(largo, 'BUY')).toBe(precio(plano, 'BUY'));
  });
});
