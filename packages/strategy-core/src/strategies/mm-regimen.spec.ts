import { StrategyKind } from '@crypton/shared';
import type { Candle } from '@crypton/shared';
import { getStrategy } from '../registry';
import { BASE_CONFIG, makeContext } from '../testing';

/**
 * La puerta de régimen del Market Maker V2 (spec 071).
 *
 * ── Por qué existe ──
 *
 * La V2 ya traía un filtro de tendencia, pero mide la eficiencia de Kaufman
 * sobre un anillo de muestras de SEGUNDOS, y el inventario de un market maker
 * se envenena a lo largo de HORAS: está mirando la escala de tiempo equivocada.
 * Medido sobre 26 pares y 400 días, ese filtro discrimina +0,015 pp — dentro
 * del ruido— mientras que el clasificador de régimen sobre velas de 1 h y 15 min
 * discrimina +0,156 pp con el mismo tiempo activo.
 *
 * ── Lo que estos tests protegen ──
 *
 * 1. Que APAGADO no cambie absolutamente nada, ni siquiera pedir velas. Un
 *    market maker corre en muchos bots a la vez y cada sondeo cuenta contra el
 *    cupo del venue: es el incidente de TICK_SLOW del spec 065.
 * 2. Que nunca PARE el bot, solo deje de añadir por un lado. El lado que reduce
 *    tiene que seguir vivo o el inventario se queda sin salida.
 * 3. Que sin velas se deje pasar, en vez de inventarse un régimen.
 */

const mmv2 = getStrategy(StrategyKind.MARKET_MAKER_V2);

describe('MM V2: la puerta de régimen', () => {
  it('viene ENCENDIDA en «evita tendencia»', () => {
    const d = mmv2.defaults();
    expect(d['regimeGuard']).toBe('EVITA_TENDENCIA');
    // Y el mando al que sustituye ya no existe: medía la eficiencia de Kaufman
    // sobre segundos, que es la escala equivocada, y se quitó en el spec 071.
    expect(d).not.toHaveProperty('trendGuardEfficiency');
    expect(mmv2.meta.fields.some((f) => f.key === 'trendGuardEfficiency')).toBe(false);
  });

  /**
   * Y el que lee la ayuda tiene que ver lo mismo que siembra el formulario: son
   * dos números distintos y en desacuerdo mentían (spec 037 R-5).
   */
  it('`meta.default` dice lo mismo que `defaults()`', () => {
    const campo = mmv2.meta.fields.find((f) => f.key === 'regimeGuard');
    expect(campo?.default).toBe(mmv2.defaults()['regimeGuard']);
  });

  /**
   * Lo más importante de todo: apagada a mano, la estrategia NO pide ni una
   * vela. Pedirlas «por si acaso» multiplicaría los sondeos al venue por el
   * número de bots de market maker, que suelen ser muchos.
   */
  it('apagada a mano no pide ni una vela', () => {
    expect(mmv2.series!({ regimeGuard: 'OFF' } as never)).toEqual([]);
    // Y sin el campo tampoco: una configuración vieja no empieza a pedir velas
    // sola al actualizar.
    expect(mmv2.series!({} as never)).toEqual([]);
  });

  it.each(['EVITA_TENDENCIA', 'SOLO_RANGO'])('encendida en %s pide 15m y 1h', (regimeGuard) => {
    const series = mmv2.series!({ regimeGuard } as never);
    expect(series.map((s) => s.interval).sort()).toEqual(['15m', '1h']);
    for (const s of series) expect(s.bars).toBeGreaterThan(100);
  });

  /**
   * COLD porque decide qué series pide el motor, y eso se resuelve al arrancar.
   * En caliente dejaría al runner pidiendo unas velas y mirando otras.
   */
  it('es COLD: no se cambia con el bot en marcha', () => {
    const campo = mmv2.meta.fields.find((f) => f.key === 'regimeGuard');
    expect(campo?.mutability).toBe('COLD');
    expect(campo?.options).toEqual(['OFF', 'EVITA_TENDENCIA', 'SOLO_RANGO']);
  });
});

describe('MM V2: qué hace la puerta cuando actúa', () => {
  const T0 = Date.UTC(2026, 8, 1);

  const HORA = 3_600_000;
  const QUINCE = 900_000;
  /** Las dos series terminan a la MISMA hora: el clasificador empareja cada vela
   * de 15 min con la de 1 h que ya habia cerrado, y necesita 100 horas detras.
   * Con las dos empezando en T0, la de 15 min solo cubria 65 h y no habia ni una
   * evaluacion que hacer. */
  const FIN = T0 + 200 * HORA;

  /** Velas que suben en línea recta: tendencia alcista de manual. */
  const subiendo = (n: number, paso: number): Candle[] =>
    Array.from({ length: n }, (_, i) => {
      const p = 100 * (1 + i * 0.002);
      return {
        t: FIN - (n - 1 - i) * paso,
        o: String(p),
        h: String(p * 1.001),
        l: String(p * 0.999),
        c: String(p),
        v: '100',
      };
    });

  const planCon = (regimeGuard: string, series?: Record<string, Candle[]>) =>
    mmv2.plan(
      makeContext({
        strategy: StrategyKind.MARKET_MAKER_V2,
        config: {
          ...mmv2.defaults(),
          ...BASE_CONFIG,
          direction: 'NEUTRAL',
          orderSizePerSide: '100',
          maxBotPositionValue: '1000',
          layers: 1,
          dynamicSpread: false,
          feeEstimateBps: '0',
          minProfitMarginBps: '0',
          leverage: 1,
          regimeGuard,
        } as never,
        market: { tickSize: '0.01', priceDecimals: 2, stepSize: '0.001', qtyDecimals: 3 },
        ...(series ? { series: series } : {}),
      }),
    );

  /** Sin velas NO se inventa un régimen: el bot sigue cotizando. */
  it('encendida pero sin velas, no bloquea nada', () => {
    expect(planCon('EVITA_TENDENCIA').orders.length).toBe(planCon('OFF').orders.length);
  });

  /**
   * En tendencia alcista el market maker acumula CORTO —vende cada vez que el
   * precio sube y nunca recompra—, así que lo que se bloquea es la venta.
   * Nunca se para el bot: las compras siguen.
   */
  it('en tendencia deja de añadir por un lado, pero NO para el bot', () => {
    const series = { '15m': subiendo(260, QUINCE), '1h': subiendo(200, HORA) };
    const abierta = planCon('OFF', series);
    const cerrada = planCon('EVITA_TENDENCIA', series);

    expect(abierta.orders.length).toBeGreaterThan(0);
    // La puerta recorta, no apaga: sigue habiendo ordenes.
    expect(cerrada.orders.length).toBeGreaterThan(0);
    expect(cerrada.orders.length).toBeLessThan(abierta.orders.length);
    // Y lo que queda es el lado que NO acumula contra la tendencia.
    expect(cerrada.orders.every((o) => o.side === 'BUY')).toBe(true);
  });

  it('SOLO_RANGO es al menos tan estricta como EVITA_TENDENCIA', () => {
    const series = { '15m': subiendo(260, QUINCE), '1h': subiendo(200, HORA) };
    expect(planCon('SOLO_RANGO', series).orders.length).toBeLessThanOrEqual(
      planCon('EVITA_TENDENCIA', series).orders.length,
    );
  });
});
